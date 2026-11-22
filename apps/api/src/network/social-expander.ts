// Ekspander „relacje w serwisach”: konto w serwisie z kodem → publiczne organizacje, obserwujący i obserwowani,
// współtwórcy własnych repozytoriów. Tylko na żądanie (grupa `social`, nie wchodzi do „wszystkich grup”).
//
// Granice uczciwości:
//   - nowe byty są KONTAMI (węzły `profile:serwis|nazwa`), nigdy osobami, i nigdy nie są scalane z podmiotem;
//   - członkostwo, obserwowanie i współtworzenie to fakty źródłowe o relacji, nie o tożsamości;
//   - obserwowanie konta nie świadczy o znajomości (siła 0,1);
//   - współtwórca repozytorium to relacja zawodowa/projektowa; „współpraca w repozytorium” i „bliska współpraca”
//     (wzajemne obserwowanie + wspólne repozytorium) to obliczenia narzędzia.
//
// Dostawcy relacji są wymienni (`SocialGraphProvider` z @olcys/sources): dziś GitHub; GitLab, Codeberg i inne
// serwisy z kodem dopisuje się jako kolejnego dostawcę i nazwę serwisu w `SOCIAL_GRAPH_SERVICES`.

import type { SocialGraph, SocialGraphProvider } from '@olcys/sources';
import { normalize } from '../identity.ts';
import { accountKey, documentKey, edgeFrom } from './entities.ts';
import type { ExpandContext, Expander } from './expander.ts';
import type { EdgeDraft, Entity, ExpanderOutput, ExpansionStop, NetworkEdge, NetworkNode } from './types.ts';

/** Serwisy, dla których istnieje dostawca relacji (rozszerzalne przez kolejnych dostawców). */
export const SOCIAL_GRAPH_SERVICES = new Set<string>(['github.com']);

/** Najwyżej tyle nowych węzłów z jednego rozwinięcia relacji konta (silnik ma własny limit 80). */
export const SOCIAL_NODE_LIMIT = 60;

export const SOCIAL_CAVEATS = {
  follows: 'Obserwowanie konta nie świadczy o znajomości.',
  contributor: 'Współtwórca repozytorium to relacja zawodowa/projektowa.',
  member: 'Członkostwo w organizacji serwisu to relacja zawodowa/projektowa — nie oznacza udziału w czynach organizacji.',
} as const;

const SERVICE_NAME: Record<string, string> = { 'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'codeberg.org': 'Codeberg' };

const providerFor = (entity: Entity, context: ExpandContext): SocialGraphProvider | undefined =>
  (context.social ?? []).find((provider) => provider.service === entity.meta.service && provider.accepts(entity.meta.handle ?? entity.value ?? ''));

const STOP_REASON: Record<string, ExpansionStop['reason']> = { budget: 'budget', rate_limit: 'source_error', source_error: 'source_error', limit: 'node_limit', missing: 'no_results' };

export const socialExpander: Expander = {
  id: 'konto-relacje-serwisu',
  group: 'social',
  label: 'Konto w serwisie z kodem → organizacje, obserwujący i obserwowani, współtwórcy repozytoriów',
  reads:
    'Publiczne relacje konta w serwisie (API serwisu): organizacje upublicznione przez konto, najnowsi obserwujący i obserwowani (po 30), ' +
    'własne repozytoria (30) i ich współtwórcy (po 10, największy wkład). Gwiazdek nie pobiera.',
  provider: 'GitHub REST API (api.github.com; token GITHUB_TOKEN opcjonalny) — dostawcy wymienni (GitLab, Codeberg do dopisania)',
  legalBasis:
    'docs/ZRODLA-PODSTAWA-PRAWNA.md, „Relacje konta w serwisach z kodem i konta zadeklarowane na stronach WWW” — GitHub REST API ' +
    '(regulamin: „Scraping does not refer to the collection of information through our API.”)',
  produces: ['org_member', 'follows', 'repo_contributor', 'repo_collaboration', 'close_collaboration'],
  applies: (entity) => entity.kind === 'account' && SOCIAL_GRAPH_SERVICES.has(entity.meta.service ?? '') && Boolean(entity.meta.handle ?? entity.value),
  cost: (entity, context) => providerFor(entity, context)?.estimate ?? 0,
  unavailable: (entity, context) =>
    entity.meta.synthetic || context.synthetic
      ? { reason: 'not_applicable', detail: 'Konto z danych demonstracyjnych — prawdziwy serwis nie jest pytany.' }
      : !context.live
        ? { reason: 'not_live', detail: 'Relacje konta w serwisie wymagają włączenia źródeł publicznych (ENABLE_LIVE).' }
        : !providerFor(entity, context)
          ? { reason: 'no_provider', detail: `Brak dostawcy relacji dla serwisu ${entity.meta.service}.` }
          : null,
  async run(entity, context) {
    const provider = providerFor(entity, context)!;
    const handle = (entity.meta.handle ?? entity.value ?? entity.label).replace(/^@/, '');
    let graph: SocialGraph | null = null;
    const errors: ExpanderOutput['errors'] = [];
    try {
      graph = await provider.fetch(handle, { reserve: context.reserve, log: (message) => context.log(`[${provider.id}] ${message}`), ...(context.signal ? { signal: context.signal } : {}), now: context.now });
    } catch (error) {
      errors.push({ source: provider.label, expander: this.id, message: error instanceof Error ? error.message : String(error) });
    }
    if (!graph) {
      return { nodes: [], edges: [], errors, notes: [{ reason: 'no_results', detail: `${SERVICE_NAME[provider.service] ?? provider.service}: brak konta „${handle}” albo brak danych.`, expander: this.id }], requests: 0 };
    }
    return { ...socialGraphToNetwork(entity, graph, this.id), errors };
  },
};

/** Przekład relacji konta na węzły i krawędzie sieci (czysta funkcja — testowana bez sieci). */
export function socialGraphToNetwork(entity: Entity, graph: SocialGraph, expander: string): ExpanderOutput {
  const service = graph.service;
  const name = SERVICE_NAME[service] ?? service;
  const self = normalize(graph.login);
  const where = `konto ${graph.login} (${name})`;
  const nodes = new Map<string, NetworkNode>();
  const edges = new Map<string, NetworkEdge>();
  const notes: ExpansionStop[] = graph.stops.map((stop) => ({ reason: STOP_REASON[stop.reason] ?? 'source_error', detail: stop.detail, ...(stop.skipped ? { skipped: stop.skipped } : {}), expander }));
  const retrievedAt = graph.retrievedAt;
  const apiEvidence = (fragment: string) => graph.sources.filter((url) => url.includes(fragment)).slice(0, 2).map((value) => ({ kind: 'url' as const, value }));
  let dropped = 0;

  const isSelf = (login: string) => normalize(login) === self;
  const account = (login: string, url: string, sublabel: string): string | null => {
    const id = accountKey(service, login);
    if (id === entity.key || isSelf(login)) return null;
    if (!nodes.has(id)) {
      if (nodes.size >= SOCIAL_NODE_LIMIT) {
        dropped++;
        return null;
      }
      nodes.set(id, { id, kind: 'profile', label: login, sublabel, url, entityKind: 'account', meta: { service, handle: login } });
    }
    return id;
  };
  const edge = (draft: EdgeDraft) => {
    if (draft.from === draft.to) return;
    const built = edgeFrom(draft, expander);
    if (!edges.has(built.id)) edges.set(built.id, built);
  };

  // 1. Organizacje (konta organizacji w serwisie, nie wpisy rejestru).
  for (const org of graph.organizations) {
    const to = account(org.login, org.url, `organizacja w serwisie ${name} — konto, nie rejestr`);
    if (!to) continue;
    edge({
      from: entity.key,
      to,
      relation: 'org_member',
      kind: 'related',
      label: `członek organizacji ${name}`,
      explanation: `${capital(where)} publicznie należy do organizacji ${org.login} według ${name}. ${SOCIAL_CAVEATS.member}`,
      evidence: [...apiEvidence('/orgs'), { kind: 'url', value: org.url }],
      retrievedAt,
    });
  }

  // 2. Współtwórcy własnych repozytoriów; konto ↔ konto — współpraca (obliczenie).
  const followers = new Set(graph.followers.map((item) => normalize(item.login)));
  const following = new Set(graph.following.map((item) => normalize(item.login)));
  const mutual = (login: string) => followers.has(normalize(login)) && following.has(normalize(login));
  const together = new Map<string, { login: string; url: string; repos: string[]; contributions: number }>();
  for (const repo of graph.repos) {
    const others = (repo.contributors ?? []).filter((item) => !isSelf(item.login));
    for (const item of others) {
      const entry = together.get(normalize(item.login)) ?? { login: item.login, url: item.url, repos: [], contributions: 0 };
      entry.repos.push(repo.fullName);
      entry.contributions += item.contributions;
      together.set(normalize(item.login), entry);
    }
  }
  // Kolejność: najpierw bliska współpraca, potem największy wkład — przy limicie węzłów zostają najistotniejsze.
  const collaborators = [...together.values()].sort((a, b) => Number(mutual(b.login)) - Number(mutual(a.login)) || b.contributions - a.contributions || a.login.localeCompare(b.login));
  const repoNodes = new Map<string, string>();
  const repoNode = (fullName: string): string => {
    const repo = graph.repos.find((item) => item.fullName === fullName)!;
    const existing = repoNodes.get(fullName);
    if (existing) return existing;
    const id = documentKey(repo.url);
    nodes.set(id, { id, kind: 'source', label: repo.fullName, sublabel: `repozytorium w serwisie ${name}${repo.pushedAt ? `; ostatnia zmiana ${repo.pushedAt.slice(0, 10)}` : ''}`, url: repo.url, status: 'source_fact', entityKind: 'document' });
    repoNodes.set(fullName, id);
    const own = (repo.contributors ?? []).find((item) => isSelf(item.login));
    edge({
      from: entity.key,
      to: id,
      relation: 'repo_contributor',
      kind: 'related',
      label: own ? `właściciel i współtwórca repozytorium ${repo.fullName}` : `właściciel repozytorium ${repo.fullName}`,
      explanation: `${capital(where)} jest właścicielem repozytorium ${repo.fullName}${own ? ` (${own.contributions} zmian według ${name})` : ''}.`,
      evidence: [{ kind: 'url', value: repo.url }, ...apiEvidence(`/repos/${repo.fullName}/contributors`)],
      retrievedAt,
    });
    return id;
  };
  for (const person of collaborators) {
    const to = account(person.login, person.url, `współtwórca repozytorium w serwisie ${name} — konto, nie osoba`);
    if (!to) continue;
    for (const fullName of person.repos) {
      const repo = graph.repos.find((item) => item.fullName === fullName)!;
      const contributions = repo.contributors?.find((item) => normalize(item.login) === normalize(person.login))?.contributions ?? 0;
      edge({
        from: to,
        to: repoNode(fullName),
        relation: 'repo_contributor',
        kind: 'related',
        label: `współtwórca repozytorium ${fullName}`,
        explanation: `${person.login}: ${contributions} zmian w repozytorium ${fullName} według ${name}. ${SOCIAL_CAVEATS.contributor}`,
        evidence: [{ kind: 'url', value: repo.url }, ...apiEvidence(`/repos/${fullName}/contributors`)],
        retrievedAt,
      });
    }
    const close = mutual(person.login);
    edge({
      from: entity.key,
      to,
      relation: close ? 'close_collaboration' : 'repo_collaboration',
      kind: 'related',
      label: close ? 'bliska współpraca (obserwują się wzajemnie, wspólne repozytorium)' : `współpraca w repozytorium ${person.repos.slice(0, 2).join(', ')}${person.repos.length > 2 ? ` i ${person.repos.length - 2} innych` : ''}`,
      explanation: close
        ? `${capital(where)} i ${person.login} obserwują się wzajemnie i oba mają wkład w ${person.repos.join(', ')}. Obliczenie narzędzia: przesłanka bliskiej współpracy zawodowej, nie znajomości ani tożsamości.`
        : `${capital(where)} i ${person.login} mają wkład w ${person.repos.join(', ')}. ${SOCIAL_CAVEATS.contributor}`,
      evidence: person.repos.slice(0, 5).map((fullName) => ({ kind: 'url' as const, value: graph.repos.find((item) => item.fullName === fullName)!.url })),
      retrievedAt,
    });
  }

  // 3. Obserwowanie: wzajemne pierwsze, potem obserwowani, potem obserwujący.
  const follow = (login: string, url: string, direction: 'out' | 'in') => {
    const both = mutual(login);
    const to = account(login, url, both ? `obserwują się wzajemnie w serwisie ${name} — konto, nie osoba` : direction === 'out' ? `konto obserwowane w serwisie ${name}` : `obserwujący w serwisie ${name}`);
    if (!to) return;
    edge({
      from: direction === 'out' ? entity.key : to,
      to: direction === 'out' ? to : entity.key,
      relation: 'follows',
      kind: 'related',
      label: both ? 'obserwują się wzajemnie' : 'obserwuje',
      explanation: `${direction === 'out' ? `${capital(where)} obserwuje konto ${login}` : `Konto ${login} obserwuje ${where}`} według ${name}${both ? ' (obserwowanie wzajemne)' : ''}. ${SOCIAL_CAVEATS.follows}`,
      evidence: [...apiEvidence(direction === 'out' ? '/following' : '/followers'), { kind: 'url', value: url }],
      retrievedAt,
    });
  };
  const mutualList = graph.following.filter((item) => mutual(item.login));
  for (const item of mutualList) {
    follow(item.login, item.url, 'out');
    follow(item.login, item.url, 'in');
  }
  for (const item of graph.following) if (!mutual(item.login)) follow(item.login, item.url, 'out');
  for (const item of graph.followers) if (!mutual(item.login)) follow(item.login, item.url, 'in');

  if (dropped > 0) notes.push({ reason: 'node_limit', detail: `${capital(where)}: pokazano ${SOCIAL_NODE_LIMIT} kont, ${dropped} pominięto (najmniej istotne: obserwujący).`, skipped: dropped, expander });
  if (nodes.size === 0) notes.push({ reason: 'no_results', detail: `${capital(where)}: brak publicznych organizacji, obserwujących ani współtwórców.`, expander });
  // Krawędzie wskazujące węzły pominięte przez limit nie trafiają do wyniku.
  const kept = [...edges.values()].filter((item) => (item.from === entity.key || nodes.has(item.from)) && (item.to === entity.key || nodes.has(item.to)));
  return { nodes: [...nodes.values()], edges: kept, notes, requests: graph.requests };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
