import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES, INDICATOR_SCALE, SCORE_INTERPRETATION } from '@olcys/core';
import type { Indicator, InvestigationIndicators, ScoreComponent } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import type { DossierView } from '../src/dossier.ts';
import { renderReportHtml } from '../src/report.ts';
import { esc } from '../src/report-html.ts';
import { renderServiceRequestHtml } from '../src/report-service.ts';
import type { CaseSummary } from '../src/storage.ts';
import { BTC_A, BTC_EXCHANGE, cashOut, chainWith, decision, dossierOf, fakeConnector, run, transfer } from './helpers.ts';

const nick = { type: 'nick' as const, value: 'krypto_janek' };
const query = { identifiers: [nick] };
const PROFILE_URL = 'https://gitpub.example/krypto_janek';
const GIT = 'gitpub.example|krypto_janek';
const FORUM = 'forum.example|janek_btc';
const EVIL = '<script>alert(1)</script>';

const caseSummary: CaseSummary = { id: 'sprawa-1', name: 'Sprawa testowa', createdAt: '2026-11-21T08:00:00.000Z', query, runs: [] };
const context = { connectors: [], rules: DEFAULT_RULES, version: 'test', generatedAt: '2026-11-21T10:00:00.000Z' };

async function baseDossier(): Promise<DossierView> {
  const deposit = transfer(1, { counterparty: BTC_EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Giełda Testowa', time: '2025-03-14T10:22:00.000Z', amount: 0.4 });
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [
    { url: PROFILE_URL, author: 'krypto_janek', text: `Wsparcie: ${BTC_A}`, publishedAt: '2024-06-01T00:00:00.000Z', profile: { handle: 'krypto_janek' } },
  ]);
  const chain = chainWith({ [BTC_A]: { transfers: [deposit], cashOuts: [cashOut(deposit, 132_000)] } });
  return dossierOf(await runAnalysis({ query, connectors: [gitpub], chainProviders: [chain] }), query);
}

const component = (rule: string, weight: number, extra: Partial<ScoreComponent> = {}): ScoreComponent => ({
  rule,
  weight,
  applied: weight,
  direction: weight < 0 ? 'contradicts' : 'supports',
  source: 'gitpub.example',
  evidence: [{ kind: 'url', value: PROFILE_URL }],
  explanation: `Wyjaśnienie reguły ${rule}.`,
  independence: 'single',
  limitations: [`Ograniczenie reguły ${rule}.`],
  ...extra,
});

const indicator = (kind: Indicator['kind'], score: number, components: ScoreComponent[], limitations: string[] = []): Indicator => ({
  kind,
  score,
  level: 'istotne przesłanki',
  calibrated: false,
  scale: INDICATOR_SCALE,
  components,
  limitations,
});

const indicators = (): InvestigationIndicators => ({
  accountWallet: [
    {
      id: 'aw-1',
      accountId: GIT,
      service: 'gitpub.example',
      handle: EVIL,
      accountUrl: PROFILE_URL,
      address: BTC_A,
      network: 'bitcoin',
      addressClass: 'private',
      notPrivateWallet: false,
      indicator: indicator('account_wallet', 72, [
        component('wallet.own_profile', 70, { explanation: `Adres w opisie profilu ${EVIL}.` }),
        component('wallet.second_source', 10, { applied: 2, independence: 'dependent', independenceNote: 'Kopia tej samej treści.' }),
      ]),
      status: 'source_fact',
    },
  ],
  commonOperator: [
    {
      id: `${FORUM}<->${GIT}`,
      accounts: [FORUM, GIT],
      accountLabels: ['janek_btc (forum.example)', 'krypto_janek (gitpub.example)'],
      personas: ['Janek BTC', 'Jan Kowalski'],
      indicator: indicator('common_operator', 45, [
        component('operator.same_email', 85, { evidence: [{ kind: 'attribute', value: 'e-mail: jan@example.com' }] }),
        component('operator.conflicting_names', -40, { blocking: true, independence: 'not_applicable', explanation: 'Konta deklarują różne imiona i nazwiska.' }),
      ], ['Wspólny e-mail może być adresem firmowym.']),
      status: 'blocked',
      statement: 'Przesłanki wspólnego operatora są mocne, ale sprzeczne deklarowane tożsamości blokują łączenie kont.',
      path: ['krypto_janek', 'e-mail jan@example.com', 'janek_btc'],
    },
  ],
  cashOut: [
    {
      id: 'co-1',
      address: BTC_A,
      network: 'bitcoin',
      stage: 'service_interaction',
      serviceName: 'Giełda Testowa',
      txids: ['tx-wyplata-1'],
      asset: 'BTC',
      amount: 0.4,
      valuePln: 132_000,
      indicator: indicator('cash_out', 60, [component('cashout.labelled_service', 60, { evidence: [{ kind: 'txid', value: 'tx-wyplata-1' }] })], ['Etykieta adresu pochodzi z publicznego zbioru.']),
      status: 'hypothesis',
      statement: 'Przelew na adres oznaczony jako giełda — to interakcja z usługą wymiany, nie dowód wypłaty.',
    },
  ],
});

const render = (dossier: DossierView): string => renderReportHtml(caseSummary, { ...run('run-test', dossier.findings), query }, dossier, [], context);

test('raport: sekcje trzech wskaźników z wierszami składników', async () => {
  const dossier = { ...(await baseDossier()), indicators: indicators() };
  const html = render(dossier);
  for (const expected of [
    'Wskaźnik A — konto → portfel',
    'Wskaźnik B — hipotezy wspólnego operatora',
    'Wskaźnik C — sygnały wyjścia do walut tradycyjnych',
    '<code>wallet.own_profile</code>',
    '<code>wallet.second_source</code>',
    'zależny — niedoliczony',
    'Kopia tej samej treści.',
    'Ograniczenie reguły wallet.own_profile.',
    '<code>operator.same_email</code>',
    '<code>operator.conflicting_names</code>',
    'kontrdowód twardy — blokuje łączenie',
    'Składniki potwierdzające:',
    'Składniki przeczące (kontrdowody):',
    'hipoteza zablokowana sprzecznością — kont nie połączono',
    'sprzeczne deklarowane tożsamości blokują łączenie kont',
    'Deklarowane persony kont: „Janek BTC” i „Jan Kowalski”',
    'Wspólny e-mail może być adresem firmowym.',
    'Szczebel drabiny dowodowej:</strong> 2 z 4 — interakcja z usługą wymiany',
    '1. transakcja w blockchainie; 2. interakcja z usługą wymiany; 3. potencjalny sygnał wypłaty; 4. udokumentowane wyjście do walut tradycyjnych',
    '<code>cashout.labelled_service</code>',
    'Etykieta adresu pochodzi z publicznego zbioru.',
    'tx-wyplata-1',
  ]) {
    assert.ok(html.includes(expected), `raport powinien zawierać: ${expected}`);
  }
  // Waga i punkty doliczone są pokazane osobno, kontrdowód ze znakiem minus.
  assert.match(html, /<td class="liczba">\+10<\/td><td class="liczba"><strong>\+2<\/strong><\/td>/);
  assert.match(html, /<td class="liczba">-40<\/td><td class="liczba"><strong>-40<\/strong><\/td>/);
});

test('raport: połączenia zablokowane z kandydatów na osobę trafiają do wskaźnika B', async () => {
  const base = await baseDossier();
  const persons = base.persons.map((person, index) => (index === 0 ? { ...person, blockedMerges: [{ profileIds: [GIT, FORUM] as [string, string], weight: 85, reason: 'Sprzeczne lokalizacje w skupieniu.' }] } : person));
  const html = render({ ...base, persons });
  assert.ok(html.includes('Połączenia kont, których nie wykonano'));
  assert.ok(html.includes('Sprzeczne lokalizacje w skupieniu.'));
  assert.ok(html.includes(esc(FORUM)));
});

test('raport: wskaźniki są porządkowe — nota o braku kalibracji pojawia się raz', async () => {
  const html = render({ ...(await baseDossier()), indicators: indicators() });
  assert.ok(html.includes(esc(INDICATOR_SCALE)));
  assert.ok(html.includes(esc(SCORE_INTERPRETATION)));
  assert.equal(html.split('Metodyka wskaźników.').length - 1, 1);
  assert.equal(html.split('nie są skalibrowanymi prawdopodobieństwami').length - 1, 1);
  // Wynik kandydata na osobę jest wskaźnikiem, a kandydat — hipotezą, nie „prawdopodobieństwem osoby”.
  assert.match(html, /Osoba główna: [^<]* — wskaźnik \d+\/100 \(hipoteza — do weryfikacji\)/);
  assert.ok(!/<h4>[^<]*— prawdopodobieństwo \d+%/.test(html));
  assert.ok(!html.includes('To ocena prawdopodobieństwa'));
});

test('raport bez wskaźników (starsza teczka): sekcje zostają z informacją o braku danych', async () => {
  const base = await baseDossier();
  const html = render({ ...base, indicators: undefined });
  assert.ok(html.includes('Wskaźnik A — konto → portfel'));
  assert.ok(html.includes('Brak ocen związku konto → portfel'));
  assert.ok(html.includes('Brak hipotez wspólnego operatora'));
  assert.ok(html.includes('Brak sygnałów wyjścia do walut tradycyjnych'));
});

test('raport: złośliwa nazwa konta i wyjaśnienie są escapowane', async () => {
  const data = indicators();
  data.commonOperator[0]!.accountLabels = [EVIL, 'krypto_janek'];
  data.commonOperator[0]!.statement = `Hipoteza dla konta ${EVIL}`;
  data.commonOperator[0]!.indicator.components[0]!.source = EVIL;
  data.commonOperator[0]!.indicator.components[0]!.evidence = [{ kind: 'attribute', value: EVIL }, { kind: 'url', value: 'javascript:alert(1)' }];
  data.cashOut[0]!.statement = EVIL;
  data.cashOut[0]!.txids = [EVIL];
  data.accountWallet[0]!.accountUrl = 'javascript:alert(1)';
  const base = await baseDossier();
  const decisions = [{ ...decision('profile', EVIL, 'rejected', EVIL), withdrawnAt: '2026-11-21T11:00:00.000Z', withdrawnBy: EVIL }];
  const html = render({ ...base, indicators: data, decisions });
  assert.ok(!html.includes('<script>'));
  assert.ok(!/<(script|link|img|iframe)\b/i.test(html));
  assert.ok(html.includes(`Adres w opisie profilu ${esc(EVIL)}.`));
  assert.ok(html.includes(`Hipoteza dla konta ${esc(EVIL)}`));
  // Adres o schemacie innym niż http(s) nie staje się odnośnikiem.
  assert.ok(!html.includes('href="javascript:'));
});

test('raport: ścieżka dowodowa adresu od identyfikatora do usługi', async () => {
  const base = await baseDossier();
  const html = render(base);
  const section = html.slice(html.indexOf('<h2>Ścieżka dowodowa</h2>'), html.indexOf('<h2>5. Adresy odrzucone</h2>'));
  for (const expected of [
    '1. Identyfikator wejściowy',
    'pseudonim (nick) „krypto_janek”',
    '2. Konto i sposób odnalezienia',
    `href="${PROFILE_URL}"`,
    'Skrót SHA-256 treści',
    base.findings[0]!.evidence[0]!.contentHash,
    'Suma kontrolna adresu: potwierdzona',
    '5. Ustalenia z blockchaina',
    'przelewów do usług wymiany: 1',
    '6. Usługa',
    'Giełda Testowa',
    'może potwierdzić tylko usługa',
  ]) {
    assert.ok(section.includes(expected), `ścieżka dowodowa powinna zawierać: ${expected}`);
  }
});

test('raport: rejestr decyzji pokazuje decyzję wycofaną i decyzję o parze kont', async () => {
  const base = await baseDossier();
  const decisions = [
    { ...decision('address', `bitcoin:${BTC_A}`, 'rejected', 'pomyłka'), withdrawnAt: '2026-11-21T11:30:00.000Z', withdrawnBy: 'kierownik' },
    { ...decision('profile', GIT, 'confirmed'), target: 'link' as const, key: `${FORUM}<->${GIT}` },
  ];
  const html = render({ ...base, decisions });
  const section = html.slice(html.indexOf('9. Rejestr decyzji analityka'));
  assert.ok(section.includes('<strong>wycofana</strong> 2026-11-21 11:30:00 UTC przez: kierownik'));
  assert.ok(section.includes('hipoteza wspólnego operatora (para kont)'));
  assert.ok(section.includes('Decyzji w rejestrze: 2, w tym wycofanych: 1.'));
});

test('raport: rozbicie Wskaźnika Pewności pokazuje wagę, źródła, niezależność i pochodzenie śladów', async () => {
  const base = await baseDossier();
  const [first] = base.findings;
  const finding = {
    ...first!,
    confidence: {
      ...first!.confidence,
      ledger: [
        {
          rule: 'base.own_profile',
          delta: 85,
          running: 85,
          explanation: 'Najmocniejszy ślad: własny profil podmiotu.',
          evidenceIds: [first!.evidence[0]!.id],
          weight: 85,
          sources: [PROFILE_URL],
          independence: 'pojedynczy ślad — punkt wyjścia oceny',
          limitations: ['Publikacja adresu jest deklaracją autora.'],
        },
      ],
      provenance: [{ evidenceIds: [first!.evidence[0]!.id], services: ['gitpub.example'], reasons: [] }],
      independentSources: 1,
    },
  };
  const html = render({ ...base, findings: [finding, ...base.findings.slice(1)] });
  for (const expected of ['waga reguły: +85 p.p.', 'niezależność: pojedynczy ślad — punkt wyjścia oceny', 'ograniczenia: Publikacja adresu jest deklaracją autora.', 'niezależnych pochodzeń: <strong>1</strong>', 'Dlaczego ślady uznano za zależne']) {
    assert.ok(html.includes(expected), `raport powinien zawierać: ${expected}`);
  }
});

test('materiał do zapytania: kandydat na osobę opisany wskaźnikiem, nie prawdopodobieństwem', async () => {
  const base = await baseDossier();
  const [service] = base.serviceLinks;
  assert.ok(service, 'scenariusz powinien dać powiązanie z usługą');
  const html = renderServiceRequestHtml(caseSummary, { ...run('run-test', base.findings), query }, base, service, { version: 'test', generatedAt: '2026-11-21T10:00:00.000Z' });
  assert.match(html, /Kandydat na osobę o najwyższym wskaźniku według analizy: <strong>[^<]+<\/strong> \(wskaźnik \d+\/100, hipoteza\)/);
  assert.ok(html.includes('nie jest skalibrowanym prawdopodobieństwem'));
});

test('raport z teczki: wskaźniki policzone przez analizę trafiają do raportu', async (t) => {
  const base = await baseDossier();
  if (!base.indicators) return t.skip('teczka nie zawiera jeszcze pola indicators');
  const html = render(base);
  for (const link of base.indicators.accountWallet) {
    assert.ok(html.includes(esc(link.address)));
    for (const item of link.indicator.components) assert.ok(html.includes(`<code>${esc(item.rule)}</code>`), `brak reguły ${item.rule}`);
  }
  for (const item of base.indicators.cashOut) assert.ok(html.includes(esc(item.statement)));
});
