// Pomiar: jak dobrze OŁCyŚ przechodzi od SAMEGO ADRESU kryptowalutowego do właściwej OSOBY.
// Dwa zbiory: laboratorium tożsamości (apps/identity-lab, sieć LAB) i piaskownica (apps/sandbox, BTC/ETH/TRON).
//
// Uruchomienie (laboratorium i piaskownica muszą działać):
//   node scripts/benchmark-address.ts [--lab http://127.0.0.1:8787] [--sandbox http://127.0.0.1:4100]
//        [--out docs/BENCHMARK-ADRES.md] [--json plik.json] [--no-deep] [--no-reverse] [--lab-sample 30]
//
// Zasady pomiaru (jak w scripts/benchmark-lab.ts):
// - analizy wykonuje nasz kod przez `buildApp` + `app.inject` (baza PGlite w pamięci, wyłącznie łączniki
//   i dostawca danych blockchain danego zbioru, bez internetu i bez modelu językowego);
// - jedynym identyfikatorem sprawy jest adres (`crypto_address`);
// - prawda wzorcowa laboratorium (`/api/ground-truth`) jest pobierana dopiero PO wszystkich analizach — strażnik
//   na `fetch` przerywa skrypt, gdyby cokolwiek sięgnęło po nią wcześniej; strażnik blokuje też każde żądanie
//   inne niż GET/HEAD i stronę `/_demo` piaskownicy (zmienia jej stan);
// - prawda wzorcowa piaskownicy powstaje z plików apps/sandbox/data (kto opublikował adres jako własny, które
//   adresy są usługą, kontraktem, cytowane przez wielu); przed analizami skrypt bierze z nich wyłącznie listę
//   adresów i nicków autorów, a przypisanie właścicieli liczy dopiero w fazie oceny;
// - reguły narzędzia nie są zmieniane ani strojone pod ten pomiar.

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
const SANDBOX_URL = option('sandbox', process.env.SANDBOX_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
const OUT_FILE = resolve(ROOT, option('out', 'docs/BENCHMARK-ADRES.md'));
const JSON_FILE = args.includes('--json') ? resolve(ROOT, option('json', 'benchmark-address.json')) : undefined;
const WITH_DEEP = !args.includes('--no-deep');
const WITH_REVERSE = !args.includes('--no-reverse');
const LAB_SAMPLE = Number(option('lab-sample', '1000'));
/** Tylko do prób skryptu: ograniczenie liczby adresów piaskownicy (kolejność SHA-256). */
const SANDBOX_SAMPLE = Number(option('sandbox-sample', '1000'));
const THRESHOLDS = [40, 60, 80];
const APP_RECYCLE = 40;
const LAB_FORBIDDEN = ['/api/ground-truth', '/api/resolve', '/api/evaluate', '/api/export', '/api/search', '/api/regenerate'];

// ---------- Strażnik żądań ----------

let phase: 'public' | 'analysis' | 'scoring' = 'public';
const requests = { lab: 0, sandbox: 0, forbidden: 0, blockedOther: 0 };
const realFetch = globalThis.fetch;
const labOrigin = new URL(LAB_URL).origin;
const sandboxOrigin = new URL(SANDBOX_URL).origin;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  if (url.origin !== labOrigin && url.origin !== sandboxOrigin) {
    requests.blockedOther++;
    throw new Error(`Pomiar działa bez internetu — zablokowano żądanie do ${url.origin}.`);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    requests.forbidden++;
    throw new Error(`Pomiar tylko czyta dane — zablokowano ${method} ${url.pathname}.`);
  }
  if (url.origin === sandboxOrigin && url.pathname.startsWith('/_demo')) {
    requests.forbidden++;
    throw new Error('Zablokowano /_demo piaskownicy (zmienia stan serwera).');
  }
  if (url.origin === labOrigin && phase !== 'scoring' && LAB_FORBIDDEN.some((path) => url.pathname.startsWith(path))) {
    requests.forbidden++;
    throw new Error(`Zablokowano żądanie ${url.pathname} przed zakończeniem analiz.`);
  }
  if (url.origin === labOrigin) requests.lab++;
  else requests.sandbox++;
  return realFetch(input, init);
}) as typeof fetch;

// ---------- Narzędzia ----------

const hashOrder = (id: string) => createHash('sha256').update(`benchmark-address-v1|${id}`).digest('hex');
const key = (address: string) => address.trim().toLowerCase();
const pct = (value: number | undefined) => (value === undefined || Number.isNaN(value) ? '—' : `${(value * 100).toFixed(1).replace('.', ',')}%`);
const num = (value: number, digits = 0) => value.toFixed(digits).replace('.', ',');
const ratio = (a: number, b: number) => (b === 0 ? undefined : a / b);
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const median = (values: number[]) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const short = (address: string) => (address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address);

async function getJson<T>(base: string, path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${base}${path} — kod ${response.status}.`);
  return (await response.json()) as T;
}

// ---------- Analiza ----------

type Dataset = 'lab' | 'sandbox';
type Depth = 'standard' | 'deep';

interface FindingSummary {
  address: string;
  score: number;
  excluded: boolean;
  widelyCited: boolean;
  evidence: number;
  subjectProbability: number;
  unrelatedPublishers: number;
  rules: string[];
  addressClass?: string;
  label?: string;
}

interface RunRecord {
  dataset: Dataset;
  kind: 'address' | 'nick';
  depth: Depth;
  query: string;
  /** Konto startowe (tylko start od nicku): id konta w laboratorium albo `serwis:nick` w piaskownicy. */
  startAccount?: string;
  status: string;
  partial: boolean;
  analysisMs: number;
  persons: { probability: number; accounts: string[]; reasons: string[]; fullName?: string }[];
  mainProbability: number;
  mainAccounts: string[];
  mainReasons: string[];
  /** Adresy przypisane osobie głównej (`network:address` → prawdopodobieństwo). */
  mainAddresses: { key: string; probability: number }[];
  /** Ustalenie dla adresu ze sprawy (start od adresu). */
  finding?: FindingSummary;
  findings: FindingSummary[];
  explanations: { kind: string; text: string }[];
  seizures: number;
  unmappedMainProfiles: number;
  errors: string[];
}

interface DossierLike {
  partial?: boolean;
  persons: { probability: number; profileIds: string[]; reasons: string[]; fullName?: string; addresses: { key: string; probability: number }[] }[];
  profiles: { id: string; url: string; service: string; handle?: string }[];
  findings: {
    address: string;
    widelyCited?: boolean;
    confidence: { score: number; excluded: boolean; ledger: { rule: string }[] };
    subjectProbability: number;
    unrelatedPublishers: number;
    evidence: unknown[];
    chain?: { profile: { addressClass: string; label?: string } };
  }[];
  explanations: { kind: string; text: string }[];
  seizures?: unknown[];
}

type App = Awaited<ReturnType<typeof buildApp>>;
type CardMapper = (card: { url: string; service: string; handle?: string }) => string | undefined;

const labCard: CardMapper = (card) => /\/profile\/([^/?#]+)/.exec(card.url)?.[1];
const sandboxCard: CardMapper = (card) => {
  const service = card.service.replace(/\.sandbox$/, '');
  if (card.handle) return `${service}:${card.handle.replace(/^@/, '').toLowerCase()}`;
  const path = new URL(card.url).pathname.split('/').filter(Boolean);
  return path.length >= 2 ? `${service}:${path[path.length - 1]!.toLowerCase()}` : undefined;
};

function summarizeFinding(finding: DossierLike['findings'][number]): FindingSummary {
  return {
    address: finding.address,
    score: finding.confidence.score,
    excluded: finding.confidence.excluded,
    widelyCited: finding.widelyCited === true,
    evidence: finding.evidence.length,
    subjectProbability: finding.subjectProbability,
    unrelatedPublishers: finding.unrelatedPublishers,
    rules: finding.confidence.ledger.map((entry) => entry.rule),
    ...(finding.chain ? { addressClass: finding.chain.profile.addressClass } : {}),
    ...(finding.chain?.profile.label ? { label: finding.chain.profile.label } : {}),
  };
}

async function analyze(app: App, connectorIds: string[], dataset: Dataset, mapCard: CardMapper, identifier: { type: 'crypto_address' | 'nick'; value: string }, depth: Depth, startAccount?: string): Promise<RunRecord> {
  const errors: string[] = [];
  const began = performance.now();
  const created = await app.inject({ method: 'POST', url: '/api/cases', payload: { name: `${dataset}: ${identifier.value} (${depth})`, identifiers: [identifier] } });
  if (created.statusCode !== 201) throw new Error(`Nie udało się założyć sprawy dla ${identifier.value}: ${created.body}`);
  const ran = await app.inject({ method: 'POST', url: `/api/cases/${created.json().id}/runs`, payload: { connectors: connectorIds, depth } });
  const analysisMs = performance.now() - began;
  if (ran.statusCode !== 201) throw new Error(`Analiza dla ${identifier.value} nie powiodła się: ${ran.body}`);
  const run = ran.json() as { id: string; status: string; log: { message: string }[] };
  for (const entry of run.log) if (/BŁĄD|Przekroczono limit czasu/.test(entry.message)) errors.push(entry.message);
  const response = await app.inject(`/api/runs/${run.id}/dossier`);
  if (response.statusCode !== 200) throw new Error(`Teczka dla ${identifier.value} nie powstała: ${response.body}`);
  const dossier = response.json() as DossierLike;

  const cardAccount = new Map(dossier.profiles.map((card) => [card.id, mapCard(card)]));
  const accountsOf = (profileIds: string[]) => [...new Set(profileIds.map((id) => cardAccount.get(id)).filter((value): value is string => Boolean(value)))];
  const main = dossier.persons[0];
  const hasMain = main !== undefined && main.probability > 0;
  const findings = dossier.findings.map(summarizeFinding);
  return {
    dataset,
    kind: identifier.type === 'crypto_address' ? 'address' : 'nick',
    depth,
    query: identifier.value,
    ...(startAccount ? { startAccount } : {}),
    status: run.status,
    partial: dossier.partial === true,
    analysisMs,
    persons: dossier.persons.map((person) => ({ probability: person.probability, accounts: accountsOf(person.profileIds), reasons: person.reasons, ...(person.fullName ? { fullName: person.fullName } : {}) })),
    mainProbability: hasMain ? main.probability : 0,
    mainAccounts: hasMain ? accountsOf(main.profileIds) : [],
    mainReasons: hasMain ? main.reasons : [],
    mainAddresses: hasMain ? main.addresses : [],
    ...(identifier.type === 'crypto_address' ? { finding: findings.find((item) => key(item.address) === key(identifier.value)) } : {}),
    findings,
    explanations: dossier.explanations.map((item) => ({ kind: item.kind, text: item.text })),
    seizures: dossier.seizures?.length ?? 0,
    unmappedMainProfiles: hasMain ? main.profileIds.filter((id) => !cardAccount.get(id)).length : 0,
    errors,
  };
}

/** Aplikacja z pustą bazą odnawiana co `APP_RECYCLE` analiz — analizy są od siebie niezależne. */
function appPool(dataset: Dataset) {
  const connectors = dataset === 'lab' ? createConnectors({ labUrl: LAB_URL }) : createConnectors({ sandboxUrl: SANDBOX_URL });
  const providers = dataset === 'lab' ? createChainProviders({ labUrl: LAB_URL }) : createChainProviders({ sandboxUrl: SANDBOX_URL, rateCacheFile: false });
  const deepProviders = dataset === 'lab' ? createChainProviders({ labUrl: LAB_URL, depth: 'deep' }) : createChainProviders({ sandboxUrl: SANDBOX_URL, rateCacheFile: false, depth: 'deep' });
  const connectorIds = connectors.map((connector) => connector.id);
  let current: { app: App; close: () => Promise<void>; used: number } | undefined;
  return {
    connectorIds,
    connectorCount: connectors.length,
    async get(): Promise<App> {
      if (current && current.used < APP_RECYCLE) {
        current.used++;
        return current.app;
      }
      await current?.close();
      const storage = createStorage(await createPgliteDriver());
      await storage.migrate();
      const app = await buildApp({ storage, connectors, chainProviders: providers, deepChainProviders: deepProviders, resolveActivity: getActivityFromProviders, matchService, normalizeText: normalizeAddressText, ai: null });
      current = {
        app,
        used: 1,
        close: async () => {
          await app.close();
          await storage.close();
        },
      };
      return app;
    },
    async close() {
      await current?.close();
      current = undefined;
    },
  };
}

// ---------- Prawda wzorcowa: wspólny kształt ----------

type Category = 'private_published' | 'private_unpublished' | 'service' | 'shared' | 'quoted_many' | 'no_owner';
const CATEGORY_TEXT: Record<Category, string> = {
  private_published: 'prywatny, właściciel sam go opublikował',
  private_unpublished: 'prywatny, właściciel go NIE opublikował',
  service: 'giełda / usługa / kontrakt',
  shared: 'wspólny adres pośrednika (zbiórka)',
  quoted_many: 'cytowany przez wielu autorów',
  no_owner: 'bez właściciela we wzorcu i bez publikacji (kontrahent anonimowy, adres pośredni)',
};
/** Kategorie, dla których poprawną odpowiedzią jest brak osoby. */
const SHOULD_ABSTAIN: Category[] = ['service', 'shared', 'quoted_many', 'no_owner'];

interface AddressTruth {
  address: string;
  category: Category;
  /** Osoba będąca właścicielem (dla `quoted_many` — autor wpisu, który podał adres jako swój). */
  owner?: string;
  ownerLabel?: string;
  /** Liczba różnych osób publikujących adres. */
  publishers: number;
  note?: string;
}

interface Truth {
  personOf: (account: string) => string;
  label: (person: string) => string;
  addresses: AddressTruth[];
}

// ---------- Ocena ----------

type Outcome = 'trafienie' | 'częściowe' | 'błąd' | 'wstrzymanie';

function outcomeOf(run: RunRecord, truth: AddressTruth, personOf: Truth['personOf']): { outcome: Outcome; persons: string[] } {
  if (run.mainProbability <= 0) return { outcome: 'wstrzymanie', persons: [] };
  const persons = [...new Set(run.mainAccounts.map(personOf))];
  if (truth.owner && persons.includes(truth.owner)) return { outcome: persons.length === 1 ? 'trafienie' : 'częściowe', persons };
  return { outcome: 'błąd', persons };
}

/** Powód wstrzymania: najpierw cecha adresu w teczce, potem rodzaj wyjaśnienia. */
function abstainReason(run: RunRecord): string {
  const finding = run.finding;
  if (run.seizures > 0) return 'zajęcie środków przez organ państwa (seized)';
  if (finding?.widelyCited) return 'adres powszechnie cytowany (≥ 10 niepowiązanych autorów)';
  if (finding?.excluded) {
    const rule = finding.rules.find((item) => item.startsWith('exclusion.')) ?? 'exclusion';
    return `adres wykluczony: ${rule}${finding.addressClass ? `, klasa ${finding.addressClass}` : ''}`;
  }
  if (finding && finding.evidence === 0 && finding.unrelatedPublishers > 0) {
    return 'adres tylko we wpisach liczonych jako wzmianka (kategoria źródła spoza OWNERSHIP_CATEGORIES i bez deklaracji własności w treści, bez modelu językowego) — autor nie jest kandydatem na właściciela';
  }
  if (!finding || finding.evidence === 0) return 'brak publikacji adresu w źródłach';
  const kinds = [...new Set(run.explanations.map((item) => item.kind))];
  return `adres opublikowany, ale bez kandydata (${kinds.join(', ') || 'brak wyjaśnienia'}; wynik ${finding.score})`;
}

interface Scored {
  run: RunRecord;
  truth: AddressTruth;
  outcome: Outcome;
  persons: string[];
}

function scoreRuns(runs: RunRecord[], truth: Truth): Scored[] {
  const byAddress = new Map(truth.addresses.map((item) => [key(item.address), item]));
  return runs.map((run) => {
    const item = byAddress.get(key(run.query))!;
    return { run, truth: item, ...outcomeOf(run, item, truth.personOf) };
  });
}

function metrics(scored: Scored[]) {
  const count = (outcome: Outcome, list = scored) => list.filter((item) => item.outcome === outcome).length;
  const published = scored.filter((item) => item.truth.category === 'private_published');
  const abstainGroup = scored.filter((item) => SHOULD_ABSTAIN.includes(item.truth.category));
  const hits = count('trafienie');
  const errors = count('błąd');
  const byThreshold = THRESHOLDS.map((threshold) => {
    const above = scored.filter((item) => item.outcome !== 'wstrzymanie' && item.run.mainProbability >= threshold);
    const t = count('trafienie', above);
    const e = count('błąd', above);
    const p = count('częściowe', above);
    const tPublished = above.filter((item) => item.outcome === 'trafienie' && item.truth.category === 'private_published').length;
    return { threshold, hits: t, errors: e, partial: p, precision: ratio(t, t + e), coverage: ratio(tPublished, published.length) };
  });
  return {
    n: scored.length,
    hits,
    partial: count('częściowe'),
    errors,
    abstain: count('wstrzymanie'),
    precision: ratio(hits, hits + errors),
    coverage: ratio(published.filter((item) => item.outcome === 'trafienie').length, published.length),
    coverageWithPartial: ratio(published.filter((item) => item.outcome === 'trafienie' || item.outcome === 'częściowe').length, published.length),
    published: published.length,
    publishedHits: published.filter((item) => item.outcome === 'trafienie').length,
    abstainGroup: abstainGroup.length,
    abstainCorrect: count('wstrzymanie', abstainGroup),
    abstainOwnerNamed: abstainGroup.filter((item) => item.outcome === 'trafienie').length,
    abstainWrong: abstainGroup.filter((item) => item.outcome === 'błąd' || item.outcome === 'częściowe').length,
    byThreshold,
    hitProbabilities: scored.filter((item) => item.outcome === 'trafienie').map((item) => item.run.mainProbability),
    errorProbabilities: scored.filter((item) => item.outcome === 'błąd').map((item) => item.run.mainProbability),
    partialProbabilities: scored.filter((item) => item.outcome === 'częściowe').map((item) => item.run.mainProbability),
    times: scored.map((item) => item.run.analysisMs),
  };
}

// ---------- Laboratorium ----------

interface LabAccount {
  id: string;
  serviceId: string;
  username: string;
  displayName: string;
  walletAddresses: string[];
}

interface LabGroundTruth {
  people: { id: string; firstName?: string; lastName?: string; walletAddresses?: string[] }[];
  accountLinks: { accountId: string; personId: string; role: string }[];
  scenarios: { id: string; query?: string }[];
  walletPostExamples?: { examples: { address: string; authorPersonId?: string; walletOwnerPersonId: string | null; addressUse: string }[] };
}

async function labPublic() {
  const wallets = (await getJson<{ wallets: { address: string; label: string }[] }>(LAB_URL, '/api/blockchain')).wallets;
  const accounts: LabAccount[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await getJson<{ total: number; accounts: LabAccount[] }>(LAB_URL, `/api/accounts?limit=1000&offset=${offset}`);
    accounts.push(...page.accounts);
    if (accounts.length >= page.total || page.accounts.length === 0) break;
  }
  const status = await getJson<{ meta: { seed: number; people: number } }>(LAB_URL, '/api/status');
  const publishers = new Map<string, LabAccount[]>();
  for (const account of [...accounts].sort((a, b) => hashOrder(a.id).localeCompare(hashOrder(b.id)))) {
    for (const address of account.walletAddresses) publishers.set(key(address), [...(publishers.get(key(address)) ?? []), account]);
  }
  const universe = [...new Set([...wallets.map((wallet) => wallet.address), ...accounts.flatMap((account) => account.walletAddresses)])].sort((a, b) => hashOrder(a).localeCompare(hashOrder(b))).slice(0, LAB_SAMPLE);
  const labelOf = new Map(wallets.map((wallet) => [key(wallet.address), wallet.label]));
  return { wallets, accounts, status, publishers, universe, labelOf };
}

async function labTruth(pub: Awaited<ReturnType<typeof labPublic>>): Promise<Truth & { raw: LabGroundTruth }> {
  const truth = await getJson<LabGroundTruth>(LAB_URL, '/api/ground-truth');
  const personOfAccount = new Map(truth.accountLinks.map((link) => [link.accountId, link.personId]));
  const accountsOfPerson = new Map<string, string[]>();
  for (const link of truth.accountLinks) accountsOfPerson.set(link.personId, [...(accountsOfPerson.get(link.personId) ?? []), link.accountId]);
  const intermediary = new Set(
    [
      ...truth.scenarios.filter((scenario) => scenario.id === 'shared-payment-address' && scenario.query).map((scenario) => scenario.query!),
      ...(truth.walletPostExamples?.examples ?? []).filter((example) => example.walletOwnerPersonId === null).map((example) => example.address),
    ].map(key),
  );
  const ownerOf = new Map<string, string>();
  for (const person of truth.people) for (const address of person.walletAddresses ?? []) if (!intermediary.has(key(address))) ownerOf.set(key(address), person.id);
  const accountById = new Map(pub.accounts.map((account) => [account.id, account]));
  /** Adres → osoby, które podały go jako własny w poście (kohorta postów z adresami). */
  const ownPosts = new Map<string, Set<string>>();
  for (const example of truth.walletPostExamples?.examples ?? []) {
    if (example.addressUse !== 'own' || !example.authorPersonId) continue;
    ownPosts.set(key(example.address), new Set([...(ownPosts.get(key(example.address)) ?? []), example.authorPersonId]));
  }
  const nameOf = new Map(truth.people.map((person) => [person.id, [person.firstName, person.lastName].filter(Boolean).join(' ') || person.id]));
  const addresses: AddressTruth[] = pub.universe.map((address) => {
    const k = key(address);
    const publishing = pub.publishers.get(k) ?? [];
    const publisherPersons = new Set(publishing.map((account) => personOfAccount.get(account.id) ?? `?${account.id}`));
    const owner = ownerOf.get(k);
    if (intermediary.has(k)) return { address, category: 'shared', publishers: publisherPersons.size, note: pub.labelOf.get(k) };
    if (!owner) return { address, category: 'no_owner', publishers: publisherPersons.size, note: pub.labelOf.get(k) };
    const ownAccounts = accountsOfPerson.get(owner) ?? [];
    const publishedByOwner = ownAccounts.some((id) => accountById.get(id)?.walletAddresses.some((item) => key(item) === k)) || ownPosts.get(k)?.has(owner) === true;
    return { address, category: publishedByOwner ? 'private_published' : 'private_unpublished', owner, ownerLabel: nameOf.get(owner), publishers: publisherPersons.size, note: pub.labelOf.get(k) };
  });
  return {
    raw: truth,
    personOf: (account) => personOfAccount.get(account) ?? `?${account}`,
    label: (person) => `${nameOf.get(person) ?? person} (${person})`,
    addresses,
  };
}

// ---------- Piaskownica ----------

/**
 * Osoby piaskownicy: konta (`serwis:nick`) jednej fikcyjnej osoby według plików apps/sandbox/data i README.
 * Skrypt sprawdza, że każde konto z `accounts` jest tu dokładnie raz. Autorzy spoza `accounts` (konta tła,
 * np. komentujący rozdanie) są osobnymi, nieznanymi osobami.
 */
const SANDBOX_PERSONS: Record<string, string[]> = {
  // scenario.ts (scenariusze a–h)
  'Kacper Wrzosek (programista, Bydgoszcz)': ['gitpub:kwrzosek_dev', 'targ:kwrzosek_dev'],
  'Kacper Wrzosek (wędkarz, Olsztyn — imiennik)': ['spolecznosc:wrzosek_ryby'],
  'Bartłomiej Kruk': ['forum:bkruk_trader'],
  'Oliwia Stępniak': ['spolecznosc:oli_stepniak'],
  'Dominik Sroka': ['www:dsroka'],
  'Marta Zielonka': ['spolecznosc:marta.zielonka', 'gitpub:zielonka_codes', 'gitpub:zielonka-labs'],
  'Hubert Jagła': ['komunikator:hubi_serwis', 'forum:hubi_serwis'],
  'Zofia Mielcarz': ['spolecznosc:zosia_mielcarz', 'forum:zosia_mielcarz', 'targ:zosia_mielcarz'],
  'Rafał Cieśla': ['gitpub:rafal_ciesla'],
  'konto „MEGA Rozdanie Krypto” (oszustwo)': ['spolecznosc:mega_rozdanie_krypto'],
  'kantor_na_rogu': ['targ:kantor_na_rogu'],
  // market.ts (rynek P2P) — drugie profile tych samych osób w innych serwisach
  'Igor Baran': ['targ:igor_baran', 'spolecznosc:igor_baran'],
  'Dariusz Mróz': ['targ:darek_mroz', 'spolecznosc:darek_mroz'],
  'Sylwia Kot': ['targ:sylwia_kot'],
  'Aleksander Czyż': ['targ:olek_czyz'],
  'Jan Pietrzak': ['targ:j_pietrzak'],
  'Marcel Zych': ['targ:marcel_zych', 'forum:mz_mineraly'],
  'Paweł Gajda': ['targ:p_gajda'],
  'Robert Dudek': ['targ:r_dudek', 'gitpub:rdudek3d'],
  'Ewelina Bąk': ['targ:ewelina_bak'],
  'Wiktor Noga': ['targ:wiktor_noga'],
  'Natalia Wilk': ['targ:nat_wilk'],
  'Kinga Sowa': ['targ:kinga_sowa', 'spolecznosc:kinga.sowa'],
  'Tomasz Lis': ['targ:tomasz_lis_p2p', 'komunikator:tomasz_lis_p2p'],
  'Monika Rak': ['targ:monika_rak', 'komunikator:monika_rak'],
  'Lena Kurek': ['targ:lena_kurek', 'spolecznosc:kurek_kolekcje'],
  'Marek Sikora (marek88 na Targu)': ['targ:marek88'],
  'Marek Wrona (marek88 na Forum)': ['forum:marek88'],
  // related.ts — „ta sama osoba pod innym nazwiskiem” to jedna osoba; pozostałe pary to różne osoby
  'Rafał Kowalski / Julia Kowalska (jedna osoba)': ['gitpub:rkowalski_btc', 'targ:rkowalski_btc', 'spolecznosc:julka_k', 'targ:julka_k'],
  'Tomasz Nowak': ['targ:t_nowak_foto'],
  'Ewa Wiśniewska': ['spolecznosc:ewa_wisniewska', 'targ:ewa_wisniewska'],
  'Piotr Zając': ['targ:auto_czesci_wwa'],
  'Anna Maj': ['targ:ania_handmade'],
  'Karolina Lis': ['targ:maj_studio'],
  // proofs.ts
  'Norbert Szpak': ['gitpub:szpak_nody'],
  'Borys Kania (fałszywy „dowód”)': ['spolecznosc:krypto_baron'],
  'Filip Jaskuła': ['targ:fjaskula_usdt', 'forum:fjaskula_usdt', 'komunikator:fjaskula_usdt'],
  'Adam Wilczek (wilczek_x9 na Targu)': ['targ:wilczek_x9'],
  'Beata Wilczyńska (wilczek_x9 na Forum)': ['forum:wilczek_x9'],
};

interface SandboxData {
  accounts: { service: string; handle: string }[];
  pages: { service: string; path: string; author: string; html: string; kind: string }[];
  threads: { service: string; path: string; opening?: { author: string; html: string }; items: { author: string; html: string }[] }[];
  snapshots: { service: string; author: string; html: string }[];
  labeledAddresses: { address: string; label?: string; addressClass?: string; isContract?: boolean }[];
  ledger: { from: string; to: string }[];
}

async function sandboxData() {
  const module = (await import('../apps/sandbox/data/scenario.ts')) as unknown as {
    scenario: SandboxData;
    ADDR: Record<string, string>;
    MARKET_ADDR: Record<string, string>;
    RELATED_ADDR: Record<string, string>;
    PROOF_ADDR: Record<string, string>;
  };
  const { scenario } = module;
  /** Każda publikacja: autor (konto) i adresy w treści. */
  const publications: { account: string; html: string; where: string; opening: boolean }[] = [
    ...scenario.pages.map((page) => ({ account: `${page.service}:${page.author.toLowerCase()}`, html: page.html, where: `/${page.service}${page.path}`, opening: true })),
    ...scenario.threads.flatMap((thread) => [
      ...(thread.opening ? [{ account: `${thread.service}:${thread.opening.author.toLowerCase()}`, html: thread.opening.html, where: `/${thread.service}${thread.path}`, opening: true }] : []),
      ...thread.items.map((item) => ({ account: `${thread.service}:${item.author.toLowerCase()}`, html: item.html, where: `/${thread.service}${thread.path}`, opening: false })),
    ]),
    ...scenario.snapshots.map((snapshot) => ({ account: `${snapshot.service}:${snapshot.author.toLowerCase()}`, html: snapshot.html, where: `/archiwum (${snapshot.service})`, opening: true })),
  ];
  const universe = [
    ...new Set([
      ...Object.values(module.ADDR),
      ...Object.values(module.MARKET_ADDR),
      ...Object.values(module.RELATED_ADDR),
      ...Object.values(module.PROOF_ADDR),
      ...scenario.labeledAddresses.map((item) => item.address),
      ...scenario.ledger.flatMap((row) => [row.from, row.to]),
    ]),
  ]
    .sort((a, b) => hashOrder(a).localeCompare(hashOrder(b)))
    .slice(0, SANDBOX_SAMPLE);
  const authorsOf = (address: string) => publications.filter((item) => item.html.includes(address));
  /** Nazwy adresów z plików danych (np. `kacperBtc`) — do tabeli pułapek. */
  const named = new Map<string, string>();
  for (const map of [module.ADDR, module.MARKET_ADDR, module.RELATED_ADDR, module.PROOF_ADDR]) for (const [name, address] of Object.entries(map)) named.set(key(address), name);
  return { scenario, publications, universe, authorsOf, named };
}

function sandboxTruth(data: Awaited<ReturnType<typeof sandboxData>>): Truth {
  const personOfAccount = new Map<string, string>();
  for (const [person, accounts] of Object.entries(SANDBOX_PERSONS)) {
    for (const account of accounts) {
      if (personOfAccount.has(account)) throw new Error(`Konto ${account} przypisane dwóm osobom.`);
      personOfAccount.set(account, person);
    }
  }
  const missing = data.scenario.accounts.map((account) => `${account.service}:${account.handle.toLowerCase()}`).filter((account) => !personOfAccount.has(account));
  if (missing.length > 0) throw new Error(`Konta piaskownicy bez osoby w SANDBOX_PERSONS: ${missing.join(', ')}.`);
  const personOf = (account: string) => personOfAccount.get(account) ?? `?${account}`;
  const labels = new Map(data.scenario.labeledAddresses.map((item) => [key(item.address), item]));
  const addresses: AddressTruth[] = data.universe.map((address) => {
    const label = labels.get(key(address));
    const authors = data.authorsOf(address);
    const persons = [...new Set(authors.map((item) => personOf(item.account)))];
    if (label?.addressClass && label.addressClass !== 'private') return { address, category: 'service', publishers: persons.length, note: label.label ?? label.addressClass };
    if (persons.length === 0) return { address, category: 'no_owner', publishers: 0 };
    if (persons.length === 1) return { address, category: 'private_published', owner: persons[0]!, ownerLabel: persons[0]!, publishers: 1 };
    // Kilku autorów: właścicielem jest autor wpisu otwierającego (np. konto rozdania), pozostali tylko cytują.
    const opener = authors.find((item) => item.opening);
    const owner = opener ? personOf(opener.account) : undefined;
    return { address, category: 'quoted_many', ...(owner ? { owner, ownerLabel: owner } : {}), publishers: persons.length, note: `${persons.length} autorów` };
  });
  return { personOf, label: (person) => person.replace(/^\?/, 'konto spoza osób scenariusza: '), addresses };
}

// ---------- Przebieg ----------

async function main() {
  const started = performance.now();
  // Faza publiczna: listy adresów i kont startowych.
  const lab = await labPublic();
  const sandbox = await sandboxData();
  const sandboxProbe = await fetch(`${SANDBOX_URL}/explorer/api/address/${sandbox.universe[0]}`);
  if (!sandboxProbe.ok && sandboxProbe.status !== 404) throw new Error(`Piaskownica ${SANDBOX_URL} nie odpowiada poprawnie (kod ${sandboxProbe.status}).`);

  // Starty od nicku (kierunek odwrotny): każde konto publikujące jakikolwiek adres — wybór z danych publicznych.
  const labNickStarts = WITH_REVERSE ? [...new Map([...lab.publishers.values()].flat().map((account) => [account.id, account])).values()] : [];
  const sandboxNickStarts = WITH_REVERSE
    ? [...new Set(data2accounts(sandbox).map((item) => item))].sort((a, b) => hashOrder(a).localeCompare(hashOrder(b)))
    : [];

  const depths: Depth[] = WITH_DEEP ? ['standard', 'deep'] : ['standard'];
  console.log(`Laboratorium ${LAB_URL}: seed ${lab.status.meta.seed}, adresów do analizy ${lab.universe.length}; piaskownica ${SANDBOX_URL}: adresów ${sandbox.universe.length}.`);
  console.log(`Tryby: ${depths.join(', ')}; starty od nicku: laboratorium ${labNickStarts.length}, piaskownica ${sandboxNickStarts.length}.`);

  phase = 'analysis';
  const runs: RunRecord[] = [];
  const progress = (label: string, index: number, total: number) => {
    if ((index + 1) % 25 === 0 || index + 1 === total) console.log(`  ${label}: ${index + 1}/${total} (${((performance.now() - started) / 1000).toFixed(0)} s)`);
  };
  for (const [dataset, universe, mapper] of [
    ['lab', lab.universe, labCard],
    ['sandbox', sandbox.universe, sandboxCard],
  ] as [Dataset, string[], CardMapper][]) {
    const pool = appPool(dataset);
    for (const depth of depths) {
      for (const [index, address] of universe.entries()) {
        runs.push(await analyze(await pool.get(), pool.connectorIds, dataset, mapper, { type: 'crypto_address', value: address }, depth));
        progress(`${dataset}, adres, ${depth}`, index, universe.length);
      }
    }
    const nickStarts = dataset === 'lab' ? labNickStarts.map((account) => ({ handle: account.username, account: account.id })) : sandboxNickStarts.map((account) => ({ handle: account.split(':')[1]!, account }));
    for (const [index, start] of nickStarts.entries()) {
      runs.push(await analyze(await pool.get(), pool.connectorIds, dataset, mapper, { type: 'nick', value: start.handle }, 'standard', start.account));
      progress(`${dataset}, nick`, index, nickStarts.length);
    }
    await pool.close();
  }
  if (requests.forbidden > 0 || requests.blockedOther > 0) throw new Error(`Naruszono zasady pomiaru: zakazanych żądań ${requests.forbidden}, poza zbiorami ${requests.blockedOther}.`);
  const analysisSeconds = (performance.now() - started) / 1000;

  // ---------- Dopiero teraz: prawda wzorcowa ----------
  phase = 'scoring';
  const labT = await labTruth(lab);
  const sandT = sandboxTruth(sandbox);
  const truthOf: Record<Dataset, Truth> = { lab: labT, sandbox: sandT };

  const addressRuns = (dataset: Dataset, depth: Depth) => runs.filter((run) => run.dataset === dataset && run.kind === 'address' && run.depth === depth);
  const scoredOf = (dataset: Dataset, depth: Depth) => scoreRuns(addressRuns(dataset, depth), truthOf[dataset]);

  // ---------- Raport ----------
  const lines: string[] = [];
  const out = (text = '') => lines.push(text);
  const table = (header: string[], rows: (string | number)[][]) => {
    out(`| ${header.join(' | ')} |`);
    out(`|${header.map(() => '---').join('|')}|`);
    for (const row of rows) out(`| ${row.join(' | ')} |`);
    out();
  };
  const DATASET_TEXT: Record<Dataset, string> = { lab: 'Laboratorium tożsamości (sieć LAB)', sandbox: 'Piaskownica (BTC / ETH / TRON)' };
  const summaries = (['lab', 'sandbox'] as Dataset[]).map((dataset) => ({ dataset, standard: metrics(scoredOf(dataset, 'standard')), deep: WITH_DEEP ? metrics(scoredOf(dataset, 'deep')) : undefined }));

  out('# Od samego adresu do osoby — pomiar OŁCyŚ');
  out();
  out(`Wygenerowano ${new Date().toISOString()} poleceniem \`node scripts/benchmark-address.ts\`. Plik powstaje automatycznie — wszystkie liczby i przykłady pochodzą z jednego przebiegu skryptu (${runs.length} analiz, ${num(analysisSeconds, 0)} s).`);
  out();
  out('Pytanie: analityk ma **wyłącznie adres** kryptowalutowy. Czy narzędzie wskaże właściwą osobę, a przede wszystkim — czy nie wskaże **niewłaściwej**?');
  out();
  out('## Wynik w skrócie');
  out();
  table(
    ['Miara (tryb standardowy)', ...summaries.map((item) => DATASET_TEXT[item.dataset])],
    [
      ['Adresów przeanalizowanych', ...summaries.map((item) => item.standard.n)],
      ['Trafienie / częściowe / błąd / wstrzymanie', ...summaries.map(({ standard: m }) => `${m.hits} / ${m.partial} / ${m.errors} / ${m.abstain}`)],
      ['**Błędne przypisanie osoby** (kandydat główny to ktoś inny)', ...summaries.map(({ standard: m }) => `**${m.errors} z ${m.n}** (${pct(ratio(m.errors, m.n))})`)],
      ['Precision przypisania = trafienia / (trafienia + błędy)', ...summaries.map(({ standard: m }) => `${pct(m.precision)} (${m.hits} / ${m.hits + m.errors})`)],
      ['Pokrycie = trafienia / adresy opublikowane przez prywatnego właściciela', ...summaries.map(({ standard: m }) => `${pct(m.coverage)} (${m.publishedHits} / ${m.published})`)],
      ['Poprawne wstrzymanie dla adresów, które nie powinny wskazywać osoby', ...summaries.map(({ standard: m }) => `${pct(ratio(m.abstainCorrect, m.abstainGroup))} (${m.abstainCorrect} / ${m.abstainGroup})`)],
      ['Czas analizy: mediana / P95', ...summaries.map(({ standard: m }) => `${num(quantile(m.times, 0.5) / 1000, 2)} s / ${num(quantile(m.times, 0.95) / 1000, 2)} s`)],
    ],
  );

  {
    const all = (['lab', 'sandbox'] as Dataset[]).flatMap((dataset) => scoredOf(dataset, 'standard'));
    const errors = all.filter((item) => item.outcome === 'błąd' || (item.outcome === 'częściowe'));
    const missed = all.filter((item) => item.truth.category === 'private_published' && item.outcome === 'wstrzymanie');
    const missedReasons = new Map<string, number>();
    for (const item of missed) missedReasons.set(abstainReason(item.run), (missedReasons.get(abstainReason(item.run)) ?? 0) + 1);
    const abstainGroup = all.filter((item) => SHOULD_ABSTAIN.includes(item.truth.category));
    out(
      `Najkrócej: na ${all.length} adresach z obu zbiorów narzędzie ${errors.length === 0 ? '**ani razu nie wskazało niewłaściwej osoby** (także częściowo)' : `wskazało niewłaściwą osobę (całkiem lub częściowo) **${errors.length} razy**`}. ` +
        `Dla ${abstainGroup.length} adresów, które nie powinny prowadzić do osoby (giełdy, kontrakty, zbiórka pośrednika, adresy cytowane i nieopublikowane), nie podało kandydata w ${abstainGroup.filter((item) => item.outcome === 'wstrzymanie').length} przypadkach` +
        `${abstainGroup.some((item) => item.outcome === 'trafienie') ? `, a w ${abstainGroup.filter((item) => item.outcome === 'trafienie').length} wskazało konto, które samo podało adres jako swój (konto rozdania-oszustwa)` : ''}. ` +
        `Z ${all.filter((item) => item.truth.category === 'private_published').length} adresów prywatnych opublikowanych przez właściciela pominęło ${missed.length}` +
        `${missed.length > 0 ? ` (${[...missedReasons.entries()].map(([reason, count]) => `${count}× ${reason}`).join('; ')})` : ''}. ` +
        (() => {
          const top = Math.max(0, ...all.filter((item) => item.outcome !== 'wstrzymanie').map((item) => item.run.mainProbability));
          return top < 80 ? `Ostrożność ma cenę: prawdopodobieństwo osoby wskazanej z samego adresu nie przekracza ${top}, więc przy progu 80 narzędzie nie wskazuje nikogo. ` : `Najwyższe prawdopodobieństwo wskazanej osoby: ${top}. `;
        })() +
        'Zbiory są syntetyczne — patrz „Czego ten pomiar nie mówi”.',
    );
    out();
    // Wskazania oparte wyłącznie na deklaracji własności w treści wypowiedzi (reguła tekstowa, bez modelu językowego).
    const byRule = all.filter((item) => item.outcome !== 'wstrzymanie' && item.run.finding?.rules.includes('basis.text_declaration'));
    const abstainedNoExplanation = all.filter((item) => item.outcome === 'wstrzymanie' && item.run.explanations.length === 0).length;
    out(
      `Deklaracja własności w treści (reguła tekstowa — wypowiedź na forum z „mój adres”, „wpłaty na”, „przyjmuję na adres” itp.; ostrzeżenia, pytania, rozdania, cytaty i przeczenia ją wykluczają): ` +
        `${byRule.length} ${byRule.length === 1 ? 'wskazanie oparte' : byRule.length % 10 >= 2 && byRule.length % 10 <= 4 && (byRule.length % 100 < 12 || byRule.length % 100 > 14) ? 'wskazania oparte' : 'wskazań opartych'} na tej regule (trafienia: ${byRule.filter((item) => item.outcome === 'trafienie').length}, błędy: ${byRule.filter((item) => item.outcome === 'błąd' || item.outcome === 'częściowe').length}); ` +
        `wypowiedź liczy się z wagą wypowiedzi na forum (50), a reguła ma niższą moc niż jawna kategoria źródła i odczyt modelu. ` +
        `Teczek bez kandydata i bez żadnego wyjaśnienia: ${abstainedNoExplanation} (wyjaśnienie \`no_owner\` mówi, dlaczego nie ma osoby i co zrobić).`,
    );
    out();
  }

  out('## Jak mierzono');
  out();
  out(`- **Zbiory.** (1) \`apps/identity-lab\`: seed ${lab.status.meta.seed}, ${lab.status.meta.people} syntetycznych osób, ${lab.accounts.length} kont w 27 portalach, łańcuch LAB z ${lab.wallets.length} portfelami — analizowano ${lab.universe.length === lab.wallets.length ? 'wszystkie' : `${lab.universe.length} (próba w kolejności SHA-256)`} adresy z \`/api/blockchain\` i z publicznych kont. (2) \`apps/sandbox\` (serwer na ${SANDBOX_URL}, tylko odczyt): ${sandbox.universe.length} adresów — wszystkie adresy z plików \`apps/sandbox/data\` (publikacje, etykiety eksploratora, księga przelewów).`);
  out(`- **Start:** sprawa z jednym identyfikatorem \`crypto_address\`; tryb standardowy${WITH_DEEP ? ' oraz — osobno — głęboki' : ''}. Narzędzie: \`buildApp\` + \`app.inject\`, baza PGlite w pamięci odnawiana co ${APP_RECYCLE} analiz, łączniki i dostawca danych blockchain wyłącznie danego zbioru (laboratorium: \`lab-*\`; piaskownica: \`sandbox-*\`), bez internetu i bez modelu językowego. Reguł nie zmieniano.`);
  out(`- **Kolejność.** Najpierw wszystkie analizy, potem prawda wzorcowa. Laboratorium: \`/api/ground-truth\` pobrane po analizach (strażnik na \`fetch\`); żądań w czasie pomiaru: laboratorium ${requests.lab}, piaskownica ${requests.sandbox}, zablokowanych (zakazane ścieżki, zapis, \`/_demo\`): ${requests.forbidden}, poza zbiorami: ${requests.blockedOther}. Piaskownica: przed analizami skrypt wziął z plików danych tylko listę adresów i nicków autorów; właścicieli wyznaczył w fazie oceny.`);
  out('- **Prawda wzorcowa — laboratorium:** właściciel = osoba, której portfel ma ten adres (`people[].walletAddresses`); adres zbiórki pośrednika (scenariusz `shared-payment-address`, posty z `walletOwnerPersonId = null`) nie należy do nikogo. „Opublikowany przez właściciela” = adres jest w publicznym polu portfeli któregoś konta tej osoby albo w jej poście z `addressUse = own`.');
  out('- **Prawda wzorcowa — piaskownica:** konta jednej osoby według plików danych i README (`SANDBOX_PERSONS` w skrypcie; skrypt sprawdza, że każde konto z `accounts` jest przypisane dokładnie raz — m.in. Rafał Kowalski i Julia Kowalska to jedna osoba, a dwa `marek88` i dwa `wilczek_x9` to różne osoby). Adres z etykietą klasy innej niż `private` = giełda / usługa / kontrakt; adres publikowany przez jedną osobę = jej adres; publikowany przez kilka osób = cytowany przez wielu (właściciel = autor wpisu otwierającego, np. konto rozdania); adres bez publikacji i bez etykiety = bez właściciela.');
  out('- **Klasyfikacja wyniku** (kandydat główny = `dossier.persons[0]` z prawdopodobieństwem > 0, konta = jego profile): **trafienie** — zawiera konto właściciela i żadnego konta innej osoby; **częściowe** — konto właściciela i konta innych osób; **błąd** — brak konta właściciela (dla adresów bez właściciela: każdy wskazany kandydat); **wstrzymanie** — teczka nie podaje kandydata.');
  out('- **Precision** = trafienia / (trafienia + błędy) — częściowe pokazane osobno. **Pokrycie** = trafienia / adresy prywatne opublikowane przez właściciela.');
  out();

  const examplesFor = (scored: Scored[], truth: Truth) => {
    const pick = (outcome: Outcome, limit: number, filter: (item: Scored) => boolean = () => true) => scored.filter((item) => item.outcome === outcome && filter(item)).slice(0, limit);
    const chosen = [
      // Trafienia: najpierw te, w których osoba ma kilka kont albo adres publikuje kilka osób.
      ...[...pick('trafienie', 100, (item) => item.truth.category === 'private_published')].sort((a, b) => b.run.mainAccounts.length + b.truth.publishers - (a.run.mainAccounts.length + a.truth.publishers)).slice(0, 2),
      ...pick('błąd', 2),
      ...pick('częściowe', 1),
      ...pick('trafienie', 1, (item) => item.truth.category === 'quoted_many'),
      ...pick('wstrzymanie', 1, (item) => item.truth.category === 'service'),
      ...pick('wstrzymanie', 1, (item) => item.truth.category === 'shared' || item.truth.category === 'quoted_many'),
      ...pick('wstrzymanie', 2, (item) => item.truth.category === 'private_published'),
    ];
    return chosen.map((item) => {
      const finding = item.run.finding;
      const findingText = finding ? `Adres w teczce: wynik ${finding.score}${finding.excluded ? ' (wykluczony)' : ''}${finding.widelyCited ? ', powszechnie cytowany' : ''}, śladów ${finding.evidence}, niepowiązanych publikujących ${finding.unrelatedPublishers}${finding.addressClass ? `, klasa ${finding.addressClass}` : ''}${finding.label ? ` („${finding.label}”)` : ''}; reguły: ${finding.rules.join(' → ') || '—'}` : 'Adresu brak w teczce';
      const who = item.persons.length > 0 ? `kandydat główny (prawdopodobieństwo ${item.run.mainProbability}): ${item.persons.map((person) => truth.label(person)).join(' + ')} — konta ${item.run.mainAccounts.join(', ')}` : 'brak kandydata';
      const reasons = item.outcome === 'wstrzymanie' ? item.run.explanations.map((explanation) => `[${explanation.kind}] ${explanation.text}`).join(' ') : item.run.mainReasons.slice(0, 3).join(' ');
      const name = sandbox.named.get(key(item.truth.address));
      return (
        `**${item.outcome.toUpperCase()}** — \`${item.truth.address}\`${name && item.run.dataset === 'sandbox' ? ` (\`${name}\`)` : ''} (${CATEGORY_TEXT[item.truth.category]}${item.truth.owner ? `; właściciel we wzorcu: ${truth.label(item.truth.owner)}` : ''}${item.truth.note ? `; ${item.truth.note}` : ''}). ` +
        `Wynik: ${who}. ${findingText}. ${reasons ? `Uzasadnienie w teczce: „${reasons.slice(0, 600)}”` : 'Teczka nie podaje żadnego wyjaśnienia (`explanations` puste).'}` +
        (item.outcome === 'wstrzymanie' ? ` Powód według pomiaru: ${abstainReason(item.run)}.` : '')
      );
    });
  };

  for (const { dataset, standard: m, deep } of summaries) {
    const truth = truthOf[dataset];
    const scored = scoredOf(dataset, 'standard');
    out(`## ${DATASET_TEXT[dataset]}`);
    out();
    const categories = [...new Set(truth.addresses.map((item) => item.category))] as Category[];
    out('### Wynik według rodzaju adresu (tryb standardowy)');
    out();
    table(
      ['Rodzaj adresu (wzorzec)', 'Adresów', 'Trafienie', 'Częściowe', 'Błąd', 'Wstrzymanie'],
      [
        ...categories.map((category) => {
          const list = scored.filter((item) => item.truth.category === category);
          const c = (outcome: Outcome) => list.filter((item) => item.outcome === outcome).length;
          return [CATEGORY_TEXT[category], list.length, c('trafienie'), c('częściowe'), c('błąd'), c('wstrzymanie')];
        }),
        ['**Razem**', m.n, m.hits, m.partial, m.errors, m.abstain],
      ],
    );
    out(`- **Precision przypisania:** ${pct(m.precision)} (trafienia: ${m.hits}, błędy: ${m.errors}; częściowe: ${m.partial}).`);
    out(`- **Pokrycie:** ${pct(m.coverage)} — ${m.publishedHits} z ${m.published} adresów, które prywatny właściciel sam opublikował; licząc też częściowe: ${pct(m.coverageWithPartial)}.`);
    out(`- **Adresy, które nie powinny wskazywać osoby** (${SHOULD_ABSTAIN.filter((category) => categories.includes(category)).map((category) => CATEGORY_TEXT[category]).join('; ') || 'brak takich w zbiorze'}): poprawne wstrzymanie ${m.abstainCorrect} z ${m.abstainGroup} (${pct(ratio(m.abstainCorrect, m.abstainGroup))}); wskazany właściciel konta, które podało adres jako swój (np. konto rozdania) ${m.abstainOwnerNamed}; wskazana niewłaściwa osoba ${m.abstainWrong}.`);
    out();

    const abstained = scored.filter((item) => item.outcome === 'wstrzymanie');
    if (abstained.length > 0) {
      out('### Dlaczego narzędzie wstrzymało się ze wskazaniem osoby');
      out();
      const reasons = new Map<string, Scored[]>();
      for (const item of abstained) reasons.set(abstainReason(item.run), [...(reasons.get(abstainReason(item.run)) ?? []), item]);
      table(
        ['Powód (z teczki)', 'Adresów', 'W tym rodzaje adresu wg wzorca'],
        [...reasons.entries()].sort((a, b) => b[1].length - a[1].length).map(([reason, list]) => {
          const byCategory = new Map<Category, number>();
          for (const item of list) byCategory.set(item.truth.category, (byCategory.get(item.truth.category) ?? 0) + 1);
          return [reason, list.length, [...byCategory.entries()].map(([category, count]) => `${CATEGORY_TEXT[category]}: ${count}`).join('; ')];
        }),
      );
      const kinds = new Map<string, number>();
      for (const item of abstained) for (const kind of new Set(item.run.explanations.map((explanation) => explanation.kind))) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      out(`Rodzaje wyjaśnień w teczkach bez kandydata (\`dossier.explanations[].kind\`, jedna teczka może mieć kilka): ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `\`${kind}\` ${count}`).join(', ') || '—'}.`);
      out();
    }

    out('### Czy prawdopodobieństwo kandydata oddziela trafienia od błędów');
    out();
    const describeList = (values: number[]) => (values.length === 0 ? '—' : `${values.length} szt.; min ${Math.min(...values)}, mediana ${num(median(values) ?? 0, 0)}, maks ${Math.max(...values)}`);
    table(
      ['Wynik', 'Prawdopodobieństwo kandydata głównego'],
      [
        ['Trafienia', describeList(m.hitProbabilities)],
        ['Częściowe', describeList(m.partialProbabilities)],
        ['Błędy', describeList(m.errorProbabilities)],
      ],
    );
    const buckets = [
      [0, 39],
      [40, 59],
      [60, 79],
      [80, 100],
    ];
    table(
      ['Przedział prawdopodobieństwa', 'Trafienia', 'Częściowe', 'Błędy'],
      buckets.map(([low, high]) => {
        const inBucket = (values: number[]) => values.filter((value) => value >= low! && value <= high!).length;
        return [`${low}–${high}`, inBucket(m.hitProbabilities), inBucket(m.partialProbabilities), inBucket(m.errorProbabilities)];
      }),
    );
    out('Liczymy tylko kandydatów z prawdopodobieństwem ≥ progu (pozostali = wstrzymanie):');
    out();
    table(
      ['Próg', 'Trafienia', 'Częściowe', 'Błędy', 'Precision', 'Pokrycie'],
      m.byThreshold.map((row) => [`≥ ${row.threshold}`, row.hits, row.partial, row.errors, pct(row.precision), pct(row.coverage)]),
    );
    const named = scored.filter((item) => item.outcome !== 'wstrzymanie');
    const bases = new Map<string, number>();
    for (const item of named) {
      const base = /^Podstawa (\d+)/.exec(item.run.mainReasons[0] ?? '')?.[1] ?? '?';
      bases.set(base, (bases.get(base) ?? 0) + 1);
    }
    const maxProbability = Math.max(0, ...named.map((item) => item.run.mainProbability));
    out(
      (m.errors === 0
        ? 'Błędów nie było, więc ten zbiór **nie pozwala sprawdzić**, czy prawdopodobieństwo kandydata odsiewa błędne wskazania — tabela pokazuje tylko, ile trafień traci się przy wyższym progu. '
        : '') +
        `Najwyższe prawdopodobieństwo kandydata w analizie samego adresu: ${maxProbability}. Podstawa prawdopodobieństwa osoby (pierwsza przesłanka kandydata): ${[...bases.entries()].map(([base, count]) => `${base} — ${count}×`).join(', ') || '—'}; resztę daje premia za mocne wiązania między profilami tej osoby (w uzasadnieniu: „Mocne wiązania między profilami (n): +x”). ` +
        (maxProbability < 80 ? 'Próg 80 odcina więc każde wskazanie: sam adres na profilu nie daje osobie wysokiej pewności, dopóki analityk jej nie potwierdzi.' : ''),
    );
    out();
    if (dataset === 'sandbox') {
      out('### Pułapki piaskownicy — adres po adresie');
      out();
      const traps = ['kacperBtc', 'namesakeBtc', 'exchangeBtc', 'stableEth', 'giveawayTron', 'dominikOldBtc', 'martaLabsTron', 'hubertTron', 'kowalBtc', 'nowakEth', 'depositEth', 'midBtc', 'lenaTron', 'kolekcjeTron', 'marekBtc', 'marekTron', 'wilczekBtc', 'wilczynskaTron', 'szpakBtc', 'baronBtc', 'jaskulaTron'];
      const byName = new Map(scored.map((item) => [sandbox.named.get(key(item.truth.address)), item]));
      table(
        ['Adres (nazwa w danych)', 'Wzorzec', 'Wynik', 'Kandydat główny (prawdopodobieństwo)', 'Adres w teczce'],
        traps
          .map((name) => byName.get(name))
          .filter((item): item is Scored => item !== undefined)
          .map((item) => [
            `\`${short(item.truth.address)}\` (${sandbox.named.get(key(item.truth.address))})`,
            `${CATEGORY_TEXT[item.truth.category]}${item.truth.owner ? ` — ${item.truth.owner}` : ''}`,
            item.outcome,
            item.persons.length > 0 ? `${item.run.mainAccounts.join(', ')} (${item.run.mainProbability})` : '—',
            item.run.finding ? `wynik ${item.run.finding.score}${item.run.finding.excluded ? ', wykluczony' : ''}; reguły: ${item.run.finding.rules.join(' → ') || '—'}` : 'brak',
          ]),
      );
    }

    if (deep) {
      out('### Tryb głęboki');
      out();
      out('W pomiarze nie ma łączników internetowych, więc tryb głęboki różni się wyłącznie limitami rozszerzania (więcej kroków i zapytań; łącznik `deep-search` istnieje tylko przy źródłach publicznych).');
      out();
      table(
        ['Tryb', 'Trafienie', 'Częściowe', 'Błąd', 'Wstrzymanie', 'Precision', 'Pokrycie', 'Mediana / P95 czasu'],
        [
          ['standardowy', m.hits, m.partial, m.errors, m.abstain, pct(m.precision), pct(m.coverage), `${num(quantile(m.times, 0.5) / 1000, 2)} s / ${num(quantile(m.times, 0.95) / 1000, 2)} s`],
          ['głęboki', deep.hits, deep.partial, deep.errors, deep.abstain, pct(deep.precision), pct(deep.coverage), `${num(quantile(deep.times, 0.5) / 1000, 2)} s / ${num(quantile(deep.times, 0.95) / 1000, 2)} s`],
        ],
      );
      const deepScored = scoredOf(dataset, 'deep');
      const changed = scored.filter((item) => deepScored.find((other) => key(other.run.query) === key(item.run.query))?.outcome !== item.outcome);
      out(changed.length === 0 ? 'Żaden adres nie zmienił klasyfikacji między trybami.' : `Zmiana klasyfikacji między trybami: ${changed.map((item) => `\`${short(item.truth.address)}\` ${item.outcome} → ${deepScored.find((other) => key(other.run.query) === key(item.run.query))?.outcome}`).join('; ')}.`);
      out();
    }

    out('### Czas analizy');
    out();
    const all = runs.filter((run) => run.dataset === dataset && run.kind === 'address');
    const failed = all.filter((run) => run.status !== 'completed' || run.partial);
    const withErrors = all.filter((run) => run.errors.length > 0);
    out(`Tryb standardowy: mediana ${num(quantile(m.times, 0.5) / 1000, 2)} s, P95 ${num(quantile(m.times, 0.95) / 1000, 2)} s, maks. ${num(Math.max(...m.times) / 1000, 2)} s (założenie sprawy + cała analiza; serwer zbioru działa na tej samej maszynie, więc bez opóźnień sieci). Analizy nieukończone lub częściowe: ${failed.length}; z błędem łącznika lub dostawcy w dzienniku: ${withErrors.length}.`);
    const unmapped = scored.filter((item) => item.run.unmappedMainProfiles > 0).length;
    if (unmapped > 0) out(`Uwaga: w ${unmapped} teczkach kandydat główny miał profile, których skrypt nie umiał przypisać do konta zbioru — liczone jako konta nieznanej osoby.`);
    out();

    out('### Przykłady');
    out();
    examplesFor(scored, truth).forEach((text, index) => out(`${index + 1}. ${text}`));
    out();
  }

  // ---------- Kierunek odwrotny ----------
  if (WITH_REVERSE) {
    out('## Kierunek odwrotny: od nicku właściciela do adresu');
    out();
    out('Ten sam przebieg: przed analizami uruchomiono analizę „sam nick” dla każdego konta, które publicznie podaje jakikolwiek adres (wybór z danych publicznych). Po odsłonięciu wzorca wybrano pary (właściciel, jego opublikowany adres) i pierwsze konto właściciela publikujące ten adres jako punkt startowy. Adres uznajemy za znaleziony i przypisany, gdy jest w teczce z Wskaźnikiem Pewności ≥ progu (adres niewykluczony, co najmniej jeden ślad).');
    out();
    const rows: (string | number)[][] = [];
    for (const dataset of ['lab', 'sandbox'] as Dataset[]) {
      const truth = truthOf[dataset];
      const nickRuns = runs.filter((run) => run.dataset === dataset && run.kind === 'nick');
      const pairs = truth.addresses.filter((item) => item.category === 'private_published' && item.owner);
      const evaluated: { address: string; run: RunRecord }[] = [];
      for (const pair of pairs) {
        const run = nickRuns.find((item) => item.startAccount && truth.personOf(item.startAccount) === pair.owner && (dataset === 'lab' ? (lab.publishers.get(key(pair.address)) ?? []).some((account) => account.id === item.startAccount) : sandbox.authorsOf(pair.address).some((publication) => publication.account === item.startAccount)));
        if (run) evaluated.push({ address: pair.address, run });
      }
      const foundAt = (threshold: number) => evaluated.filter(({ address, run }) => run.findings.some((finding) => key(finding.address) === key(address) && !finding.excluded && finding.evidence > 0 && finding.score >= threshold)).length;
      const inDossier = evaluated.filter(({ address, run }) => run.findings.some((finding) => key(finding.address) === key(address) && finding.evidence > 0)).length;
      const mainIsOwner = evaluated.filter(({ address, run }) => {
        const owner = truth.addresses.find((item) => key(item.address) === key(address))!.owner!;
        const persons = new Set(run.mainAccounts.map(truth.personOf));
        return persons.size === 1 && persons.has(owner);
      }).length;
      const foreignAt60 = evaluated.reduce((sum, { address, run }) => {
        const owner = truth.addresses.find((item) => key(item.address) === key(address))!.owner!;
        return sum + run.findings.filter((finding) => !finding.excluded && finding.evidence > 0 && finding.score >= 60 && truth.addresses.find((item) => key(item.address) === key(finding.address) && item.owner && item.owner !== owner)).length;
      }, 0);
      rows.push([DATASET_TEXT[dataset], `${evaluated.length} z ${pairs.length}`, `${inDossier} (${pct(ratio(inDossier, evaluated.length))})`, ...THRESHOLDS.map((threshold) => `${foundAt(threshold)} (${pct(ratio(foundAt(threshold), evaluated.length))})`), `${mainIsOwner} (${pct(ratio(mainIsOwner, evaluated.length))})`, foreignAt60]);
    }
    table(['Zbiór', 'Pary (właściciel, adres) ze startem', 'Adres w teczce', ...THRESHOLDS.map((threshold) => `Przypisany ≥ ${threshold}`), 'Osoba główna = tylko właściciel', 'Cudze adresy przypisane ≥ 60'], rows);
    out('Dla porównania pełniejszy pomiar tego kierunku w laboratorium (start: nick + e-mail, także konta bez własnego adresu) jest w [BENCHMARK-LAB.md](BENCHMARK-LAB.md), sekcja „(b) Przypisanie adresów do osoby”.');
    out();
  }

  // ---------- Czego ten pomiar nie mówi ----------
  out('## Czego ten pomiar nie mówi');
  out();
  out('- **Dane są syntetyczne i małe.** Oba zbiory wygenerowano tak, żeby zawierały przewidziane pułapki (imiennik, ten sam nick u dwóch osób, adres giełdy wklejony na forum, rozdanie, zbiórka pośrednika, fałszywy podpis). Wysoka precision znaczy tylko, że te pułapki nie zmyliły reguł; nie dowodzi skuteczności w prawdziwym internecie. Liczności są małe (kilkadziesiąt adresów na zbiór) — jeden przypadek przesuwa wynik o kilka punktów procentowych.');
  out('- **W prawdziwym świecie adres zwykle NIE jest nigdzie opublikowany.** W obu zbiorach większość adresów prywatnych ktoś podał publicznie — inaczej nie byłoby czego mierzyć. W rzeczywistości ogromna większość adresów nie ma żadnej publikacji i odpowiedzią narzędzia jest wtedy „brak kandydata”: pokrycie z tego pomiaru nie przenosi się na losowy adres z łańcucha.');
  out('- **Brak opóźnień i limitów.** Serwery zbiorów działają lokalnie; czasy nie zawierają opóźnień sieci ani limitów zapytań prawdziwych serwisów (w ustawieniach: do 20 s na zapytanie, 120 s na analizę).');
  out('- **Dwa kierunki błędu nie są symetryczne.** Dla zespołu dochodzeniowego błędne wskazanie osoby jest kosztowniejsze niż brak wskazania; dlatego najważniejsza liczba to „błąd”, a nie pokrycie.');
  out('- **Kontrole na prawdziwych danych (ręczne, poza tym pomiarem, 21.11.2026, tryb LIVE):**');
  out('  - adres z kradzieży Bitfinex 2016 `1CGA4srJbPWhtJb7ezgY6GQf4PKhFuzD9w` → teczka bez kandydata na osobę (7 autorów tylko wymienia adres; wyjaśnienie `no_owner`); wykryte przekazanie środków na adres rządu USA (zajęcie środków);');
  out('  - adres oszustwa z przejęcia kont Twittera 2020 `bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh` → adres powszechnie cytowany (61 niepowiązanych autorów), teczka bez kandydata, z wyjaśnieniem `no_owner`;');
  out('  - nazwa ENS `vitalik.eth` (start od nazwy, nie od adresu) → osoba wskazana i adres potwierdzony zapisem ENS;');
  out('  - sam adres `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` → jedyny kandydat `vitalik.eth` (90%) z rozwiązania odwrotnego ENS sprawdzonego w obie strony; 54 autorów wymieniających adres (m.in. README bibliotek z adresem jako przykładem) to wzmianki. Przed zmianą z 21.11.2026 README zwykłych repozytoriów liczyły się jako „własny profil”, więc kandydatów było 11 po 60% i pierwszym był autor biblioteki, nie właściciel nazwy.');
  out('  To cztery pojedyncze próby, nie statystyka — pokazują tylko, że mechanizmy wstrzymania (zajęcie, powszechne cytowanie) i potwierdzenia (ENS) działają także na prawdziwych danych.');
  out('- **Jeden przebieg, jeden seed laboratorium, stan piaskownicy z chwili pomiaru** (m.in. faza scenariusza podmiany adresu na `/_demo`; skrypt jej nie zmienia).');
  out();

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${lines.join('\n')}\n`, 'utf8');
  if (JSON_FILE) writeFileSync(JSON_FILE, JSON.stringify({ runs, truth: { lab: labT.addresses, sandbox: sandT.addresses } }, null, 1), 'utf8');

  console.log('\n=== Od adresu do osoby (tryb standardowy) ===');
  console.table(
    Object.fromEntries(
      summaries.map(({ dataset, standard: m }) => [
        dataset,
        { adresy: m.n, trafienie: m.hits, częściowe: m.partial, błąd: m.errors, wstrzymanie: m.abstain, precision: pct(m.precision), pokrycie: pct(m.coverage), 'wstrzymanie poprawne': `${m.abstainCorrect}/${m.abstainGroup}`, 'mediana s': num(quantile(m.times, 0.5) / 1000, 2), 'p95 s': num(quantile(m.times, 0.95) / 1000, 2) },
      ]),
    ),
  );
  console.log(`Raport: ${OUT_FILE}`);
}

/** Konta piaskownicy (`serwis:nick`), które publikują jakikolwiek adres — punkty startowe kierunku odwrotnego. */
function data2accounts(data: Awaited<ReturnType<typeof sandboxData>>): string[] {
  return data.universe.flatMap((address) => data.authorsOf(address).map((item) => item.account));
}

await main();
