// Trasy rozwijania sieci: rozwinięcie, plan, trwałość, wycofanie, budżet, odtwarzalność, przetrwanie ponownej analizy.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { accountKey } from '../src/network/entities.ts';
import type { SanctionsProvider } from '../src/network/sanctions.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import type { Storage } from '../src/storage.ts';
import { BTC_A, BTC_B, ETH_A, FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

let app: FastifyInstance;
let storage: Storage;
let rdapCalls = 0;

const sanctions: SanctionsProvider = {
  id: 'atrapa',
  label: 'Atrapa listy sankcyjnej',
  legalBasis: 'test',
  outbound: false,
  async screen(query) {
    return query.addresses.some((item) => item.address === ETH_A)
      ? [{ list: 'Lista testowa', entryId: 'T-1', entryName: 'NORDWIND CAPITAL (test)', entryType: 'organization', match: 'identifier', matchedValue: ETH_A }]
      : [];
  },
};

before(async () => {
  storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [{ url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie: ${BTC_A}.`, profile: { handle: 'krypto_janek', displayName: 'Jan Kowalski', emails: ['kontakt@wymiennik.example'] } }]
      : [],
  );
  const targ = fakeConnector('targ', 'targ.example', ['email', 'crypto_address'], (identifier) => {
    const b = { url: 'https://targ.example/oferta/b', author: 'wymiennik_b', category: 'sale_offer' as const, text: `Wymiana. BTC: ${BTC_B}`, profile: { handle: 'wymiennik_b', emails: ['kontakt@wymiennik.example'] } };
    const c = { url: 'https://targ.example/oferta/c', author: 'leon_c', category: 'sale_offer' as const, text: `Wpłaty: ${BTC_B} albo ETH ${ETH_A}`, profile: { handle: 'leon_c', displayName: 'Leon Cichy' } };
    if (identifier.type === 'email' && identifier.value === 'kontakt@wymiennik.example') return [b];
    if (identifier.type === 'crypto_address' && identifier.value === BTC_B) return [c, b];
    return [];
  });
  app = await buildApp({
    storage,
    connectors: [gitpub, targ],
    chainProviders: [fakeProvider()],
    now: FIXED_NOW,
    network: { sanctions: [sanctions], organizations: null, rdap: { lookup: async () => (rdapCalls++, null) } },
  });
});
after(() => app.close());

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

async function caseWithRun(): Promise<string> {
  const created = (await post('/api/cases', { name: 'Jan K.', identifiers: [{ type: 'nick', value: 'krypto_janek' }] })).json();
  assert.equal((await post(`/api/cases/${created.id}/runs`)).statusCode, 201);
  return created.id;
}

const network = async (caseId: string) => {
  const response = await app.inject(`/api/cases/${caseId}/network`);
  assert.equal(response.statusCode, 200);
  return response.json();
};

test('sieć bez analizy: czytelny błąd 409', async () => {
  const created = (await post('/api/cases', { name: 'Pusta', identifiers: [{ type: 'nick', value: 'nikt' }] })).json();
  const response = await app.inject(`/api/cases/${created.id}/network`);
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /najpierw wykonaj analizę/);
});

test('rozwinięcie konta → e-mail → konto B; zapis trwały, widoczny w sieci i w historii', async () => {
  const caseId = await caseWithRun();
  const before = await network(caseId);
  const profile = before.graph.nodes.find((node: { kind: string; label: string }) => node.kind === 'profile' && node.label === 'krypto_janek');
  assert.ok(profile, 'konto podmiotu w grafie teczki');
  assert.deepEqual(before.expansions, []);
  assert.equal(before.live, false);

  const plan = (await app.inject(`/api/cases/${caseId}/network/plan?nodeId=${encodeURIComponent(profile.id)}`)).json();
  assert.equal(plan.expandable, true);
  assert.ok(plan.groups.some((group: { id: string }) => group.id === 'accounts'));

  const expanded = await post(`/api/cases/${caseId}/network/expand`, { nodeId: profile.id, relations: ['accounts'], depth: 2 });
  assert.equal(expanded.statusCode, 201);
  const { expansion, added } = expanded.json();
  assert.ok(added.nodes >= 2);
  assert.equal(expansion.requestedBy, 'analityk');
  assert.deepEqual(expansion.relations, ['accounts']);
  assert.ok(expansion.results.runs.every((run: { legalBasis: string }) => run.legalBasis.length > 0));

  const after = await network(caseId);
  const b = after.graph.nodes.find((node: { id: string }) => node.id === accountKey('targ.example', 'wymiennik_b'));
  assert.ok(b, 'konto B w sieci');
  assert.ok(after.graph.edges.some((edge: { relation?: string; to: string; status: string }) => edge.relation === 'same_email' && edge.to === b.id && edge.status === 'source_fact'));
  const email = after.graph.nodes.find((node: { id: string }) => node.id === 'id:email:kontakt@wymiennik.example');
  assert.equal(email.depth, 1);
  assert.ok(email.link?.label, 'opis powiązania z podmiotem');
  assert.equal(after.expansions.length, 1);
  assert.ok(after.depthCounts['2'] >= 1);
  // Trwałość: zapis w bazie.
  const stored = await storage.listNetworkExpansions(caseId);
  assert.equal(stored[0]!.id, expansion.id);
  assert.deepEqual(stored[0]!.results.nodes.map((node) => node.id), expansion.results.nodes.map((node: { id: string }) => node.id));
});

test('druga ścieżka: adres B → konto C → wpis listy sankcyjnej; ścieżka do podmiotu pokazuje statusy kroków', async () => {
  const caseId = await caseWithRun();
  const profile = (await network(caseId)).graph.nodes.find((node: { kind: string; label: string }) => node.kind === 'profile' && node.label === 'krypto_janek');
  // Konto podmiotu → e-mail (1) → konto B (2) → adres B (3).
  await post(`/api/cases/${caseId}/network/expand`, { nodeId: profile.id, relations: ['accounts'], depth: 3 });
  const second = await post(`/api/cases/${caseId}/network/expand`, { nodeId: `addr:bitcoin:${BTC_B}`, relations: ['publications', 'accounts', 'sanctions'], depth: 2 });
  assert.equal(second.statusCode, 201);
  const net = await network(caseId);
  assert.equal(net.sanctioned.length, 1);
  const entry = net.graph.nodes.find((node: { id: string }) => node.id === net.sanctioned[0]);
  assert.equal(entry.status, 'source_fact');
  assert.ok(entry.link.summary.startsWith('ścieżka: '));
  assert.ok(net.graph.nodes.some((node: { id: string }) => node.id === accountKey('targ.example', 'leon_c')));
});

test('wycofanie: rozwinięcie znika z sieci, ale zostaje w historii (audyt); drugie wycofanie = 404', async () => {
  const caseId = await caseWithRun();
  const profile = (await network(caseId)).graph.nodes.find((node: { kind: string; label: string }) => node.kind === 'profile' && node.label === 'krypto_janek');
  const { expansion } = (await post(`/api/cases/${caseId}/network/expand`, { nodeId: profile.id, relations: ['accounts'] })).json();
  const removed = await app.inject({ method: 'DELETE', url: `/api/cases/${caseId}/network/expand/${expansion.id}` });
  assert.equal(removed.statusCode, 200);
  assert.ok(removed.json().expansion.withdrawnAt);
  const net = await network(caseId);
  assert.equal(net.expansions.length, 1);
  assert.ok(net.expansions[0].withdrawnAt);
  assert.ok(!net.graph.nodes.some((node: { expansionId?: string }) => node.expansionId === expansion.id));
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/cases/${caseId}/network/expand/${expansion.id}` })).statusCode, 404);
});

test('budżet z żądania i walidacja: głębokość ponad limit = 400, nieznany węzeł = 404', async () => {
  const caseId = await caseWithRun();
  assert.equal((await post(`/api/cases/${caseId}/network/expand`, { nodeId: 'subject', depth: 9 })).statusCode, 400);
  assert.equal((await post(`/api/cases/${caseId}/network/expand`, { nodeId: 'brak', depth: 1 })).statusCode, 404);
  assert.equal((await post(`/api/cases/${caseId}/network/expand`, { nodeId: 'subject', relations: ['nieznana'] })).statusCode, 400);
  const response = await post(`/api/cases/${caseId}/network/expand`, { nodeId: `addr:bitcoin:${BTC_B}`, relations: ['publications'], budget: 1 });
  // Adres B nie jest jeszcze w sieci tej sprawy.
  assert.equal(response.statusCode, 404);
  const profile = (await network(caseId)).graph.nodes.find((node: { kind: string; label: string }) => node.kind === 'profile' && node.label === 'krypto_janek');
  const limited = (await post(`/api/cases/${caseId}/network/expand`, { nodeId: profile.id, relations: ['accounts'], depth: 3, budget: 1 })).json();
  assert.equal(limited.expansion.budget.limit, 1);
  assert.ok(limited.expansion.budget.used <= 1);
  assert.ok(limited.expansion.stops.some((stop: { reason: string }) => stop.reason === 'budget'));
  assert.equal(rdapCalls, 0, 'bez źródeł publicznych RDAP nie jest pytany');
});

test('odtwarzalność i przetrwanie ponownej analizy: te same klucze bytów, rozwinięcie nadal w sieci', async () => {
  const caseId = await caseWithRun();
  const profile = (await network(caseId)).graph.nodes.find((node: { kind: string; label: string }) => node.kind === 'profile' && node.label === 'krypto_janek');
  const first = (await post(`/api/cases/${caseId}/network/expand`, { nodeId: profile.id, relations: ['accounts'], depth: 2 })).json().expansion;
  const again = (await post(`/api/cases/${caseId}/network/expand`, { nodeId: profile.id, relations: ['accounts'], depth: 2, force: true })).json().expansion;
  const shape = (record: { results: { nodes: { id: string }[]; edges: { id: string; status: string }[] } }) => ({
    nodes: record.results.nodes.map((node) => node.id),
    edges: record.results.edges.map((edge) => `${edge.id}:${edge.status}`),
  });
  assert.deepEqual(shape(again), shape(first));
  // Ponowna analiza: rozwinięcia zostają przypięte do tych samych kluczy.
  assert.equal((await post(`/api/cases/${caseId}/runs`)).statusCode, 201);
  const net = await network(caseId);
  assert.ok(net.graph.nodes.some((node: { id: string }) => node.id === accountKey('targ.example', 'wymiennik_b')));
  assert.equal(net.expansions.length, 2);
});
