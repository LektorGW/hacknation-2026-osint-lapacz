// Pomiar narzędzia na laboratorium tożsamości (apps/identity-lab): łączenie kont jednej osoby,
// przypisanie adresów i czas analizy — twarde liczby względem prawdy wzorcowej laboratorium.
//
// Uruchomienie (laboratorium musi działać: `pnpm --filter synthetic-identity-lab start`):
//   node scripts/benchmark-lab.ts [--lab http://127.0.0.1:8787] [--sample 60] [--no-full] [--out docs/BENCHMARK-LAB.md] [--json plik.json]
// `--no-full` pomija pełny przegląd (każde konto jako punkt startowy) i skraca pomiar do około 2 minut.
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
/** Pełny przegląd: każde konto laboratorium jest punktem startowym osobnej analizy (nick + e-mail). */
const FULL_SWEEP = !args.includes('--no-full');
/** Po tylu analizach powstaje nowa aplikacja z pustą bazą. */
const APP_RECYCLE = 40;
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

const CUE_ORDER = ['same_email', 'email_variant', 'same_handle', 'handle_variant', 'bio_alias', 'name_location', 'name_only', 'location_only', 'none'];
/** Co oznacza najmocniejsza publiczna cecha łącząca POMINIĘTE konto z kontami, które narzędzie znalazło. */
const MISS_TEXT: Record<string, string> = {
  same_email: 'ten sam e-mail co konto znalezione — ale znalezione tylko jako „powiązana tożsamość”; narzędzie nie rozwija dalej tożsamości powiązanych',
  email_variant: 'wariant tego samego e-maila (dopisek „+…”, kropki w nazwie skrzynki) — narzędzie porównuje e-maile dosłownie',
  same_handle: 'ten sam nick co znalezione konto, bez zgodnej nazwy wyświetlanej ani miejscowości — sam nick ma wagę 20 przy progu łączenia 50',
  handle_variant: 'wariant nicku znalezionego konta (inne separatory: „.”, „_”, „-”) — narzędzie szuka tylko dokładnego nicku',
  bio_alias: 'opis wprost wskazuje drugie konto („piszę jako …”, „dawniej …”) — ani łącznik, ani reguły nie czytają takich wskazań',
  name_location: 'ta sama nazwa wyświetlana i ta sama miejscowość — w regułach to za mało (nazwa 15, miejscowość bez wagi, próg 50), a nazwa konta nie jest używana do dalszego wyszukiwania',
  name_only: 'tylko ta sama nazwa wyświetlana',
  location_only: 'tylko ta sama miejscowość',
  none: 'brak jakiejkolwiek publicznej cechy wspólnej (np. konto pod przybraną tożsamością) — pominięcie jest poprawne',
};
const REASON_KIND_TEXT: Record<string, string> = {
  address: 'przesłanka „adres podmiotu publikuje jako własny także profil …”',
  email: 'przesłanka „publikacja podaje e-mail podmiotu” / „ten sam e-mail”',
  transfer: 'przesłanka przelewów między adresami',
  other: 'inna przesłanka',
};

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
  // Pełny przegląd: każde konto jako punkt startowy; bez niego tylko konta potrzebne do prób.
  const neededIds = new Set([...sampleStarts, ...addressStarts, ...trapStarts].map((account) => account.id));
  const fullStarts = FULL_SWEEP ? ordered : ordered.filter((account) => neededIds.has(account.id));

  console.log(`Laboratorium ${LAB_URL}: seed ${status.meta.seed}, osób ${status.meta.people}, kont ${accounts.length}, adresów publicznych ${publishers.size}.`);
  console.log(`Analizy: ${fullStarts.length} kont (nick + e-mail)${FULL_SWEEP ? ' — pełny przegląd' : ''}, ${sampleStarts.length} kandydatów próby w wariancie „sam nick”, ${sharedNicks.length} wspólnych nicków.`);

  const connectors = createConnectors({ labUrl: LAB_URL });
  const providers = createChainProviders({ labUrl: LAB_URL });
  const connectorIds = connectors.map((connector) => connector.id);
  // Co `APP_RECYCLE` analiz powstaje nowa aplikacja z pustą bazą: analizy są od siebie niezależne,
  // a czas składania teczki nie rośnie z liczbą wcześniejszych spraw.
  let current: { app: App; close: () => Promise<void>; used: number } | undefined;
  const appFor = async (): Promise<App> => {
    if (current && current.used < APP_RECYCLE) {
      current.used++;
      return current.app;
    }
    await current?.close();
    const storage = createStorage(await createPgliteDriver());
    await storage.migrate();
    const app = await buildApp({ storage, connectors, chainProviders: providers, deepChainProviders: providers, resolveActivity: getActivityFromProviders, matchService, normalizeText: normalizeAddressText, ai: null });
    current = {
      app,
      used: 1,
      close: async () => {
        await app.close();
        await storage.close();
      },
    };
    return app;
  };

  phase = 'analysis';
  const runs: RunSummary[] = [];
  const plan: { set: string; variant: RunSummary['variant']; start: PublicAccount }[] = [
    ...fullStarts.map((start) => ({ set: 'all', variant: 'nick+email' as const, start })),
    ...sampleStarts.map((start) => ({ set: 'sample-nick', variant: 'nick' as const, start })),
    ...sharedNicks.map(([, list]) => ({ set: 'nick', variant: 'nick' as const, start: list[0]! })),
  ];
  const wallStarted = performance.now();
  for (const [index, item] of plan.entries()) {
    runs.push(await analyze(await appFor(), connectorIds, item.set, item.variant, item.start));
    if ((index + 1) % 100 === 0 || index + 1 === plan.length) console.log(`  analiz ${index + 1}/${plan.length} (${((performance.now() - wallStarted) / 1000).toFixed(0)} s)`);
  }
  await current?.close();
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
  const truthOf = (run: RunSummary) => accountsOfPerson.get(personOf.get(run.startAccount)!)!;
  const ownedOf = (run: RunSummary) => ownedBy.get(personOf.get(run.startAccount)!) ?? [];

  /** Pierwszy punkt startowy każdej osoby (w podanej kolejności) — żadna osoba nie liczy się dwa razy. */
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
  const allRuns = runs.filter((run) => run.set === 'all');
  const runOf = new Map(allRuns.map((run) => [run.startAccount, run]));
  const pick = (starts: PublicAccount[]) => starts.map((account) => runOf.get(account.id)).filter((run): run is RunSummary => run !== undefined);
  const sampleFull = distinctPersons(pick(sampleStarts), SAMPLE_PERSONS);
  const sampleIds = new Set(sampleFull.map((run) => run.startAccount));
  const sampleNick = runs.filter((run) => run.set === 'sample-nick' && sampleIds.has(run.startAccount));
  const addressSet = distinctPersons(pick(addressStarts));
  const trapRuns = distinctPersons(pick(trapStarts));
  const nickSetRuns = runs.filter((run) => run.set === 'nick');

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
      const truthSet = new Set(truthOf(run));
      const predicted = new Set(predict(run));
      const tp = [...predicted].filter((account) => truthSet.has(account)).length;
      const fp = predicted.size - tp;
      micro.tp += tp;
      micro.fp += fp;
      micro.fn += truthSet.size - tp;
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
    { label: `Próba główna (${sampleFull.length} osób), start: nick + e-mail — osoba główna + „prawdopodobnie ta sama osoba”`, short: 'próba, nick+e-mail, główna + ta sama os.', result: linking(sampleFull, mainAndSame) },
    { label: `Próba główna (${sampleFull.length} osób), start: nick + e-mail — tylko profile osoby głównej`, short: 'próba, nick+e-mail, tylko główna', result: linking(sampleFull, mainOnly) },
    { label: `Próba główna (${sampleNick.length} osób), start: sam nick — osoba główna + „prawdopodobnie ta sama osoba”`, short: 'próba, sam nick, główna + ta sama os.', result: linking(sampleNick, mainAndSame) },
    ...(FULL_SWEEP ? [{ label: `Pełny przegląd (${allRuns.length} kont jako punkty startowe), start: nick + e-mail — osoba główna + „prawdopodobnie ta sama osoba”`, short: 'pełny przegląd, główna + ta sama os.', result: linking(allRuns, mainAndSame) }] : []),
  ];
  const startRoles = ['ordinary', 'multi', 'fake'].map((role) => ({ role, result: linking(allRuns.filter((run) => roleOf.get(run.startAccount) === role), mainAndSame) }));

  // ---------- Przyczyny błędów łączenia (z danych publicznych i wzorca) ----------
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
  /** Najmocniejsza publiczna cecha między dwoma zbiorami kont. */
  function bestCue(left: string[], right: string[]): { cue: string; from?: PublicAccount; to?: PublicAccount } {
    let best: { cue: string; from?: PublicAccount; to?: PublicAccount } = { cue: 'none' };
    for (const a of left) {
      for (const b of right) {
        if (a === b) continue;
        const cue = cueBetween(byId.get(a)!, byId.get(b)!);
        if (CUE_ORDER.indexOf(cue) < CUE_ORDER.indexOf(best.cue)) best = { cue, from: byId.get(a)!, to: byId.get(b)! };
      }
    }
    return best;
  }
  const describe = (account: PublicAccount | undefined) => (account ? `${account.id} (@${account.username}, ${account.serviceId}, „${account.displayName}”)` : '?');
  const contact = (account: PublicAccount) => `e-maile: ${emailsOf(account).join(', ')}; miejscowość: ${account.location}`;

  interface ErrorExample {
    key: string;
    cue: string;
    text: string;
  }
  const reasonKind = (texts: string[]) => (texts.some((text) => /publikuje jako własny/.test(text)) ? 'address' : texts.some((text) => /e-mail/.test(text)) ? 'email' : texts.some((text) => /[Pp]rzelew/.test(text)) ? 'transfer' : 'other');

  function linkingErrors(list: RunSummary[], predict: Predictor) {
    const missed = new Map<string, ErrorExample[]>();
    const extra = new Map<string, ErrorExample[]>();
    const add = (target: Map<string, ErrorExample[]>, example: ErrorExample) => target.set(example.key, [...(target.get(example.key) ?? []), example]);
    for (const run of list) {
      const truthSet = truthOf(run);
      const predicted = new Set(predict(run));
      const found = truthSet.filter((id) => predicted.has(id));
      const unfound = truthSet.filter((id) => !predicted.has(id));
      for (const id of unfound) {
        // „Wyspa”: niezałączone konta osoby połączone cechami, które narzędzie rozpoznaje (ten sam e-mail lub nick).
        // Przyczyną pominięcia całej wyspy jest brak mostu między nią a kontami już znalezionymi.
        const island = new Set([id]);
        for (let grown = true; grown; ) {
          grown = false;
          for (const other of unfound) {
            if (island.has(other)) continue;
            if ([...island].some((member) => ['same_email', 'same_handle'].includes(cueBetween(byId.get(member)!, byId.get(other)!)))) {
              island.add(other);
              grown = true;
            }
          }
        }
        const bridge = bestCue([...island], found);
        const account = byId.get(id)!;
        const viaIsland = bridge.from !== undefined && bridge.from.id !== id;
        add(missed, {
          key: bridge.cue,
          cue: bridge.cue,
          text:
            `Start: ${describe(byId.get(run.startAccount))}. Pominięte konto: ${describe(account)}, rola we wzorcu \`${roleOf.get(id)}\` (${contact(account)}).` +
            (bridge.from && bridge.to
              ? ` Najmocniejsza cecha łącząca${viaIsland ? ` (przez konto ${describe(bridge.from)} dzielące z nim e-mail lub nick)` : ''} ze znalezionym kontem ${describe(bridge.to)} (${contact(bridge.to)}): ${MISS_TEXT[bridge.cue]}.`
              : ` ${MISS_TEXT.none}.`) +
            (bridge.cue === 'bio_alias' ? ` Opisy: „${(bridge.from ?? account).bio.slice(0, 220)}” / „${(bridge.to ?? account).bio.slice(0, 220)}”.` : ''),
        });
      }
      for (const id of predicted) {
        if (truthSet.includes(id)) continue;
        const account = byId.get(id)!;
        const { cue, to } = bestCue([id], found);
        const inMain = run.mainAccounts.includes(id);
        const toolReasons = inMain ? (run.identityReasons[id] ?? []) : (run.reasons[id] ?? []);
        const kind = reasonKind(toolReasons);
        add(extra, {
          key: `${inMain ? 'w osobie głównej' : 'relacja „prawdopodobnie ta sama osoba”'}; ${REASON_KIND_TEXT[kind]}; publiczna cecha wspólna z kontami osoby: ${cue}`,
          cue: `${kind}|${cue}`,
          text:
            `Start: ${describe(byId.get(run.startAccount))}. Błędnie dołączone konto: ${describe(account)} — inna osoba (${contact(account)}).` +
            `${to ? ` Publiczna cecha wspólna z kontem ${describe(to)}: ${cue}.` : ''} Przesłanka narzędzia: „${toolReasons.slice(0, 2).join(' ') || 'brak opisu'}”`,
        });
      }
    }
    return { missed, extra };
  }
  const errorsSample = linkingErrors(sampleFull, mainAndSame);
  const errorsAll = linkingErrors(allRuns, mainAndSame);
  const total = (groups: Map<string, ErrorExample[]>) => [...groups.values()].reduce((sum, list) => sum + list.length, 0);

  // ---------- (b) Adresy ----------
  type Scorer = (finding: FindingSummary) => number;
  const byConfidence: Scorer = (finding) => (finding.excluded ? -1 : finding.score);
  const bySubject: Scorer = (finding) => (finding.excluded ? -1 : finding.subjectProbability);
  const assigned = (run: RunSummary, scorer: Scorer, threshold: number) => new Set(run.findings.filter((finding) => finding.evidence > 0 && scorer(finding) >= threshold).map((finding) => finding.address));
  /** Czy wszyscy publikujący adres to konta właściciela (wtedy „niepowiązani publikujący” są w rzeczywistości jego kontami). */
  const onlyOwnPublishers = (address: string, person: string) => (publishers.get(address) ?? []).every((account) => personOf.get(account.id) === person);
  function addressMetrics(list: RunSummary[], scorer: Scorer, threshold: number) {
    const counts = emptyCounts();
    let fpIntermediary = 0;
    let fpOtherPerson = 0;
    const missReasons = { notReached: 0, sharedPenaltyOwnAccounts: 0, sharedPenaltyOther: 0, lowScore: 0 };
    const examples: { kind: string; text: string }[] = [];
    for (const run of list) {
      const person = personOf.get(run.startAccount)!;
      const owned = new Set(ownedOf(run));
      const predicted = assigned(run, scorer, threshold);
      for (const address of predicted) {
        if (owned.has(address)) counts.tp++;
        else {
          counts.fp++;
          if (intermediary.has(address)) fpIntermediary++;
          else fpOtherPerson++;
          const finding = run.findings.find((item) => item.address === address)!;
          examples.push({ kind: 'fp', text: `Start ${describe(byId.get(run.startAccount))}: błędnie przypisany adres \`${address}\` (${intermediary.has(address) ? 'adres pośrednika' : 'właściciel we wzorcu: inna osoba'}), wynik ${finding.score}, niepowiązanych publikujących ${finding.unrelatedPublishers}, reguły: ${finding.rules.join(' → ')}.` });
        }
      }
      for (const address of owned) {
        if (predicted.has(address)) continue;
        counts.fn++;
        const finding = run.findings.find((item) => item.address === address && item.evidence > 0);
        if (!finding) {
          missReasons.notReached++;
          const publishing = (publishers.get(address) ?? []).filter((account) => personOf.get(account.id) === person);
          examples.push({ kind: 'notReached', text: `Start ${describe(byId.get(run.startAccount))}: własny adres \`${address}\` nie trafił do teczki — publikują go konta tej osoby ${publishing.slice(0, 3).map(describe).join(', ')}, do których narzędzie nie dotarło z konta startowego (znalezione konta: ${run.mainAccounts.join(', ') || '—'}).` });
        } else if (finding.rules.includes('penalty.shared_address')) {
          const own = onlyOwnPublishers(address, person);
          if (own) missReasons.sharedPenaltyOwnAccounts++;
          else missReasons.sharedPenaltyOther++;
          examples.push({ kind: own ? 'ownPenalty' : 'otherPenalty', text: `Start ${describe(byId.get(run.startAccount))}: własny adres \`${address}\` dostał wynik ${finding.score} (reguły: ${finding.rules.join(' → ')}), bo narzędzie policzyło ${finding.unrelatedPublishers} „niepowiązanych publikujących”${own ? ` — a wszystkie konta publikujące ten adres (${(publishers.get(address) ?? []).map((account) => `@${account.username}`).join(', ')}) należą do tej samej osoby` : ''}.` });
        } else {
          missReasons.lowScore++;
          examples.push({ kind: 'lowScore', text: `Start ${describe(byId.get(run.startAccount))}: własny adres \`${address}\` z wynikiem ${finding.score}${finding.excluded ? ' (wykluczony)' : ''} poniżej progu ${threshold}; reguły: ${finding.rules.join(' → ')}.` });
        }
      }
    }
    return { runs: list.length, counts, precision: precisionOf(counts), recall: recallOf(counts), f1: f1Of(precisionOf(counts), recallOf(counts)), fpIntermediary, fpOtherPerson, missReasons, examples };
  }
  const withWallet = (list: RunSummary[]) => list.filter((run) => ownedOf(run).length > 0);
  const publishesOwn = (run: RunSummary) => ownedOf(run).some((address) => byId.get(run.startAccount)!.walletAddresses.includes(address));
  const allWithWallet = withWallet(allRuns);
  const addressSets: [string, RunSummary[]][] = [
    [`Próba główna (${sampleFull.length} osób, ${withWallet(sampleFull).length} z portfelem)`, sampleFull],
    [`Zbiór adresowy: start z konta, które samo publikuje adres (${addressSet.length} osób)`, addressSet],
    ...(FULL_SWEEP
      ? ([
          [`Pełny przegląd: wszystkie konta (${allRuns.length} punktów, ${allWithWallet.length} u osób z portfelem)`, allRuns],
          [`Pełny przegląd: konta osób z portfelem, które same adresu NIE publikują (${allWithWallet.filter((run) => !publishesOwn(run)).length} punktów)`, allWithWallet.filter((run) => !publishesOwn(run))],
          [`Pełny przegląd: konta osób z portfelem, które same publikują adres (${allWithWallet.filter(publishesOwn).length} punktów)`, allWithWallet.filter(publishesOwn)],
        ] as [string, RunSummary[]][])
      : []),
  ];
  const widest = FULL_SWEEP ? allRuns : sampleFull;

  // ---------- Pułapka wspólnego adresu pośrednika ----------
  const trapAddress = widely?.[0];
  const trapIsIntermediary = trapAddress !== undefined && intermediary.has(trapAddress);
  const foreign = (run: RunSummary, list: string[]) => list.filter((account) => !truthOf(run).includes(account));
  const trap = trapRuns.map((run) => ({ run, finding: run.findings.find((item) => item.address === trapAddress), foreignMain: foreign(run, run.mainAccounts), foreignSame: foreign(run, run.sameLikelyAccounts), foreignPossibly: foreign(run, run.possiblyAccounts) }));

  // ---------- Pułapka tego samego nicku ----------
  const nickRuns = nickSetRuns.map((run) => {
    const group = nickGroups.get(handleKey(byId.get(run.startAccount)!.username))!;
    const persons = new Set(group.map((account) => personOf.get(account.id)!));
    const mainPersons = new Map<string, number>();
    for (const account of run.mainAccounts) mainPersons.set(personOf.get(account)!, (mainPersons.get(personOf.get(account)!) ?? 0) + 1);
    const majority = [...mainPersons.entries()].sort((a, b) => b[1] - a[1])[0];
    const covered = new Set([...run.mainAccounts, ...run.sameLikelyAccounts]);
    return {
      run,
      nick: byId.get(run.startAccount)!.username,
      group,
      crossPerson: persons.size > 1,
      persons,
      mainPersons: mainPersons.size,
      sameCross: run.sameLikelyAccounts.filter((account) => majority && personOf.get(account) !== majority[0]),
      groupCovered: group.filter((account) => covered.has(account.id)).length,
    };
  });
  const crossNick = nickRuns.filter((item) => item.crossPerson);
  const sameNick = nickRuns.filter((item) => !item.crossPerson);
  const crossMerged = crossNick.filter((item) => item.mainPersons > 1);
  const crossSame = crossNick.filter((item) => item.sameCross.length > 0);
  const sameNickJoined = sameNick.filter((item) => item.groupCovered === item.group.length).length;
  // Analizy startujące z dowolnego konta osób, które dzielą nick z inną osobą.
  const nickPersons = new Set(crossNick.flatMap((item) => [...item.persons]));
  const nickPersonRuns = allRuns.filter((run) => nickPersons.has(personOf.get(run.startAccount)!));
  const nickPersonErrors = nickPersonRuns.filter((run) => foreign(run, mainAndSame(run)).length > 0);

  // ---------- (c) Czas ----------
  const timeOf = (list: RunSummary[]) => ({ n: list.length, mean: mean(list.map((run) => run.analysisMs)) ?? 0, median: quantile(list.map((run) => run.analysisMs), 0.5), p95: quantile(list.map((run) => run.analysisMs), 0.95), max: Math.max(0, ...list.map((run) => run.analysisMs)) });
  const failed = runs.filter((run) => run.status !== 'completed' || run.partial);
  const withErrors = runs.filter((run) => run.errors.length > 0);
  const timeRows: [string, ReturnType<typeof timeOf>][] = [
    ['Wszystkie analizy', timeOf(runs)],
    [`Start: nick + e-mail (${FULL_SWEEP ? 'pełny przegląd' : 'konta prób'})`, timeOf(allRuns)],
    ['Próba główna, nick + e-mail', timeOf(sampleFull)],
    ['Próba główna, sam nick', timeOf(sampleNick)],
    ['Konta publikujące adres pośrednika', timeOf(pick(trapStarts))],
    ['Wspólne nicki, start: sam nick', timeOf(nickSetRuns)],
  ];

  // ---------- Błędy narzędzia jako rekomendacje ----------
  interface Recommendation {
    title: string;
    count: string;
    text: string;
    example?: string;
  }
  const recommendations: Recommendation[] = [];
  const scope = FULL_SWEEP ? `pełny przegląd, ${allRuns.length} analiz` : `${allRuns.length} analiz`;
  const missedOf = (cue: string) => errorsAll.missed.get(cue) ?? [];
  const extraWhere = (test: (cue: string) => boolean) => [...errorsAll.extra.values()].flat().filter((example) => test(example.cue));
  const address60 = addressMetrics(widest, byConfidence, 60);
  const pushMiss = (cue: string, title: string, text: string) => {
    const list = missedOf(cue);
    if (list.length > 0) recommendations.push({ title, count: `${list.length} pominiętych kont (${scope})`, text, example: list[0]!.text });
  };
  pushMiss('name_location', 'Konta tej samej osoby z tą samą nazwą wyświetlaną i miejscowością, ale innym e-mailem i nickiem, zostają osobno', 'Reguły łączą profile dopiero od wagi 50; zgodna nazwa wyświetlana daje 15, a miejscowość sama nic. Narzędzie w ogóle nie szuka po nazwie wyświetlanej znalezionego profilu, więc takie konto nie trafia nawet na listę kandydatów. Rekomendacja: wyszukiwać po nazwie wyświetlanej potwierdzonego profilu i pokazywać trafienia ze zgodną miejscowością jako kandydatów „możliwe: ta sama osoba” do decyzji analityka (bez automatycznego łączenia).');
  pushMiss('email_variant', 'Warianty tego samego e-maila nie są rozpoznawane', 'E-maile porównywane są dosłownie, więc `jan.k+kontakt@…` i `jan.k@…` to dla narzędzia dwie różne skrzynki. Rekomendacja: przy porównaniu i wyszukiwaniu sprowadzać e-mail do postaci bez dopisku „+…” (i oznaczać takie dopasowanie jako słabsze niż dosłowne).');
  pushMiss('handle_variant', 'Warianty nicku (kropka, podkreślenie, łącznik) nie są wyszukiwane', 'Łączniki szukają dokładnego nicku, a pętla rozszerzania odcina tylko cyfry i przyrostki. Konto `imie.nazwisko12` i `imie_nazwisko12` tej samej osoby nie spotykają się. Rekomendacja: generować warianty separatorów jako słaby trop (do potwierdzenia inną cechą, np. miejscowością).');
  pushMiss('bio_alias', 'Wskazanie drugiego konta w opisie profilu nie jest czytane', 'Opisy typu „Na forum X piszę jako …” albo „Dawniej …” to jawne wskazanie własnego konta, ale ani łącznik, ani reguły ich nie interpretują (czytane są tylko e-maile i wzmianki `@konto`). Rekomendacja: wyodrębniać nazwy kont z takich zwrotów jako odkryte identyfikatory o statusie „wskazane przez profil”.');
  pushMiss('same_handle', 'Ten sam nick bez zgodnej nazwy lub miejscowości nie wystarcza do połączenia', 'To zachowanie zamierzone (sam nick ma wagę 20 przy progu 50) — chroni przed sklejaniem różnych osób, ale kosztuje pominięcia, gdy osoba podaje na kontach różne nazwy wyświetlane. Do rozważenia: pokazywać takie konta jako kandydatów do decyzji analityka.');
  pushMiss('same_email', 'Tożsamości powiązane nie są rozwijane dalej', 'Konto uznane za „prawdopodobnie tę samą osobę” (np. przez wspólny adres) nie staje się punktem wyjścia do dalszego łączenia: inne konta z tym samym e-mailem zostają poza wynikiem. Rekomendacja: po uznaniu tożsamości za tę samą osobę wykonać dla niej krok łączenia po e-mailu.');
  const ownPenalty = address60.examples.filter((example) => example.kind === 'ownPenalty');
  if (ownPenalty.length > 0) {
    recommendations.push({
      title: 'Własne konta osoby liczone jako „niepowiązani publikujący” obniżają wynik jej własnego adresu',
      count: `${ownPenalty.length} analiz, w których własny adres spadł poniżej progu 60 (${scope})`,
      text: 'Adres opublikowany przez kilka kont tej samej osoby pod różnymi nickami dostaje karę za „adres współdzielony” (−30), bo konta, których narzędzie nie połączyło z osobą, liczy jako obcych publikujących. Błąd łączenia kont przenosi się więc na ocenę adresu. Rekomendacja: przed naliczeniem kary sprawdzać, czy publikujący nie mają cech wspólnych z podmiotem (nazwa wyświetlana, miejscowość, wariant e-maila), i wtedy traktować ich jako możliwe własne konta, nie jako obcych.',
      example: ownPenalty[0]!.text,
    });
  }
  const notReached = address60.examples.filter((example) => example.kind === 'notReached');
  if (notReached.length > 0) {
    recommendations.push({
      title: 'Adres osoby pozostaje nieznaleziony, gdy publikuje go konto, którego narzędzie nie połączyło z kontem startowym',
      count: `${notReached.length} analiz bez własnego adresu osoby w teczce (${scope})`,
      text: 'To bezpośredni skutek niskiego recall łączenia kont: adres jest publiczny, ale na koncie z innej „wyspy” e-mailowej tej samej osoby. Każda poprawa łączenia (punkty wyżej) podnosi też recall adresów. Teczka nie sygnalizuje analitykowi, że w tych samych portalach istnieją konta o tej samej nazwie wyświetlanej i miejscowości publikujące adres.',
      example: notReached[0]!.text,
    });
  }
  const byNickGrouping = extraWhere((cue) => cue === 'address|same_handle');
  if (byNickGrouping.length > 0) {
    recommendations.push({
      title: 'Powiązane tożsamości są grupowane po samym nicku — przesłanka jednego konta przechodzi na cudze konto o tym samym nicku',
      count: `${byNickGrouping.length} błędnie dołączonych kont (${scope})`,
      text: '`buildLinkedIdentities` (apps/api/src/aliases.ts) składa profile w tożsamość po kluczu „nick”, niezależnie od serwisu. Gdy konto podmiotu o popularnym nicku publikuje jego adres, do tej samej tożsamości trafia konto innej osoby o tym samym nicku w innym serwisie i dostaje relację „prawdopodobnie ta sama osoba”. Rekomendacja: grupować po `serwis|nick`, a profile o tym samym nicku z różnych serwisów łączyć tylko przy drugiej zgodnej cesze.',
      example: byNickGrouping[0]!.text,
    });
  }
  const byForeignEmail = extraWhere((cue) => cue.startsWith('email|'));
  if (byForeignEmail.length > 0) {
    recommendations.push({
      title: 'Pętla rozszerzania bierze cechy także z profili, które nie należą do osoby głównej',
      count: `${byForeignEmail.length} błędnie dołączonych kont (${scope})`,
      text: 'W `runAnalysis` punktem wyjścia tropów są wszystkie profile w roli „podmiot” — także profil innej osoby o tym samym nicku, który w teczce jest osobnym kandydatem. Jego e-mail jest potem opisywany jako „e-mail podmiotu”, a kolejne konto z tym e-mailem dostaje relację „prawdopodobnie ta sama osoba”. Rekomendacja: tropy z cech profilu oceniać względem osoby głównej (cecha musi pochodzić z profilu zaliczonego do osoby głównej).',
      example: byForeignEmail[0]!.text,
    });
  }
  const otherExtra = extraWhere((cue) => cue !== 'address|same_handle' && !cue.startsWith('email|'));
  if (otherExtra.length > 0) {
    recommendations.push({
      title: 'Pozostałe błędne dołączenia kont',
      count: `${otherExtra.length} błędnie dołączonych kont (${scope})`,
      text: 'Przypadki spoza dwóch mechanizmów opisanych wyżej — do ręcznego przejrzenia.',
      example: otherExtra[0]!.text,
    });
  }
  const possiblyForeign = allRuns.filter((run) => foreign(run, run.possiblyAccounts).length > 0);
  if (possiblyForeign.length > 0) {
    const sample = possiblyForeign[0]!;
    const account = foreign(sample, sample.possiblyAccounts)[0]!;
    recommendations.push({
      title: 'Przelewy w obie strony dają relację „możliwe: ta sama osoba albo bliska” między obcymi osobami',
      count: `${possiblyForeign.length} analiz z co najmniej jednym cudzym kontem w tej relacji (${scope}; relacja nie jest wliczana do miar łączenia)`,
      text: 'To relacja pomocnicza i jej opis uczciwie mówi „albo osoba bliska”, ale w łańcuchu, w którym obce osoby zwyczajnie sobie płacą, pojawia się często. Rekomendacja: przy samych przelewach w obie strony (bez innej przesłanki) używać relacji „osoba powiązana”, a „możliwe: ta sama osoba” zostawić dla przesłanek dotyczących tożsamości.',
      example: `Start: ${describe(byId.get(sample.startAccount))}. Cudze konto: ${describe(byId.get(account))}. Przesłanka narzędzia: „${(sample.reasons[account] ?? []).slice(0, 1).join(' ')}”`,
    });
  }
  if (trapAddress && trapIsIntermediary) {
    const excludedBy = trap.filter((item) => item.finding?.rules.includes('exclusion.widely_cited')).length;
    const labelled = trap.find((item) => item.finding)?.finding;
    recommendations.push({
      title: 'Adres pośrednika odrzuca wyłącznie liczba publikujących — etykieta z eksploratora nie jest wykorzystywana',
      count: `${excludedBy} z ${trap.length} analiz: wykluczenie regułą „adres powszechnie cytowany” (próg 10 niepowiązanych autorów)`,
      text: `W tym zbiorze adres zbiórki publikuje ${widely![1].length} kont, więc próg zadziałał w każdej analizie. Ale rejestr łańcucha LAB nazywa ten portfel wprost „Portfel pośrednika LAB”, a narzędzie nadaje mu klasę \`${labelled?.addressClass ?? 'unknown'}\` (etykieta bez klasy). Z reguł wynika, że przy 3–9 publikujących adres dostałby tylko karę −30 (własny profil 85 → 55), a przy 1–2 publikujących (bazowy scenariusz laboratorium: dwie osoby) nie byłoby żadnej korekty. Tego przypadku pomiar NIE objął. Rekomendacja: słowa „pośrednik”, „zbiórka”, „escrow” w etykiecie eksploratora traktować jako sygnał klasy pośrednika (do weryfikacji), niezależnie od liczby publikujących.`,
    });
  }
  const fakeMissed = missedOf('none');
  if (fakeMissed.length > 0) {
    recommendations.push({
      title: 'Konta bez żadnej publicznej cechy wspólnej nie są łączone — zachowanie poprawne, ale obniża recall',
      count: `${fakeMissed.length} pominiętych kont (${scope})`,
      text: 'Konta pod przybraną tożsamością (inna nazwa, e-mail, często miejscowość) nie mają w danych publicznych nic, co łączyłoby je z osobą. Narzędzie ich nie zgaduje i nie powinno; wzorzec liczy je jednak jako konta osoby, więc recall 100% jest na tym zbiorze nieosiągalny bez fałszywych połączeń.',
      example: fakeMissed[0]!.text,
    });
  }

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
  const truthSizes = sampleFull.map((run) => truthOf(run).length);
  const roleTotals = truth.accountLinks.reduce<Record<string, number>>((acc, link) => ({ ...acc, [link.role]: (acc[link.role] ?? 0) + 1 }), {});
  const walletPersons = [...ownedBy.values()].filter((list) => list.length > 0).length;
  const headline = linkingRows[0]!.result;
  const fullRow = linkingRows.find((row) => row.short.startsWith('pełny'))?.result;
  const sample60 = addressMetrics(sampleFull, byConfidence, 60);
  const trapHits = (threshold: number) => trap.filter((item) => item.finding && item.finding.evidence > 0 && !item.finding.excluded && item.finding.score >= threshold).length;

  out('# Pomiar OŁCyŚ na laboratorium tożsamości (identity-lab)');
  out();
  out(`Wygenerowano ${new Date().toISOString()} poleceniem \`node scripts/benchmark-lab.ts\`. Plik powstaje automatycznie — wszystkie liczby i przykłady pochodzą z jednego przebiegu skryptu.`);
  out();
  out('## Wynik w skrócie');
  out();
  table(
    ['Miara', 'Wynik'],
    [
      [`Łączenie kont, próba ${sampleFull.length} osób (nick + e-mail): precision / recall / F1 mikro`, `${pct(headline.microPrecision)} / ${pct(headline.microRecall)} / ${pct(headline.microF1)}`],
      [`Łączenie kont, próba ${sampleFull.length} osób: precision / recall / F1 makro`, `${pct(headline.macroPrecision)} / ${pct(headline.macroRecall)} / ${pct(headline.macroF1)}`],
      ['Łączenie kont bez konta startowego (ile pozostałych kont osoby dołączono): precision / recall', `${pct(headline.othersPrecision)} / ${pct(headline.othersRecall)}`],
      ...(fullRow ? [[`Łączenie kont, pełny przegląd ${allRuns.length} kont: precision / recall / F1 mikro`, `${pct(fullRow.microPrecision)} / ${pct(fullRow.microRecall)} / ${pct(fullRow.microF1)}`]] : []),
      ...(FULL_SWEEP
        ? THRESHOLDS.map((threshold) => {
            const result = addressMetrics(allRuns, byConfidence, threshold);
            return [`Adresy, pełny przegląd, próg ≥ ${threshold}: precision / recall (TP / FP / FN)`, `${pct(result.precision)} / ${pct(result.recall)} (${result.counts.tp} / ${result.counts.fp} / ${result.counts.fn})`];
          })
        : []),
      [`Adresy, próba ${sampleFull.length} osób, próg ≥ 60: precision / recall (TP / FP / FN)`, `${pct(sample60.precision)} / ${pct(sample60.recall)} (${sample60.counts.tp} / ${sample60.counts.fp} / ${sample60.counts.fn})`],
      ['Pułapka adresu pośrednika: analizy, w których adres przypisano osobie (próg ≥ 40)', trapAddress ? `${trapHits(40)} / ${trap.length}` : '—'],
      ['Pułapka tego samego nicku u różnych osób: błędne sklejenie w osobie głównej (start: sam nick)', `${crossMerged.length} / ${crossNick.length} — w zbiorze jest tylko ${crossNick.length} taki nick`],
      ['Czas analizy: średnio / mediana / P95', `${num(timeOf(runs).mean / 1000, 2)} s / ${num(timeOf(runs).median / 1000, 2)} s / ${num(timeOf(runs).p95 / 1000, 2)} s`],
    ],
  );
  out('Najkrócej: na tym zbiorze narzędzie prawie nigdy nie skleja cudzych kont i nie przypisuje cudzych adresów (wysoka precision), ale znajduje tylko około połowy kont tej samej osoby. Łączy po dosłownie tym samym e-mailu oraz po tym samym nicku potwierdzonym nazwą lub miejscowością; nie widzi wariantów e-maila i nicku, wskazań w opisie profilu ani samej zgodności nazwy z miejscowością. Liczby dotyczą wyłącznie tego syntetycznego zbioru (patrz „Ograniczenia pomiaru”).');
  out();

  out('## Co i jak zmierzono');
  out();
  out(`- **Zbiór:** \`apps/identity-lab\`, seed ${status.meta.seed}, ${status.meta.people} syntetycznych osób, ${accounts.length} kont (role we wzorcu: ${Object.entries(roleTotals).map(([role, count]) => `${role} ${count}`).join(', ')}) w 27 fikcyjnych portalach, ${status.counts.posts} wpisów, ${status.counts.listings} ofert, ${status.counts.threads} wątków, testowy łańcuch LAB z ${publishers.size} publicznie podanymi adresami \`lab1…\`. Katalog danych laboratorium nie jest w repozytorium — powstał przy pierwszym uruchomieniu (scenariusz bazowy), a kohortę 200 postów ujawniających adresy dodano dokumentowanym poleceniem \`npm run wallet-posts -- --apply\` (WALLET-POSTS.md). Kodu laboratorium nie zmieniano.`);
  out('- **Narzędzie:** nasz kod bez zmian reguł — `buildApp` z `apps/api/src/app.ts` wywoływany przez `app.inject`, baza PGlite w pamięci, wyłącznie łączniki `lab-*` (`packages/sources/src/lab.ts`) i dostawca sieci laboratoryjnej (`packages/chain/src/providers/lab.ts`); tryb standardowy, bez internetu, bez modelu językowego.');
  out('- **Dostęp do danych:** łączniki czytają tylko publiczne API laboratorium (`/api/accounts`, `/api/accounts/:id`, `/api/portal/:slug`, `/api/blockchain`). Nie używają `/api/search` (zwraca hipotezy silnika laboratorium), `/api/resolve`, `/api/evaluate` ani eksportów.');
  out(`- **Kolejność:** punkty startowe wybrano deterministycznie z danych publicznych (kolejność wg SHA-256 identyfikatora konta), wykonano wszystkie ${runs.length} analiz, a dopiero potem pobrano \`/api/ground-truth\`. Strażnik na \`fetch\` przerwałby skrypt przy wcześniejszym odczycie; żądań do laboratorium w fazie analiz: ${requests.analysis}, do ścieżek zakazanych: ${requests.forbiddenDuringAnalysis}, poza laboratorium: ${requests.nonLab}.`);
  out(`- **Próba główna:** ${sampleFull.length} punktów startowych = pierwsze ${sampleFull.length} RÓŻNYCH osób wśród ${sampleStarts.length} pierwszych kont w tej kolejności (po jednym koncie na osobę; role kont startowych: ${Object.entries(sampleRoles).map(([role, count]) => `${role} ${count}`).join(', ')}). Osoby z próby mają od ${Math.min(...truthSizes)} do ${Math.max(...truthSizes)} kont (średnio ${num(mean(truthSizes) ?? 0, 1)}).`);
  if (FULL_SWEEP) out(`- **Pełny przegląd:** dodatkowo każde z ${allRuns.length} kont było punktem startowym osobnej analizy (nick + e-mail). Osoby z większą liczbą kont ważą tu więcej; przegląd służy do policzenia przypadków rzadkich (adresy, pułapki) bez szumu losowania.`);
  out('- **Identyfikatory startowe:** wariant „nick + e-mail” (nick i publiczny e-mail konta startowego) oraz wariant „sam nick”.');
  out('- **Łączenie kont:** konta przypisane osobie = profile osoby głównej w teczce + profile powiązanych tożsamości z relacją „prawdopodobnie ta sama osoba”; wzorzec = wszystkie konta tej osoby (także dodatkowe `multi` i pod przybraną tożsamością `fake`). Mikro: suma TP/FP/FN po punktach startowych; makro: średnia wartości z punktów startowych.');
  out('- **Adresy:** adres uznajemy za przypisany osobie, gdy Wskaźnik Pewności w teczce (liczony względem osoby głównej, adres niewykluczony, co najmniej jeden zaliczony ślad) osiąga próg. Wzorzec = adresy portfeli należących do osoby; adres pośrednika nie należy do nikogo z publikujących.');
  out(`- **Niezależność analiz:** co ${APP_RECYCLE} analiz skrypt tworzy nową aplikację z pustą bazą, więc wcześniejsze sprawy nie wpływają na późniejsze.`);
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
    ['Wariant', 'Precision', 'Recall', 'Dołączone / błędnie dołączone / pominięte', 'Dołączone wg roli konta: ordinary · multi · fake', 'Analizy bez osoby głównej'],
    linkingRows.map(({ label, result }) => [label, pct(result.othersPrecision), pct(result.othersRecall), `${result.others.tp} / ${result.others.fp} / ${result.others.fn}`, ['ordinary', 'multi', 'fake'].map((role) => (result.byRole[role] ? `${result.byRole[role]!.found}/${result.byRole[role]!.total}` : '—')).join(' · '), result.empty]),
  );
  const nickSame = linkingRows[2]!.result.micro.tp === headline.micro.tp && linkingRows[2]!.result.micro.fp === headline.micro.fp;
  out(
    nickSame
      ? 'Wariant „sam nick” daje na tej próbie dokładnie ten sam wynik co „nick + e-mail”: e-mail konta jest w laboratorium publiczny, więc narzędzie samo odkrywa go w pierwszym kroku. W prawdziwych serwisach e-mail zwykle nie jest widoczny i różnica byłaby istotna.'
      : 'Wariant „sam nick” różni się od „nick + e-mail” tam, gdzie e-mail nie wynika z profilu znalezionego po nicku.',
  );
  out();
  if (FULL_SWEEP) {
    out('Pełny przegląd w podziale na rolę konta startowego (start z konta pod przybraną tożsamością z założenia nie prowadzi do pozostałych kont):');
    out();
    table(['Rola konta startowego', 'Punkty', 'Precision mikro', 'Recall mikro', 'F1 mikro', 'Recall bez konta startowego'], startRoles.map(({ role, result }) => [role, result.runs, pct(result.microPrecision), pct(result.microRecall), pct(result.microF1), pct(result.othersRecall)]));
  }
  const errorTable = (title: string, groups: Map<string, ErrorExample[]>, explain: (example: ErrorExample) => string) => {
    out(`**${title}** (łącznie ${total(groups)}):`);
    out();
    if (total(groups) === 0) {
      out('Brak.');
      out();
      return;
    }
    table(['Przyczyna', 'Liczba', 'Znaczenie'], [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, list]) => [key, list.length, explain(list[0]!)]));
  };
  out('### Dlaczego konta zostały pominięte albo błędnie dołączone');
  out();
  out('Dla każdego pominiętego konta skrypt (już po odsłonięciu wzorca) szuka najmocniejszej publicznej cechy łączącej je — bezpośrednio albo przez inne pominięte konto z tym samym e-mailem lub nickiem — z kontami, które narzędzie znalazło. Ta cecha to przesłanka, która „nie zadziałała”.');
  out();
  for (const [name, errors] of [[`próba główna, ${sampleFull.length} osób`, errorsSample], ...(FULL_SWEEP ? [[`pełny przegląd, ${allRuns.length} analiz`, errorsAll]] : [])] as [string, typeof errorsSample][]) {
    errorTable(`Konta pominięte — ${name}`, errors.missed, (example) => MISS_TEXT[example.cue] ?? example.cue);
    errorTable(`Konta błędnie dołączone — ${name}`, errors.extra, () => 'konto innej osoby zaliczone do badanej; opis w sekcji „Błędy narzędzia i rekomendacje”');
  }

  out('## (b) Przypisanie adresów do osoby');
  out();
  out(`We wzorcu ${walletPersons} osób ma własny portfel (po jednym adresie); ${intermediary.size} adres to adres pośrednika. Wariant startu: nick + e-mail.`);
  out();
  const addressRows: (string | number)[][] = [];
  for (const [label, list] of addressSets) {
    for (const threshold of THRESHOLDS) {
      const result = addressMetrics(list, byConfidence, threshold);
      addressRows.push([label, `≥ ${threshold}`, pct(result.precision), pct(result.recall), pct(result.f1), `${result.counts.tp} / ${result.counts.fp} / ${result.counts.fn}`, result.fpIntermediary, result.fpOtherPerson]);
    }
  }
  table(['Zbiór punktów startowych', 'Próg Wskaźnika Pewności', 'Precision', 'Recall', 'F1', 'TP / FP / FN', 'FP: adres pośrednika', 'FP: adres innej osoby'], addressRows);
  const reasons60 = address60.missReasons;
  out(`Dlaczego własny adres nie został przypisany (${FULL_SWEEP ? 'pełny przegląd' : 'próba główna'}, próg 60): narzędzie nie dotarło do konta publikującego adres — ${reasons60.notReached}; kara za „adres współdzielony”, gdy wszyscy publikujący to konta tej samej osoby — ${reasons60.sharedPenaltyOwnAccounts}; kara za adres publikowany także przez inne osoby — ${reasons60.sharedPenaltyOther}; inny powód niskiego wyniku — ${reasons60.lowScore}.`);
  out();
  out('Dla porównania — ten sam pomiar z progiem na **łącznym prawdopodobieństwie osoba–adres** (`subjectProbability` = prawdopodobieństwo osoby głównej × prawdopodobieństwo adresu u tej osoby):');
  out();
  table(
    ['Zbiór punktów startowych', 'Próg', 'Precision', 'Recall', 'F1', 'TP / FP / FN'],
    THRESHOLDS.map((threshold) => {
      const result = addressMetrics(widest, bySubject, threshold);
      return [FULL_SWEEP ? 'Pełny przegląd' : 'Próba główna', `≥ ${threshold}`, pct(result.precision), pct(result.recall), pct(result.f1), `${result.counts.tp} / ${result.counts.fp} / ${result.counts.fn}`];
    }),
  );
  const chainSeen = allRuns.flatMap((run) => run.findings).filter((finding) => finding.evidence > 0);
  out(`Aktywność w łańcuchu LAB: dla ${chainSeen.filter((finding) => finding.addressClass !== undefined).length} z ${chainSeen.length} adresów w teczkach dostawca zwrócił profil (saldo, przelewy); ${chainSeen.filter((finding) => finding.transfers > 0).length} ma co najmniej jeden przelew między adresami. Token LAB nie ma wartości — żadnej kwoty nie wyceniono w PLN i nie powstał żaden wskaźnik wypłaty.`);
  out();

  out('### Pułapka: wspólny adres pośrednika (zbiórka)');
  out();
  if (!trapAddress) out('W danych publicznych nie ma adresu wyraźnie częściej publikowanego niż pozostałe — pułapki nie mierzono.');
  else {
    out(`Adres \`${trapAddress}\` publikuje ${widely![1].length} kont należących do ${new Set(widely![1].map((account) => personOf.get(account.id))).size} różnych osób; we wzorcu ${trapIsIntermediary ? 'to adres pośrednika — nie należy do żadnej z publikujących osób' : 'NIE jest oznaczony jako adres pośrednika (sprawdź zbiór)'}. Oceniono po jednej analizie na publikującą osobę (${trapRuns.length} punktów startowych, nick + e-mail).`);
    out();
    table(['Próg Wskaźnika Pewności', 'Analizy, w których adres pośrednika przypisano osobie', 'Odsetek'], THRESHOLDS.map((threshold) => [`≥ ${threshold}`, `${trapHits(threshold)} / ${trap.length}`, pct(ratio(trapHits(threshold), trap.length))]));
    const scoreGroups = new Map<string, number>();
    for (const item of trap) {
      const key = item.finding ? `${item.finding.excluded ? 'wykluczony' : `wynik ${item.finding.score}`}; niepowiązanych publikujących ${item.finding.unrelatedPublishers}; reguły: ${item.finding.rules.join(' → ') || '—'}` : 'adres nie pojawił się w teczce';
      scoreGroups.set(key, (scoreGroups.get(key) ?? 0) + 1);
    }
    out('Jak narzędzie oceniło adres pośrednika:');
    out();
    for (const [key, count] of [...scoreGroups.entries()].sort((a, b) => b[1] - a[1])) out(`- ${count}× ${key}`);
    out();
    const trapLinking = linking(trapRuns, mainAndSame);
    const ownTotal = trap.reduce((sum, item) => sum + ownedOf(item.run).length, 0);
    const ownKept = trap.reduce((sum, item) => sum + ownedOf(item.run).filter((address) => assigned(item.run, byConfidence, 60).has(address)).length, 0);
    out(`Czy wspólny adres skleił różne osoby: w ${trap.filter((item) => item.foreignMain.length > 0).length} z ${trap.length} analiz do osoby głównej trafiło cudze konto; w ${trap.filter((item) => item.foreignSame.length > 0).length} analizach cudze konto dostało relację „prawdopodobnie ta sama osoba” (przesłanki tych przypadków są opisane w rekomendacjach — żadna nie powołuje się na adres pośrednika); w ${trap.filter((item) => item.foreignPossibly.length > 0).length} — „możliwe: ta sama osoba albo bliska”. Łączenie kont w tym zbiorze (mikro): precision ${pct(trapLinking.microPrecision)}, recall ${pct(trapLinking.microRecall)}. Własne adresy tych osób: ${ownKept} z ${ownTotal} przypisano przy progu 60.`);
    out();
    if (FULL_SWEEP) {
      out(`W pełnym przeglądzie (${allRuns.length} analiz) adres pośrednika przypisano osobie przy progu 40 w ${allRuns.filter((run) => assigned(run, byConfidence, 40).has(trapAddress)).length} analizach.`);
      out();
    }
  }

  out('### Pułapka: ten sam nick u różnych osób');
  out();
  out(`W danych publicznych ${[...nickGroups.values()].filter((list) => list.length >= 2).length} nicków występuje na co najmniej dwóch kontach; przeanalizowano ${nickRuns.length} (start: sam nick). Według wzorca tylko **${crossNick.length}** z nich należy do RÓŻNYCH osób (${crossNick.map((item) => `„${item.nick}”`).join(', ') || '—'}) — to za mało na statystykę, wynik jest anegdotyczny. Pozostałe ${sameNick.length} to konta jednej osoby (kontrola).`);
  out();
  table(
    ['Miara', 'Wynik'],
    [
      ['Nick różnych osób, start: sam nick — osoba główna zawiera konta więcej niż jednej osoby (błędne sklejenie)', `${crossMerged.length} / ${crossNick.length}`],
      ['Nick różnych osób, start: sam nick — cudze konto z relacją „prawdopodobnie ta sama osoba”', `${crossSame.length} / ${crossNick.length}`],
      ['Nick różnych osób — prawdopodobieństwo osoby głównej (średnio)', num(mean(crossNick.map((item) => item.run.mainProbability)) ?? 0, 1)],
      ...(FULL_SWEEP ? [['Start z dowolnego konta osób dzielących nick z inną osobą (nick + e-mail) — cudze konto w wyniku', `${nickPersonErrors.length} / ${nickPersonRuns.length}`]] : []),
      ['Nick jednej osoby (kontrola) — wszystkie konta z tym nickiem uznane za jedną osobę', `${sameNickJoined} / ${sameNick.length} (${pct(ratio(sameNickJoined, sameNick.length))})`],
      ['Nick jednej osoby (kontrola) — prawdopodobieństwo osoby głównej (średnio)', num(mean(sameNick.map((item) => item.run.mainProbability)) ?? 0, 1)],
    ],
  );
  for (const item of crossNick) {
    out(`Nick „${item.nick}”: konta ${item.group.map(describe).join(' oraz ')}. Start od samego nicku: osoba główna (prawdopodobieństwo ${item.run.mainProbability}) = ${item.run.mainAccounts.join(', ') || '—'}; pozostali kandydaci: ${item.run.otherCandidateAccounts.map((list) => `[${list.join(', ')}]`).join(' ') || '—'}. Narzędzie ${item.mainPersons > 1 ? 'SKLEIŁO konta różnych osób' : 'rozdzieliło osoby na osobnych kandydatów'}${item.run.otherCandidateAccounts.length > 0 ? ' — analityk dostaje kandydatów o zbliżonym prawdopodobieństwie i sam musi wybrać właściwego' : ''}.`);
    out();
  }
  out('Kontrola pokazuje drugą stronę: ten sam nick u jednej osoby jest łączony, gdy zgadza się też nazwa wyświetlana albo miejscowość (waga 50). W laboratorium zwykłe konta osoby mają tę samą miejscowość, co jest cechą zaprojektowaną — w prawdziwych danych ta reguła zadziała rzadziej.');
  out();

  out('## (c) Czas analizy');
  out();
  table(['Zbiór', 'Analiz', 'Średnio', 'Mediana', 'P95', 'Maks.'], timeRows.map(([label, item]) => [label, item.n, `${num(item.mean / 1000, 2)} s`, `${num(item.median / 1000, 2)} s`, `${num(item.p95 / 1000, 2)} s`, `${num(item.max / 1000, 2)} s`]));
  out(`Czas obejmuje założenie sprawy i całą analizę (wyszukiwanie w 27 portalach, wystąpienia adresów, łańcuch LAB, rozszerzanie, ocena, zapis w bazie); złożenie teczki to dodatkowo średnio ${num((mean(runs.map((run) => run.dossierMs)) ?? 0) / 1000, 2)} s. Średnio ${num(mean(runs.map((run) => run.connectorQueries)) ?? 0, 0)} zapytań do łączników na analizę. Analizy nieukończone lub częściowe: ${failed.length}; analizy z błędem łącznika lub dostawcy w dzienniku: ${withErrors.length}.`);
  out();
  out('Uwaga: laboratorium działa na tej samej maszynie i odpowiada w milisekundach, więc te czasy mierzą wyłącznie koszt własny narzędzia. Przy prawdziwych serwisach czas wyznaczają opóźnienia sieci i limity źródeł (w ustawieniach: do 20 s na zapytanie, 120 s na analizę). Czas składania teczki rośnie z liczbą spraw w bazie (teczka wczytuje ostatnie analizy innych spraw) — w pierwszym przebiegu pomiaru, na jednej bazie, doszedł do ponad 1 s po kilkuset sprawach; dlatego pomiar odnawia bazę co kilkadziesiąt analiz.');
  out();

  out('## Błędy narzędzia i rekomendacje');
  out();
  out('Reguł nie zmieniano. Poniżej błędy i słabości ujawnione przez pomiar, każda z konkretnym przypadkiem (identyfikatory kont z laboratorium) i przesłanką, która zawiodła.');
  out();
  recommendations.forEach((item, index) => {
    out(`### ${index + 1}. ${item.title}`);
    out();
    out(`- **Skala:** ${item.count}.`);
    out(`- **Opis i rekomendacja:** ${item.text}`);
    if (item.example) out(`- **Przykład:** ${item.example}`);
    out();
  });

  out('## Ograniczenia pomiaru');
  out();
  out('- **Zbiór jest syntetyczny.** Osoby, konta, treści i adresy wygenerował program; nie ma tu ani jednego prawdziwego konta. Nazwy portali nawiązują do znanych serwisów, ale to lokalne symulacje.');
  out('- **Rozkład cech jest zaprojektowany.** Generator sam decyduje, jak często konta jednej osoby dzielą e-mail, wariant nicku, miejscowość czy opis. W szczególności e-mail każdego konta jest tu publiczny (w prawdziwych serwisach zwykle nie jest), a zwykłe konta osoby mają tę samą miejscowość. Wynik zależy od tych decyzji co najmniej tak samo jak od jakości narzędzia.');
  out('- **Wynik nie dowodzi jakości na rzeczywistych danych.** To test techniczny integracji i reguł w kontrolowanych warunkach, nie walidacja skuteczności w prawdziwym internecie. Wysoka precision oznacza tylko, że pułapki przewidziane przez autora zbioru nie zmyliły reguł.');
  out(`- **Małe liczności.** ${sampleFull.length} osób w próbie głównej, ${walletPersons} osób z portfelem, jeden adres pośrednika i ${crossNick.length} nick wspólny dla różnych osób. Pojedynczy przypadek przesuwa wyniki o kilka punktów procentowych; przedziałów ufności nie liczono. Pełny przegląd zmniejsza szum losowania, ale nie zwiększa liczby osób ani adresów.`);
  out('- **Pułapka pośrednika jest tu łatwa.** Adres zbiórki publikuje kilkanaście osób, więc wystarcza próg „adres powszechnie cytowany”. Wariant trudny (2–9 publikujących) w tym zbiorze nie występuje i nie został zmierzony.');
  out('- **Jeden seed, jeden przebieg.** Inny seed laboratorium da inne liczby. Kolejność punktów startowych jest deterministyczna, więc powtórzenie na tym samym zbiorze daje ten sam wynik (poza czasami).');
  out('- **Punkt startowy to konto istniejące w zbiorze.** Nie mierzono zapytań o osoby spoza zbioru, błędnie zapisanych identyfikatorów ani startu od imienia i nazwiska.');
  out('- **Adresy `lab1…` nie mają sumy kontrolnej**, a łańcuch LAB ma 30 portfeli i kilkadziesiąt przelewów — z pomiaru nie wynika nic o śledzeniu środków, wypłatach ani wycenie (token LAB nie ma wartości; dostawca nie wycenia go w PLN).');
  out('- **Łącznik nie czyta wszystkiego.** Odpowiedzi konta w cudzych wątkach są pobierane tylko przy wyszukiwaniu adresu; wskazania słowne w opisie („piszę jako …”) nie są interpretowane; `/api/search` laboratorium jest celowo pominięte. Poprawiano wyłącznie integrację — reguł oceny nie strojono pod zbiór.');
  out();

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${lines.join('\n')}\n`, 'utf8');
  if (JSON_FILE) {
    writeFileSync(
      JSON_FILE,
      JSON.stringify({ runs, truth: { personOf: Object.fromEntries(personOf), roleOf: Object.fromEntries(roleOf), intermediary: [...intermediary], ownerOf: Object.fromEntries(ownerOf) }, errors: { missed: Object.fromEntries(errorsAll.missed), extra: Object.fromEntries(errorsAll.extra) }, addressExamples: address60.examples }, null, 1),
      'utf8',
    );
  }

  // ---------- Konsola ----------
  console.log('\n=== (a) Łączenie kont ===');
  console.table(Object.fromEntries(linkingRows.map(({ short, result }) => [short, { punkty: result.runs, 'P mikro': pct(result.microPrecision), 'R mikro': pct(result.microRecall), 'F1 mikro': pct(result.microF1), 'P makro': pct(result.macroPrecision), 'R makro': pct(result.macroRecall), 'F1 makro': pct(result.macroF1), 'R bez startu': pct(result.othersRecall) }])));
  console.log('=== (b) Adresy (próg Wskaźnika Pewności) ===');
  console.table(addressRows.map((row) => ({ zbiór: String(row[0]).replace(/\s*\(.*$/, '').slice(0, 70), próg: row[1], P: row[2], R: row[3], F1: row[4], 'TP/FP/FN': row[5], 'FP pośrednik': row[6], 'FP inna osoba': row[7] })));
  if (trapAddress) {
    console.log('=== Pułapka wspólnego adresu pośrednika ===');
    console.table(THRESHOLDS.map((threshold) => ({ próg: `≥ ${threshold}`, 'adres pośrednika przypisany': `${trapHits(threshold)} / ${trap.length}` })));
  }
  console.log('=== Pułapka tego samego nicku ===');
  console.table({
    'różne osoby, sam nick: sklejone w osobie głównej': `${crossMerged.length} / ${crossNick.length}`,
    'różne osoby, sam nick: „prawdopodobnie ta sama osoba”': `${crossSame.length} / ${crossNick.length}`,
    ...(FULL_SWEEP ? { 'start z kont osób dzielących nick: cudze konto w wyniku': `${nickPersonErrors.length} / ${nickPersonRuns.length}` } : {}),
    'jedna osoba (kontrola): uznane za jedną': `${sameNickJoined} / ${sameNick.length}`,
  });
  console.log('=== (c) Czas analizy ===');
  console.table(timeRows.map(([label, item]) => ({ zbiór: label, analiz: item.n, średnio: `${num(item.mean / 1000, 2)} s`, mediana: `${num(item.median / 1000, 2)} s`, p95: `${num(item.p95 / 1000, 2)} s`, maks: `${num(item.max / 1000, 2)} s` })));
  console.log(`Błędy i słabości opisane w raporcie: ${recommendations.length}. Raport: ${OUT_FILE}`);
}

await main();
