// Ustalenie rzeczywistej osoby: automatyczne łączenie profili w kandydatów na osoby
// i ocena, który kandydat jest osobą, której dotyczy sprawa. Oś teczki — działa bez
// udziału analityka; jego decyzje są tylko opcjonalną korektą.
//
// Jak to działa (wszystkie liczby w `PERSON_RULES`):
// 1. Między każdą parą profili liczymy wagę wiązania — sumę wag wspólnych cech
//    (ten sam e-mail 100, wzajemne odnośniki 90, ten sam niewspółdzielony adres 80, …).
// 2. Profil dostaje też wiązanie z „kotwicą”, czyli identyfikatorami podanymi przez
//    analityka (profil znaleziony po e-mailu 100, nick potwierdzony w treści 80, …).
// 3. Profile i kotwicę łączymy w skupienia po wiązaniach o wadze ≥ `joinThreshold` — od najmocniejszego
//    do najsłabszego i tylko wtedy, gdy ŻADNA para profili z obu łączonych skupień nie jest sprzeczna
//    (różne deklarowane imiona i nazwiska, decyzja analityka „to nie ten sam operator”). Łączenie nie jest
//    więc przechodnie: A–B i B–C nie daje A–C, jeśli A i C sobie przeczą. Pominięte połączenia zostają
//    w `blockedMerges`. Sam zgodny nick lub samo nazwisko nie wystarcza — taki profil zostaje osobnym
//    kandydatem (np. imiennik) i jego ślady nie podnoszą wyniku osoby głównej.
//    Ten sam adres wiąże profile tylko wtedy, gdy OBA publikują go jako własny i nie są to kopie tej samej
//    treści; wzmianka, cytat albo przedruk to słaba przesłanka, a adresy giełd, kontraktów i adresy
//    współdzielone nie liczą się wcale.
// 4. Prawdopodobieństwo kandydata: podstawa z najmocniejszego powiązania z kotwicą,
//    premia za kolejne mocne wiązania, kara za sprzeczności (różne miejscowości, nazwiska).
// 5. Prawdopodobieństwo osoba–adres = W × p + premia, gdzie W to Wskaźnik Pewności adresu
//    względem autora publikacji (ślady tylko z profili kandydata, bez korekty tożsamości),
//    p — pewność (0–1), że publikujący profil należy do kandydata, a premia to 5 pkt za
//    każdy kolejny profil kandydata publikujący adres (najwyżej 10); wynik nie przekracza W.
// Wszystko tutaj jest wnioskowaniem narzędzia — do weryfikacji przez analityka.

import { computeConfidence, linkKey, textFingerprint } from '@olcys/core';
import type { Decision, Finding, Identifier, IdentityMatch, PersonCandidate, ScoreRules } from '@olcys/core';
import { OWNERSHIP_CATEGORIES } from './analysis.ts';
import type { ProfileNode } from './entity.ts';
import { plural } from './format.ts';
import { isCommonHandle, isUniqueType, matchRank, normalize } from './identity.ts';
import { AI_RULES } from './ai-rules.ts';
import { addressKey, sightingKey } from './intel.ts';
import type { AuthorComparison } from './intel.ts';
import { normalizeProfileUrl } from './diff.ts';

export const PERSON_RULES = {
  /** Minimalna waga wiązania, przy której dwa profile uznajemy za jedną osobę. */
  joinThreshold: 50,
  ties: {
    same_email: 100,
    same_phone: 100,
    mutual_links: 90,
    same_address: 80,
    /** Ten sam adres, ale tylko wzmianka, cytat albo kopia tej samej treści — sam nie łączy profili. */
    same_address_mention: 30,
    one_way_link: 50,
    /** Odnośnik jednostronny słabnie o tyle za każdy kolejny niepotwierdzony krok. */
    link_step_penalty: 10,
    same_website: 50,
    same_avatar: 50,
    rare_handle_with_name_or_location: 50,
    same_handle: 20,
    same_name: 15,
  },
  anchor: {
    verified: 100,
    unique_identifier: 100,
    attribute_match: 100,
    confirmed_handle: 80,
    analyst_confirmed: 100,
  },
  probability: {
    anchor_strong: 90,
    anchor_confirmed_handle: 80,
    publishes_analyst_address: 60,
    same_handle: 50,
    linked_only: 35,
    common_handle: 30,
    name_only: 20,
    strong_tie_bonus_anchored: 3,
    max_bonus_anchored: 9,
    strong_tie_bonus: 5,
    max_bonus: 15,
    contradiction_penalty: 10,
    max_penalty: 20,
    analyst_confirmed: 100,
  },
  address: { extra_profile_bonus: 5, max_bonus: 10 },
  description:
    'Profile łączone są w osoby po wiązaniach o wadze co najmniej 50 (suma wag wspólnych cech pary profili), od najmocniejszego wiązania, ' +
    'i tylko wtedy, gdy żadne dwa profile z łączonych grup sobie nie przeczą (różne deklarowane imiona i nazwiska albo decyzja analityka ' +
    '„to nie ten sam operator”) — łączenie nie jest przechodnie, a pominięte połączenia są wykazane z powodem. ' +
    'Ten sam adres wiąże profile (80) tylko wtedy, gdy oba publikują go jako własny i nie są to kopie tej samej treści; wzmianka, cytat ' +
    'albo przedruk daje 30 i sama nie łączy (łączy dopiero z drugą zgodną cechą, np. tym samym nickiem); adresy giełd, kontraktów, zbiórek i adresy współdzielone nie są liczone. ' +
    'Pewność przynależności profilu do osoby wynika z najsłabszego ogniwa na drodze do profilu wyznaczającego osobę. ' +
    'Każdy kandydat jest hipotezą narzędzia, dopóki nie potwierdzi go analityk. ' +
    'Prawdopodobieństwo kandydata wynika z najmocniejszego powiązania z identyfikatorami analityka, premii za kolejne ' +
    'mocne wiązania i kar za sprzeczności. Prawdopodobieństwo osoba–adres = Wskaźnik Pewności adresu względem autora ' +
    '× pewność przynależności profilu do osoby, z premią za kolejne profile tej osoby publikujące adres.',
} as const;

const STRONG = 80;

/** Zdanie z jedną kropką na końcu, także gdy wstawiona przesłanka już ją miała. */
const sentence = (text: string): string => `${text.replace(/[.\s]+$/, '')}.`;

export interface PersonsInput {
  nodes: ProfileNode[];
  /** Porównania autorów z modelu językowego (opcjonalne) — tylko dodatkowa słaba przesłanka. */
  authorComparisons?: AuthorComparison[];
  /** Identyfikatory podane przez analityka. */
  identifiers: Identifier[];
  /** Adresy analizy przed korektami — do wiązania „ten sam adres” i oceny osoba–adres. */
  findings: Finding[];
  /** Decyzje analityka o profilach: `ProfileCard.id` → decyzja. */
  decisions: Map<string, Decision>;
  /** Decyzje analityka o parach kont (wspólny operator): `linkKey(a, b)` → decyzja. */
  linkDecisions?: Map<string, Decision>;
  rules: ScoreRules;
}

export interface PersonsResult {
  /** Kandydaci malejąco; pierwszy to ustalenie główne. */
  persons: PersonCandidate[];
  /** `ProfileCard.id` → identyfikator kandydata. */
  personOfProfile: Map<string, string>;
  /** Połączenia pominięte z powodu sprzeczności: `linkKey(a, b)` → powód. */
  blockedPairs: Map<string, string>;
}

interface Tie {
  weight: number;
  reasons: string[];
  /** Wiązanie przez wzajemne odnośniki — jedyne, które samo potwierdza tożsamość profilu. */
  mutual?: boolean;
  /** Wspólne cechy, z których powstało wiązanie — z wartościami do pokazania jako dowód. */
  features: TieFeatures;
}

export interface TieFeatures {
  email?: string;
  phone?: string;
  /** Adresy publikowane przez OBA profile jako własne, w niezależnych treściach (`network:address`). */
  addresses: string[];
  /** Wspólne adresy, które choć jeden profil tylko wymienia albo cytuje. */
  mentionedAddresses?: string[];
  /** Wspólne adresy z publikacji będących kopią tej samej treści. */
  copiedAddresses?: string[];
  /** Wspólne adresy NIELICZONE: giełdy, kontrakty, zbiórki, miksery, adresy współdzielone. */
  excludedAddresses?: string[];
  /** Ten sam rzadki nick wraz ze zgodną nazwą lub lokalizacją (liczony zamiast samego nicku i nazwy). */
  rareHandle?: boolean;
  /** Waga doliczona za odnośniki między profilami. */
  linkWeight?: number;
  /** Wartości, przez które profile wskazują się nawzajem (nick, adres profilu, e-mail). */
  linkVia?: string[];
  website?: string;
  avatar?: boolean;
  sameName?: boolean;
  sameLocation?: string;
  sameHandle?: boolean;
  links?: 'mutual' | 'one_way';
}

const stripDiacritics = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L');

const fold = (value: string): string => stripDiacritics(value).trim().toLowerCase().replace(/\s+/g, ' ');
const digits = (value: string): string => value.replace(/\D/g, '').replace(/^48(?=\d{9}$)/, '');
const cleanUrl = (url: string): string => normalizeProfileUrl(url).toLowerCase();

const intersect = (left: string[], right: string[]): string[] => left.filter((value) => right.includes(value));

/** Nazwa wyglądająca jak imię i nazwisko: 2–3 wyrazy od wielkiej litery, bez cyfr i znaków nicku. */
export function looksLikePersonName(value: string): boolean {
  const words = value.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 3 && words.every((word) => /^\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?$/u.test(word));
}

/** Czy część lokalna e-maila odpowiada imieniu i nazwisku (`jan.kowalski@`, `jkowalski@`, `kowalski.jan@`). */
function emailMatchesName(email: string, name: string): boolean {
  const local = fold(email.split('@')[0] ?? '').replace(/[^a-z]/g, '');
  const words = fold(name).split(' ');
  const first = words[0]!;
  const last = words.at(-1)!;
  return local.length >= 5 && [first + last, last + first, first[0] + last, last + first[0]].includes(local);
}

/** Dane wspólne dla wszystkich par: adresy nieliczone i odciski treści publikacji z adresami. */
interface TieContext {
  shared: Set<string>;
  /** `adres|dokument` → odcisk fragmentu treści z adresem (do rozpoznania kopii). */
  prints: Map<string, string | undefined>;
}

function tieContext(findings: Finding[], rules: ScoreRules): TieContext {
  const prints = new Map<string, string | undefined>();
  for (const finding of findings) {
    for (const item of finding.evidence) prints.set(`${addressKey(finding)}|${sightingKey(item)}`, textFingerprint(item.excerpt));
  }
  return { shared: sharedAddressKeys(findings, rules), prints };
}

/** Jak dwa profile publikują ten sam adres: oba jako własny, jako kopię tej samej treści, czy tylko wzmiankę. */
function sharedAddressKind(a: ProfileNode, b: ProfileNode, key: string, context: TieContext): 'owned' | 'copied' | 'mentioned' {
  const owning = (node: ProfileNode) => node.sightings.filter((item) => item.addresses.includes(key) && OWNERSHIP_CATEGORIES.includes(item.category));
  const [left, right] = [owning(a), owning(b)];
  if (left.length === 0 || right.length === 0) return 'mentioned';
  const print = (item: { url: string; archivedAt?: string }) => context.prints.get(`${key}|${sightingKey(item)}`);
  // Wystarczy jedna para publikacji o różnej treści, by uznać deklaracje za niezależne.
  const independent = left.some((x) => right.some((y) => print(x) === undefined || print(x) !== print(y)));
  return independent ? 'owned' : 'copied';
}

function pairTie(a: ProfileNode, b: ProfileNode, context: TieContext): Tie {
  const { ties } = PERSON_RULES;
  const reasons: string[] = [];
  const features: TieFeatures = { addresses: [] };
  let weight = 0;
  const add = (points: number, reason: string) => {
    weight += points;
    reasons.push(`${reason} (waga ${points})`);
  };

  const emails = intersect((a.card.attributes.emails ?? []).map(fold), (b.card.attributes.emails ?? []).map(fold));
  if (emails.length > 0) {
    features.email = emails[0];
    add(ties.same_email, `ten sam e-mail ${emails[0]}`);
  }
  const phones = intersect((a.card.attributes.phones ?? []).map(digits), (b.card.attributes.phones ?? []).map(digits)).filter(Boolean);
  if (phones.length > 0) {
    features.phone = phones[0];
    add(ties.same_phone, `ten sam telefon ${phones[0]}`);
  }

  // Odnośnik: profil wskazuje nazwę lub adres drugiego albo identyfikator, po którym tamten znaleziono.
  const pointedBy = (target: ProfileNode) =>
    new Set([...target.names, ...target.sightings.filter((item) => item.step > 0).map((item) => normalize(item.matchedIdentifier.value))]);
  const via = (from: ProfileNode, to: ProfileNode) => [...pointedBy(to)].filter((name) => from.refs.has(name));
  const [forwardVia, backwardVia] = [via(a, b), via(b, a)];
  const forward = forwardVia.length > 0;
  const backward = backwardVia.length > 0;
  const mutual = forward && backward;
  if (mutual) {
    features.linkWeight = ties.mutual_links;
    add(ties.mutual_links, 'wzajemne odnośniki między profilami');
  } else if (forward || backward) {
    const target = forward ? b : a;
    const steps = Math.max(1, target.base.distance ?? 1);
    const points = Math.max(0, ties.one_way_link - (steps - 1) * ties.link_step_penalty);
    features.linkWeight = points;
    add(points, steps > 1 ? `jednostronny odnośnik, ${steps} kroki bez odnośnika zwrotnego` : 'jednostronny odnośnik między profilami');
  }
  if (forward || backward) features.linkVia = [...new Set([...forwardVia, ...backwardVia])];

  const weak: string[] = [];
  for (const key of intersect(a.card.addresses, b.card.addresses)) {
    if (context.shared.has(key)) {
      (features.excludedAddresses ??= []).push(key);
      continue;
    }
    const kind = sharedAddressKind(a, b, key, context);
    if (kind === 'owned') features.addresses.push(key);
    else {
      weak.push(key);
      if (kind === 'copied') (features.copiedAddresses ??= []).push(key);
      else (features.mentionedAddresses ??= []).push(key);
    }
  }
  if (features.addresses.length > 0) {
    add(ties.same_address, 'ten sam adres kryptowalutowy publikowany przez oba profile jako własny, niepublikowany przez wiele innych osób');
  } else if (weak.length > 0) {
    add(ties.same_address_mention, 'ten sam adres w skopiowanej publikacji / wzmiance — nie dowodzi wspólnego operatora');
  }

  const websites = intersect((a.card.attributes.urls ?? []).map(cleanUrl), (b.card.attributes.urls ?? []).map(cleanUrl));
  if (websites.length > 0) {
    features.website = websites[0];
    add(ties.same_website, `ta sama strona WWW ${websites[0]}`);
  }
  if (a.card.attributes.avatarUrl && a.card.attributes.avatarUrl === b.card.attributes.avatarUrl) {
    features.avatar = true;
    add(ties.same_avatar, 'ten sam awatar');
  }

  const sameName =
    a.card.attributes.displayName !== undefined &&
    b.card.attributes.displayName !== undefined &&
    fold(a.card.attributes.displayName) === fold(b.card.attributes.displayName);
  const sameLocation =
    a.card.attributes.location !== undefined &&
    b.card.attributes.location !== undefined &&
    fold(a.card.attributes.location) === fold(b.card.attributes.location);
  const sameHandle = a.card.handle !== undefined && b.card.handle !== undefined && normalize(a.card.handle) === normalize(b.card.handle);
  if (sameHandle && !isCommonHandle(a.card.handle!) && (sameName || sameLocation)) {
    features.rareHandle = true;
    add(ties.rare_handle_with_name_or_location, `ten sam rzadki nick i zgodna ${sameName ? 'nazwa wyświetlana' : 'lokalizacja'}`);
  } else {
    if (sameHandle) add(ties.same_handle, 'ten sam nick (sam w sobie nie dowodzi tej samej osoby)');
    if (sameName) add(ties.same_name, 'ta sama nazwa wyświetlana (możliwa zbieżność nazwisk)');
  }
  if (forward || backward) features.links = mutual ? 'mutual' : 'one_way';
  if (sameName) features.sameName = true;
  if (sameLocation) features.sameLocation = a.card.attributes.location;
  if (sameHandle) features.sameHandle = true;
  return { weight: Math.min(100, weight), reasons, mutual, features };
}

function anchorTie(node: ProfileNode, identifiers: Identifier[], decision: Decision | undefined): Tie {
  const { anchor } = PERSON_RULES;
  if (decision === 'confirmed') return { weight: anchor.analyst_confirmed, reasons: ['profil potwierdzony decyzją analityka'], features: { addresses: [] } };
  if (node.base.match === 'verified_link') {
    return { weight: anchor.verified, reasons: [`tożsamość profilu potwierdzona: ${node.base.reasons.join(' ') || 'odnośniki wzajemne lub dowód kryptograficzny'}`], features: { addresses: [] } };
  }
  const direct = node.step === 0 && node.base.match === 'exact_identifier';
  const type = node.matchedIdentifier.type;
  if (direct && isUniqueType(type) && type !== 'crypto_address') {
    return { weight: anchor.unique_identifier, reasons: [`profil odnaleziony po identyfikatorze unikalnym podanym przez analityka („${node.matchedIdentifier.value}”)`], features: { addresses: [] } };
  }
  const emails = identifiers.filter((item) => item.type === 'email').map((item) => fold(item.value));
  const ownEmail = (node.card.attributes.emails ?? []).map(fold).find((email) => emails.includes(email));
  if (ownEmail) return { weight: anchor.attribute_match, reasons: [`e-mail profilu (${ownEmail}) zgadza się z identyfikatorem podanym przez analityka`], features: { addresses: [] } };
  const urls = identifiers.filter((item) => item.type === 'profile_url').map((item) => cleanUrl(item.value));
  if (urls.includes(cleanUrl(node.card.url))) {
    return { weight: anchor.attribute_match, reasons: ['adres profilu podał analityk'], features: { addresses: [] } };
  }
  if (direct && type !== 'crypto_address') {
    return { weight: anchor.confirmed_handle, reasons: [`nick lub nazwisko potwierdzone drugim identyfikatorem podmiotu: ${node.base.reasons.join(' ')}`], features: { addresses: [] } };
  }
  return { weight: 0, reasons: [], features: { addresses: [] } };
}

/** Najbardziej prawdopodobne imię i nazwisko z nazw wyświetlanych; nic nie zgadujemy. */
function chooseName(members: ProfileNode[]): { fullName?: string; variants: string[]; reason: string } {
  const emails = members.flatMap((node) => node.card.attributes.emails ?? []);
  const byName = new Map<string, { name: string; services: Set<string>; email: boolean }>();
  const others = new Set<string>();
  for (const node of members) {
    const name = node.card.attributes.displayName?.trim();
    if (!name) continue;
    if (!looksLikePersonName(name)) {
      others.add(name);
      continue;
    }
    const entry = byName.get(fold(name)) ?? { name, services: new Set<string>(), email: emails.some((email) => emailMatchesName(email, name)) };
    entry.services.add(node.card.service);
    byName.set(fold(name), entry);
  }
  const ranked = [...byName.values()].sort(
    (a, b) => Number(b.email) * 2 + b.services.size - (Number(a.email) * 2 + a.services.size) || a.name.localeCompare(b.name, 'pl'),
  );
  const best = ranked[0];
  const variants = [...ranked.slice(1).map((item) => item.name), ...others];
  if (!best) {
    return {
      variants,
      reason:
        others.size > 0
          ? 'Imię i nazwisko: nie ustalono — nazwy wyświetlane w profilach wyglądają jak pseudonim lub nazwa firmy.'
          : 'Imię i nazwisko: nie ustalono — profile nie ujawniają nazwy wyświetlanej.',
    };
  }
  const services = [...best.services];
  return {
    fullName: best.name,
    variants,
    reason:
      `Imię i nazwisko „${best.name}”: nazwa wyświetlana w ${services.length} ${plural(services.length, 'serwisie', 'serwisach', 'serwisach')} (${services.join(', ')})` +
      `${best.email ? ', zgodna z adresem e-mail profilu' : ''}.`,
  };
}

function collectAttributes(members: ProfileNode[]): PersonCandidate['attributes'] {
  const found = new Map<string, PersonCandidate['attributes'][number]>();
  const add = (kind: PersonCandidate['attributes'][number]['kind'], value: string | undefined, service: string) => {
    if (!value?.trim()) return;
    const key = `${kind}|${fold(value)}`;
    const entry = found.get(key) ?? { kind, value: value.trim(), sources: [] };
    if (!entry.sources.includes(service)) entry.sources.push(service);
    found.set(key, entry);
  };
  for (const { card } of members) {
    for (const email of card.attributes.emails ?? []) add('email', email, card.service);
    for (const phone of card.attributes.phones ?? []) add('phone', phone, card.service);
    add('location', card.attributes.location, card.service);
    for (const url of card.attributes.urls ?? []) add('website', url, card.service);
    add('handle', card.handle, card.service);
  }
  return [...found.values()].sort((a, b) => b.sources.length - a.sources.length);
}

/** Sprzeczności w skupieniu: różne miejscowości albo różne nazwiska w profilach. */
function contradictions(members: ProfileNode[]): string[] {
  const found: string[] = [];
  const locations = new Map(members.filter((node) => node.card.attributes.location).map((node) => [fold(node.card.attributes.location!), node.card.attributes.location!]));
  if (locations.size > 1) found.push(`różne lokalizacje w profilach (${[...locations.values()].join(' / ')})`);
  const surnames = new Map(
    members
      .map((node) => node.card.attributes.displayName?.trim())
      .filter((name): name is string => name !== undefined && looksLikePersonName(name))
      .map((name) => [fold(name).split(' ').at(-1)!, name]),
  );
  if (surnames.size > 1) found.push(`różne nazwiska w profilach (${[...surnames.values()].join(' / ')})`);
  return found;
}

const BASE_BY_MATCH: Record<IdentityMatch, { points: number; text: string }> = {
  verified_link: { points: PERSON_RULES.probability.anchor_strong, text: 'tożsamość profilu potwierdzona' },
  exact_identifier: { points: PERSON_RULES.probability.publishes_analyst_address, text: 'autor sam publikuje adres wskazany w sprawie' },
  same_handle: { points: PERSON_RULES.probability.same_handle, text: 'zgodny tylko nick — tego samego nicku może używać inna osoba' },
  linked_profile: { points: PERSON_RULES.probability.linked_only, text: 'profil znaleziony pośrednio, bez wystarczającego wiązania z pozostałymi' },
  common_handle: { points: PERSON_RULES.probability.common_handle, text: 'zgodny tylko pospolity nick' },
  name_only: { points: PERSON_RULES.probability.name_only, text: 'zgodne tylko imię i nazwisko — możliwy imiennik' },
};

/**
 * Dwa profile podają różne imiona i nazwiska. Takich profili nie łączymy automatycznie w jedną osobę,
 * nawet przy mocnym wiązaniu (ten sam e-mail, ten sam adres): to może być ta sama osoba pod innym
 * nazwiskiem, osoba bliska albo podstawiona — rozstrzyga analityk, a teczka pokazuje „powiązaną tożsamość”.
 */
export function nameConflict(a: ProfileNode, b: ProfileNode): boolean {
  const [left, right] = [a.card.attributes.displayName?.trim(), b.card.attributes.displayName?.trim()];
  return left !== undefined && right !== undefined && looksLikePersonName(left) && looksLikePersonName(right) && fold(left) !== fold(right);
}

/** Wiązanie dwóch profili (wspólne cechy z wartościami) — do oceny powiązanych tożsamości. */
export function tieBetween(a: ProfileNode, b: ProfileNode, findings: Finding[], rules: ScoreRules): { weight: number; reasons: string[]; features: TieFeatures } {
  return pairTie(a, b, tieContext(findings, rules));
}

/** Jak `tieBetween`, ale z danymi wspólnymi policzonymi raz — do porównywania wielu par. */
export function createTieScorer(findings: Finding[], rules: ScoreRules): (a: ProfileNode, b: ProfileNode) => { weight: number; reasons: string[]; features: TieFeatures } {
  const context = tieContext(findings, rules);
  return (a, b) => pairTie(a, b, context);
}

/** Adresy, które nie świadczą o tej samej osobie: współdzielone albo należące do pośredników. */
const sharedAddressKeys = (findings: Finding[], rules: ScoreRules): Set<string> =>
  new Set(
    findings
      .filter((finding) => finding.unrelatedPublishers >= rules.sharedAddressThreshold || rules.excludedClasses.includes(finding.chain?.profile.addressClass ?? 'unknown'))
      .map(addressKey),
  );

/**
 * Pary profili o wiązaniu „możliwym, ale niepotwierdzonym” (waga poniżej progu łączenia) —
 * tylko dla nich pytamy model językowy o podobieństwo stylu.
 */
export function comparablePairs(nodes: ProfileNode[], findings: Finding[], rules: ScoreRules): { a: ProfileNode; b: ProfileNode; weight: number }[] {
  const shared = tieContext(findings, rules);
  const { minTieWeight, maxTieWeight } = AI_RULES.authorComparison;
  const pairs: { a: ProfileNode; b: ProfileNode; weight: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const { weight } = pairTie(nodes[i]!, nodes[j]!, shared);
      if (weight >= minTieWeight && weight <= maxTieWeight) pairs.push({ a: nodes[i]!, b: nodes[j]!, weight });
    }
  }
  return pairs;
}

export function resolvePersons(input: PersonsInput): PersonsResult {
  const { nodes, rules } = input;
  const rules_ = PERSON_RULES.probability;
  const count = nodes.length;
  const ANCHOR = count;

  const sharedAddresses = tieContext(input.findings, rules);

  // ---------- Wiązania ----------
  const rejected = nodes.map((node) => input.decisions.get(node.card.id) === 'rejected');
  const anchors = nodes.map((node, index) =>
    rejected[index] ? { weight: 0, reasons: [], features: { addresses: [] } } : anchorTie(node, input.identifiers, input.decisions.get(node.card.id)),
  );
  const pairs = new Map<string, Tie>();
  const pair = (i: number, j: number): Tie => pairs.get(i < j ? `${i}|${j}` : `${j}|${i}`) ?? { weight: 0, reasons: [], features: { addresses: [] } };
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (rejected[i] || rejected[j]) continue;
      const tie = pairTie(nodes[i]!, nodes[j]!, sharedAddresses);
      const ids = [nodes[i]!.card.id, nodes[j]!.card.id];
      const comparison = input.authorComparisons?.find((item) => ids.includes(item.a) && ids.includes(item.b) && item.a !== item.b);
      const { minTieWeight, maxTieWeight, maxBonus } = AI_RULES.authorComparison;
      if (comparison && tie.weight >= minTieWeight && tie.weight <= maxTieWeight) {
        // Model może dołożyć słabą przesłankę, ale nigdy sam nie przenosi wiązania ponad próg łączenia.
        const bonus = Math.min(maxBonus, Math.round((comparison.likelihood / 100) * maxBonus), PERSON_RULES.joinThreshold - 1 - tie.weight);
        if (bonus > 0) {
          tie.weight += bonus;
          tie.reasons.push(`model ${comparison.model}: podobny styl wypowiedzi (${comparison.likelihood}%) — słaba przesłanka, nie łączy profili (waga ${bonus})`);
        }
      }
      if (tie.weight > 0) pairs.set(`${i}|${j}`, tie);
    }
  }

  // ---------- Skupienia z ograniczeniami ----------
  // Każde połączenie sprawdza WSZYSTKIE pary profili z obu skupień: jedna sprzeczność wstrzymuje
  // połączenie, więc łańcuch A–B, B–C nie skleja A z C, gdy A i C sobie przeczą.
  const groupOf = Array.from({ length: count + 1 }, (_, index) => index);
  const membersOf = new Map<number, number[]>(groupOf.map((id) => [id, [id]]));
  const union = (a: number, b: number) => {
    const [from, to] = [groupOf[a]!, groupOf[b]!];
    if (from === to) return;
    for (const index of membersOf.get(from)!) groupOf[index] = to;
    membersOf.set(to, [...membersOf.get(to)!, ...membersOf.get(from)!]);
    membersOf.delete(from);
  };
  const confirmed = nodes.map((node) => input.decisions.get(node.card.id) === 'confirmed');
  const linkDecision = (i: number, j: number): Decision | undefined => input.linkDecisions?.get(linkKey(nodes[i]!.card.id, nodes[j]!.card.id));
  const declaredName = (index: number): string | undefined => {
    const name = nodes[index]!.card.attributes.displayName?.trim();
    return name !== undefined && looksLikePersonName(name) ? fold(name) : undefined;
  };
  const tag = (index: number) => `${nodes[index]!.card.service}${nodes[index]!.card.handle ? ` („${nodes[index]!.card.handle}”)` : ''}`;
  /** Sprzeczność twarda między dwoma skupieniami albo `undefined`, gdy wolno je połączyć. */
  const conflictBetween = (a: number, b: number): { pair: [number, number]; reason: string } | undefined => {
    const [left, right] = [membersOf.get(groupOf[a]!)!, membersOf.get(groupOf[b]!)!].map((items) => items.filter((index) => index !== ANCHOR));
    const names = (items: number[]) => new Set(items.map(declaredName).filter((name): name is string => name !== undefined));
    const [leftNames, rightNames] = [names(left!), names(right!)];
    for (const x of left!) {
      for (const y of right!) {
        const decided = linkDecision(x, y);
        if (decided === 'rejected') return { pair: [x, y], reason: `decyzja analityka: konta ${tag(x)} i ${tag(y)} nie mają wspólnego operatora` };
        // Decyzja analityka „to ta sama osoba” znosi blokadę różnych nazwisk dla par, których dotyczy;
        // nazwisko już przyjęte w skupieniu (decyzją analityka) nie jest sprzecznością.
        if (decided === 'confirmed' || confirmed[x] || confirmed[y]) continue;
        if (nameConflict(nodes[x]!, nodes[y]!) && !leftNames.has(declaredName(y)!) && !rightNames.has(declaredName(x)!)) {
          return {
            pair: [x, y],
            reason: `sprzeczne deklarowane imiona i nazwiska: „${nodes[x]!.card.attributes.displayName!.trim()}” (${tag(x)}) i „${nodes[y]!.card.attributes.displayName!.trim()}” (${tag(y)})`,
          };
        }
      }
    }
    return undefined;
  };
  const blocked: { pair: [number, number]; weight: number; reason: string }[] = [];
  /** Pary połączone decyzją analityka o wspólnym operatorze. */
  const forcedLinks = new Set<string>();
  const pairKey = (i: number, j: number) => (i < j ? `${i}|${j}` : `${j}|${i}`);

  // Profile w kolejności od najmocniej związanego z identyfikatorami analityka: pierwszy wyznacza
  // imię i nazwisko osoby głównej; profil podający INNĄ osobę nie jest do niej dołączany automatycznie.
  const byAnchor = nodes.map((_, index) => index).sort((a, b) => anchors[b]!.weight - anchors[a]!.weight || matchRank(nodes[b]!.base.match) - matchRank(nodes[a]!.base.match) || a - b);

  // 1. Decyzje analityka. Profil potwierdzony trafia do osoby głównej: do profilu, który ją wyznacza
  //    (najmocniej związanego z identyfikatorami analityka), oraz do samych identyfikatorów.
  const mainSeed = byAnchor.find((index) => !confirmed[index] && !rejected[index]);
  for (let i = 0; i < count; i++) {
    if (!confirmed[i]) continue;
    union(i, ANCHOR);
    if (mainSeed !== undefined) union(mainSeed, i);
  }
  //    Para kont potwierdzona jako wspólny operator trafia do jednego kandydata mimo różnych nazwisk.
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (linkDecision(i, j) !== 'confirmed' || rejected[i] || rejected[j] || groupOf[i] === groupOf[j]) continue;
      const conflict = conflictBetween(i, j);
      if (conflict && linkDecision(...conflict.pair) === 'rejected') {
        blocked.push({ pair: [i, j], weight: PERSON_RULES.anchor.analyst_confirmed, reason: conflict.reason });
        continue;
      }
      forcedLinks.add(pairKey(i, j));
      union(i, j);
    }
  }
  // 2. Powiązania z identyfikatorami analityka — one wyznaczają osobę główną.
  for (const i of byAnchor) {
    if (confirmed[i] || anchors[i]!.weight < PERSON_RULES.joinThreshold || groupOf[i] === groupOf[ANCHOR]) continue;
    const conflict = conflictBetween(i, ANCHOR);
    if (conflict) {
      blocked.push({ pair: conflict.pair, weight: anchors[i]!.weight, reason: `profil ${tag(i)} odnaleziono po identyfikatorach analityka, ale nie dołączono go do osoby głównej — ${conflict.reason}` });
      continue;
    }
    union(i, ANCHOR);
  }
  // 3. Wiązania par profili, od najmocniejszego do najsłabszego.
  const candidates: { i: number; j: number; weight: number }[] = [];
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (pair(i, j).weight >= PERSON_RULES.joinThreshold) candidates.push({ i, j, weight: pair(i, j).weight });
    }
  }
  candidates.sort((a, b) => b.weight - a.weight || a.i - b.i || a.j - b.j);
  for (const { i, j, weight } of candidates) {
    if (groupOf[i] === groupOf[j]) continue;
    const conflict = conflictBetween(i, j);
    if (conflict) {
      blocked.push({ pair: [i, j], weight, reason: conflict.reason });
      continue;
    }
    union(i, j);
  }
  const find = (index: number): number => groupOf[index]!;
  /** Waga wiązania do oceny przynależności: para połączona decyzją analityka liczy się jak pewna. */
  const effective = (i: number, j: number): number => (forcedLinks.has(pairKey(i, j)) ? 100 : pair(i, j).weight);
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < count; i++) clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]);

  // ---------- Kandydaci ----------
  const drafts = [...clusters.entries()].map(([root, indexes]) => {
    const anchored = root === find(ANCHOR);
    const members = indexes.map((index) => nodes[index]!);
    const reasons: string[] = [];
    let probability: number;

    const strongPairs = indexes.flatMap((i, at) => indexes.slice(at + 1).filter((j) => pair(i, j).weight >= STRONG).map((j) => [i, j] as const));
    const anchorStrong = indexes.filter((index) => anchors[index]!.weight >= STRONG);
    // Profil, od którego liczymy przynależność pozostałych: najmocniej związany z kotwicą lub najlepiej odnaleziony.
    const seed = [...indexes].sort(
      (a, b) => anchors[b]!.weight - anchors[a]!.weight || matchRank(nodes[b]!.base.match) - matchRank(nodes[a]!.base.match) || a - b,
    )[0]!;

    if (indexes.every((index) => rejected[index])) {
      probability = 0;
      reasons.push('Profil odrzucony decyzją analityka — nie jest zaliczany do badanej osoby.');
    } else if (anchored) {
      const top = Math.max(...indexes.map((index) => anchors[index]!.weight));
      const confirmed = indexes.some((index) => input.decisions.get(nodes[index]!.card.id) === 'confirmed');
      probability = confirmed ? rules_.analyst_confirmed : top >= PERSON_RULES.anchor.unique_identifier ? rules_.anchor_strong : rules_.anchor_confirmed_handle;
      const lead = nodes[seed]!;
      reasons.push(sentence(`Podstawa ${probability}: profil ${lead.card.service}${lead.card.handle ? ` („${lead.card.handle}”)` : ''} — ${anchors[seed]!.reasons.join('; ')}`));
      const extra = Math.min(rules_.max_bonus_anchored, (anchorStrong.length - 1 + strongPairs.length) * rules_.strong_tie_bonus_anchored);
      if (extra > 0 && !confirmed) {
        probability += extra;
        reasons.push(`Kolejne niezależne mocne wiązania (${anchorStrong.length - 1 + strongPairs.length}): +${extra}.`);
      }
    } else {
      const lead = nodes[seed]!;
      const base = BASE_BY_MATCH[lead.base.match];
      probability = base.points;
      reasons.push(`Podstawa ${base.points}: profil ${lead.card.service}${lead.card.handle ? ` („${lead.card.handle}”)` : ''} — ${base.text}.`);
      const extra = Math.min(rules_.max_bonus, strongPairs.length * rules_.strong_tie_bonus);
      if (extra > 0) {
        probability += extra;
        reasons.push(`Mocne wiązania między profilami (${strongPairs.length}): +${extra}.`);
      }
    }
    for (const [i, j] of indexes.flatMap((i, at) => indexes.slice(at + 1).map((j) => [i, j] as const))) {
      const tie = pair(i, j);
      if (forcedLinks.has(pairKey(i, j))) {
        reasons.push(`Połączono profile ${nodes[i]!.card.service} i ${nodes[j]!.card.service} decyzją analityka o wspólnym operatorze.`);
      } else if (tie.weight >= PERSON_RULES.joinThreshold) {
        reasons.push(`Połączono profile ${nodes[i]!.card.service} i ${nodes[j]!.card.service}: ${tie.reasons.join('; ')}.`);
      }
    }
    const blockedHere = blocked.filter((item) => item.pair.some((index) => indexes.includes(index)));
    for (const item of blockedHere) {
      reasons.push(sentence(`Nie połączono profili ${tag(item.pair[0])} i ${tag(item.pair[1])} mimo wiązania o wadze ${item.weight}: ${item.reason}`));
    }
    const conflicts = probability > 0 ? contradictions(members) : [];
    if (conflicts.length > 0) {
      const penalty = Math.min(rules_.max_penalty, conflicts.length * rules_.contradiction_penalty);
      probability -= penalty;
      reasons.push(`Sprzeczności: ${conflicts.join('; ')} — −${penalty}.`);
    }
    probability = Math.max(0, Math.min(100, probability));

    // Przynależność profilu = najsłabsze ogniwo na najlepszej drodze do profilu wyznaczającego osobę
    // (albo bezpośrednie powiązanie z identyfikatorami analityka). Profil dołączony pośrednio, przez
    // słabsze wiązanie innego profilu, nie dziedziczy pewności po swoim najmocniejszym sąsiedzie.
    const reach = new Map<number, number>(indexes.map((index) => [index, index === seed ? 100 : 0]));
    for (let changed = true; changed; ) {
      changed = false;
      for (const from of indexes) {
        for (const to of indexes) {
          const through = Math.min(reach.get(from)!, effective(from, to));
          if (from !== to && through > reach.get(to)!) {
            reach.set(to, through);
            changed = true;
          }
        }
      }
    }
    const membership = new Map<number, number>();
    for (const index of indexes) membership.set(index, index === seed ? 1 : Math.max(anchors[index]!.weight, reach.get(index)!) / 100);
    const status: NonNullable<PersonCandidate['status']> = indexes.every((index) => rejected[index])
      ? 'rejected'
      : indexes.some((index) => confirmed[index]) || indexes.some((i) => indexes.some((j) => forcedLinks.has(`${i}|${j}`)))
        ? 'confirmed'
        : 'hypothesis';
    const blockedMerges = blockedHere.map((item) => ({
      profileIds: [nodes[item.pair[0]]!.card.id, nodes[item.pair[1]]!.card.id] as [string, string],
      weight: item.weight,
      reason: item.reason,
    }));
    return { anchored, indexes, members, probability, reasons, membership, seed, status, blockedMerges };
  });

  drafts.sort(
    (a, b) =>
      Number(b.anchored) - Number(a.anchored) ||
      b.probability - a.probability ||
      b.members.reduce((sum, node) => sum + node.card.evidenceIds.length, 0) - a.members.reduce((sum, node) => sum + node.card.evidenceIds.length, 0) ||
      a.members[0]!.card.id.localeCompare(b.members[0]!.card.id),
  );

  const persons: PersonCandidate[] = [];
  const personOfProfile = new Map<string, string>();
  drafts.forEach((draft, position) => {
    const id = `osoba-${position + 1}`;
    const main = position === 0;
    const name = chooseName(draft.members);
    draft.reasons.push(name.reason);

    // ---------- Karty profili: ocena tożsamości spójna z ustaleniem osoby ----------
    for (const index of draft.indexes) {
      const node = nodes[index]!;
      const share = draft.membership.get(index)!;
      const decision = input.decisions.get(node.card.id);
      personOfProfile.set(node.card.id, id);
      const tiesToOthers = draft.indexes
        .filter((other) => other !== index && pair(index, other).weight >= PERSON_RULES.joinThreshold)
        .map((other) => `Wiązanie z profilem ${nodes[other]!.card.service}: ${pair(index, other).reasons.join('; ')}.`);
      // Wiązania poniżej progu z udziałem modelu pokazujemy jako informację — profile pozostają osobno.
      for (let other = 0; other < count; other++) {
        const tie = pair(index, other);
        if (other !== index && tie.weight < PERSON_RULES.joinThreshold && tie.reasons.some((reason) => reason.startsWith('model '))) {
          tiesToOthers.push(`Możliwe, ale niepotwierdzone wiązanie z profilem ${nodes[other]!.card.id} (waga ${tie.weight}, poniżej progu ${PERSON_RULES.joinThreshold}): ${tie.reasons.join('; ')}.`);
        }
      }
      const topTie = Math.max(0, ...draft.indexes.filter((other) => other !== index).map((other) => pair(index, other).weight));

      let match = node.base.match;
      if (decision === 'confirmed') match = 'verified_link';
      else if (draft.anchored && matchRank(match) < matchRank('exact_identifier')) {
        // W skupieniu z identyfikatorami analityka profil dziedziczy pewność po wiązaniu, które go tam wprowadziło.
        const strength = index === draft.seed ? Math.max(anchors[index]!.weight, topTie) : Math.round(share * 100);
        const mutual = draft.indexes.some((other) => other !== index && pair(index, other).mutual);
        match = mutual ? 'verified_link' : strength >= STRONG ? 'exact_identifier' : 'linked_profile';
      }
      node.card.identityMatch = match;
      node.card.identityScore = decision === 'rejected' ? 0 : Math.round(draft.probability * share);
      node.card.identityReasons = [
        ...(decision === 'confirmed' ? ['Profil potwierdzony decyzją analityka.'] : decision === 'rejected' ? ['Profil odrzucony decyzją analityka.'] : []),
        ...node.base.reasons,
        ...(anchors[index]!.weight > 0 && decision !== 'confirmed' ? [sentence(`Powiązanie z identyfikatorami analityka: ${anchors[index]!.reasons.join('; ')}`)] : []),
        ...tiesToOthers,
        main
          ? `Profil zaliczony do osoby głównej (prawdopodobieństwo ${draft.probability}%, pewność przynależności profilu ${Math.round(share * 100)}%).`
          : `Profil zaliczony do innego kandydata (${id}) — brak wystarczającego wiązania z osobą główną; jego ślady nie podnoszą jej wyniku.`,
      ];
      if (decision) node.card.decision = decision;
    }

    // ---------- Łączne prawdopodobieństwo osoba–adres ----------
    const docs = new Map<string, number>();
    for (const index of draft.indexes) {
      for (const sighting of nodes[index]!.sightings) docs.set(sightingKey(sighting), index);
    }
    const addresses: PersonCandidate['addresses'] = [];
    for (const finding of input.findings) {
      const own = finding.evidence.filter((item) => docs.has(sightingKey(item)));
      if (own.length === 0 || draft.probability === 0) continue;
      const publishers = new Set(own.map((item) => docs.get(sightingKey(item))!));
      const authorScore = computeConfidence(
        {
          evidence: own.map((item) => ({ ...item, identityMatch: 'exact_identifier' as const })),
          addressClass: finding.chain?.profile.addressClass ?? 'unknown',
          unrelatedPublishers: finding.unrelatedPublishers,
        },
        rules,
      ).score;
      const share = Math.max(...[...publishers].map((index) => draft.membership.get(index)!));
      const bonus = Math.min(PERSON_RULES.address.max_bonus, (publishers.size - 1) * PERSON_RULES.address.extra_profile_bonus);
      addresses.push({ key: addressKey(finding), probability: Math.min(authorScore, Math.round(authorScore * share) + bonus) });
    }
    addresses.sort((a, b) => b.probability - a.probability);

    persons.push({
      id,
      ...(name.fullName ? { fullName: name.fullName } : {}),
      nameVariants: name.variants,
      probability: draft.probability,
      reasons: draft.reasons,
      attributes: collectAttributes(draft.members),
      profileIds: draft.members.map((node) => node.card.id),
      addresses,
      status: draft.status,
      ...(draft.blockedMerges.length > 0 ? { blockedMerges: draft.blockedMerges } : {}),
    });
  });

  const blockedPairs = new Map(blocked.map((item) => [linkKey(nodes[item.pair[0]]!.card.id, nodes[item.pair[1]]!.card.id), item.reason] as const));
  return { persons, personOfProfile, blockedPairs };
}
