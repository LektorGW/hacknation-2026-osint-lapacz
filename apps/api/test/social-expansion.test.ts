// Rozwinięcie „relacje w serwisach” (GitHub): organizacje, obserwujący, współtwórcy. Statusy relacji, granice
// uczciwości (konta, nie osoby; bez scalania z podmiotem), zapis trwały i wycofanie. Dane fikcyjne, `fetch` — atrapa.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createGithubSocialProvider } from '@olcys/sources';
import type { SocialGraph } from '@olcys/sources';
import { buildApp } from '../src/app.ts';
import { accountKey } from '../src/network/entities.ts';
import { socialExpander, socialGraphToNetwork } from '../src/network/social-expander.ts';
import type { Entity } from '../src/network/types.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import type { Storage } from '../src/storage.ts';
import { FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

const API = 'https://api.github.com';
const user = (login: string) => ({ login, html_url: `https://github.com/${login}`, type: 'User' });

const routes: Record<string, unknown> = {
  [`${API}/users/ola-gh`]: { login: 'ola-gh', html_url: 'https://github.com/ola-gh', followers: 2, following: 2, public_repos: 1 },
  [`${API}/users/ola-gh/orgs?per_page=30`]: [{ login: 'pracownia-oli' }],
  [`${API}/users/ola-gh/followers?per_page=30&page=1`]: [user('kolega-gh'), user('fan-gh')],
  [`${API}/users/ola-gh/following?per_page=30&page=1`]: [user('kolega-gh'), user('autorka-gh')],
  [`${API}/users/ola-gh/repos?type=owner&sort=pushed&per_page=30`]: [{ full_name: 'ola-gh/narzedzie', html_url: 'https://github.com/ola-gh/narzedzie', fork: false }],
  [`${API}/repos/ola-gh/narzedzie/contributors?per_page=10`]: [
    { ...user('ola-gh'), contributions: 120 },
    { ...user('kolega-gh'), contributions: 30 },
    { ...user('pomocnik-gh'), contributions: 4 },
  ],
};
const calls: string[] = [];
const fetcher = async (url: string) => {
  calls.push(url);
  const body = routes[url];
  return new Response(body === undefined ? '{}' : JSON.stringify(body), { status: body === undefined ? 404 : 200, headers: { 'content-type': 'application/json' } });
};

let app: FastifyInstance;
let storage: Storage;

before(async () => {
  storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const github = fakeConnector('gh-atrapa', 'github.com', ['nick'], (identifier) =>
    identifier.value === 'ola-gh' ? [{ url: 'https://github.com/ola-gh', author: 'ola-gh', text: 'Profil Oli.', profile: { handle: 'ola-gh', displayName: 'Ola Przykładowa' } }] : [],
  );
  app = await buildApp({
    storage,
    connectors: [github],
    chainProviders: [fakeProvider()],
    now: FIXED_NOW,
    network: { live: true, sanctions: [], organizations: null, rdap: null, social: [createGithubSocialProvider({ fetcher })] },
  });
});
after(() => app.close());

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
const network = async (caseId: string) => (await app.inject(`/api/cases/${caseId}/network`)).json();

const entity: Entity = { key: accountKey('github.com', 'ola-gh'), kind: 'account', label: 'ola-gh', value: 'ola-gh', meta: { service: 'github.com', handle: 'ola-gh' } };
const graph: SocialGraph = {
  service: 'github.com',
  login: 'ola-gh',
  profileUrl: 'https://github.com/ola-gh',
  organizations: [{ login: 'pracownia-oli', url: 'https://github.com/pracownia-oli', kind: 'organization' }],
  followers: [{ login: 'kolega-gh', url: 'https://github.com/kolega-gh', kind: 'user' }, { login: 'fan-gh', url: 'https://github.com/fan-gh', kind: 'user' }],
  following: [{ login: 'kolega-gh', url: 'https://github.com/kolega-gh', kind: 'user' }, { login: 'Ola-GH', url: 'https://github.com/Ola-GH', kind: 'user' }],
  repos: [
    {
      fullName: 'ola-gh/narzedzie',
      url: 'https://github.com/ola-gh/narzedzie',
      fork: false,
      contributors: [
        { login: 'ola-gh', url: 'https://github.com/ola-gh', contributions: 120 },
        { login: 'kolega-gh', url: 'https://github.com/kolega-gh', contributions: 30 },
        { login: 'pomocnik-gh', url: 'https://github.com/pomocnik-gh', contributions: 4 },
      ],
    },
  ],
  totals: { followers: 2, following: 2, publicRepos: 1 },
  sources: [`${API}/users/ola-gh/orgs?per_page=30`, `${API}/users/ola-gh/followers?per_page=30&page=1`, `${API}/users/ola-gh/following?per_page=30&page=1`],
  retrievedAt: '2026-11-22T10:00:00.000Z',
  requests: 6,
  stops: [],
};

test('relacje konta: statusy, siły i zastrzeżenia; nowe byty to konta, nigdy podmiot', () => {
  const out = socialGraphToNetwork(entity, graph, socialExpander.id);
  const edge = (relation: string, to: string) => out.edges.find((item) => item.relation === relation && (item.to === to || item.from === to));
  const kolega = accountKey('github.com', 'kolega-gh');
  const pomocnik = accountKey('github.com', 'pomocnik-gh');
  const org = accountKey('github.com', 'pracownia-oli');

  // Podmiot nie jest nowym węzłem (także pod inną wielkością liter).
  assert.ok(!out.nodes.some((node) => node.id === entity.key));
  assert.ok(out.nodes.filter((node) => node.kind === 'profile').every((node) => node.entityKind === 'account' && node.meta?.service === 'github.com'));
  assert.ok(!out.nodes.some((node) => node.kind === 'person'), 'żadnej osoby z relacji w serwisie');

  const member = edge('org_member', org)!;
  assert.equal(member.status, 'source_fact');
  assert.match(member.label!, /członek organizacji GitHub/);

  const follows = out.edges.filter((item) => item.relation === 'follows');
  assert.ok(follows.every((item) => item.status === 'source_fact' && item.strength === 0.1));
  assert.ok(follows.every((item) => /Obserwowanie konta nie świadczy o znajomości/.test(item.explanation!)));
  assert.ok(follows.some((item) => item.from === accountKey('github.com', 'fan-gh') && item.to === entity.key), 'obserwujący → konto');
  assert.ok(follows.some((item) => item.from === entity.key && item.to === kolega) && follows.some((item) => item.from === kolega && item.to === entity.key), 'obserwowanie wzajemne');

  const contributor = out.edges.find((item) => item.relation === 'repo_contributor' && item.from === pomocnik)!;
  assert.equal(contributor.status, 'source_fact');
  assert.match(contributor.label!, /współtwórca repozytorium ola-gh\/narzedzie/);
  assert.match(contributor.explanation!, /relacja zawodowa\/projektowa/);

  // Wzajemne obserwowanie + wspólne repozytorium = bliska współpraca (obliczenie); sam wkład = współpraca w repozytorium.
  assert.equal(edge('close_collaboration', kolega)!.status, 'computed');
  assert.equal(edge('repo_collaboration', kolega), undefined);
  const collab = edge('repo_collaboration', pomocnik)!;
  assert.equal(collab.status, 'computed');
  assert.match(collab.label!, /współpraca w repozytorium ola-gh\/narzedzie/);
});

test('plan: grupa „relacje w serwisach” tylko dla kont GitHub; rozwinięcie zapisane, widoczne w sieci i wycofywalne', async () => {
  const created = (await post('/api/cases', { name: 'Ola P.', identifiers: [{ type: 'nick', value: 'ola-gh' }] })).json();
  assert.equal((await post(`/api/cases/${created.id}/runs`)).statusCode, 201);
  const caseId = created.id;
  const before = await network(caseId);
  const profile = before.graph.nodes.find((node: { kind: string; label: string }) => node.kind === 'profile' && node.label === 'ola-gh');
  assert.ok(profile, 'konto GitHub w teczce');

  const plan = (await app.inject(`/api/cases/${caseId}/network/plan?nodeId=${encodeURIComponent(profile.id)}`)).json();
  const group = plan.groups.find((item: { id: string }) => item.id === 'social');
  assert.ok(group, 'grupa social w planie');
  assert.match(group.label, /relacje w serwisach \(GitHub: organizacje, obserwujący, współtwórcy\)/);
  assert.equal(group.available, true);

  // „Wszystkie grupy” (bez wskazania) nie uruchamiają relacji w serwisach — tylko na żądanie.
  const callsBefore = calls.length;
  const all = (await post(`/api/cases/${caseId}/network/expand`, { nodeId: profile.id })).json();
  assert.ok(!all.expansion.results.runs.some((run: { expander: string }) => run.expander === socialExpander.id));
  assert.equal(calls.length, callsBefore);

  const response = await post(`/api/cases/${caseId}/network/expand`, { nodeId: profile.id, relations: ['social'] });
  assert.equal(response.statusCode, 201);
  const { expansion } = response.json();
  assert.deepEqual(expansion.relations, ['social']);
  const run = expansion.results.runs.find((item: { expander: string }) => item.expander === socialExpander.id);
  assert.equal(run.requests, 6);
  assert.match(run.legalBasis, /GitHub REST API/);
  assert.ok(expansion.budget.used >= 6);

  const net = await network(caseId);
  const kolega = accountKey('github.com', 'kolega-gh');
  assert.ok(net.graph.nodes.some((node: { id: string; kind: string }) => node.id === kolega && node.kind === 'profile'));
  assert.ok(net.graph.edges.some((edge: { relation?: string; status: string }) => edge.relation === 'close_collaboration' && edge.status === 'computed'));
  const stored = await storage.listNetworkExpansions(caseId);
  assert.ok(stored.some((item) => item.id === expansion.id));

  const removed = await app.inject({ method: 'DELETE', url: `/api/cases/${caseId}/network/expand/${expansion.id}` });
  assert.equal(removed.statusCode, 200);
  const afterWithdraw = await network(caseId);
  assert.ok(!afterWithdraw.graph.nodes.some((node: { id: string }) => node.id === kolega));
  assert.ok(afterWithdraw.expansions.some((item: { id: string; withdrawnAt?: string }) => item.id === expansion.id && item.withdrawnAt));
});
