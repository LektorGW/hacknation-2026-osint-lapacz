// Tryb demonstracyjny (`?demo=1`): rozwijanie sieci na małym, SYNTETYCZNYM zbiorze danych.
// Wszystkie osoby, firmy, konta, adresy i wpis listy sankcyjnej są ZMYŚLONE — w tym wpis „listy syntetycznej”,
// który nie odpowiada żadnej prawdziwej liście. Zasady są te same co w usłudze: status i siła każdej relacji,
// zanik na hipotezach, kontrahenci tylko jako adresy, rola w organizacji ≠ własność adresu, trafienie
// na liście = fakt wyłącznie dla bytu z listy.
//
// Scenariusz dla jury: konto podmiotu → e-mail kontaktowy → konto „kantor_wzor” na Targu → wspólny adres BTC
// → drugie konto „leon_mewa” → adres USDT na liście syntetycznej; równolegle domena e-maila → firma z rejestru
// (RDAP) → jednostka dominująca „Nordwind Capital Ltd (fikcyjna)” → ten sam wpis listy (po identyfikatorze LEI).
import type { ClaimStatus, GraphEdge, GraphNode, NetworkRelation } from '@olcys/core';
import { NETWORK_RELATIONS } from '../../../packages/core/src/network-path.ts';
import type { Backend } from './api.ts';
import { RELATION_GROUP_LABEL, RELATION_GROUP_ORDER, mergeExpansions } from './graph/network.ts';
import type { ExpandRequest, ExpandResult, ExpansionRecord, ExpansionStop, NetworkEdge, NetworkNode, NetworkPlan, NetworkView, RelationGroup } from './graph/network.ts';

const SANDBOX = 'https://piaskownica.example';
const Y = 'bc1qc2404vh2fkw50q07zf0rryfw7pmhluuk9slmqy';
const Z = '0x25E6d9F3ac99f2a374D83b82F9a691ccBB2558cF';
const DONOR = 'bc1qqc7wfn95hlqy258wunz82upt9t24c7ac4xwu2f';
const SAME_WALLET = '1AaQkkcE45GXGqgN4Wx7Yv79Mr3shMWmWy';
const LIST = 'Lista sankcyjna SYNTETYCZNA (dane zmyślone — demonstracja)';

const node = (id: string, kind: GraphNode['kind'], label: string, sublabel: string, extra: Partial<NetworkNode> = {}): NetworkNode => ({ id, kind, label, sublabel, ...extra, meta: { synthetic: true, ...(extra.meta ?? {}) } });

const N = {
  email: node('id:email:kontakt@kantor-wzor.example', 'identifier', 'kontakt@kantor-wzor.example', 'e-mail opublikowany przez konto'),
  kantor: node('profile:targ.example|kantor_wzor', 'profile', 'kantor_wzor', 'targ.example — konto z rozwinięcia („Kantor Wzór”)', { url: `${SANDBOX}/targ/oferta/9101` }),
  kantorForum: node('profile:forum.example|kantor_b', 'profile', 'kantor_b', 'forum.example — konto z rozwinięcia', { url: `${SANDBOX}/forum/u/kantor_b` }),
  gamer: node('profile:gry.example|tomwzor', 'profile', 'tomwzor', 'gry.example — konto o tej samej nazwie'),
  phone: node('id:phone:500000871', 'identifier', '+48 500 000 871', 'telefon opublikowany przez konto'),
  phoneLeon: node('id:phone:500000872', 'identifier', '+48 500 000 872', 'telefon opublikowany przez konto'),
  domain: node('id:domain:kantor-wzor.example', 'identifier', 'kantor-wzor.example', 'domena'),
  y: node(`addr:bitcoin:${Y}`, 'address', 'bc1qc2404v…k9slmqy', 'adres opublikowany przez konto'),
  z: node(`addr:ethereum:${Z}`, 'address', '0x25E6d9F3…BB2558cF', 'adres USDT opublikowany przez konto'),
  donor: node(`addr:bitcoin:${DONOR}`, 'address', 'bc1qqc7wfn…ac4xwu2f', 'kontrahent przelewu — anonimowy adres, nie osoba'),
  wallet: node(`addr:bitcoin:${SAME_WALLET}`, 'address', '1AaQkkcE45…3shMWmWy', 'ten sam portfel (heurystyka) — adres, nie osoba'),
  offerKantor: node('source:https://piaskownica.example/targ/oferta/9101', 'source', 'Szybka wymiana BTC ⇄ PLN', 'publikacja w targ.example z 2025-09-02', { url: `${SANDBOX}/targ/oferta/9101`, status: 'source_fact' }),
  offerLeon: node('source:https://piaskownica.example/targ/oferta/9102', 'source', 'Odbiór gotówki — rozliczenie BTC lub USDT', 'publikacja w targ.example z 2025-10-11', { url: `${SANDBOX}/targ/oferta/9102`, status: 'source_fact' }),
  leon: node('profile:targ.example|leon_mewa', 'profile', 'leon_mewa', 'targ.example — konto z rozwinięcia („Leon Mewa”)', { url: `${SANDBOX}/targ/oferta/9102` }),
  company: node('org:nazwa:kantor-wzor', 'organization', 'Kantor Wzór Sp. z o.o. (fikcyjna)', 'abonent domeny kantor-wzor.example według RDAP', { status: 'source_fact', url: 'https://rdap.example/domain/kantor-wzor.example' }),
  officer: node('person:demo:hubert-kos', 'person', 'Hubert Kos (fikcyjny)', 'prezes zarządu — rola w rejestrze; nie własność adresu', { status: 'source_fact', url: 'https://rejestr.example/krs/0000999001' }),
  parent: node('org:lei:DEMO-LEI-0001', 'organization', 'Nordwind Capital Ltd (fikcyjna)', 'jednostka dominująca według rejestru (LEI DEMO-LEI-0001)', { status: 'source_fact', url: 'https://rejestr.example/lei/DEMO-LEI-0001' }),
  entry: node('sankcje:lista-syntetyczna:SYN-2026-001', 'organization', 'NORDWIND CAPITAL LTD (FIKCYJNA)', `wpis na liście: ${LIST}`, { status: 'source_fact', url: `${SANDBOX}/sankcje/wpis/SYN-2026-001`, meta: { sanctioned: { list: LIST, entryId: 'SYN-2026-001', synthetic: true } } }),
};

interface Rel {
  group: RelationGroup;
  to: NetworkNode;
  relation: NetworkRelation;
  kind: GraphEdge['kind'];
  reverse?: boolean;
  label?: string;
  status?: ClaimStatus;
  layer?: 'identity' | 'chain';
  explanation: string;
  url?: string;
  attribute?: string;
}

const rel = (group: RelationGroup, to: NetworkNode, relation: NetworkRelation, kind: GraphEdge['kind'], explanation: string, extra: Partial<Rel> = {}): Rel => ({ group, to, relation, kind, explanation, ...extra });

/** Relacje bytów scenariusza (klucz = identyfikator węzła). */
const SCENARIO: Record<string, Rel[]> = {
  [N.email.id]: [
    rel('accounts', N.kantor, 'same_email', 'found_profile', 'Konto kantor_wzor na Targu podaje ten sam adres e-mail w ogłoszeniu.', { url: `${SANDBOX}/targ/oferta/9101`, attribute: 'e-mail: kontakt@kantor-wzor.example' }),
    rel('accounts', N.kantorForum, 'same_email', 'found_profile', 'Konto kantor_b na forum podaje ten sam adres e-mail w profilu.', { url: `${SANDBOX}/forum/u/kantor_b`, attribute: 'e-mail: kontakt@kantor-wzor.example' }),
    rel('accounts', N.domain, 'email_domain', 'links_to', 'Domena wynika z zapisu adresu e-mail.', { attribute: 'domena: kantor-wzor.example' }),
  ],
  [N.kantor.id]: [
    rel('accounts', N.phone, 'publishes_identifier', 'links_to', 'Ogłoszenie konta kantor_wzor podaje numer telefonu.', { url: `${SANDBOX}/targ/oferta/9101`, attribute: 'telefon: +48 500 000 871' }),
    rel('accounts', N.y, 'publishes_identifier', 'publishes', 'Konto kantor_wzor publikuje adres BTC do rozliczeń — deklaracja autora, nie dowód dysponowania kluczem.', { label: 'publikuje adres', url: `${SANDBOX}/targ/oferta/9101`, attribute: `adres: ${Y}` }),
  ],
  [N.phone.id]: [rel('accounts', N.kantorForum, 'same_phone', 'found_profile', 'Konto kantor_b na forum podaje ten sam numer telefonu.', { url: `${SANDBOX}/forum/u/kantor_b`, attribute: 'telefon: +48 500 000 871' })],
  [N.y.id]: [
    rel('publications', N.offerKantor, 'cited_in', 'documented_by', 'Ogłoszenie zawiera ten adres.', { label: 'adres w publikacji', url: `${SANDBOX}/targ/oferta/9101` }),
    rel('publications', N.offerLeon, 'cited_in', 'documented_by', 'Ogłoszenie zawiera ten adres.', { label: 'adres w publikacji', url: `${SANDBOX}/targ/oferta/9102` }),
    rel('publications', N.leon, 'publishes_identifier', 'publishes', 'Konto leon_mewa publikuje ten sam adres BTC jako „wspólny adres z partnerem” — deklaracja autora.', { reverse: true, label: 'publikuje adres jako własny', url: `${SANDBOX}/targ/oferta/9102`, attribute: `adres: ${Y}` }),
    rel('publications', N.kantor, 'publishes_identifier', 'publishes', 'Konto kantor_wzor publikuje ten adres jako własny.', { reverse: true, label: 'publikuje adres jako własny', url: `${SANDBOX}/targ/oferta/9101`, attribute: `adres: ${Y}` }),
  ],
  [N.leon.id]: [
    rel('accounts', N.z, 'publishes_identifier', 'publishes', 'Konto leon_mewa publikuje adres USDT (ERC-20) — deklaracja autora.', { label: 'publikuje adres', url: `${SANDBOX}/targ/oferta/9102`, attribute: `adres: ${Z}` }),
    rel('accounts', N.phoneLeon, 'publishes_identifier', 'links_to', 'Ogłoszenie konta leon_mewa podaje numer telefonu.', { url: `${SANDBOX}/targ/oferta/9102`, attribute: 'telefon: +48 500 000 872' }),
  ],
  [N.z.id]: [rel('sanctions', N.entry, 'sanctions_hit', 'documented_by', 'Adres figuruje we wpisie SYN-2026-001 LISTY SYNTETYCZNEJ — dane zmyślone. Trafienie dotyczy wyłącznie bytu z listy.', { url: `${SANDBOX}/sankcje/wpis/SYN-2026-001`, attribute: `${LIST}: SYN-2026-001` })],
  [N.domain.id]: [rel('organizations', N.company, 'rdap_registrant', 'links_to', 'Rejestr domen (RDAP) podaje „Kantor Wzór Sp. z o.o.” jako abonenta domeny (dane fikcyjne).', { url: 'https://rdap.example/domain/kantor-wzor.example', attribute: 'abonent: Kantor Wzór Sp. z o.o.' })],
  [N.company.id]: [
    rel('organizations', N.officer, 'holds_role', 'holds_role', 'Według rejestru: Hubert Kos — prezes zarządu (dane fikcyjne). Rola w organizacji nie oznacza własności adresu.', { reverse: true, label: 'prezes zarządu', url: 'https://rejestr.example/krs/0000999001' }),
    rel('organizations', N.parent, 'org_parent', 'org_relation', 'Według rejestru „Nordwind Capital Ltd” jest jednostką dominującą wobec „Kantor Wzór Sp. z o.o.” (dane fikcyjne).', { reverse: true, label: 'jednostka dominująca → spółka zależna', url: 'https://rejestr.example/lei/DEMO-LEI-0001' }),
  ],
  [N.parent.id]: [rel('sanctions', N.entry, 'sanctions_hit', 'documented_by', 'Identyfikator LEI DEMO-LEI-0001 figuruje we wpisie SYN-2026-001 LISTY SYNTETYCZNEJ — dane zmyślone. Fakt dotyczy wyłącznie bytu z listy.', { url: `${SANDBOX}/sankcje/wpis/SYN-2026-001`, attribute: 'LEI: DEMO-LEI-0001' })],
};

/** Relacje węzła: scenariusz albo — dla węzłów teczki — wejście do scenariusza zależne od rodzaju węzła. */
function relationsOf(item: GraphNode): Rel[] {
  if (SCENARIO[item.id]) return SCENARIO[item.id]!;
  if (item.kind === 'profile') return [rel('accounts', N.email, 'publishes_identifier', 'links_to', 'Profil konta podaje kontaktowy adres e-mail (dane demonstracyjne).', { url: item.url, attribute: 'e-mail: kontakt@kantor-wzor.example' })];
  if (item.kind === 'identifier' && item.id.startsWith('id:email:')) return SCENARIO[N.email.id]!.slice(0, 1);
  if (item.kind === 'identifier' && item.id.startsWith('id:nick:')) return [rel('accounts', N.gamer, 'same_nick', 'found_profile', 'Konto w serwisie z grami używa tej samej nazwy — zbieżność nazwy, nie ustalenie tożsamości.', { url: 'https://gry.example/u/tomwzor', attribute: `nick: ${item.label}` })];
  if (item.kind === 'address')
    return [
      rel('flows', N.y, 'counterparty', 'transfer', 'Przelew zapisany w blockchainie: 0,85 BTC na adres Y. Kontrahent jest tylko adresem.', { label: '1 przel., 0,85 BTC', layer: 'chain', attribute: 'txid: demo-1' }),
      rel('flows', N.donor, 'counterparty', 'transfer', 'Wpłata od anonimowego adresu (darczyńca, klient) — to nie jest osoba ze sprawy.', { reverse: true, label: '1 przel., 0,9 BTC', layer: 'chain', attribute: 'txid: demo-2' }),
      rel('flows', N.wallet, 'same_wallet', 'related', 'Adres zaliczony do tego samego portfela heurystyką wspólnych wejść — wnioskowanie, nie zapis.', { layer: 'chain', attribute: 'heurystyka: wspólne wejścia' }),
    ];
  return [];
}

const ENTITY_KINDS: GraphNode['kind'][] = ['subject', 'identifier', 'profile', 'address', 'organization', 'person', 'source', 'service'];

function edgeOf(from: GraphNode, item: Rel, expansionId: string, now: string): NetworkEdge {
  const spec = NETWORK_RELATIONS[item.relation];
  const [a, b] = item.reverse ? [item.to.id, from.id] : [from.id, item.to.id];
  const status = item.status ?? spec.status;
  return {
    id: `net:${item.relation}:${a}>${b}`,
    from: a,
    to: b,
    kind: item.kind,
    label: item.label ?? spec.label,
    status,
    ...(status === 'hypothesis' ? { inferred: true } : {}),
    weight: Math.round(spec.strength * 100),
    strength: spec.strength,
    relation: item.relation,
    layer: item.layer ?? 'identity',
    explanation: item.explanation,
    evidence: [...(item.url ? [{ kind: 'url' as const, value: item.url }] : []), ...(item.attribute ? [{ kind: 'attribute' as const, value: item.attribute }] : [])],
    expansionId,
    retrievedAt: now,
    caveat: spec.caveat,
  };
}

const expansions: ExpansionRecord[] = [];
let sequence = 0;

/** Rozwijanie sieci w trybie demonstracyjnym — `graphOf` zwraca graf teczki sprawy. */
export function createDemoNetwork(graphOf: (caseId: string) => Promise<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>): Pick<Backend, 'getNetwork' | 'getNetworkPlan' | 'expandNetwork' | 'withdrawExpansion'> {
  const view = async (caseId: string): Promise<NetworkView | null> => {
    const graph = await graphOf(caseId);
    if (!graph) return null;
    const own = expansions.filter((item) => item.caseId === caseId);
    return { caseId, runId: 'demo', generatedAt: new Date().toISOString(), ...mergeExpansions(graph, own), expansions: own, live: false, demo: true };
  };
  return {
    getNetwork: view,
    async getNetworkPlan(caseId, nodeId): Promise<NetworkPlan | null> {
      const network = await view(caseId);
      const target = network?.graph.nodes.find((item) => item.id === nodeId);
      if (!network || !target) return null;
      if (!ENTITY_KINDS.includes(target.kind)) {
        return { nodeId, expandable: false, reason: 'Węzeł jest hipotezą narzędzia (np. operator) — rozwija się byty ze źródeł: konta, identyfikatory, adresy, organizacje, osoby, publikacje.', items: [], groups: [] };
      }
      const rels = relationsOf(target);
      const groups = RELATION_GROUP_ORDER.filter((group) => group === 'sanctions' || rels.some((item) => item.group === group));
      return {
        nodeId,
        expandable: true,
        entity: { kind: target.kind, label: target.label },
        items: [],
        groups: groups.map((group) => ({ id: group, label: RELATION_GROUP_LABEL[group], cost: group === 'sanctions' ? 0 : Math.max(1, rels.filter((item) => item.group === group).length), available: true, done: false })),
        limits: { defaultBudget: 20, maxBudget: 60, maxDepth: 3 },
      };
    },
    async expandNetwork(caseId, request: ExpandRequest): Promise<ExpandResult> {
      const network = await view(caseId);
      const seed = network?.graph.nodes.find((item) => item.id === request.nodeId);
      if (!network || !seed) throw new Error('Nie ma takiego węzła w sieci sprawy.');
      await new Promise((resolve) => setTimeout(resolve, 600));
      const id = `demo-rozwiniecie-${++sequence}`;
      const now = new Date().toISOString();
      const known = new Map(network.graph.nodes.map((item) => [item.id, item]));
      const groups = request.relations.length > 0 ? request.relations : RELATION_GROUP_ORDER;
      const nodes = new Map<string, NetworkNode>([[seed.id, { ...seed, known: true }]]);
      const edges = new Map<string, NetworkEdge>();
      const stops: ExpansionStop[] = [];
      let frontier: GraphNode[] = [seed];
      let used = 0;
      const budget = request.budget ?? 20;
      for (let hop = 1; hop <= request.depth && frontier.length > 0; hop++) {
        const next: GraphNode[] = [];
        for (const current of frontier) {
          const rels = relationsOf(current).filter((item) => groups.includes(item.group));
          if (groups.includes('sanctions') && !rels.some((item) => item.group === 'sanctions')) stops.push({ reason: 'no_results', detail: `${current.label}: brak trafień na liście syntetycznej.` });
          for (const item of rels) {
            if (used >= budget) {
              stops.push({ reason: 'budget', detail: `Budżet ${budget} zapytań wyczerpany — pominięto część relacji „${current.label}”.` });
              break;
            }
            used += item.group === 'sanctions' ? 0 : 1;
            if (!nodes.has(item.to.id)) {
              const existing = known.get(item.to.id);
              nodes.set(item.to.id, existing ? { ...existing, known: true } : { ...item.to, depth: hop, expansionId: id });
              next.push(item.to);
            }
            const edge = edgeOf(current, item, id, now);
            edges.set(edge.id, edge);
          }
        }
        if (hop === request.depth && next.length > 0) stops.push({ reason: 'depth_limit', detail: `Osiągnięto wskazaną głębokość (${request.depth}) — nowych bytów (${next.length}) nie rozwijano dalej.` });
        frontier = next;
      }
      if (edges.size === 0) stops.push({ reason: 'no_results', detail: `„${seed.label}”: dane demonstracyjne nie zawierają dalszych powiązań dla wybranych grup.` });
      const record: ExpansionRecord = {
        id,
        caseId,
        nodeId: seed.id,
        relations: request.relations,
        depth: request.depth,
        budget: { limit: budget, used },
        startedAt: now,
        finishedAt: new Date().toISOString(),
        requestedBy: 'analityk (demo)',
        results: {
          nodes: [...nodes.values()],
          edges: [...edges.values()],
          runs: groups.map((group) => ({ expander: `demo-${group}`, label: RELATION_GROUP_LABEL[group], entity: seed.id, provider: 'dane demonstracyjne (syntetyczne)', legalBasis: 'dane zmyślone — bez zapytań do prawdziwych źródeł', requests: 0, nodes: 0, edges: 0, hop: 1 })),
        },
        stops,
        sourceErrors: [],
      };
      expansions.push(record);
      return { expansion: record, added: { nodes: record.results.nodes.filter((item) => !item.known).length, edges: edges.size } };
    },
    async withdrawExpansion(caseId, expansionId) {
      const record = expansions.find((item) => item.caseId === caseId && item.id === expansionId && !item.withdrawnAt);
      if (!record) throw new Error('Nie ma takiego obowiązującego rozwinięcia.');
      record.withdrawnAt = new Date().toISOString();
      record.withdrawnBy = 'analityk (demo)';
    },
  };
}
