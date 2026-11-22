// Osoba publiczna (Wikidata): dopasowanie wymaga drugiej cechy, kilka osób = kandydaci, sieć organizacji w limitach,
// relacje rodzinne tylko na żądanie, decyzja analityka rozwija sieć (głębokość 2) — na atrapie odpowiedzi Wikidata.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { NETWORK_LIMITS, runExpansion } from '../src/network/engine.ts';
import { EXPANDERS } from '../src/network/expanders.ts';
import type { ExpandContext } from '../src/network/expander.ts';
import { createRegistryOrganizationProvider } from '../src/network/organizations.ts';
import type { NetworkNode } from '../src/network/types.ts';
import {
  PUBLIC_FIGURE_LIMITS,
  accountFromUrl,
  applyPublicFigureDecision,
  caseAttributesFrom,
  publicFigureGraph,
  runPublicFigureStage,
} from '../src/public-figure.ts';
import type { PublicFigure } from '../src/public-figure.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import { FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

type Claim = Record<string, unknown>;
const item = (id: string, qualifiers: Record<string, Claim[]> = {}): Claim => ({ mainsnak: { datavalue: { value: { id } } }, qualifiers, rank: 'normal' });
const text = (value: string): Claim => ({ mainsnak: { datavalue: { value } }, rank: 'normal' });
const time = (value: string): Claim => ({ datavalue: { value: { time: `+${value}T00:00:00Z` } } });
const qual = (id: string): Claim => ({ datavalue: { value: { id } } });
const entity = (id: string, label: string, claims: Record<string, Claim[]>, description?: string) => ({
  id,
  labels: { pl: { value: label } },
  ...(description ? { descriptions: { pl: { value: description } } } : {}),
  claims,
});
const human = { P31: [item('Q5')] };
const company = { P31: [item('Q4830453')] };
const TOKEN = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

/** Atrapa Wikidata: wyszukiwarka, wpisy, wyszukiwanie wpisów wskazujących osobę; reszta rejestrów — 404. */
function fakeWikidata(entities: Record<string, ReturnType<typeof entity>>, options: { search: Record<string, string[]>; inverse?: string[] }) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.hostname !== 'www.wikidata.org') return new Response('{}', { status: 404 });
    const action = url.searchParams.get('action');
    if (action === 'wbsearchentities') {
      const ids = options.search[url.searchParams.get('search') ?? ''] ?? [];
      return json({ search: ids.map((id) => ({ id, label: entities[id]?.labels.pl.value, match: { type: 'label', text: entities[id]?.labels.pl.value } })) });
    }
    if (action === 'wbgetentities') {
      const ids = (url.searchParams.get('ids') ?? '').split('|');
      return json({ entities: Object.fromEntries(ids.map((id) => [id, entities[id] ?? { id, missing: '' }])) });
    }
    if (action === 'query') return json({ query: { search: (options.inverse ?? []).map((title) => ({ title })) } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetch, calls };
}

/** Jan Testowy (Q100): konto X „jantestowy”, pracodawca Q200, prezes Q201 (stanowisko z kwalifikatorem „of”). */
function janEntities(extra: Record<string, ReturnType<typeof entity>> = {}) {
  return {
    Q100: entity('Q100', 'Jan Testowy', {
      ...human,
      P2002: [text('jantestowy')],
      P856: [text('https://jantestowy.example.org')],
      P108: [item('Q200', { P580: [time('2015-03-01')] })],
      P39: [item('Q900', { P642: [qual('Q201')], P580: [time('2019-00-00')] })],
      P26: [item('Q103')],
    }, 'przedsiębiorca testowy'),
    Q101: entity('Q101', 'Anna Nowak', { ...human }),
    Q103: entity('Q103', 'Ewa Testowa', { ...human }),
    Q200: entity('Q200', 'Testowa Fabryka', { ...company, P169: [item('Q101')], P355: [item('Q202')] }),
    Q201: entity('Q201', 'Fundacja Testowa', { P31: [item('Q157031')], P112: [item('Q100')], P10824: [text(TOKEN)] }),
    Q202: entity('Q202', 'Testowa Spółka Zależna', { ...company }),
    Q203: entity('Q203', 'Samochód Testowy', { P31: [item('Q1420')], P127: [item('Q100')] }),
    Q900: entity('Q900', 'prezes zarządu', { P31: [item('Q4164871')] }),
    ...extra,
  };
}

const xProfile = { service: 'x.com', url: 'https://x.com/jantestowy', handle: 'jantestowy' };

test('nazwy kont z adresów URL: X, GitHub, Mastodon; zwykła strona nie jest kontem', () => {
  assert.deepEqual(accountFromUrl('https://twitter.com/JanTestowy'), { property: 'P2002', handle: 'jantestowy' });
  assert.deepEqual(accountFromUrl('https://x.com/intent/user?screen_name=jantestowy'), { property: 'P2002', handle: 'jantestowy' });
  assert.deepEqual(accountFromUrl('https://github.com/jtest'), { property: 'P2037', handle: 'jtest' });
  assert.deepEqual(accountFromUrl('https://mastodon.social/@jan'), { property: 'P4033', handle: 'jan@mastodon.social' });
  assert.equal(accountFromUrl('https://x.com/search?q=jan'), undefined);
  const attributes = caseAttributesFrom([{ type: 'email', value: 'jan@jantestowy.example.org' }], [{ service: 'forum.example', url: 'https://forum.example/u/jan', urls: ['https://twitter.com/jantestowy'] }]);
  assert.ok(attributes.accounts.some((account) => account.property === 'P2002' && account.handle === 'jantestowy' && account.origin === 'profile_link'));
  assert.ok(attributes.domains.some((domain) => domain.domain === 'example.org' && domain.origin === 'analyst'));
});

test('dokładna zgodność nazwiska + konto X ze sprawy → hipoteza dopasowania i sieć organizacji (głębokość 1)', async () => {
  const wikidata = fakeWikidata(janEntities(), { search: { 'Jan Testowy': ['Q100'] }, inverse: ['Q201', 'Q203'] });
  const { publicFigure, network } = await runPublicFigureStage({ names: ['Jan Testowy'], identifiers: [{ type: 'full_name', value: 'Jan Testowy' }], profiles: [xProfile], fetch: wikidata.fetch, now: FIXED_NOW });
  assert.ok(publicFigure);
  assert.equal(publicFigure.wikidataId, 'Q100');
  assert.equal(publicFigure.match, 'corroborated');
  assert.equal(publicFigure.status, 'hypothesis');
  assert.equal(publicFigure.matchedBy[0]?.property, 'P2002');
  assert.equal(publicFigure.matchedBy[0]?.origin, 'profile');
  assert.equal(publicFigure.expansion?.depth, 1);
  assert.ok(network);
  const names = network.organizations.map((org) => org.name);
  assert.ok(names.includes('Testowa Fabryka') && names.includes('Fundacja Testowa'), names.join(', '));
  // Przedmiot „należący do” osoby nie jest organizacją.
  assert.ok(!names.includes('Samochód Testowy'));
  // Organizacje rozpoznane po QID — dopasowanie po identyfikatorze, nie po nazwie.
  assert.ok(network.organizations.filter((org) => org.id.startsWith('org:wikidata:Q20')).every((org) => org.match !== 'name_only'));
  // Role osoby z datami: pracodawca od 2015-03-01, stanowisko „prezes zarządu” w fundacji od 2019, założyciel fundacji.
  const roles = publicFigure.roles ?? [];
  assert.ok(roles.some((role) => role.organization === 'Testowa Fabryka' && role.from === '2015-03-01'));
  assert.ok(roles.some((role) => role.organization === 'Fundacja Testowa' && role.role.includes('prezes zarządu') && role.from === '2019'));
  assert.ok(roles.some((role) => role.organization === 'Fundacja Testowa' && role.property === 'P112'));
  // Istniejący etap sieci organizacji: CEO fabryki i spółka zależna.
  assert.ok(network.persons.some((person) => person.name === 'Anna Nowak' && person.organizationId === 'org:wikidata:Q200'));
  assert.ok(network.relations.some((relation) => relation.kind === 'subsidiary' && relation.to === 'org:wikidata:Q202'));
  // Osoba ↔ osoba: wspólna organizacja (obliczenie).
  assert.ok(network.personLinks.some((link) => link.status === 'computed'));
  // Osoba centralna nie tworzy relacji „wspólny członek zarządu” między wszystkimi swoimi podmiotami.
  assert.ok(!network.relations.some((relation) => relation.kind === 'shared_officer'));
  // Adres kontraktu tokena z wpisu fundacji — adres kandydujący bytu z rejestru.
  assert.equal(publicFigure.cryptoAddresses?.[0]?.address, TOKEN);
  assert.equal(publicFigure.cryptoAddresses?.[0]?.entityId, 'org:wikidata:Q201');
  // Rodzina NIGDY automatycznie: wpis małżonki nie został pobrany.
  assert.ok(!wikidata.calls.some((url) => url.includes('Q103')));
  // Graf: węzeł osoby publicznej połączony z podmiotem krawędzią „dopasowanie do wpisu Wikidata” z dowodami.
  const graph = publicFigureGraph(publicFigure, 'subject');
  const edge = graph.edges.find((item) => item.from === 'subject');
  assert.equal(edge?.label, 'dopasowanie do wpisu Wikidata');
  assert.equal(edge?.status, 'hypothesis');
  assert.ok(edge?.evidence.some((item) => item.value === 'https://x.com/jantestowy'));
  assert.equal(graph.nodes[0]?.id, 'regperson:Q100');
});

test('zgodne tylko imię i nazwisko → słaby kandydat bez rozwijania sieci', async () => {
  const wikidata = fakeWikidata(janEntities(), { search: { 'Jan Testowy': ['Q100'] }, inverse: ['Q201'] });
  const { publicFigure, network } = await runPublicFigureStage({
    names: ['Jan Testowy'],
    identifiers: [{ type: 'full_name', value: 'Jan Testowy' }],
    profiles: [{ service: 'forum.example', url: 'https://forum.example/u/inny_jan', handle: 'inny_jan' }],
    fetch: wikidata.fetch,
    now: FIXED_NOW,
  });
  assert.equal(publicFigure?.match, 'name_only');
  assert.equal(publicFigure?.matchedBy.length, 0);
  assert.match(publicFigure!.statement, /Możliwa osoba publiczna o tym nazwisku \(niepotwierdzona\)/);
  assert.equal(network, undefined);
  assert.equal(publicFigure?.roles, undefined);
  // Tylko wyszukiwanie i wpis osoby — żadnych zapytań o organizacje.
  assert.ok(!wikidata.calls.some((url) => url.includes('Q200') || url.includes('haswbstatement')));
  const node = publicFigureGraph(publicFigure, 'subject').nodes[0];
  assert.equal(node?.sublabel, 'możliwa osoba publiczna o tym nazwisku (niepotwierdzona)');
  assert.equal((node?.meta as { publicFigure?: string }).publicFigure, 'name_only');
});

test('dwie osoby o tym samym nazwisku → lista kandydatów bez automatycznego wyboru', async () => {
  const entities = janEntities({ Q110: entity('Q110', 'Jan Testowy', { ...human }, 'piłkarz testowy') });
  const wikidata = fakeWikidata(entities, { search: { 'Jan Testowy': ['Q100', 'Q110'] } });
  const { publicFigure, network } = await runPublicFigureStage({ names: ['Jan Testowy'], identifiers: [{ type: 'full_name', value: 'Jan Testowy' }], profiles: [], fetch: wikidata.fetch, now: FIXED_NOW });
  assert.equal(publicFigure?.match, 'ambiguous');
  assert.equal(publicFigure?.wikidataId, undefined);
  assert.deepEqual(publicFigure?.candidates?.map((item) => item.wikidataId).sort(), ['Q100', 'Q110']);
  assert.equal(network, undefined);
  assert.equal(publicFigureGraph(publicFigure, 'subject').nodes.length, 0);
  // Ta sama sytuacja, ale drugą cechą zgadza się dokładnie jedna osoba — ta jest hipotezą, druga zostaje kandydatem.
  const again = await runPublicFigureStage({ names: ['Jan Testowy'], identifiers: [], profiles: [xProfile], fetch: fakeWikidata(entities, { search: { 'Jan Testowy': ['Q100', 'Q110'] } }).fetch, now: FIXED_NOW });
  assert.equal(again.publicFigure?.wikidataId, 'Q100');
  assert.deepEqual(again.publicFigure?.candidates?.map((item) => item.wikidataId), ['Q110']);
});

test('limity sieci osoby publicznej: 40 organizacji, powody zatrzymania, rozwinięcie tylko najważniejszych', async () => {
  const extra: Record<string, ReturnType<typeof entity>> = {};
  const memberships: Claim[] = [];
  for (let index = 0; index < 50; index++) {
    const id = `Q${5000 + index}`;
    extra[id] = entity(id, `Stowarzyszenie ${index}`, { P31: [item('Q15911314')] });
    memberships.push(item(id));
  }
  const entities = janEntities(extra);
  entities.Q100.claims.P463 = memberships;
  const wikidata = fakeWikidata(entities, { search: { 'Jan Testowy': ['Q100'] }, inverse: ['Q201'] });
  const { publicFigure, network } = await runPublicFigureStage({ names: ['Jan Testowy'], identifiers: [], profiles: [xProfile], fetch: wikidata.fetch, now: FIXED_NOW });
  assert.ok(network && publicFigure);
  assert.ok(network.organizations.length <= PUBLIC_FIGURE_LIMITS.maxOrganizations);
  assert.ok(network.persons.length <= PUBLIC_FIGURE_LIMITS.maxPersons);
  assert.ok(network.stops.some((stop) => stop.reason === 'query_limit' && /limit 40 organizacji/.test(stop.detail)), network.stops.map((stop) => stop.detail).join('\n'));
  assert.ok(network.stops.some((stop) => stop.reason === 'depth_limit' && /rozwinięto dla 6 najważniejszych/.test(stop.detail)));
  // Najważniejsze role (zatrudnienie, stanowisko, założyciel) przed członkostwami.
  assert.equal(network.organizations[0]?.identifiers.wikidata !== undefined, true);
  assert.ok(network.organizations.slice(0, 3).some((org) => org.name === 'Testowa Fabryka' || org.name === 'Fundacja Testowa'));
  assert.equal(network.limits.maxOrganizations, 40);
});

test('decyzja analityka: potwierdzenie wpisu, wybór kandydata, odrzucenie', () => {
  const base: PublicFigure = {
    query: 'Jan Testowy',
    wikidataId: 'Q100',
    label: 'Jan Testowy',
    url: 'https://www.wikidata.org/wiki/Q100',
    matchedBy: [],
    status: 'hypothesis',
    match: 'name_only',
    candidates: [{ wikidataId: 'Q110', label: 'Jan Testowy', url: 'https://www.wikidata.org/wiki/Q110', corroborated: false }],
    statement: 'x',
    notes: [],
    sources: [],
  };
  const at = '2026-11-21T10:00:00.000Z';
  assert.equal(applyPublicFigureDecision(base, [{ target: 'public_figure', key: 'Q100', decision: 'confirmed', decidedAt: at, author: 'analityk' }])?.status, 'confirmed');
  const chosen = applyPublicFigureDecision(base, [{ target: 'public_figure', key: 'Q110', decision: 'confirmed', decidedAt: at, author: 'analityk' }]);
  assert.equal(chosen?.wikidataId, 'Q110');
  assert.equal(chosen?.status, 'confirmed');
  assert.ok(chosen?.candidates?.some((item) => item.wikidataId === 'Q100'));
  assert.equal(applyPublicFigureDecision(base, [{ target: 'public_figure', key: 'Q100', decision: 'rejected', decidedAt: at, author: 'analityk' }])?.status, 'rejected');
  // Wycofana decyzja niczego nie zmienia.
  assert.equal(applyPublicFigureDecision(base, [{ target: 'public_figure', key: 'Q100', decision: 'confirmed', decidedAt: at, author: 'analityk', withdrawnAt: at }])?.status, 'hypothesis');
});

test('relacje rodzinne: tylko na żądanie (grupa „relacje rodzinne”), osoby z wpisem w Wikidata, z zastrzeżeniem', async () => {
  const wikidata = fakeWikidata(janEntities(), { search: {} });
  const organizations = (await createRegistryOrganizationProvider({ fetch: wikidata.fetch, now: FIXED_NOW }))!;
  const node: NetworkNode = { id: 'regperson:Q100', kind: 'person', label: 'Jan Testowy', meta: { registry: { wikidata: 'Q100' }, publicFigure: 'corroborated' } };
  const context: Omit<ExpandContext, 'reserve' | 'nodes'> = {
    caseId: 'sprawa',
    connectors: [],
    chainProviders: [],
    findings: [],
    profiles: [],
    documents: async () => [],
    corpusPhrase: async () => [],
    corpusDocument: async () => null,
    live: true,
    organizations: { ...organizations, expand: async () => ({ organizations: [], persons: [], relations: [], stops: [] }), rolesOf: async () => ({ organizations: [] }) },
    sanctions: [],
    synthetic: false,
    now: FIXED_NOW,
    log: () => {},
  };
  const base = { caseId: 'sprawa', seed: node, depth: 1, budget: NETWORK_LIMITS.defaultBudget, requestedBy: 'test', network: { nodes: [node], edges: [] }, previous: [], context, expanders: EXPANDERS };
  // Rozwinięcie „wszystkie grupy” (bez wskazania) nie obejmuje rodziny.
  const all = await runExpansion({ ...base, id: 'r1', groups: [] });
  assert.ok(!all.results.runs.some((run) => run.expander === 'osoba-rodzina'));
  assert.ok(!all.results.edges.some((edge) => edge.relation === 'family_relation'));
  // Wyraźne żądanie analityka.
  const family = await runExpansion({ ...base, id: 'r2', groups: ['family'] });
  const edge = family.results.edges.find((item) => item.relation === 'family_relation');
  assert.ok(edge, JSON.stringify(family.stops));
  assert.equal(edge.status, 'source_fact');
  assert.match(edge.label ?? '', /relacja rodzinna według Wikidata: małżonek/);
  assert.match(edge.explanation ?? '', /nie jest dowodem/);
  assert.ok(family.results.nodes.some((item) => item.id === 'person:wikidata:Q103' && item.label === 'Ewa Testowa'));
  // Osoba dopasowana tylko nazwiskiem: najpierw decyzja analityka.
  const weak = await runExpansion({ ...base, id: 'r3', groups: ['family'], seed: { ...node, meta: { registry: { wikidata: 'Q100' }, publicFigure: 'name_only' } } });
  assert.equal(weak.results.edges.length, 0);
  assert.ok(weak.stops.some((stop) => /najpierw potwierdź/.test(stop.detail)));
});

test('potwierdzenie analityka rozwija sieć (głębokość 2), teczka pokazuje sieć, licznik i węzeł osoby; wycofanie ją usuwa', async () => {
  const storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const forum = fakeConnector('forum', 'forum.example', ['full_name'], () => [
    { url: 'https://forum.example/u/jan', author: 'jan_t', text: 'Jan Testowy — profil.', profile: { handle: 'jan_t', displayName: 'Jan Testowy' } },
  ]);
  const wikidata = fakeWikidata(janEntities(), { search: { 'Jan Testowy': ['Q100'] }, inverse: ['Q201'] });
  const app = await buildApp({ storage, connectors: [forum], chainProviders: [fakeProvider()], now: FIXED_NOW, fetch: wikidata.fetch, network: { live: true, organizations: null, sanctions: [] } });
  try {
    const created = (await app.inject({ method: 'POST', url: '/api/cases', payload: { name: 'Jan Testowy', identifiers: [{ type: 'full_name', value: 'Jan Testowy' }] } })).json();
    const runResponse = await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs` });
    assert.equal(runResponse.statusCode, 201);
    const runId = runResponse.json().id as string;
    // Analiza bez źródeł publicznych nie pyta Wikidata — wynik dopasowania (słaby kandydat) wstawiamy jak z analizy.
    const stage = await runPublicFigureStage({ names: ['Jan Testowy'], identifiers: [], profiles: [], fetch: fakeWikidata(janEntities(), { search: { 'Jan Testowy': ['Q100'] } }).fetch, now: FIXED_NOW });
    assert.equal(stage.publicFigure?.match, 'name_only');
    const intel = await storage.getRunIntel(runId);
    await storage.saveRunIntel(runId, { ...intel!, publicFigure: stage.publicFigure! });

    const before = (await app.inject(`/api/cases/${created.id}/dossier`)).json();
    assert.equal(before.publicFigure.match, 'name_only');
    assert.equal(before.organizationNetwork, undefined);
    assert.ok(before.graph.nodes.some((node: { id: string }) => node.id === 'regperson:Q100'));

    assert.equal((await app.inject({ method: 'POST', url: `/api/cases/${created.id}/public-figure`, payload: { wikidataId: 'Q999', decision: 'confirmed' } })).statusCode, 400);
    const confirm = await app.inject({ method: 'POST', url: `/api/cases/${created.id}/public-figure`, payload: { wikidataId: 'Q100', decision: 'confirmed', note: 'zdjęcie i biografia zgodne' } });
    assert.equal(confirm.statusCode, 201, confirm.body);
    assert.ok(confirm.json().expansion.counts.organizations >= 3);

    const after = (await app.inject(`/api/cases/${created.id}/dossier`)).json();
    assert.equal(after.publicFigure.status, 'confirmed');
    assert.equal(after.publicFigure.expansion.depth, 2);
    assert.ok(after.publicFigure.counts.organizations >= 3);
    assert.ok(after.organizationNetwork.organizations.some((org: { name: string }) => org.name === 'Testowa Fabryka'));
    assert.ok(after.graph.edges.some((edge: { label?: string; status?: string }) => edge.label === 'dopasowanie do wpisu Wikidata' && edge.status === 'confirmed'));
    assert.ok(after.graph.nodes.some((node: { id: string }) => node.id === 'org:wikidata:Q200'));
    assert.ok(after.keyFindings.some((item: { text: string }) => /Siatka: \d+ organizacji/.test(item.text)));
    // Sieć sprawy: zapis rozwinięcia dopięty do węzła osoby publicznej.
    const network = (await app.inject(`/api/cases/${created.id}/network`)).json();
    const record = network.expansions.find((item: { nodeId: string }) => item.nodeId === 'regperson:Q100');
    assert.ok(record);
    // Wycofanie rozwinięcia: teczka wraca do stanu bez sieci (decyzja zostaje).
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/cases/${created.id}/network/expand/${record.id}` })).statusCode, 200);
    const withdrawn = (await app.inject(`/api/cases/${created.id}/dossier`)).json();
    assert.equal(withdrawn.publicFigure.status, 'confirmed');
    assert.equal(withdrawn.organizationNetwork, undefined);
  } finally {
    await app.close();
    await storage.close();
  }
});
