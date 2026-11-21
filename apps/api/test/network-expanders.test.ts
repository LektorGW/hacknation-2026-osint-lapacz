// Ekspandery rozwijania sieci, siła ścieżek z zanikiem i bezpiecznik „winy przez skojarzenie” — bez sieci.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HYPOTHESIS_DECAY, describePath, strongestPath } from '@olcys/core';
import type { Finding, SourceConnector } from '@olcys/core';
import { accountKey, entityFromNode, identifierKey } from '../src/network/entities.ts';
import { planExpansion, runExpansion } from '../src/network/engine.ts';
import type { ExpandContext } from '../src/network/expander.ts';
import { EXPANDERS } from '../src/network/expanders.ts';
import { mergeNetwork } from '../src/network/merge.ts';
import type { OrganizationProvider } from '../src/network/organizations.ts';
import { createRdapClient, parseRdapDomain } from '../src/network/rdap.ts';
import { discoverSanctionsModules } from '../src/network/sanctions.ts';
import type { SanctionsProvider } from '../src/network/sanctions.ts';
import type { NetworkNode } from '../src/network/types.ts';
import { BTC_A, BTC_B, BTC_C, ETH_A, FIXED_NOW, fakeActivity, fakeConnector, finding, transfer } from './helpers.ts';

const SUBJECT: NetworkNode = { id: 'subject', kind: 'subject', label: 'Jan K.' };

/** Świat testowy: e-mail → konto B (targ), adres B → konto C (targ), adres C → wpis listy. */
function world() {
  const targ = fakeConnector('targ', 'targ.example', ['nick', 'email', 'crypto_address'], (identifier) => {
    const b = { url: 'https://targ.example/oferta/b', author: 'wymiennik_b', category: 'sale_offer' as const, text: `Wymiana. BTC: ${BTC_B}. Kontakt kontakt@wymiennik.example`, profile: { handle: 'wymiennik_b', emails: ['kontakt@wymiennik.example'], phones: ['+48 500 000 870'] } };
    const c = { url: 'https://targ.example/oferta/c', author: 'leon_c', category: 'sale_offer' as const, text: `Wpłaty: ${BTC_B} albo ETH ${ETH_A}`, profile: { handle: 'leon_c', displayName: 'Leon Cichy' } };
    const forum = { url: 'https://forum.example/watek/1', author: 'gapiacy', category: 'forum_post' as const, text: `Ktoś zna adres ${BTC_B}?`, profile: { handle: 'gapiacy' } };
    if (identifier.type === 'email' && identifier.value === 'kontakt@wymiennik.example') return [b];
    if (identifier.type === 'crypto_address' && identifier.value === BTC_B) return [c, b, forum];
    if (identifier.type === 'nick' && identifier.value === 'janek') return [{ url: 'https://targ.example/u/janek', author: 'janek', category: 'own_profile' as const, text: 'profil', profile: { handle: 'janek' } }, { url: 'https://targ.example/u/janek2', author: 'Janek', category: 'own_profile' as const, text: 'inny', profile: { handle: 'janek' } }];
    return [];
  });
  return { targ };
}

const fakeSanctions: SanctionsProvider = {
  id: 'atrapa-listy',
  label: 'Atrapa listy sankcyjnej',
  legalBasis: 'test',
  outbound: false,
  async screen(query) {
    const hits = [];
    if (query.addresses.some((item) => item.address === ETH_A)) hits.push({ list: 'Lista testowa', entryId: 'T-1', entryName: 'NORDWIND CAPITAL (test)', entryType: 'organization' as const, match: 'identifier' as const, matchedValue: ETH_A });
    if (query.names.includes('Leon Cichy')) hits.push({ list: 'Lista testowa', entryId: 'T-2', entryName: 'Leon Cichy', entryType: 'person' as const, match: 'name' as const, matchedValue: 'Leon Cichy' });
    return hits;
  },
};

function context(connectors: SourceConnector[], extra: Partial<ExpandContext> = {}): Omit<ExpandContext, 'reserve' | 'nodes'> {
  return {
    caseId: 'sprawa-1',
    connectors,
    chainProviders: [],
    findings: [],
    profiles: [],
    documents: async () => [],
    corpusPhrase: async () => [],
    corpusDocument: async () => null,
    live: false,
    sanctions: [fakeSanctions],
    synthetic: false,
    now: FIXED_NOW,
    log: () => {},
    ...extra,
  };
}

const emailNode: NetworkNode = { id: identifierKey('email', 'kontakt@wymiennik.example'), kind: 'identifier', label: 'kontakt@wymiennik.example' };

const expand = (seed: NetworkNode, groups: Parameters<typeof runExpansion>[0]['groups'], options: Partial<Parameters<typeof runExpansion>[0]> = {}, connectors = [world().targ]) =>
  runExpansion({
    id: 'r1',
    caseId: 'sprawa-1',
    seed,
    groups,
    depth: 1,
    budget: 20,
    requestedBy: 'analityk',
    network: { nodes: [SUBJECT, seed], edges: [{ id: 'e0', from: 'subject', to: seed.id, kind: 'has_identifier', status: 'source_fact' }] },
    previous: [],
    context: context(connectors),
    ...options,
  });

test('identyfikator e-mail → konto, które publikuje ten sam e-mail (fakt źródłowy)', async () => {
  const record = await expand(emailNode, ['accounts']);
  const account = record.results.nodes.find((node) => node.id === accountKey('targ.example', 'wymiennik_b'));
  assert.ok(account, 'konto B w wyniku');
  assert.equal(account.kind, 'profile');
  assert.deepEqual(account.meta?.addresses, [`bitcoin:${BTC_B}`]);
  const edge = record.results.edges.find((item) => item.to === account.id);
  assert.equal(edge?.relation, 'same_email');
  assert.equal(edge?.status, 'source_fact');
  assert.ok(edge?.evidence?.some((item) => item.kind === 'url' && item.value === 'https://targ.example/oferta/b'));
  assert.equal(edge?.retrievedAt, '2026-11-21T09:00:00.000Z');
  // Domena e-maila — obliczenie lokalne, bez zapytań.
  assert.ok(record.results.nodes.some((node) => node.id === 'id:domain:wymiennik.example'));
  assert.equal(record.budget.used, 1);
});

test('nick → konta o tej samej nazwie to hipoteza (wspólny nick)', async () => {
  const record = await expand({ id: identifierKey('nick', 'janek'), kind: 'identifier', label: 'janek' }, ['accounts']);
  const edges = record.results.edges.filter((edge) => edge.relation === 'same_nick');
  assert.ok(edges.length >= 1);
  assert.ok(edges.every((edge) => edge.status === 'hypothesis' && edge.inferred === true));
});

test('adres → publikacje: własna oferta = publikuje adres, wpis na forum = tylko wymienia', async () => {
  const seed: NetworkNode = { id: `addr:bitcoin:${BTC_B}`, kind: 'address', label: BTC_B };
  const record = await expand(seed, ['publications']);
  const leon = accountKey('targ.example', 'leon_c');
  const owner = record.results.edges.find((edge) => edge.from === leon && edge.to === seed.id);
  assert.equal(owner?.relation, 'publishes_identifier');
  const forum = record.results.edges.find((edge) => edge.from === accountKey('targ.example', 'gapiacy') && edge.to === seed.id);
  assert.equal(forum?.relation, 'cited_in');
  assert.ok(record.results.nodes.some((node) => node.id === 'source:https://forum.example/watek/1' && node.kind === 'source'));
});

test('dwa kroki: e-mail → konto B → jego adres; potem adres → konto C → wpis listy sankcyjnej (fakt tylko dla wpisu)', async () => {
  const first = await expand(emailNode, ['accounts'], { depth: 2 });
  assert.ok(first.results.nodes.some((node) => node.id === `addr:bitcoin:${BTC_B}` && node.depth === 2));
  const address = first.results.nodes.find((node) => node.id === `addr:bitcoin:${BTC_B}`)!;
  const second = await expand(address, ['publications', 'accounts', 'sanctions'], { depth: 2, id: 'r2' });
  const entry = second.results.nodes.find((node) => node.meta?.sanctioned);
  assert.ok(entry, 'wpis listy w wyniku');
  assert.equal(entry.status, 'source_fact');
  const hit = second.results.edges.find((edge) => edge.to === entry.id && edge.relation === 'sanctions_hit');
  assert.equal(hit?.from, `addr:ethereum:${ETH_A}`, 'trafienie dotyczy adresu z listy, nie konta');
  // Zgodna sama nazwa konta z wpisem = hipoteza.
  const name = second.results.edges.find((edge) => edge.relation === 'sanctions_name_match');
  assert.equal(name?.status, 'hypothesis');
});

test('budżet: rozwinięcie nie przekracza limitu zapytań i zapisuje powód zatrzymania', async () => {
  const many = Array.from({ length: 5 }, (_, index) => fakeConnector(`src${index}`, `s${index}.example`, ['email'], () => []));
  const record = await expand(emailNode, ['accounts'], { budget: 2 }, many);
  assert.equal(record.budget.used, 2);
  assert.ok(record.stops.some((stop) => stop.reason === 'budget'));
});

test('odtwarzalność: to samo rozwinięcie na tych samych danych daje ten sam zapis', async () => {
  const a = await expand(emailNode, ['accounts', 'sanctions'], { depth: 2 });
  const b = await expand(emailNode, ['accounts', 'sanctions'], { depth: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(a.results)), JSON.parse(JSON.stringify(b.results)));
  assert.deepEqual(a.stops, b.stops);
});

test('pomijanie powtórzeń: droga wykonana wcześniej nie jest powtarzana (chyba że force)', async () => {
  const first = await expand(emailNode, ['accounts']);
  const again = await expand(emailNode, ['accounts'], { previous: [first], id: 'r2' });
  assert.ok(again.stops.some((stop) => stop.reason === 'duplicate'));
  assert.equal(again.budget.used, 0);
  const forced = await expand(emailNode, ['accounts'], { previous: [first], id: 'r3', force: true });
  assert.equal(forced.budget.used, 1);
  // Wycofane rozwinięcie nie blokuje ponownego.
  const afterWithdraw = await expand(emailNode, ['accounts'], { previous: [{ ...first, withdrawnAt: '2026-11-21T11:00:00.000Z' }], id: 'r4' });
  assert.equal(afterWithdraw.budget.used, 1);
});

test('kontrahenci przelewów i współwpłacający są wyłącznie adresami — nigdy osobami', async () => {
  const activity = fakeActivity('bitcoin', BTC_A, 'private');
  activity.transfers = [
    transfer(1, { counterparty: BTC_B, time: '2025-01-01T00:00:00Z', amount: 1, direction: 'in' }),
    transfer(2, { counterparty: BTC_C, time: '2025-01-02T00:00:00Z', amount: 2, direction: 'in' }),
    transfer(3, { counterparty: BTC_B, time: '2025-01-03T00:00:00Z', amount: 0.5, direction: 'out' }),
  ];
  (activity as unknown as { linkedAddresses: unknown[] }).linkedAddresses = [{ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', kind: 'co_depositor', strength: 70, txids: ['ab'], service: 'Giełda' }];
  const found: Finding = { ...finding(BTC_A, 80, []), chain: activity };
  const seed: NetworkNode = { id: `addr:bitcoin:${BTC_A}`, kind: 'address', label: BTC_A };
  const record = await runExpansion({ id: 'r1', caseId: 'sprawa-1', seed, groups: ['flows'], depth: 1, budget: 5, requestedBy: 'analityk', network: { nodes: [SUBJECT, seed], edges: [] }, previous: [], context: context([], { findings: [found] }) });
  const fresh = record.results.nodes.filter((node) => !node.known);
  assert.ok(fresh.length >= 3);
  assert.ok(fresh.every((node) => node.kind === 'address'), 'tylko adresy');
  assert.ok(!record.results.nodes.some((node) => node.kind === 'person'));
  const both = record.results.edges.find((edge) => edge.to === `addr:bitcoin:${BTC_B}` || edge.from === `addr:bitcoin:${BTC_B}`);
  assert.match(both?.label ?? '', /w obie strony/);
  assert.equal(record.results.edges.find((edge) => edge.relation === 'co_depositor')?.status, 'hypothesis');
  assert.equal(record.budget.used, 0, 'aktywność z teczki — bez zapytań');
});

test('organizacja → osoby w rolach: rola łączy osobę z organizacją, nigdy z adresem', async () => {
  const provider: OrganizationProvider = {
    label: 'atrapa rejestru',
    async expand(seed, options) {
      options.reserve();
      const source = { url: 'https://rejestr.example/krs/1', retrievedAt: '2026-11-21T09:30:00.000Z', registry: 'KRS' };
      return {
        organizations: [
          { id: 'org:krs:0000000001', name: seed.name, match: 'identifier', matchNote: 'KRS', identifiers: { krs: '0000000001' }, sources: [source], seed: true } as never,
          { id: 'org:lei:X', name: 'Holding X', match: 'related', matchNote: 'GLEIF', identifiers: { lei: 'X' }, sources: [source] },
        ],
        persons: [{ id: 'org:krs:0000000001:rep:0', name: 'J*** K***', masked: true, role: 'prezes zarządu', organizationId: 'org:krs:0000000001', source }],
        relations: [{ from: 'org:lei:X', to: 'org:krs:0000000001', kind: 'parent', label: 'jednostka dominująca → spółka zależna', status: 'source_fact', source, explanation: 'GLEIF' }],
        stops: [],
      };
    },
  };
  const seed: NetworkNode = { id: 'org:krs:0000000001', kind: 'organization', label: 'Wymiennik Sp. z o.o.' };
  const record = await runExpansion({ id: 'r1', caseId: 'sprawa-1', seed, groups: ['organizations'], depth: 1, budget: 10, requestedBy: 'analityk', network: { nodes: [SUBJECT, seed], edges: [] }, previous: [], context: context([], { live: true, organizations: provider }) });
  const roles = record.results.edges.filter((edge) => edge.relation === 'holds_role');
  assert.equal(roles.length, 1);
  assert.equal(roles[0]!.to, seed.id);
  assert.ok(record.results.edges.every((edge) => !(edge.relation === 'holds_role' && edge.to.startsWith('addr:'))));
  assert.ok(record.results.edges.some((edge) => edge.relation === 'org_parent' && edge.from === 'org:lei:X'));
  assert.match(record.results.nodes.find((node) => node.kind === 'person')!.sublabel!, /nie własność adresu/);
  // Bez źródeł publicznych rejestry nie są pytane.
  const offline = await runExpansion({ id: 'r2', caseId: 'sprawa-1', seed, groups: ['organizations'], depth: 1, budget: 10, requestedBy: 'analityk', network: { nodes: [SUBJECT, seed], edges: [] }, previous: [], context: context([], { organizations: provider }) });
  assert.ok(offline.stops.some((stop) => stop.reason === 'not_live'));
});

test('dane demonstracyjne nie trafiają do prawdziwych rejestrów (RDAP, rejestry organizacji)', async () => {
  const seed: NetworkNode = { id: 'id:domain:wymiennik.example', kind: 'identifier', label: 'wymiennik.example', meta: { synthetic: true } };
  const record = await runExpansion({ id: 'r1', caseId: 'sprawa-1', seed, groups: ['organizations', 'accounts'], depth: 1, budget: 10, requestedBy: 'analityk', network: { nodes: [SUBJECT, seed], edges: [] }, previous: [], context: context([], { live: true, rdap: { lookup: async () => assert.fail('RDAP nie może być pytany') } }) });
  assert.ok(record.stops.some((stop) => stop.expander === 'domena-rdap' && stop.reason === 'not_applicable'));
});

test('RDAP: organizacja abonenta, gdy rejestr ją publikuje; dane zredagowane — bez węzła', () => {
  const published = parseRdapDomain('firma.example', { entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['org', {}, 'text', 'Firma Testowa Sp. z o.o.'], ['adr', { cc: 'PL' }, 'text', ['', '', '', '', '', '', 'PL']]]] }, { roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Rejestrator SA']]] }] }, 'https://rdap.example/domain/firma.example', '2026-11-21T10:00:00.000Z');
  assert.equal(published.organization, 'Firma Testowa Sp. z o.o.');
  assert.equal(published.registrar, 'Rejestrator SA');
  assert.equal(published.redacted, false);
  const redacted = parseRdapDomain('osoba.example', { entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'REDACTED FOR PRIVACY']]] }], redacted: [{ name: { description: 'Registrant Name' } }] }, 'https://rdap.example/domain/osoba.example', '2026-11-21T10:00:00.000Z');
  assert.equal(redacted.organization, undefined);
  assert.equal(redacted.name, undefined);
  assert.equal(redacted.redacted, true);
});

test('RDAP: rejestr wskazany plikiem IANA, jawny User-Agent, jedno zapytanie o domenę', async () => {
  const calls: { url: string; agent: string | null }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), agent: new Headers(init?.headers).get('User-Agent') });
    if (String(url).includes('dns.json')) return new Response(JSON.stringify({ services: [[['pl'], ['https://rdap.dns.pl/']]] }));
    return new Response(JSON.stringify({ entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['org', {}, 'text', 'Spółka Przykładowa']]] }] }));
  }) as typeof fetch;
  const client = createRdapClient({ fetch: fetcher, now: FIXED_NOW });
  const record = await client.lookup('przyklad.com.pl');
  assert.equal(record?.organization, 'Spółka Przykładowa');
  assert.equal(calls.at(-1)!.url, 'https://rdap.dns.pl/domain/przyklad.com.pl');
  assert.ok(calls.every((call) => call.agent?.startsWith('OLCyS')));
  await client.lookup('inna.pl');
  assert.equal(calls.filter((call) => call.url.includes('dns.json')).length, 1, 'plik IANA raz na proces');
});

// ---------- Siła ścieżki, zanik, bezpiecznik ----------

test('siła ścieżki: iloczyn sił, zanik na hipotezie, najsłabsze ogniwo w podsumowaniu', () => {
  const edges = [
    { id: 'a', from: 'subject', to: 'email', status: 'source_fact', relation: 'publishes_identifier' },
    { id: 'b', from: 'email', to: 'konto', status: 'source_fact', relation: 'same_email' },
    { id: 'c', from: 'konto', to: 'inne', status: 'hypothesis', relation: 'same_nick' },
  ];
  const path = strongestPath(edges, 'inne', 'subject')!;
  assert.equal(path.steps.length, 3);
  assert.equal(path.summary, 'ścieżka: 3 kroki, najsłabsze ogniwo: wspólny nick (hipoteza)');
  assert.ok(Math.abs(path.strength - 0.9 * 0.85 * 0.35 * HYPOTHESIS_DECAY) < 1e-9);
  assert.equal(path.level, 'circumstantial');
});

test('bezpiecznik: ścieżka z samych hipotez nigdy nie jest opisana mocniej niż „ścieżka poszlakowa”', () => {
  // Bardzo silne hipotezy (siła 1) — liczba wysoka, a opis i tak poszlakowy.
  const edges = [
    { id: 'a', from: 'subject', to: 'x', status: 'hypothesis', strength: 1 },
    { id: 'b', from: 'x', to: 'y', status: 'hypothesis', strength: 1 },
  ];
  const path = strongestPath(edges, 'y', 'subject')!;
  assert.equal(path.level, 'circumstantial');
  const merged = mergeNetwork({ nodes: [SUBJECT, { id: 'x', kind: 'identifier', label: 'x' }], edges: [edges[0]! as never] }, [
    { id: 'r1', caseId: 'sprawa-1', nodeId: 'x', relations: [], depth: 1, budget: { limit: 1, used: 0 }, startedAt: 't', finishedAt: 't', requestedBy: 'a', results: { nodes: [{ id: 'y', kind: 'profile', label: 'y', expansionId: 'r1', depth: 1 }], edges: [{ ...(edges[1] as never), expansionId: 'r1' }], runs: [] }, stops: [], sourceErrors: [] },
  ]);
  const y = merged.nodes.find((node) => node.id === 'y')!;
  assert.equal(y.link?.label, 'w siatce — ścieżka poszlakowa');
  assert.equal(merged.depthCounts['1'], 1);
});

test('ścieżka: droga po faktach ma pierwszeństwo przed silniejszą liczbowo hipotezą', () => {
  const edges = [
    { id: 'h', from: 'subject', to: 'z', status: 'hypothesis', strength: 1 },
    { id: 'f1', from: 'subject', to: 'm', status: 'source_fact', strength: 0.5 },
    { id: 'f2', from: 'm', to: 'z', status: 'source_fact', strength: 0.5 },
  ];
  const path = strongestPath(edges, 'z', 'subject')!;
  assert.deepEqual(path.steps.map((step) => step.edge.id), ['f2', 'f1']);
  assert.equal(path.hypotheses, 0);
  assert.equal(path.level, 'distant');
  assert.equal(describePath(['a'], []).summary, 'ten sam węzeł');
  assert.equal(strongestPath([{ id: 'r', from: 'a', to: 'b', status: 'rejected' }], 'a', 'b'), null);
});

test('moduł oficjalnych list ryzyka podłączony jako dostawca: adres z listy = fakt dla wpisu, sama nazwa = hipoteza', async () => {
  const modules = await discoverSanctionsModules();
  assert.ok(modules.length >= 1, 'moduł list ryzyka wykryty w pakietach');
  const listed = 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81';
  const seed: NetworkNode = { id: `addr:tron:${listed}`, kind: 'address', label: listed };
  const record = await runExpansion({ id: 'r1', caseId: 'sprawa-1', seed, groups: ['sanctions'], depth: 1, budget: 5, requestedBy: 'analityk', network: { nodes: [SUBJECT, seed], edges: [] }, previous: [], context: context([], { sanctions: modules }) });
  const hit = record.results.edges.find((edge) => edge.relation === 'sanctions_hit');
  assert.equal(hit?.status, 'source_fact');
  assert.match(record.results.nodes.find((node) => node.id === hit!.to)!.label, /BANK MARKAZI/);
  const org: NetworkNode = { id: 'org:nazwa:central-bank-of-iran', kind: 'organization', label: 'Central Bank of Iran' };
  const byName = await runExpansion({ id: 'r2', caseId: 'sprawa-1', seed: org, groups: ['sanctions'], depth: 1, budget: 5, requestedBy: 'analityk', network: { nodes: [SUBJECT, org], edges: [] }, previous: [], context: context([], { sanctions: modules }) });
  const names = byName.results.edges.filter((edge) => edge.from === org.id);
  assert.ok(names.length >= 1);
  assert.ok(names.every((edge) => edge.relation === 'sanctions_name_match' && edge.status === 'hypothesis'));
});

test('plan rozwinięcia: drogi, koszt, dostępność i drogi już wykonane', async () => {
  const entity = entityFromNode(emailNode)!;
  const ctx = { ...context([world().targ]), nodes: new Map(), reserve: () => true };
  const plan = planExpansion(entity, ctx);
  const ids = plan.map((item) => item.expander);
  assert.ok(ids.includes('identyfikator-konta') && ids.includes('identyfikator-domena') && ids.includes('listy-sankcyjne'));
  assert.equal(plan.find((item) => item.expander === 'identyfikator-konta')!.cost, 1);
  assert.ok(plan.every((item) => item.legalBasis.length > 0));
  assert.equal(EXPANDERS.length, new Set(EXPANDERS.map((item) => item.id)).size);
});
