// Ekspander „obieg środków (ping-pong)”: na żądanie („Szukaj dalej” przy adresie) szuka wypływów, które
// wracają na adres badany, inny adres jego portfela albo inny adres sprawy — bezpośrednio (A→B→A) albo
// przez 1..N adresów pośrednich. Algorytm: `findRoundTrips` z @olcys/chain; tu tylko dane, budżet i graf.
//
// Każdy krok obiegu to krawędź „przelew” ze statusem faktu źródłowego (txid w dowodach). Sam obieg — że krążą
// te same środki albo działa ta sama osoba — jest hipotezą i jest opisany w zapisie rozwinięcia, nie krawędzią.

import { INTERMEDIARY_CLASS_LABEL, ROUNDTRIP_LIMITS, StaticRateSource, findRoundTrips } from '@olcys/chain';
import type { ChainRequestContext, RoundTripActivity, RoundTripStopReason } from '@olcys/chain';
import type { ChainActivity, Network } from '@olcys/core';
import { shortAddress } from '../format.ts';
import { addressNodeKey, edgeFrom } from './entities.ts';
import { LEGAL } from './expander.ts';
import type { ExpandContext, Expander } from './expander.ts';
import type { Entity, ExpansionStop, NetworkEdge, NetworkNode, RoundTripCycleView } from './types.ts';

const STOP_REASON: Record<RoundTripStopReason, ExpansionStop['reason']> = {
  budget: 'budget',
  max_hops: 'depth_limit',
  time_window: 'time_limit',
  service_reached: 'not_applicable',
  fan_out: 'node_limit',
  dust: 'node_limit',
  cycle_limit: 'node_limit',
  source_error: 'source_error',
};

const findingOf = (entity: Entity, context: ExpandContext) =>
  context.findings.find((finding) => finding.network === entity.meta.network && finding.address.toLowerCase() === (entity.meta.address ?? '').toLowerCase());

const norm = (address: string) => (address.startsWith('0x') ? address.toLowerCase() : address);
const amountText = (amount: number) => amount.toLocaleString('pl-PL', { maximumFractionDigits: 8 });

export const roundTripExpander: Expander = {
  id: 'adres-obieg',
  group: 'roundtrip',
  label: 'Adres → obieg środków (ping-pong): wypływy, które wracają na ten adres, jego portfel albo inny adres sprawy',
  reads:
    'Przelewy adresu z teczki (ping-pong A→B→A bez zapytań), a na żądanie — przelewy wychodzące kolejnych adresów pośrednich: tylko największe kwoty, ' +
    'w oknie czasu, do limitu kroków i budżetu pobrań. Historii giełd, mikserów i kontraktów nie pobiera.',
  provider: 'zapisana aktywność z teczki; adresy pośrednie — dostawcy danych blockchain (@olcys/chain, uprzejmy klient HTTP)',
  legalBasis: `${LEGAL.dossier}; ${LEGAL.chain}`,
  produces: ['roundtrip_hop'],
  applies: (entity) => entity.kind === 'crypto_address',
  cost: (entity, context) => (findingOf(entity, context)?.chain ? 0 : 1) + (context.roundtrip?.budget ?? ROUNDTRIP_LIMITS.defaultBudget),
  unavailable: (entity, context) =>
    findingOf(entity, context)?.chain || context.chainProviders.some((provider) => provider.supports(entity.meta.network as never, entity.meta.address ?? ''))
      ? null
      : { reason: 'no_provider', detail: `Brak dostawcy danych blockchain dla sieci ${entity.meta.network}.` },
  async run(entity, context) {
    const network = entity.meta.network!;
    const address = entity.meta.address!;
    const notes: ExpansionStop[] = [];
    const errors: { source: string; expander: string; message: string }[] = [];
    let requests = 0;
    const supported = context.chainProviders.filter((provider) => provider.supports(network as never, address));
    // Adres pośredni: najnowsza historia, bez śledzenia w głąb i bez szukania powiązań — tylko przelewy.
    const fetchFrom = async (target: string): Promise<ChainActivity | undefined> => {
      const request: ChainRequestContext = {
        log: (message: string) => context.log(`[obieg] ${message}`),
        ...(context.signal ? { signal: context.signal } : {}),
        history: 'recent',
        requestBudget: 1,
        linkBudget: 0,
      };
      requests++;
      const providers = context.chainProviders.filter((provider) => provider.supports(network as never, target));
      return context.resolveActivity ? context.resolveActivity(providers, network as Network, target, request) : providers[0]?.getActivity(network as Network, target, request);
    };

    let origin: ChainActivity | undefined = findingOf(entity, context)?.chain;
    if (!origin) {
      if (!context.reserve()) {
        notes.push({ reason: 'budget', detail: `Budżet wyczerpany — nie pobrano aktywności adresu ${shortAddress(address)}.`, skipped: 1, expander: this.id });
        return { nodes: [], edges: [], notes, requests };
      }
      try {
        origin = supported.length > 0 ? await fetchFrom(address) : undefined;
      } catch (error) {
        errors.push({ source: 'dane blockchain', expander: this.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!origin) {
      notes.push({ reason: 'no_results', detail: `Brak danych blockchain dla adresu ${shortAddress(address)} — obiegu nie szukano.`, expander: this.id });
      return { nodes: [], edges: [], notes, errors, requests };
    }

    const caseAddresses = context.findings.filter((finding) => finding.network === network && norm(finding.address) !== norm(address)).map((finding) => finding.address);
    const result = await findRoundTrips({
      network,
      origin: address,
      originActivity: origin as RoundTripActivity,
      cluster: (origin.cluster?.addresses ?? []).map((item) => item.address),
      caseAddresses,
      fetchActivity: fetchFrom,
      reserve: context.reserve,
      ...(context.roundtrip ?? {}),
      // Wycena orientacyjna: kurs przykładowy (opis wyceny przy każdym kroku to mówi wprost).
      rateSource: new StaticRateSource(),
      ...(context.onRoundTripProgress ? { onProgress: context.onRoundTripProgress } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    // ---------- Graf: węzły adresów pośrednich i krawędzie-przelewy (fakty) ----------
    const retrievedAt = context.now().toISOString();
    const synthetic = entity.meta.synthetic || context.synthetic ? { synthetic: true } : {};
    const findingKeys = new Map(context.findings.filter((finding) => finding.network === network).map((finding) => [norm(finding.address), addressNodeKey(finding.network, finding.address)]));
    const keyOf = (target: string) => (norm(target) === norm(address) ? entity.key : (findingKeys.get(norm(target)) ?? addressNodeKey(network, target)));
    const nodes = new Map<string, NetworkNode>();
    const pairs = new Map<string, { from: string; to: string; hops: RoundTripCycleView['hops'] }>();
    const cycles: RoundTripCycleView[] = result.cycles.map((cycle) => {
      const nodeIds = [keyOf(cycle.hops[0]!.from), ...cycle.hops.map((hop) => keyOf(hop.to))];
      for (const item of cycle.intermediaries) {
        const id = keyOf(item.address);
        if (id === entity.key || nodes.has(id) || context.nodes.has(id)) continue;
        nodes.set(id, {
          id,
          kind: 'address',
          label: shortAddress(item.address),
          sublabel: `adres pośredni obiegu środków (${INTERMEDIARY_CLASS_LABEL[item.class]}${item.label ? `: ${item.label}` : ''}) — adres, nie osoba`,
          entityKind: 'crypto_address',
          meta: { ...synthetic, network, address: item.address },
        });
      }
      // Powrót na inny adres portfela albo sprawy: węzeł tego adresu (zwykle już jest w teczce).
      const home = cycle.returnsTo.address;
      const homeId = keyOf(home);
      if (homeId !== entity.key && !nodes.has(homeId) && !context.nodes.has(homeId)) {
        nodes.set(homeId, { id: homeId, kind: 'address', label: shortAddress(home), sublabel: cycle.returnsTo.role === 'cluster' ? 'ten sam portfel (heurystyka) — adres, nie osoba' : 'adres sprawy', entityKind: 'crypto_address', meta: { ...synthetic, network, address: home } });
      }
      const edgeIds = cycle.hops.map((hop) => {
        const from = keyOf(hop.from);
        const to = keyOf(hop.to);
        const pair = `${from}>${to}`;
        const entry = pairs.get(pair) ?? { from, to, hops: [] };
        if (!entry.hops.some((item) => item.txid === hop.txid)) entry.hops.push(hop);
        pairs.set(pair, entry);
        return `net:roundtrip_hop:${pair}`;
      });
      return { ...cycle, nodeIds, edgeIds };
    });
    const edges: NetworkEdge[] = [...pairs.values()].map(({ from, to, hops }) => {
      const sorted = [...hops].sort((a, b) => a.time.localeCompare(b.time));
      const first = sorted[0]!;
      return edgeFrom(
        {
          from,
          to,
          relation: 'roundtrip_hop',
          kind: 'transfer',
          layer: 'chain',
          label: sorted.length === 1 ? `${amountText(first.amount)} ${first.asset} · ${first.time.slice(0, 10)}` : `${sorted.length} przel. w obiegu`,
          explanation:
            `Przelew${sorted.length > 1 ? 'y' : ''} zapisan${sorted.length > 1 ? 'e' : 'y'} w blockchainie: ` +
            sorted.map((hop) => `${amountText(hop.amount)} ${hop.asset} (${hop.time.slice(0, 10)}, tx ${hop.txid.slice(0, 12)}…)`).join('; ') +
            '. Krok obiegu środków — fakt; że to te same środki lub ta sama osoba, jest hipotezą.',
          evidence: [...sorted.slice(0, 8).map((hop) => ({ kind: 'txid' as const, value: hop.txid })), ...(first.explorerUrl ? [{ kind: 'url' as const, value: first.explorerUrl }] : [])],
          retrievedAt,
        },
        this.id,
      );
    });

    for (const item of result.stops) notes.push({ reason: STOP_REASON[item.reason], detail: `Obieg środków: ${item.detail}${item.count > 1 ? ` (${item.count})` : ''}`, ...(item.count > 0 ? { skipped: item.count } : {}), expander: this.id });
    if (cycles.length === 0) {
      notes.push({
        reason: 'no_results',
        detail: `Obieg środków: nie znaleziono powrotu środków na adres ${shortAddress(address)} w zbadanym zakresie (pobrane adresy: ${result.stats.addressesFetched}, najdalszy krok: ${result.stats.deepestHop}, okno ${result.params.windowDays} dni).`,
        expander: this.id,
      });
    }
    return {
      nodes: [...nodes.values()],
      edges,
      notes,
      errors,
      requests,
      roundtrip: { ...result, anchor: entity.key, cycles },
    };
  },
};
