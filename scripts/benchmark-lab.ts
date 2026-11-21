// Pomiar narzędzia na laboratorium tożsamości (apps/identity-lab): łączenie kont jednej osoby,
// przypisanie adresów i czas analizy — twarde liczby względem prawdy wzorcowej laboratorium.
//
// Uruchomienie (laboratorium musi działać: `pnpm --filter synthetic-identity-lab start`):
//   node scripts/benchmark-lab.ts [--lab http://127.0.0.1:8787] [--sample 60] [--out docs/BENCHMARK-LAB.md] [--json plik.json]
//
// Zasady pomiaru:
// - analizy wykonuje nasz kod przez `buildApp` + `app.inject` (baza w pamięci, wyłącznie łączniki
//   laboratorium i dostawca sieci laboratoryjnej, bez internetu i bez modelu językowego);
// - punkty startowe są wybierane WYŁĄCZNIE z danych publicznych (`/api/accounts`), deterministycznie;
// - prawda wzorcowa (`/api/ground-truth`) jest pobierana dopiero PO wszystkich analizach — strażnik
//   na `fetch` przerywa skrypt, gdyby cokolwiek sięgnęło po nią wcześniej;
// - reguły narzędzia nie są zmieniane ani strojone pod ten zbiór.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../apps/api/src/app.ts';
import { createPgliteDriver, createStorage } from '../apps/api/src/storage.ts';
import { createChainProviders, getActivityFromProviders, matchService } from '../packages/chain/src/index.ts';
import { createConnectors, normalizeAddressText } from '../packages/sources/src/index.ts';

// ---------- Parametry ----------

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1]! : fallback;
};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAB_URL = option('lab', process.env.LAB_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SAMPLE_PERSONS = Number(option('sample', '60'));
const OUT_FILE = resolve(ROOT, option('out', 'docs/BENCHMARK-LAB.md'));
const JSON_FILE = args.includes('--json') ? resolve(ROOT, option('json', 'benchmark-lab.json')) : undefined;
const THRESHOLDS = [40, 60, 80];
/** Ilu kandydatów na punkty startowe analizujemy, żeby po odsłonięciu wzorca zostało `SAMPLE_PERSONS` różnych osób. */
const SAMPLE_CANDIDATES = Math.ceil(SAMPLE_PERSONS * 1.6);
/** Górny limit analiz dla pułapki tego samego nicku (nicki występujące na co najmniej dwóch kontach). */
const MAX_NICK_GROUPS = Number(option('nicks', '240'));
const FORBIDDEN = ['/api/ground-truth', '/api/resolve', '/api/evaluate', '/api/export', '/api/search', '/api/regenerate'];

// ---------- Strażnik: w fazie analiz nikt nie czyta prawdy wzorcowej ----------

let phase: 'public' | 'analysis' | 'scoring' = 'public';
const requests = { public: 0, analysis: 0, scoring: 0, forbiddenDuringAnalysis: 0, nonLab: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!`${url.origin}`.startsWith(LAB_URL)) {
    requests.nonLab++;
    throw new Error(`Pomiar działa bez internetu — zablokowano żądanie do ${url.origin}.`);
  }
  if (phase !== 'scoring' && FORBIDDEN.some((path) => url.pathname.startsWith(path))) {
    requests.forbiddenDuringAnalysis++;
    throw new Error(`Zablokowano żądanie ${url.pathname} przed zakończeniem analiz.`);
  }
  requests[phase]++;
  return realFetch(input, init);
}) as typeof fetch;

// ---------- Dane publiczne laboratorium ----------

interface PublicAccount {
  id: string;
  serviceId: string;
  username: string;
  displayName: string;
  email: string;
  bio: string;
  location: string;
  walletAddresses: string[];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${LAB_URL}${path}`);
  if (!response.ok) throw new Error(`Laboratorium: ${path} — kod ${response.status}.`);
  return (await response.json()) as T;
}

const hashOrder = (id: string) => createHash('sha256').update(`benchmark-lab-v1|${id}`).digest('hex');
const handleKey = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').trim().toLowerCase().replace(/\s+/g, ' ');
const emailsIn = (text: string) => [...new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? []).map((email) => email.toLowerCase()))];
const emailsOf = (account: PublicAccount) => [...new Set([account.email.toLowerCase(), ...emailsIn(account.bio)])];
const emailVariant = (email: string) => {
  const [local, domain] = email.split('@');
  return `${(local ?? '').replace(/\+.*$/, '').replace(/\./g, '')}@${domain}`;
};
const handleVariant = (value: string) => handleKey(value).replace(/[._-]/g, '');
const pct = (value: number | undefined) => (value === undefined || Number.isNaN(value) ? '—' : `${(value * 100).toFixed(1).replace('.', ',')}%`);
const num = (value: number, digits = 0) => value.toFixed(digits).replace('.', ',');
const ratio = (a: number, b: number) => (b === 0 ? undefined : a / b);
const f1Of = (precision: number | undefined, recall: number | undefined) => (precision === undefined || recall === undefined || precision + recall === 0 ? (precision === undefined && recall === undefined ? undefined : 0) : (2 * precision * recall) / (precision + recall));

// ---------- Analiza jednego punktu startowego ----------

interface FindingSummary {
  address: string;
  score: number;
  excluded: boolean;
  subjectProbability: number;
  unrelatedPublishers: number;
  rules: string[];
  evidence: number;
  transfers: number;
  addressClass?: string;
}

interface RunSummary {
  set: string;
  variant: 'nick+email' | 'nick';
  startAccount: string;
  identifiers: { type: string; value: string }[];
  status: string;
  partial: boolean;
  analysisMs: number;
  dossierMs: number;
  connectorQueries: number;
  mainProbability: number;
  mainAccounts: string[];
  sameLikelyAccounts: string[];
  possiblyAccounts: string[];
  associatedAccounts: string[];
  otherCandidateAccounts: string[][];
  /** Przesłanki narzędzia dla profilu: konto → teksty. */
  reasons: Record<string, string[]>;
  identityReasons: Record<string, string[]>;
  findings: FindingSummary[];
  /** Adresy powiązanych tożsamości „prawdopodobnie ta sama osoba”. */
  sameLikelyAddresses: string[];
  errors: string[];
}

const accountOfUrl = (url: string): string | undefined => /\/profile\/([^/?#]+)/.exec(url)?.[1];

interface DossierLike {
  partial?: boolean;
  persons: { probability: number; profileIds: string[] }[];
  profiles: { id: string; url: string; identityReasons: string[] }[];
  findings: {
    address: string;
    confidence: { score: number; excluded: boolean; ledger: { rule: string }[] };
    subjectProbability: number;
    unrelatedPublishers: number;
    evidence: unknown[];
    chain?: { transfers: unknown[]; profile: { addressClass: string } };
  }[];
  linkedIdentities: { relation: string; profiles: { url: string }[]; reasons: { text: string }[]; addresses: { address: string; basis: string }[] }[];
}

type App = Awaited<ReturnType<typeof buildApp>>;

async function analyze(app: App, connectorIds: string[], set: string, variant: RunSummary['variant'], start: PublicAccount): Promise<RunSummary> {
  const identifiers = [{ type: 'nick', value: start.username }, ...(variant === 'nick+email' ? [{ type: 'email', value: start.email }] : [])];
  const errors: string[] = [];
  const began = performance.now();
  const created = await app.inject({ method: 'POST', url: '/api/cases', payload: { name: `${set}: ${start.id} (${variant})`, identifiers } });
  if (created.statusCode !== 201) throw new Error(`Nie udało się założyć sprawy dla ${start.id}: ${created.body}`);
  const ran = await app.inject({ method: 'POST', url: `/api/cases/${created.json().id}/runs`, payload: { connectors: connectorIds } });
  const analysisMs = performance.now() - began;
  if (ran.statusCode !== 201) throw new Error(`Analiza dla ${start.id} nie powiodła się: ${ran.body}`);
  const run = ran.json() as { id: string; status: string; log: { message: string }[] };
  for (const entry of run.log) if (/BŁĄD|Przekroczono limit czasu/.test(entry.message)) errors.push(entry.message);
  const queries = Number(/zapytań do łączników (\d+)/.exec(run.log.map((entry) => entry.message).join('\n'))?.[1] ?? 0);
  const dossierBegan = performance.now();
  const response = await app.inject(`/api/runs/${run.id}/dossier`);
  const dossierMs = performance.now() - dossierBegan;
  if (response.statusCode !== 200) throw new Error(`Teczka dla ${start.id} nie powstała: ${response.body}`);
  const dossier = response.json() as DossierLike;

  const cardAccount = new Map(dossier.profiles.map((card) => [card.id, accountOfUrl(card.url)]));
  const accountsOf = (profileIds: string[]) => [...new Set(profileIds.map((id) => cardAccount.get(id)).filter((value): value is string => Boolean(value)))];
  const main = dossier.persons[0];
  const identityAccounts = (relation: string) => [...new Set(dossier.linkedIdentities.filter((identity) => identity.relation === relation).flatMap((identity) => identity.profiles.map((profile) => accountOfUrl(profile.url))).filter((value): value is string => Boolean(value)))];
  const reasons: Record<string, string[]> = {};
  for (const identity of dossier.linkedIdentities) {
    for (const profile of identity.profiles) {
      const account = accountOfUrl(profile.url);
      if (account) reasons[account] = identity.reasons.map((reason) => reason.text);
    }
  }
  const identityReasons: Record<string, string[]> = {};
  for (const card of dossier.profiles) {
    const account = accountOfUrl(card.url);
    if (account) identityReasons[account] = card.identityReasons;
  }
  return {
    set,
    variant,
    startAccount: start.id,
    identifiers,
    status: run.status,
    partial: dossier.partial === true,
    analysisMs,
    dossierMs,
    connectorQueries: queries,
    mainProbability: main?.probability ?? 0,
    mainAccounts: main && main.probability > 0 ? accountsOf(main.profileIds) : [],
    sameLikelyAccounts: identityAccounts('same_person_likely'),
    possiblyAccounts: identityAccounts('possibly_same_or_close'),
    associatedAccounts: identityAccounts('associated'),
    otherCandidateAccounts: dossier.persons.slice(1).map((person) => accountsOf(person.profileIds)),
    reasons,
    identityReasons,
    findings: dossier.findings.map((finding) => ({
      address: finding.address,
      score: finding.confidence.score,
      excluded: finding.confidence.excluded,
      subjectProbability: finding.subjectProbability,
      unrelatedPublishers: finding.unrelatedPublishers,
      rules: finding.confidence.ledger.map((entry) => entry.rule),
      evidence: finding.evidence.length,
      transfers: finding.chain?.transfers.length ?? 0,
      addressClass: finding.chain?.profile.addressClass,
    })),
    sameLikelyAddresses: [...new Set(dossier.linkedIdentities.filter((identity) => identity.relation === 'same_person_likely').flatMap((identity) => identity.addresses.map((item) => item.address)))],
    errors,
  };
}

// ---------- Prawda wzorcowa (dopiero po analizach) ----------

interface GroundTruth {
  people: { id: string; walletAddresses?: string[] }[];
  accountLinks: { accountId: string; personId: string; role: string }[];
  scenarios: { id: string; query?: string; accountIds?: string[] }[];
  walletPostExamples?: { examples: { address: string; walletOwnerPersonId: string | null; addressUse: string }[] };
}

interface Counts {
  tp: number;
  fp: number;
  fn: number;
}
const emptyCounts = (): Counts => ({ tp: 0, fp: 0, fn: 0 });
const precisionOf = (counts: Counts) => ratio(counts.tp, counts.tp + counts.fp);
const recallOf = (counts: Counts) => ratio(counts.tp, counts.tp + counts.fn);
const mean = (values: number[]) => (values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length);
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

// ---------- Przebieg ----------

async function main() {
  const status = await getJson<{ meta: { seed: number; people: number }; counts: Record<string, number> }>('/api/status');
  const accounts: PublicAccount[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await getJson<{ total: number; accounts: PublicAccount[] }>(`/api/accounts?limit=1000&offset=${offset}`);
    accounts.push(...page.accounts);
    if (accounts.length >= page.total || page.accounts.length === 0) break;
  }
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const ordered = [...accounts].sort((a, b) => hashOrder(a.id).localeCompare(hashOrder(b.id)));

  // Punkty startowe — wyłącznie z danych publicznych.
  const sampleStarts = ordered.slice(0, SAMPLE_CANDIDATES);
  const publishers = new Map<string, PublicAccount[]>();
  for (const account of ordered) for (const address of account.walletAddresses) publishers.set(address, [...(publishers.get(address) ?? []), account]);
  const byPublishers = [...publishers.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  // Adres „szeroko publikowany”: zdecydowanie najczęściej podawany adres w zbiorze (kryterium publiczne).
  const widely = byPublishers[0] && byPublishers[0][1].length >= 2 * (byPublishers[1]?.[1].length ?? 0) && byPublishers[0][1].length >= 6 ? byPublishers[0] : undefined;
  const addressStarts = byPublishers.filter((entry) => entry !== widely).map(([, list]) => list[0]!);
  const trapStarts = widely ? widely[1] : [];
  const nickGroups = new Map<string, PublicAccount[]>();
  for (const account of ordered) nickGroups.set(handleKey(account.username), [...(nickGroups.get(handleKey(account.username)) ?? []), account]);
  const sharedNicks = [...nickGroups.entries()].filter(([, list]) => list.length >= 2).sort((a, b) => hashOrder(a[0]).localeCompare(hashOrder(b[0]))).slice(0, MAX_NICK_GROUPS);

  console.log(`Laboratorium ${LAB_URL}: seed ${status.meta.seed}, osób ${status.meta.people}, kont ${accounts.length}, adresów publicznych ${publishers.size}.`);
  console.log(`Punkty startowe: próba ${sampleStarts.length} kandydatów (×2 warianty), adresy ${addressStarts.length}, pułapka wspólnego adresu ${trapStarts.length}, wspólne nicki ${sharedNicks.length}.`);

  const storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const connectors = createConnectors({ labUrl: LAB_URL });
  const providers = createChainProviders({ labUrl: LAB_URL });
  const app = await buildApp({
    storage,
    connectors,
    chainProviders: providers,
    deepChainProviders: providers,
    resolveActivity: getActivityFromProviders,
    matchService,
    normalizeText: normalizeAddressText,
    ai: null,
  });
  const connectorIds = connectors.map((connector) => connector.id);

  phase = 'analysis';
  const runs: RunSummary[] = [];
  const plan: { set: string; variant: RunSummary['variant']; start: PublicAccount }[] = [
    ...sampleStarts.map((start) => ({ set: 'sample', variant: 'nick+email' as const, start })),
    ...sampleStarts.map((start) => ({ set: 'sample', variant: 'nick' as const, start })),
    ...addressStarts.map((start) => ({ set: 'address', variant: 'nick+email' as const, start })),
    ...trapStarts.map((start) => ({ set: 'trap', variant: 'nick+email' as const, start })),
    ...sharedNicks.map(([, list]) => ({ set: 'nick', variant: 'nick' as const, start: list[0]! })),
  ];
  const wallStarted = performance.now();
  for (const [index, item] of plan.entries()) {
    runs.push(await analyze(app, connectorIds, item.set, item.variant, item.start));
    if ((index + 1) % 25 === 0 || index + 1 === plan.length) console.log(`  analiz ${index + 1}/${plan.length} (${((performance.now() - wallStarted) / 1000).toFixed(0)} s)`);
  }
  await app.close();
  await storage.close();
  if (requests.forbiddenDuringAnalysis > 0 || requests.nonLab > 0) throw new Error('Naruszono zasady pomiaru: żądanie do zakazanej ścieżki albo poza laboratorium.');

  // ---------- Dopiero teraz: prawda wzorcowa ----------
  phase = 'scoring';
  const truth = await getJson<GroundTruth>('/api/ground-truth');
  const personOf = new Map(truth.accountLinks.map((link) => [link.accountId, link.personId]));
  const roleOf = new Map(truth.accountLinks.map((link) => [link.accountId, link.role]));
  const accountsOfPerson = new Map<string, string[]>();
  for (const link of truth.accountLinks) accountsOfPerson.set(link.personId, [...(accountsOfPerson.get(link.personId) ?? []), link.accountId]);
  const intermediary = new Set([
    ...truth.scenarios.filter((scenario) => scenario.id === 'shared-payment-address' && scenario.query).map((scenario) => scenario.query!),
    ...(truth.walletPostExamples?.examples ?? []).filter((example) => example.walletOwnerPersonId === null).map((example) => example.address),
  ]);
  const ownedBy = new Map<string, string[]>();
  for (const person of truth.people) ownedBy.set(person.id, (person.walletAddresses ?? []).filter((address) => !intermediary.has(address)));
  const ownerOf = new Map<string, string>();
  for (const [person, list] of ownedBy) for (const address of list) ownerOf.set(address, person);

  /** Pierwszy punkt startowy każdej osoby (w kolejności analiz) — żadna osoba nie liczy się dwa razy. */
  const distinctPersons = (list: RunSummary[], limit = Infinity): RunSummary[] => {
    const seen = new Set<string>();
    const kept: RunSummary[] = [];
    for (const run of list) {
      const person = personOf.get(run.startAccount)!;
      if (seen.has(person) || kept.length >= limit) continue;
      seen.add(person);
      kept.push(run);
    }
    return kept;
  };
  const of = (set: string, variant: RunSummary['variant']) => runs.filter((run) => run.set === set && run.variant === variant);
  const sampleFull = distinctPersons(of('sample', 'nick+email'), SAMPLE_PERSONS);
  const sampleIds = new Set(sampleFull.map((run) => run.startAccount));
  const sampleNick = of('sample', 'nick').filter((run) => sampleIds.has(run.startAccount));

  // ---------- (a) Łączenie kont ----------
  type Predictor = (run: RunSummary) => string[];
  const mainOnly: Predictor = (run) => run.mainAccounts;
  const mainAndSame: Predictor = (run) => [...new Set([...run.mainAccounts, ...run.sameLikelyAccounts])];

  function linking(list: RunSummary[], predict: Predictor) {
    const micro = emptyCounts();
    const others = emptyCounts();
    const perRun: { precision?: number; recall: number; f1: number }[] = [];
    const byRole = new Map<string, { found: number; total: number }>();
    let empty = 0;
    let seedMissing = 0;
    for (const run of list) {
      const person = personOf.get(run.startAccount)!;
      const truthSet = new Set(accountsOfPerson.get(person));
      const predicted = new Set(predict(run));
      const tp = [...predicted].filter((account) => truthSet.has(account)).length;
      const fp = predicted.size - tp;
      const fn = truthSet.size - tp;
      micro.tp += tp;
      micro.fp += fp;
      micro.fn += fn;
      // Bez konta startowego: ile POZOSTAŁYCH kont osoby udało się dołączyć.
      const seedHit = predicted.has(run.startAccount) ? 1 : 0;
      others.tp += tp - seedHit;
      others.fp += fp;
      others.fn += truthSet.size - 1 - (tp - seedHit);
      if (predicted.size === 0) empty++;
      if (!seedHit) seedMissing++;
      const precision = ratio(tp, predicted.size);
      const recall = tp / truthSet.size;
      perRun.push({ ...(precision !== undefined ? { precision } : {}), recall, f1: f1Of(precision ?? 0, recall) ?? 0 });
      for (const account of truthSet) {
        if (account === run.startAccount) continue;
        const role = roleOf.get(account) ?? '?';
        const entry = byRole.get(role) ?? { found: 0, total: 0 };
        entry.total++;
        if (predicted.has(account)) entry.found++;
        byRole.set(role, entry);
      }
    }
    return {
      runs: list.length,
      micro,
      microPrecision: precisionOf(micro),
      microRecall: recallOf(micro),
      microF1: f1Of(precisionOf(micro), recallOf(micro)),
      macroPrecision: mean(perRun.filter((item) => item.precision !== undefined).map((item) => item.precision!)),
      macroRecall: mean(perRun.map((item) => item.recall)),
      macroF1: mean(perRun.map((item) => item.f1)),
      othersPrecision: precisionOf(others),
      othersRecall: recallOf(others),
      others,
      empty,
      seedMissing,
      byRole: Object.fromEntries(byRole),
    };
  }

  const linkingRows = [
    { label: 'Próba główna, start: nick + e-mail — osoba główna + „prawdopodobnie ta sama osoba”', result: linking(sampleFull, mainAndSame) },
    { label: 'Próba główna, start: nick + e-mail — tylko profile osoby głównej', result: linking(sampleFull, mainOnly) },
    { label: 'Próba główna, start: sam nick — osoba główna + „prawdopodobnie ta sama osoba”', result: linking(sampleNick, mainAndSame) },
    { label: 'Próba główna, start: sam nick — tylko profile osoby głównej', result: linking(sampleNick, mainOnly) },
  ];

  // ---------- Przyczyny błędów łączenia (z danych publicznych i wzorca) ----------
  const CUE_TEXT: Record<string, string> = {
    same_email: 'ten sam e-mail (pole konta lub opis) co inne konto tej osoby',
    email_variant: 'wariant tego samego e-maila (dopisek „+…”, kropki) — narzędzie porównuje e-maile dosłownie',
    same_handle: 'ten sam nick co inne konto tej osoby — sam nick nie wystarcza do połączenia (waga 20 < próg 50)',
    handle_variant: 'wariant nicku (inne separatory: „.”, „_”, „-”) — narzędzie nie zna wariantów nicków',
    bio_alias: 'opis wskazuje wprost inne konto („piszę jako …”, „dawniej …”) — łącznik i reguły nie czytają takich wskazań',
    name_location: 'ta sama nazwa wyświetlana i miejscowość — w regułach to za mało (nazwa 15, brak wagi za miejscowość)',
    name_only: 'tylko ta sama nazwa wyświetlana',
    location_only: 'tylko ta sama miejscowość',
    none: 'brak publicznej cechy wspólnej z innymi kontami osoby (np. konto pod przybraną tożsamością)',
  };
  const CUE_ORDER = Object.keys(CUE_TEXT);
  const mentions = (bio: string, handle: string) => handle.length >= 4 && new RegExp(`(?<![A-Za-z0-9_.@-])${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i').test(bio);
  function cueBetween(a: PublicAccount, b: PublicAccount): string {
    const [ea, eb] = [emailsOf(a), emailsOf(b)];
    if (ea.some((email) => eb.includes(email))) return 'same_email';
    if (ea.some((email) => eb.map(emailVariant).includes(emailVariant(email)))) return 'email_variant';
    if (handleKey(a.username) === handleKey(b.username)) return 'same_handle';
    if (handleVariant(a.username) === handleVariant(b.username)) return 'handle_variant';
    if (mentions(a.bio, b.username) || mentions(b.bio, a.username)) return 'bio_alias';
    const sameName = fold(a.displayName) === fold(b.displayName);
    const sameLocation = fold(a.location) === fold(b.location);
    if (sameName && sameLocation) return 'name_location';
    if (sameName) return 'name_only';
    if (sameLocation) return 'location_only';
    return 'none';
  }
  /** Najmocniejsza publiczna cecha łącząca konto z kontami ze zbioru; `partner` to konto, z którym ją dzieli. */
  function bestCue(account: PublicAccount, candidates: string[]): { cue: string; partner?: PublicAccount } {
    let best: { cue: string; partner?: PublicAccount } = { cue: 'none' };
    for (const id of candidates) {
      const other = byId.get(id);
      if (!other || other.id === account.id) continue;
      const cue = cueBetween(account, other);
      if (CUE_ORDER.indexOf(cue) < CUE_ORDER.indexOf(best.cue)) best = { cue, partner: other };
    }
    return best;
  }
  const describe = (account: PublicAccount | undefined) => (account ? `${account.id} (@${account.username}, ${account.serviceId}, „${account.displayName}”)` : '?');

  interface ErrorExample {
    start: string;
    account: string;
    role: string;
    cue: string;
    partner?: string;
    partnerFound?: boolean;
    detail: string;
  }
  function linkingErrors(list: RunSummary[], predict: Predictor) {
    const missed = new Map<string, ErrorExample[]>();
    const extra = new Map<string, ErrorExample[]>();
    for (const run of list) {
      const person = personOf.get(run.startAccount)!;
      const truthSet = accountsOfPerson.get(person)!;
      const predicted = new Set(predict(run));
      for (const id of truthSet) {
        if (predicted.has(id)) continue;
        const account = byId.get(id)!;
        // Najpierw cecha wspólna z kontem, które narzędzie już miało; dopiero potem z dowolnym kontem osoby.
        const found = bestCue(account, [...predicted].filter((item) => truthSet.includes(item)));
        const any = bestCue(account, truthSet);
        const chosen = CUE_ORDER.indexOf(found.cue) <= CUE_ORDER.indexOf(any.cue) ? { ...found, partnerFound: found.partner !== undefined } : { ...any, partnerFound: false };
        const key = `${chosen.cue}${chosen.partner && !chosen.partnerFound ? ' (z kontem, którego narzędzie też nie znalazło)' : ''}`;
        missed.set(key, [
          ...(missed.get(key) ?? []),
          {
            start: describe(byId.get(run.startAccount)),
            account: describe(account),
            role: roleOf.get(id) ?? '?',
            cue: chosen.cue,
            ...(chosen.partner ? { partner: describe(chosen.partner), partnerFound: chosen.partnerFound } : {}),
            detail: `e-maile konta: ${emailsOf(account).join(', ')}${chosen.partner ? `; e-maile konta wspólnego: ${emailsOf(chosen.partner).join(', ')}` : ''}; opis: „${account.bio.slice(0, 160)}”`,
          },
        ]);
      }
      for (const id of predicted) {
        if (truthSet.includes(id)) continue;
        const account = byId.get(id)!;
        const { cue, partner } = bestCue(account, [...predicted].filter((item) => truthSet.includes(item)));
        const sharedWallet = partner ? account.walletAddresses.filter((address) => partner.walletAddresses.includes(address)) : [];
        const anyShared = account.walletAddresses.filter((address) => [...predicted].some((item) => item !== id && truthSet.includes(item) && byId.get(item)!.walletAddresses.includes(address)));
        const key = anyShared.length > 0 ? `wspólny adres (${anyShared.some((address) => intermediary.has(address)) ? 'pośrednika' : 'innej osoby'})` : cue;
        const toolReasons = [...(run.reasons[id] ?? []), ...(run.identityReasons[id] ?? [])].slice(0, 3).join(' | ');
        extra.set(key, [
          ...(extra.get(key) ?? []),
          {
            start: describe(byId.get(run.startAccount)),
            account: describe(account),
            role: roleOf.get(id) ?? '?',
            cue,
            ...(partner ? { partner: describe(partner) } : {}),
            detail: `przesłanka narzędzia: ${toolReasons || 'brak opisu'}${sharedWallet.length > 0 ? `; wspólny adres ${sharedWallet[0]}` : ''}`,
          },
        ]);
      }
    }
    return { missed, extra };
  }
  const errorsFull = linkingErrors(sampleFull, mainAndSame);
  const errorsNick = linkingErrors(sampleNick, mainAndSame);

  // ---------- (b) Adresy ----------
  type Scorer = (finding: FindingSummary) => number;
  const byConfidence: Scorer = (finding) => (finding.excluded ? -1 : finding.score);
  const bySubject: Scorer = (finding) => (finding.excluded ? -1 : finding.subjectProbability);
  function addressMetrics(list: RunSummary[], scorer: Scorer, threshold: number) {
    const counts = emptyCounts();
    let fpIntermediary = 0;
    let fpOtherPerson = 0;
    const examples: string[] = [];
    for (const run of list) {
      const person = personOf.get(run.startAccount)!;
      const owned = new Set(ownedBy.get(person) ?? []);
      const predicted = new Set(run.findings.filter((finding) => finding.evidence > 0 && scorer(finding) >= threshold).map((finding) => finding.address));
      for (const address of predicted) {
        if (owned.has(address)) counts.tp++;
        else {
          counts.fp++;
          if (intermediary.has(address)) fpIntermediary++;
          else fpOtherPerson++;
          const finding = run.findings.find((item) => item.address === address)!;
          examples.push(`start ${describe(byId.get(run.startAccount))}: adres ${address} (${intermediary.has(address) ? 'pośrednik' : `właściciel: ${ownerOf.get(address) ?? 'nieznany'}`}), wynik ${finding.score}, niepowiązanych publikujących ${finding.unrelatedPublishers}, reguły: ${finding.rules.join(' → ')}`);
        }
      }
      for (const address of owned) {
        if (predicted.has(address)) continue;
        counts.fn++;
        const finding = run.findings.find((item) => item.address === address);
        examples.push(`start ${describe(byId.get(run.startAccount))}: POMINIĘTY adres własny ${address} — ${finding ? `wynik ${finding.score}${finding.excluded ? ' (wykluczony)' : ''}, śladów ${finding.evidence}, niepowiązanych publikujących ${finding.unrelatedPublishers}, reguły: ${finding.rules.join(' → ')}` : 'adres nie pojawił się w teczce (narzędzie nie dotarło do konta, które go publikuje)'}`);
      }
    }
    return { runs: list.length, counts, precision: precisionOf(counts), recall: recallOf(counts), f1: f1Of(precisionOf(counts), recallOf(counts)), fpIntermediary, fpOtherPerson, examples };
  }
  const addressSet = distinctPersons(of('address', 'nick+email'));
  const combined = distinctPersons([...of('address', 'nick+email'), ...sampleFull]);
  const withWallet = (list: RunSummary[]) => list.filter((run) => (ownedBy.get(personOf.get(run.startAccount)!) ?? []).length > 0).length;

  // ---------- Pułapka wspólnego adresu pośrednika ----------
  const trapRuns = distinctPersons(of('trap', 'nick+email'));
  const trapAddress = widely?.[0];
  const trapIsIntermediary = trapAddress !== undefined && intermediary.has(trapAddress);
  const trap = trapRuns.map((run) => {
    const person = personOf.get(run.startAccount)!;
    const truthSet = new Set(accountsOfPerson.get(person));
    const finding = run.findings.find((item) => item.address === trapAddress);
    const predicted = mainAndSame(run);
    return {
      run,
      finding,
      foreignMain: run.mainAccounts.filter((account) => !truthSet.has(account)),
      foreignSame: run.sameLikelyAccounts.filter((account) => !truthSet.has(account)),
      foreignPossibly: run.possiblyAccounts.filter((account) => !truthSet.has(account)),
      linkPrecision: ratio(predicted.filter((account) => truthSet.has(account)).length, predicted.length),
      ownAddressKept: (ownedBy.get(person) ?? []).map((address) => run.findings.find((item) => item.address === address)).filter((item): item is FindingSummary => item !== undefined),
    };
  });

  // ---------- Pułapka tego samego nicku ----------
  const nickRuns = of('nick', 'nick').map((run) => {
    const group = nickGroups.get(handleKey(byId.get(run.startAccount)!.username))!;
    const persons = new Set(group.map((account) => personOf.get(account.id)!));
    const mainPersons = new Map<string, number>();
    for (const account of run.mainAccounts) mainPersons.set(personOf.get(account)!, (mainPersons.get(personOf.get(account)!) ?? 0) + 1);
    const majority = [...mainPersons.entries()].sort((a, b) => b[1] - a[1])[0];
    const sameCross = run.sameLikelyAccounts.filter((account) => majority && personOf.get(account) !== majority[0]);
    const covered = new Set([...run.mainAccounts, ...run.sameLikelyAccounts]);
    return {
      run,
      nick: byId.get(run.startAccount)!.username,
      group,
      crossPerson: persons.size > 1,
      persons: persons.size,
      mainPersons: mainPersons.size,
      purity: ratio(majority?.[1] ?? 0, run.mainAccounts.length),
      sameCross,
      groupCovered: group.filter((account) => covered.has(account.id)).length,
      mainHasGroupAccounts: group.filter((account) => run.mainAccounts.includes(account.id)).length,
    };
  });
  const crossNick = nickRuns.filter((item) => item.crossPerson);
  const sameNick = nickRuns.filter((item) => !item.crossPerson);

  // ---------- (c) Czas ----------
  const times = runs.map((run) => run.analysisMs);
  const dossierTimes = runs.map((run) => run.dossierMs);
  const timeBySet = (list: RunSummary[]) => ({ n: list.length, mean: mean(list.map((run) => run.analysisMs)) ?? 0, median: quantile(list.map((run) => run.analysisMs), 0.5), p95: quantile(list.map((run) => run.analysisMs), 0.95), max: Math.max(0, ...list.map((run) => run.analysisMs)) });
  const failed = runs.filter((run) => run.status !== 'completed' || run.partial);
  const withErrors = runs.filter((run) => run.errors.length > 0);

  // ---------- Raport ----------
  const lines: string[] = [];
  const out = (text = '') => lines.push(text);
  const table = (header: string[], rows: (string | number)[][]) => {
    out(`| ${header.join(' | ')} |`);
    out(`|${header.map(() => '---').join('|')}|`);
    for (const row of rows) out(`| ${row.join(' | ')} |`);
    out();
  };
  const sampleRoles = sampleFull.reduce<Record<string, number>>((acc, run) => {
    const role = roleOf.get(run.startAccount) ?? '?';
    acc[role] = (acc[role] ?? 0) + 1;
    return acc;
  }, {});
  const truthSizes = sampleFull.map((run) => accountsOfPerson.get(personOf.get(run.startAccount)!)!.length);

  out('# Pomiar OŁCyŚ na laboratorium tożsamości (identity-lab)');
  out();
  out(`Wygenerowano: ${new Date().toISOString()} poleceniem \`node scripts/benchmark-lab.ts\`. Plik powstaje automatycznie — liczby i przykłady pochodzą z jednego przebiegu.`);
  out();
  out('## Co i jak zmierzono');
  out();
  out(`- **Zbiór:** \`apps/identity-lab\`, seed ${status.meta.seed}, ${status.meta.people} syntetycznych osób, ${accounts.length} kont w 27 fikcyjnych portalach, ${status.counts.posts} wpisów, ${status.counts.listings} ofert, ${status.counts.threads} wątków (w tym kohorta 200 postów ujawniających adresy — dane zaimportowane dokumentowanym poleceniem \`npm run wallet-posts -- --apply\`), testowy łańcuch LAB z ${publishers.size} publicznie podanymi adresami \`lab1…\`.`);
  out('- **Narzędzie:** nasz kod bez zmian reguł — `buildApp` z `apps/api/src/app.ts` wywoływany przez `app.inject`, baza PGlite w pamięci, wyłącznie łączniki `lab-*` (`packages/sources/src/lab.ts`) i dostawca sieci laboratoryjnej (`packages/chain/src/providers/lab.ts`); tryb standardowy, bez internetu, bez modelu językowego.');
  out('- **Dostęp do danych:** łączniki czytają tylko publiczne API laboratorium (`/api/accounts`, `/api/accounts/:id`, `/api/portal/:slug`, `/api/blockchain`). Nie używają `/api/search` (zwraca hipotezy silnika laboratorium), `/api/resolve`, `/api/evaluate` ani eksportów.');
  out(`- **Kolejność:** punkty startowe wybrano deterministycznie z danych publicznych (kolejność wg SHA-256 identyfikatora konta), wykonano wszystkie analizy, a dopiero potem pobrano \`/api/ground-truth\`. Strażnik na \`fetch\` przerwałby skrypt przy wcześniejszym odczycie; żądań do laboratorium w fazie analiz: ${requests.analysis}, do ścieżek zakazanych: ${requests.forbiddenDuringAnalysis}, poza laboratorium: ${requests.nonLab}.`);
  out(`- **Próba główna:** ${sampleFull.length} punktów startowych = pierwsze ${sampleFull.length} RÓŻNYCH osób wśród ${sampleStarts.length} wylosowanych kont (po jednym koncie na osobę; role kont startowych: ${Object.entries(sampleRoles).map(([role, count]) => `${role} ${count}`).join(', ')}). Osoby z próby mają od ${Math.min(...truthSizes)} do ${Math.max(...truthSizes)} kont (średnio ${num(mean(truthSizes) ?? 0, 1)}).`);
  out('- **Identyfikatory startowe:** wariant „nick + e-mail” (nick i publiczny e-mail konta startowego) oraz wariant „sam nick”.');
  out('- **Łączenie kont:** konta przypisane osobie = profile osoby głównej w teczce + profile powiązanych tożsamości z relacją „prawdopodobnie ta sama osoba”; wzorzec = wszystkie konta tej osoby (także dodatkowe `multi` i pod przybraną tożsamością `fake`). Mikro: suma TP/FP/FN po punktach startowych; makro: średnia wartości z punktów startowych.');
  out('- **Adresy:** adres uznajemy za przypisany osobie, gdy Wskaźnik Pewności w teczce (względem osoby głównej, adres niewykluczony) osiąga próg. Wzorzec = adresy portfeli należących do osoby; adres pośrednika nie należy do nikogo z publikujących.');
  out();

  out('## (a) Łączenie kont tej samej osoby');
  out();
  table(
    ['Wariant', 'Punkty', 'Precision mikro', 'Recall mikro', 'F1 mikro', 'Precision makro', 'Recall makro', 'F1 makro', 'TP / FP / FN'],
    linkingRows.map(({ label, result }) => [label, result.runs, pct(result.microPrecision), pct(result.microRecall), pct(result.microF1), pct(result.macroPrecision), pct(result.macroRecall), pct(result.macroF1), `${result.micro.tp} / ${result.micro.fp} / ${result.micro.fn}`]),
  );
  out('Konto startowe jest zawsze znane, więc zawyża recall. Ta sama ocena **bez konta startowego** (ile POZOSTAŁYCH kont osoby narzędzie dołączyło):');
  out();
  table(
    ['Wariant', 'Precision', 'Recall', 'Dołączone / błędnie dołączone / pominięte', 'Recall wg roli konta (ordinary / multi / fake)', 'Analizy bez osoby głównej', 'Konto startowe poza wynikiem'],
    linkingRows.map(({ label, result }) => [
      label,
      pct(result.othersPrecision),
      pct(result.othersRecall),
      `${result.others.tp} / ${result.others.fp} / ${result.others.fn}`,
      ['ordinary', 'multi', 'fake'].map((role) => (result.byRole[role] ? `${result.byRole[role]!.found}/${result.byRole[role]!.total}` : '—')).join(' · '),
      result.empty,
      result.seedMissing,
    ]),
  );

  const errorTable = (title: string, groups: Map<string, ErrorExample[]>, total: number) => {
    out(`**${title}** (łącznie ${total}):`);
    out();
    table(
      ['Publiczna cecha łącząca konto z osobą', 'Liczba', 'Znaczenie'],
      [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, list]) => [key, list.length, CUE_TEXT[list[0]!.cue] ?? key]),
    );
  };
  out('### Dlaczego konta zostały pominięte albo błędnie dołączone (wariant nick + e-mail)');
  out();
  errorTable('Konta pominięte', errorsFull.missed, [...errorsFull.missed.values()].reduce((sum, list) => sum + list.length, 0));
  errorTable('Konta błędnie dołączone', errorsFull.extra, [...errorsFull.extra.values()].reduce((sum, list) => sum + list.length, 0));
  out('### To samo dla wariantu „sam nick”');
  out();
  errorTable('Konta pominięte', errorsNick.missed, [...errorsNick.missed.values()].reduce((sum, list) => sum + list.length, 0));
  errorTable('Konta błędnie dołączone', errorsNick.extra, [...errorsNick.extra.values()].reduce((sum, list) => sum + list.length, 0));

  out('## (b) Przypisanie adresów do osoby');
  out();
  out(`Zbiory punktów startowych: **adresowy** — po jednym koncie na każdy publicznie podany adres (bez adresu szeroko publikowanego), ${addressSet.length} różnych osób, z czego ${withWallet(addressSet)} ma własny portfel; **próba główna** — ${sampleFull.length} osób, z czego ${withWallet(sampleFull)} ma własny portfel; **łącznie** — oba zbiory bez powtórzeń osób (${combined.length} osób, ${withWallet(combined)} z portfelem). Wariant startu: nick + e-mail.`);
  out();
  const addressRows: (string | number)[][] = [];
  for (const [label, list] of [['Zbiór adresowy', addressSet], ['Próba główna', sampleFull], ['Łącznie', combined]] as const) {
    for (const threshold of THRESHOLDS) {
      const result = addressMetrics(list, byConfidence, threshold);
      addressRows.push([label, `≥ ${threshold}`, pct(result.precision), pct(result.recall), pct(result.f1), `${result.counts.tp} / ${result.counts.fp} / ${result.counts.fn}`, result.fpIntermediary, result.fpOtherPerson]);
    }
  }
  table(['Zbiór', 'Próg Wskaźnika Pewności', 'Precision', 'Recall', 'F1', 'TP / FP / FN', 'FP: adres pośrednika', 'FP: adres innej osoby'], addressRows);
  out('Dla porównania — ten sam pomiar z progiem na **łącznym prawdopodobieństwie osoba–adres** (`subjectProbability` = prawdopodobieństwo osoby głównej × prawdopodobieństwo adresu u tej osoby):');
  out();
  table(
    ['Zbiór', 'Próg', 'Precision', 'Recall', 'F1', 'TP / FP / FN'],
    THRESHOLDS.map((threshold) => {
      const result = addressMetrics(combined, bySubject, threshold);
      return ['Łącznie', `≥ ${threshold}`, pct(result.precision), pct(result.recall), pct(result.f1), `${result.counts.tp} / ${result.counts.fp} / ${result.counts.fn}`];
    }),
  );
  const chainSeen = combined.flatMap((run) => run.findings).filter((finding) => finding.evidence > 0);
  out(`Aktywność w łańcuchu LAB: dla ${chainSeen.filter((finding) => finding.addressClass !== undefined).length} z ${chainSeen.length} adresów w teczkach dostawca zwrócił profil (saldo, przelewy); ${chainSeen.filter((finding) => finding.transfers > 0).length} ma co najmniej jeden przelew między adresami. Token LAB nie ma wartości — żadnej kwoty nie wyceniono w PLN.`);
  out();

  out('### Pułapka: wspólny adres pośrednika (zbiórka)');
  out();
  if (!trapAddress) out('W danych publicznych nie ma adresu wyraźnie częściej publikowanego niż pozostałe — pułapki nie mierzono.');
  else {
    out(`Adres \`${trapAddress}\` publikuje ${widely![1].length} kont (${new Set(widely![1].map((account) => personOf.get(account.id))).size} różnych osób); we wzorcu ${trapIsIntermediary ? 'to adres pośrednika — nie należy do żadnej z publikujących osób' : 'NIE jest oznaczony jako adres pośrednika (sprawdź zbiór)'}. Analizę uruchomiono dla każdej publikującej osoby (${trapRuns.length} punktów startowych, nick + e-mail).`);
    out();
    table(
      ['Próg Wskaźnika Pewności', 'Analizy, w których adres pośrednika przypisano osobie', 'Odsetek'],
      THRESHOLDS.map((threshold) => {
        const hits = trap.filter((item) => item.finding && item.finding.evidence > 0 && !item.finding.excluded && item.finding.score >= threshold).length;
        return [`≥ ${threshold}`, `${hits} / ${trap.length}`, pct(ratio(hits, trap.length))];
      }),
    );
    const scores = trap.map((item) => item.finding).filter((item): item is FindingSummary => item !== undefined);
    const scoreGroups = new Map<string, number>();
    for (const finding of scores) {
      const key = `${finding.excluded ? 'wykluczony' : `wynik ${finding.score}`}; niepowiązanych publikujących ${finding.unrelatedPublishers}; reguły: ${finding.rules.join(' → ') || '—'}`;
      scoreGroups.set(key, (scoreGroups.get(key) ?? 0) + 1);
    }
    out('Jak narzędzie oceniło adres pośrednika:');
    out();
    for (const [key, count] of [...scoreGroups.entries()].sort((a, b) => b[1] - a[1])) out(`- ${count}× ${key}`);
    if (scores.length < trap.length) out(`- ${trap.length - scores.length}× adres nie pojawił się w teczce`);
    out();
    const foreignSame = trap.filter((item) => item.foreignSame.length > 0).length;
    const foreignMain = trap.filter((item) => item.foreignMain.length > 0).length;
    const foreignPossibly = trap.filter((item) => item.foreignPossibly.length > 0).length;
    out(`Czy wspólny adres skleił różne osoby: w ${foreignMain} z ${trap.length} analiz do osoby głównej trafiło cudze konto, w ${foreignSame} analizach cudze konto dostało relację „prawdopodobnie ta sama osoba”, w ${foreignPossibly} — „możliwe: ta sama osoba albo bliska”. Precision łączenia kont w tym zbiorze (mikro): ${pct(linking(trapRuns, mainAndSame).microPrecision)}, recall: ${pct(linking(trapRuns, mainAndSame).microRecall)}.`);
    out();
    const ownKept = trap.flatMap((item) => item.ownAddressKept);
    out(`Własne adresy tych samych osób (prawdziwie należące do nich): ${ownKept.filter((finding) => !finding.excluded && finding.score >= 60).length} z ${trap.reduce((sum, item) => sum + (ownedBy.get(personOf.get(item.run.startAccount)!) ?? []).length, 0)} przypisano przy progu 60.`);
    out();
  }

  out('### Pułapka: ten sam nick u różnych osób');
  out();
  out(`W danych publicznych ${[...nickGroups.values()].filter((list) => list.length >= 2).length} nicków występuje na co najmniej dwóch kontach; przeanalizowano ${nickRuns.length} (start: sam nick). Według wzorca ${crossNick.length} z nich należy do RÓŻNYCH osób (pułapka), a ${sameNick.length} to konta jednej osoby (kontrola).`);
  out();
  const crossMerged = crossNick.filter((item) => item.mainPersons > 1);
  const crossSame = crossNick.filter((item) => item.sameCross.length > 0);
  table(
    ['Miara', 'Wynik'],
    [
      ['Nicki różnych osób: osoba główna zawiera konta więcej niż jednej osoby (błędne sklejenie)', `${crossMerged.length} / ${crossNick.length} (${pct(ratio(crossMerged.length, crossNick.length))})`],
      ['Nicki różnych osób: cudze konto z relacją „prawdopodobnie ta sama osoba”', `${crossSame.length} / ${crossNick.length} (${pct(ratio(crossSame.length, crossNick.length))})`],
      ['Nicki różnych osób: średnia czystość osoby głównej (udział kont osoby dominującej)', pct(mean(crossNick.map((item) => item.purity).filter((value): value is number => value !== undefined)))],
      ['Nicki różnych osób: prawdopodobieństwo osoby głównej (średnio)', num(mean(crossNick.map((item) => item.run.mainProbability)) ?? 0, 1)],
      ['Nicki jednej osoby (kontrola): wszystkie konta z tym nickiem uznane za jedną osobę', `${sameNick.filter((item) => item.groupCovered === item.group.length).length} / ${sameNick.length} (${pct(ratio(sameNick.filter((item) => item.groupCovered === item.group.length).length, sameNick.length))})`],
      ['Nicki jednej osoby (kontrola): prawdopodobieństwo osoby głównej (średnio)', num(mean(sameNick.map((item) => item.run.mainProbability)) ?? 0, 1)],
    ],
  );
  const crossAddress = crossNick.flatMap((item) => {
    const persons = new Set(item.run.mainAccounts.map((account) => personOf.get(account)));
    return item.run.findings.filter((finding) => finding.evidence > 0 && !finding.excluded && finding.score >= 60 && !persons.has(ownerOf.get(finding.address)));
  });
  out(`Adresy w analizach nicków różnych osób: ${crossAddress.length} adresów z wynikiem ≥ 60 nie należy do żadnej osoby, której konta są w osobie głównej.`);
  out();

  out('## (c) Czas analizy');
  out();
  const timeRows = [
    ['Wszystkie analizy', timeBySet(runs)],
    ['Próba główna, nick + e-mail', timeBySet(sampleFull)],
    ['Próba główna, sam nick', timeBySet(sampleNick)],
    ['Zbiór adresowy', timeBySet(of('address', 'nick+email'))],
    ['Pułapka wspólnego adresu', timeBySet(of('trap', 'nick+email'))],
    ['Pułapka nicku', timeBySet(of('nick', 'nick'))],
  ] as const;
  table(['Zbiór', 'Analiz', 'Średnio', 'Mediana', 'P95', 'Maks.'], timeRows.map(([label, item]) => [label, item.n, `${num(item.mean / 1000, 2)} s`, `${num(item.median / 1000, 2)} s`, `${num(item.p95 / 1000, 2)} s`, `${num(item.max / 1000, 2)} s`]));
  out(`Czas obejmuje założenie sprawy i całą analizę (wyszukiwanie w 27 portalach, wystąpienia adresów, łańcuch LAB, rozszerzanie, ocena, zapis); złożenie teczki to dodatkowo średnio ${num((mean(dossierTimes) ?? 0) / 1000, 2)} s. Średnio ${num(mean(runs.map((run) => run.connectorQueries)) ?? 0, 0)} zapytań do łączników na analizę. Laboratorium działa na tej samej maszynie, więc czas nie zawiera opóźnień sieci ani limitów prawdziwych serwisów. Analizy nieukończone lub częściowe: ${failed.length}; analizy z błędem łącznika lub dostawcy w dzienniku: ${withErrors.length}.`);
  out();

  // ---------- Przykłady błędów ----------
  out('## Przykłady błędów (konkretne konta)');
  out();
  const exampleLines: string[] = [];
  const pushExamples = (kind: string, groups: Map<string, ErrorExample[]>, perGroup: number) => {
    for (const [key, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      for (const example of list.slice(0, perGroup)) {
        exampleLines.push(
          `**${kind} — ${key}.** Start: ${example.start}. Konto: ${example.account}, rola we wzorcu: \`${example.role}\`.` +
            `${example.partner ? ` Cecha wspólna z kontem ${example.partner}${example.partnerFound === false ? ' (też nieznalezionym)' : ''}.` : ''} Zawiodła przesłanka: ${CUE_TEXT[example.cue] ?? key}. Szczegóły: ${example.detail}`,
        );
      }
    }
  };
  pushExamples('Pominięte konto', errorsFull.missed, 1);
  pushExamples('Błędnie dołączone konto', errorsFull.extra, 2);
  pushExamples('Błędnie dołączone konto (start: sam nick)', errorsNick.extra, 1);
  for (const item of crossMerged.slice(0, 2)) {
    exampleLines.push(`**Ten sam nick, różne osoby — sklejone.** Nick „${item.nick}” mają konta ${item.group.map((account) => describe(account)).join(' oraz ')} (${item.persons} różne osoby). Osoba główna w teczce zawiera konta ${item.mainPersons} osób: ${item.run.mainAccounts.join(', ')}.`);
  }
  for (const item of crossNick.filter((entry) => entry.mainPersons <= 1).slice(0, 1)) {
    exampleLines.push(`**Ten sam nick, różne osoby — rozdzielone poprawnie.** Nick „${item.nick}”: konta ${item.group.map((account) => describe(account)).join(' oraz ')}; osoba główna (prawdopodobieństwo ${item.run.mainProbability}) zawiera konta tylko jednej osoby: ${item.run.mainAccounts.join(', ') || '—'}; pozostali kandydaci: ${item.run.otherCandidateAccounts.map((list) => `[${list.join(', ')}]`).join(' ') || '—'}.`);
  }
  const addressErrors = addressMetrics(combined, byConfidence, 60).examples;
  for (const example of addressErrors.slice(0, 4)) exampleLines.push(`**Adres (próg 60).** ${example}`);
  const trapExample = trap.find((item) => item.finding && !item.finding.excluded && item.finding.score >= 40) ?? trap[0];
  if (trapExample?.finding) {
    exampleLines.push(`**Adres pośrednika.** Start ${describe(byId.get(trapExample.run.startAccount))}: adres \`${trapExample.finding.address}\` dostał ${trapExample.finding.excluded ? 'wykluczenie' : `wynik ${trapExample.finding.score}`} (niepowiązanych publikujących ${trapExample.finding.unrelatedPublishers}; reguły: ${trapExample.finding.rules.join(' → ')}).`);
  }
  exampleLines.forEach((line, index) => out(`${index + 1}. ${line}`));
  out();

  out('## Ograniczenia pomiaru');
  out();
  out('- **Zbiór jest syntetyczny.** Osoby, konta, treści i adresy wygenerował program; nie ma tu ani jednego prawdziwego konta. Nazwy portali nawiązują do znanych serwisów, ale to lokalne symulacje.');
  out('- **Rozkład cech jest zaprojektowany.** Generator sam decyduje, jak często konta jednej osoby dzielą e-mail, wariant nicku czy opis; w szczególności e-mail konta jest tu publiczny, czego w prawdziwych serwisach zwykle nie ma. Wynik zależy od tych decyzji bardziej niż od jakości narzędzia.');
  out('- **Wynik nie dowodzi jakości na rzeczywistych danych.** To test techniczny integracji i reguł w kontrolowanych warunkach, nie walidacja skuteczności w prawdziwym internecie.');
  out(`- **Mała próba.** ${sampleFull.length} osób w próbie głównej i ${withWallet(combined)} osób z portfelem — pojedyncze przypadki przesuwają wyniki o kilka punktów procentowych; nie liczono przedziałów ufności.`);
  out('- **Jeden seed, jeden przebieg.** Inny seed laboratorium da inne liczby. Kolejność punktów startowych jest deterministyczna, więc powtórzenie na tym samym zbiorze daje ten sam wynik.');
  out('- **Punkt startowy to konto z danymi kontaktowymi.** Wariant „nick + e-mail” zakłada, że analityk zna e-mail osoby; wariant „sam nick” pokazuje wynik bez tej wiedzy.');
  out('- **Adresy `lab1…` nie mają sumy kontrolnej**, a łańcuch LAB ma 30 portfeli i kilkadziesiąt przelewów — z pomiaru nie wynika nic o śledzeniu środków, wypłatach ani wycenie (token LAB nie ma wartości; dostawca nie wycenia go w PLN).');
  out('- **Reguł nie strojono pod zbiór.** Poprawiano wyłącznie integrację (łączniki, dostawca sieci laboratoryjnej); błędy wynikające z reguł są opisane wyżej jako rekomendacje, bez zmian w kodzie oceny.');
  out('- **Łącznik nie czyta wszystkiego.** Odpowiedzi konta w cudzych wątkach są pobierane tylko przy wyszukiwaniu adresu; `/api/search` laboratorium jest celowo pominięte.');
  out();

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${lines.join('\n')}\n`, 'utf8');
  if (JSON_FILE) {
    writeFileSync(
      JSON_FILE,
      JSON.stringify(
        {
          runs,
          truth: { personOf: Object.fromEntries(personOf), roleOf: Object.fromEntries(roleOf), intermediary: [...intermediary], ownerOf: Object.fromEntries(ownerOf) },
          errors: { full: { missed: Object.fromEntries(errorsFull.missed), extra: Object.fromEntries(errorsFull.extra) }, nick: { missed: Object.fromEntries(errorsNick.missed), extra: Object.fromEntries(errorsNick.extra) } },
          addressExamples: addressMetrics(combined, byConfidence, 60).examples,
          trap: trap.map((item) => ({ start: item.run.startAccount, finding: item.finding, foreignMain: item.foreignMain, foreignSame: item.foreignSame, foreignPossibly: item.foreignPossibly, reasons: item.run.reasons })),
          nick: nickRuns.map((item) => ({ nick: item.nick, group: item.group.map((account) => account.id), crossPerson: item.crossPerson, mainPersons: item.mainPersons, main: item.run.mainAccounts, probability: item.run.mainProbability, sameCross: item.sameCross })),
        },
        null,
        1,
      ),
      'utf8',
    );
  }

  // ---------- Konsola ----------
  console.log('\n=== (a) Łączenie kont ===');
  console.table(
    Object.fromEntries(
      linkingRows.map(({ label, result }) => [
        label.replace('Próba główna, start: ', '').replace('„prawdopodobnie ta sama osoba”', 'ta sama os.'),
        { punkty: result.runs, 'P mikro': pct(result.microPrecision), 'R mikro': pct(result.microRecall), 'F1 mikro': pct(result.microF1), 'P makro': pct(result.macroPrecision), 'R makro': pct(result.macroRecall), 'F1 makro': pct(result.macroF1), 'R bez startu': pct(result.othersRecall) },
      ]),
    ),
  );
  console.log('=== (b) Adresy (Wskaźnik Pewności) ===');
  console.table(addressRows.map((row) => ({ zbiór: row[0], próg: row[1], P: row[2], R: row[3], F1: row[4], 'TP/FP/FN': row[5], 'FP pośrednik': row[6], 'FP inna osoba': row[7] })));
  if (trapAddress) {
    console.log('=== Pułapka wspólnego adresu ===');
    console.table(THRESHOLDS.map((threshold) => ({ próg: `≥ ${threshold}`, 'adres pośrednika przypisany': `${trap.filter((item) => item.finding && item.finding.evidence > 0 && !item.finding.excluded && item.finding.score >= threshold).length} / ${trap.length}` })));
  }
  console.log('=== Pułapka nicku ===');
  console.table({ 'różne osoby: sklejone': `${crossMerged.length} / ${crossNick.length}`, 'różne osoby: „ta sama osoba”': `${crossSame.length} / ${crossNick.length}`, 'jedna osoba: uznane za jedną': `${sameNick.filter((item) => item.groupCovered === item.group.length).length} / ${sameNick.length}` });
  console.log('=== (c) Czas analizy ===');
  console.table(timeRows.map(([label, item]) => ({ zbiór: label, analiz: item.n, średnio: `${num(item.mean / 1000, 2)} s`, mediana: `${num(item.median / 1000, 2)} s`, p95: `${num(item.p95 / 1000, 2)} s`, maks: `${num(item.max / 1000, 2)} s` })));
  console.log(`Łączny czas analiz: ${num(times.reduce((sum, value) => sum + value, 0) / 1000, 0)} s. Raport: ${OUT_FILE}`);
}

await main();
