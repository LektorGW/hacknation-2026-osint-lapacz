// Tryb demo: trzy wskaźniki śledcze i statusy relacji grafu dla teczek demonstracyjnych.
// Liczby nie są wpisane ręcznie — wskaźnik A liczy `computeConfidence` z publikacji konta,
// a B i C składa `combineComponents` z cech widocznych w danych demo (tak jak w usłudze analizy).
import type {
  AccountWalletLink,
  AnalystDecision,
  CashOutAssessment,
  CashOutStage,
  ClaimStatus,
  EvidenceRef,
  Finding,
  GraphEdge,
  GraphNode,
  InvestigationIndicators,
  OperatorHypothesis,
  ProfileCard,
  ScoreComponent,
  ServiceKind,
} from '@olcys/core';
import { INDICATOR_SCALE, combineComponents, indicatorLevel, linkKey } from '../../../packages/core/src/indicators.ts';
import type { ComponentDraft } from '../../../packages/core/src/indicators.ts';
import { DEFAULT_RULES, computeConfidence } from '../../../packages/core/src/score.ts';
import { addressKey } from './dossier.ts';
import type { FullDossier } from './proof.ts';

/** Wagi jak w regułach usługi analizy (opis `OPERATOR_RULES` i `CASH_OUT_RULES`). */
const OPERATOR_WEIGHT = { email: 100, phone: 100, mutualLinks: 90, sameAddress: 80, handleWithContext: 50, handle: 20, name: 15, conflictName: 10, conflictLocation: 10, analystRejected: 100 } as const;
const CASH_OUT_WEIGHT = {
  onchainTransfer: 5,
  direct: { exchange: 40, p2p: 45, crypto_card: 45, payment_gateway: 30 } as Partial<Record<ServiceKind, number>>,
  depositAddressInferred: 55,
  repeatedDeposits: 60,
  valuationAvailable: 5,
  repeatedMin: 3,
} as const;

const OWNERSHIP_CATEGORIES = ['cryptographic_proof', 'own_profile', 'sale_offer', 'settlement_message'];
const MENTION_PENALTY = 20;
const BANK_SIDE_LIMITATION =
  'Dane blockchain nie pokazują wypłaty na rachunek bankowy ani w gotówce. Wyjście do walut tradycyjnych może potwierdzić wyłącznie usługa ' +
  '(dane właściciela konta, historia zleceń i wypłat) albo dokument spoza blockchaina przyjęty przez analityka.';
const HYPOTHESIS_LIMITATIONS = [
  'Wskaźnik opisuje przesłanki, że dwa konta obsługuje ten sam operator; nie ustala, kim ten operator jest.',
  'Uwzględniono wyłącznie cechy widoczne w danych przykładowych trybu demo.',
  'Bez decyzji analityka hipoteza pozostaje wnioskowaniem narzędzia.',
];

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').trim().toLowerCase().replace(/\s+/g, ' ');
const latest = (decisions: AnalystDecision[], target: string, key: string) =>
  decisions.filter((item) => (item.target as string) === target && item.key.toLowerCase() === key.toLowerCase()).at(-1);
const accountLabel = (card: ProfileCard) => `„${card.handle ?? card.url}” (${card.service})`;
const personaOf = (card: ProfileCard) => card.attributes.displayName?.trim() || card.handle || card.url;

// ---------- A. Konto → portfel ----------

function accountWalletLinks(profiles: ProfileCard[], findings: Finding[], decisions: AnalystDecision[]): AccountWalletLink[] {
  const findingOf = new Map(findings.map((finding) => [addressKey(finding), finding]));
  const links: AccountWalletLink[] = [];
  for (const card of profiles) {
    for (const key of card.addresses) {
      const finding = findingOf.get(key);
      const own = (finding?.evidence ?? []).filter((item) => card.evidenceIds.includes(item.id));
      if (!finding || own.length === 0) continue;
      const addressClass = finding.chain?.profile.addressClass ?? 'unknown';
      // Pytanie brzmi „czy KONTO deklaruje adres”, nie „czyje to konto” — stąd brak korekty tożsamości.
      const result = computeConfidence({ evidence: own.map((item) => ({ ...item, identityMatch: 'exact_identifier' as const })), addressClass, unrelatedPublishers: finding.unrelatedPublishers }, DEFAULT_RULES);
      const components: ScoreComponent[] = result.ledger.map((entry) => {
        const weight = entry.weight ?? entry.delta;
        return {
          rule: `wallet.${entry.rule}`,
          weight,
          applied: entry.delta,
          direction: weight < 0 || entry.rule.startsWith('exclusion.') ? 'contradicts' : 'supports',
          source: card.service,
          evidence: [...entry.evidenceIds.map((value) => ({ kind: 'evidence_id' as const, value })), { kind: 'address' as const, value: finding.address }],
          explanation: entry.explanation,
          independence: entry.rule.startsWith('base.') ? ((result.independentSources ?? 1) > 1 ? 'independent' : 'single') : entry.rule.startsWith('synergy.') ? 'independent' : 'not_applicable',
          ...(entry.independence ? { independenceNote: entry.independence } : {}),
          limitations: entry.limitations ?? [],
          ...(entry.rule.startsWith('exclusion.') ? { blocking: true } : {}),
        };
      });
      let score = result.score;
      const limitations = ['Wskaźnik dotyczy deklaracji konta, nie tego, kto konto obsługuje ani kto dysponuje kluczem prywatnym adresu.'];
      const notPrivateWallet = result.excluded;
      if (notPrivateWallet) limitations.push('Adres usługi, kontraktu, zbiórki, miksera lub instytucji: publikacja odnotowana, ale to NIE jest portfel prywatny konta.');
      if (!own.some((item) => OWNERSHIP_CATEGORIES.includes(item.category)) && !notPrivateWallet) {
        const applied = -Math.min(score, MENTION_PENALTY);
        score += applied;
        components.push({
          rule: 'wallet.mention_only',
          weight: -MENTION_PENALTY,
          applied,
          direction: 'contradicts',
          source: card.service,
          evidence: own.map((item) => ({ kind: 'url' as const, value: item.url })),
          explanation: 'Konto wymienia adres w wypowiedzi lub komentarzu, ale nie podaje go jako własnego (profil, oferta, rozliczenie, dowód kryptograficzny).',
          independence: 'not_applicable',
          limitations: ['wzmianka, nie deklaracja własności'],
        });
        limitations.push('wzmianka, nie deklaracja własności');
      }
      const decision = latest(decisions, 'address', key);
      let status: ClaimStatus = 'computed';
      if (decision) {
        status = decision.decision;
        const rejected = decision.decision === 'rejected';
        const applied = rejected ? -score : 0;
        score += applied;
        components.push({
          rule: rejected ? 'wallet.decision.address_rejected' : 'wallet.decision.address_confirmed',
          weight: rejected ? -100 : 0,
          applied,
          direction: rejected ? 'contradicts' : 'supports',
          source: 'decyzja analityka',
          evidence: [{ kind: 'decision', value: decision.id }],
          explanation: rejected ? 'Adres odrzucony przez analityka.' : 'Adres potwierdzony przez analityka jako adres podmiotu — wskaźnik deklaracji konta pozostaje bez zmian.',
          independence: 'not_applicable',
          limitations: ['Decyzja dotyczy adresu w sprawie; można ją wycofać.'],
          ...(rejected ? { blocking: true } : {}),
        });
      }
      links.push({
        id: `${card.id}=>${key}`,
        accountId: card.id,
        service: card.service,
        ...(card.handle ? { handle: card.handle } : {}),
        accountUrl: card.url,
        address: finding.address,
        network: finding.network,
        addressClass,
        notPrivateWallet,
        indicator: { kind: 'account_wallet', score, level: indicatorLevel(score), calibrated: false, scale: INDICATOR_SCALE, components, limitations },
        status,
      });
    }
  }
  return links.sort((a, b) => b.indicator.score - a.indicator.score);
}

// ---------- B. Wspólny operator ----------

const looksLikeFullName = (value: string | undefined) => value !== undefined && /^\p{Lu}\p{L}+ \p{Lu}\p{L}{2,}$/u.test(value.trim());
const city = (value: string | undefined) => (value ? fold(value.split(',')[0]!) : undefined);

function operatorHypotheses(dossier: FullDossier, accounts: ProfileCard[], decisions: AnalystDecision[]): OperatorHypothesis[] {
  const excluded = new Set(dossier.findings.filter((finding) => finding.confidence.excluded).map(addressKey));
  const groupOf = (id: string) => dossier.persons.findIndex((person) => person.profileIds.includes(id));
  const result: OperatorHypothesis[] = [];
  for (let i = 0; i < accounts.length; i += 1) {
    for (let j = i + 1; j < accounts.length; j += 1) {
      const a = accounts[i]!;
      const b = accounts[j]!;
      const drafts: ComponentDraft[] = [];
      const source = `${a.service} + ${b.service}`;
      const urls: EvidenceRef[] = [
        { kind: 'url', value: a.url },
        { kind: 'url', value: b.url },
      ];
      const supports = (rule: string, weight: number, explanation: string, limitations: string[], evidence: EvidenceRef[], originKey: string) =>
        drafts.push({ rule, weight, direction: 'supports', source, evidence: [...evidence, ...urls], explanation, limitations, originKey });
      const contradicts = (rule: string, weight: number, explanation: string, limitations: string[], evidence: EvidenceRef[], blocking = false) =>
        drafts.push({ rule, weight, direction: 'contradicts', source, evidence: [...evidence, ...urls], explanation, limitations, ...(blocking ? { blocking } : {}) });

      for (const email of (a.attributes.emails ?? []).filter((value) => (b.attributes.emails ?? []).some((other) => fold(other) === fold(value)))) {
        supports('operator.same_email', OPERATOR_WEIGHT.email, `Oba konta podają ten sam adres e-mail (${email}).`, ['Adres e-mail może być współdzielony (firma, rodzina) albo podany cudzy.'], [{ kind: 'attribute', value: email }], `email:${fold(email)}`);
      }
      for (const phone of (a.attributes.phones ?? []).filter((value) => (b.attributes.phones ?? []).some((other) => other.replace(/\D/g, '') === value.replace(/\D/g, '')))) {
        supports('operator.same_phone', OPERATOR_WEIGHT.phone, `Oba konta podają ten sam numer telefonu (${phone}).`, ['Numer telefonu może należeć do firmy albo zostać przekazany innej osobie.'], [{ kind: 'attribute', value: phone }], `phone:${phone.replace(/\D/g, '')}`);
      }
      const pointsTo = (from: ProfileCard, to: ProfileCard) => (from.attributes.urls ?? []).includes(to.url);
      if (pointsTo(a, b) && pointsTo(b, a)) {
        supports('operator.mutual_links', OPERATOR_WEIGHT.mutualLinks, 'Konta wskazują na siebie wzajemnie odnośnikami w profilach.', ['Wzajemne odnośniki mogą łączyć także współpracowników albo znajomych.'], [], 'mutual-links');
      }
      const shared = a.addresses.filter((key) => b.addresses.includes(key) && !excluded.has(key));
      for (const key of shared) {
        supports('operator.same_address', OPERATOR_WEIGHT.sameAddress, 'Oba konta publikują ten sam adres kryptowalutowy.', ['Ten sam adres mogą podawać wspólnicy, rodzina albo pośrednik; adresy usług i zbiórek nie są liczone.'], [{ kind: 'address', value: key.slice(key.indexOf(':') + 1) }], `address:${key}`);
      }
      const sameCity = city(a.attributes.location) !== undefined && city(a.attributes.location) === city(b.attributes.location);
      const sameName = a.attributes.displayName !== undefined && b.attributes.displayName !== undefined && fold(a.attributes.displayName) === fold(b.attributes.displayName);
      if (a.handle && b.handle && fold(a.handle) === fold(b.handle)) {
        if (sameCity || sameName) {
          supports('operator.handle_with_context', OPERATOR_WEIGHT.handleWithContext, `Ta sama nazwa konta („${a.handle}”) ze zgodną ${sameCity ? 'lokalizacją' : 'nazwą wyświetlaną'}.`, ['Zgodność nicku i ogólnej lokalizacji zdarza się u różnych osób.'], [{ kind: 'attribute', value: a.handle }], 'handle');
        } else {
          supports('operator.same_handle', OPERATOR_WEIGHT.handle, `Ta sama nazwa konta („${a.handle}”) bez innego potwierdzenia.`, ['Ten sam nick często należy do różnych osób.'], [{ kind: 'attribute', value: a.handle }], 'handle');
        }
      } else if (sameName) {
        supports('operator.same_name', OPERATOR_WEIGHT.name, `Ta sama nazwa wyświetlana („${a.attributes.displayName}”).`, ['Sama zbieżność nazwy nie odróżnia imienników.'], [{ kind: 'attribute', value: a.attributes.displayName! }], 'name');
      }
      if (drafts.length === 0) continue;

      if (looksLikeFullName(a.attributes.displayName) && looksLikeFullName(b.attributes.displayName) && !sameName) {
        contradicts('operator.conflict.declared_name', OPERATOR_WEIGHT.conflictName, `Konta deklarują różne imiona i nazwiska („${a.attributes.displayName}” i „${b.attributes.displayName}”).`, ['Deklarowane nazwisko może być nieprawdziwe.'], [], true);
      }
      if (city(a.attributes.location) && city(b.attributes.location) && !sameCity) {
        contradicts('operator.conflict.location', OPERATOR_WEIGHT.conflictLocation, `Konta deklarują różne lokalizacje (${a.attributes.location} i ${b.attributes.location}).`, ['Lokalizacja w profilu bywa nieaktualna albo ogólna.'], []);
      }
      const id = linkKey(a.id, b.id);
      const decision = latest(decisions, 'link', id);
      if (decision?.decision === 'rejected') {
        contradicts('operator.conflict.analyst_rejected', OPERATOR_WEIGHT.analystRejected, 'Analityk odrzucił hipotezę wspólnego operatora tych kont.', ['Decyzję można wycofać.'], [{ kind: 'decision', value: decision.id }], true);
      }
      const indicator = combineComponents('common_operator', drafts, { confirmed: decision?.decision === 'confirmed', limitations: HYPOTHESIS_LIMITATIONS });
      const blocked = indicator.components.some((item) => item.blocking);
      const grouped = groupOf(a.id) >= 0 && groupOf(a.id) === groupOf(b.id);
      const status: OperatorHypothesis['status'] = decision ? decision.decision : blocked ? 'blocked' : grouped ? 'auto_grouped' : 'hypothesis';
      result.push({
        id,
        accounts: [a.id, b.id],
        accountLabels: [accountLabel(a), accountLabel(b)],
        personas: [personaOf(a), personaOf(b)],
        indicator,
        status,
        statement:
          status === 'confirmed'
            ? `Analityk potwierdził, że konta ${accountLabel(a)} i ${accountLabel(b)} obsługuje ten sam operator.`
            : status === 'rejected'
              ? `Analityk odrzucił hipotezę wspólnego operatora kont ${accountLabel(a)} i ${accountLabel(b)}.`
              : `Przesłanki wskazują, że konta ${accountLabel(a)} i ${accountLabel(b)} może obsługiwać ten sam operator (${indicator.level}). To hipoteza narzędzia — nie jest ustaleniem tożsamości.`,
        path: indicator.components.filter((item) => item.direction === 'supports').map((item) => item.explanation),
        ...(decision ? { decision: { decision: decision.decision, decidedAt: decision.decidedAt, author: 'analityk (demo)', note: decision.note, id: decision.id } } : {}),
      });
    }
  }
  return result.sort((x, y) => y.indicator.score - x.indicator.score);
}

// ---------- C. Wyjście do walut tradycyjnych ----------

function cashOutAssessments(dossier: FullDossier): CashOutAssessment[] {
  const result: CashOutAssessment[] = [];
  for (const link of dossier.serviceLinks) {
    const out = link.transfers.filter((item) => item.direction === 'out');
    const bySubject = new Map<string, typeof out>();
    for (const item of out) bySubject.set(item.subjectAddress, [...(bySubject.get(item.subjectAddress) ?? []), item]);
    for (const [address, transfers] of bySubject) {
      const txRefs: EvidenceRef[] = transfers.map((item) => ({ kind: 'txid', value: item.txid }));
      const via = transfers.filter((item) => item.viaAddress !== undefined);
      const direct = transfers.filter((item) => item.viaAddress === undefined);
      const directWeight = CASH_OUT_WEIGHT.direct[link.kind];
      const drafts: ComponentDraft[] = [];
      const source = 'dane blockchain (demo)';
      if (direct.length > 0 && directWeight !== undefined) {
        drafts.push({
          rule: 'cashout.direct_service_transfer',
          weight: directWeight,
          direction: 'supports',
          source,
          evidence: [...direct.map((item) => ({ kind: 'txid' as const, value: item.txid })), { kind: 'address', value: direct[0]!.serviceAddress }],
          explanation: `Bezpośredni przelew z badanego adresu na adres oznaczony jako usługa „${link.name}” (liczba przelewów: ${direct.length}).`,
          limitations: ['Przelew do usługi nie dowodzi sprzedaży ani wypłaty: środki mogły zostać w usłudze albo zostać wypłacone dalej w blockchainie.'],
          originKey: 'direct',
        });
      } else if (direct.length > 0) {
        drafts.push({
          rule: 'cashout.onchain_transfer',
          weight: CASH_OUT_WEIGHT.onchainTransfer,
          direction: 'supports',
          source,
          evidence: txRefs,
          explanation: `Przelew na adres usługi „${link.name}”, która nie służy do wymiany na waluty tradycyjne.`,
          limitations: ['Sam przelew w blockchainie nie jest przesłanką wyjścia do walut tradycyjnych.'],
          originKey: 'onchain',
        });
      }
      if (via.length > 0) {
        drafts.push({
          rule: 'cashout.deposit_address_inferred',
          weight: CASH_OUT_WEIGHT.depositAddressInferred,
          direction: 'supports',
          source,
          evidence: [...via.map((item) => ({ kind: 'txid' as const, value: item.txid })), ...[...new Set(via.map((item) => item.viaAddress!))].map((value) => ({ kind: 'address' as const, value }))],
          explanation: `Środki trafiły na adres bez publicznej etykiety, który przekazał je do portfela usługi „${link.name}” — wzorzec indywidualnego adresu wpłat klienta.`,
          limitations: ['Adres wpłat ustalono WNIOSKOWANIEM z dalszej drogi środków; może należeć do innej osoby lub pośrednika. Rozstrzyga usługa.'],
          originKey: 'deposit',
        });
      }
      if (transfers.length >= CASH_OUT_WEIGHT.repeatedMin && (directWeight !== undefined || via.length > 0)) {
        drafts.push({
          rule: 'cashout.repeated_deposits',
          weight: CASH_OUT_WEIGHT.repeatedDeposits,
          direction: 'supports',
          source,
          evidence: txRefs,
          explanation: `Powtarzalne wpłaty do tej samej usługi (${transfers.length}).`,
          limitations: ['Powtarzalność wpłat jest typowa także dla handlu i przechowywania środków w usłudze.'],
          originKey: 'repeated',
        });
      }
      const valued = transfers.filter((item) => item.valuePln !== undefined);
      if (valued.length > 0 && drafts.length > 0) {
        drafts.push({
          rule: 'cashout.valuation_available',
          weight: CASH_OUT_WEIGHT.valuationAvailable,
          direction: 'supports',
          source: 'wycena (demo)',
          evidence: valued.map((item) => ({ kind: 'txid' as const, value: item.txid })),
          explanation: 'Dla przelewów dostępny jest kurs z dnia transakcji — wartość w PLN da się odtworzyć.',
          limitations: ['Wycena jest szacunkiem po kursie dziennym, nie kwotą faktycznie wypłaconą.'],
          originKey: 'valuation',
        });
      }
      if (drafts.length === 0) continue;
      const indicator = combineComponents('cash_out', drafts, { limitations: [BANK_SIDE_LIMITATION] });
      const signal = drafts.some((item) => item.rule === 'cashout.deposit_address_inferred' || item.rule === 'cashout.repeated_deposits');
      const stage: CashOutStage = signal ? 'cashout_signal' : drafts.some((item) => item.rule === 'cashout.direct_service_transfer') ? 'service_interaction' : 'onchain_transfer';
      const network = link.networks.find((item) => dossier.findings.some((finding) => finding.address === address && finding.network === item)) ?? link.networks[0] ?? 'bitcoin';
      const valuePln = valued.reduce((total, item) => total + (item.valuePln ?? 0), 0);
      const assets = new Set(transfers.map((item) => item.asset));
      result.push({
        id: `${network}:${address}=>${link.id}`,
        address,
        network,
        stage,
        serviceName: link.name,
        txids: transfers.map((item) => item.txid),
        ...(assets.size === 1 ? { asset: transfers[0]!.asset, amount: transfers.reduce((total, item) => total + item.amount, 0) } : {}),
        ...(valued.length > 0 ? { valuePln } : {}),
        indicator,
        status: via.length > 0 ? 'hypothesis' : 'computed',
        statement:
          stage === 'cashout_signal'
            ? `Wzorzec przelewów do usługi „${link.name}” jest typowy dla wypłaty, ale samej wymiany na waluty tradycyjne dane blockchain nie pokazują.`
            : stage === 'service_interaction'
              ? `Środki z adresu dotarły do usługi wymiany „${link.name}”. To interakcja z usługą — nie dowód wypłaty.`
              : `Przelew w blockchainie do „${link.name}” — bez przesłanek wymiany na waluty tradycyjne.`,
      });
    }
  }
  return result.sort((a, b) => b.indicator.score - a.indicator.score);
}

// ---------- Graf: statusy relacji, hipoteza operatora, persony, źródła ----------

const HYPOTHESIS_CLAIM: Record<OperatorHypothesis['status'], ClaimStatus> = { hypothesis: 'hypothesis', auto_grouped: 'hypothesis', blocked: 'hypothesis', confirmed: 'confirmed', rejected: 'rejected' };

const EDGE_EXPLANATION: Partial<Record<GraphEdge['kind'], string>> = {
  has_identifier: 'Identyfikator podmiotu: podany przez analityka albo odkryty w źródle.',
  found_profile: 'Konto odnalezione po identyfikatorze podmiotu. Ocena, czy to konto podmiotu, jest osobnym wskaźnikiem.',
  links_to: 'Odnośnik albo wskazanie widoczne wprost w profilu.',
  publishes: 'Konto opublikowało ten adres — treść publikacji jest zapisana jako ślad.',
  transfer: 'Przelew zapisany w blockchainie między tymi adresami.',
  cash_out: 'Przelew na adres usługi wymiany. Wniosek, że to wypłata, jest wnioskowaniem narzędzia.',
  related: 'Powiązanie z inną tożsamością wynikające z przesłanek — do weryfikacji.',
};

function investigationGraph(dossier: FullDossier, hypotheses: OperatorHypothesis[], decisions: AnalystDecision[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = dossier.graph.nodes.map((node) => ({ ...node }));
  const has = (id: string) => nodes.some((node) => node.id === id);
  const txidsOf = (addressNode: string, counterpartyNode: string): EvidenceRef[] => {
    const finding = dossier.findings.find((item) => addressNode === `adres:${addressKey(item)}`);
    const counterparty = counterpartyNode.replace(/^kontrahent:/, '').replace(/^adres:[^:]+:/, '');
    return (finding?.chain?.transfers ?? []).filter((item) => item.counterparty === counterparty).slice(0, 5).map((item) => ({ kind: 'txid' as const, value: item.txid }));
  };
  const edges: GraphEdge[] = dossier.graph.edges.map((edge) => {
    const chain = edge.kind === 'transfer' || edge.kind === 'cash_out';
    const profile = dossier.profiles.find((item) => item.id === edge.from) ?? dossier.profiles.find((item) => item.id === edge.to);
    const finding = edge.kind === 'publishes' ? dossier.findings.find((item) => edge.to === `adres:${addressKey(item)}`) : undefined;
    const evidence: EvidenceRef[] = chain
      ? [...txidsOf(edge.from, edge.to), ...txidsOf(edge.to, edge.from)]
      : edge.kind === 'publishes'
        ? (finding?.evidence ?? []).filter((item) => profile?.evidenceIds.includes(item.id)).map((item) => ({ kind: 'url' as const, value: item.url }))
        : edge.kind === 'found_profile' && profile
          ? [{ kind: 'url', value: profile.url }]
          : [];
    return {
      ...edge,
      status: edge.status ?? (edge.inferred ? 'hypothesis' : 'source_fact'),
      layer: edge.layer ?? (chain ? 'chain' : 'identity'),
      explanation: edge.explanation ?? EDGE_EXPLANATION[edge.kind],
      ...(evidence.length > 0 ? { evidence } : {}),
    };
  });
  const addEdge = (edge: Omit<GraphEdge, 'id'>) => {
    const id = `${edge.kind}:${edge.from}>${edge.to}`;
    if (has(edge.from) && has(edge.to) && !edges.some((item) => item.id === id)) edges.push({ id, layer: 'identity', ...edge });
  };

  // Hipoteza operatora głównego: konta zaliczone do osoby głównej. Nie jest ustaloną osobą.
  const subject = nodes.find((node) => node.kind === 'subject');
  const main = dossier.persons[0];
  const members = (main?.profileIds ?? []).filter(has);
  const operatorOf = new Map<string, string>();
  if (subject && members.length > 1) {
    // Operator jest potwierdzony dopiero wtedy, gdy potwierdzone hipotezy łączą WSZYSTKIE jego konta w jedną grupę.
    const group = new Map(members.map((member) => [member, member]));
    const find = (id: string): string => (group.get(id) === id ? id : find(group.get(id)!));
    for (const item of hypotheses) {
      const [a, b] = item.accounts;
      if (item.status === 'confirmed' && group.has(a) && group.has(b)) group.set(find(a), find(b));
    }
    const confirmed = new Set(members.map(find)).size === 1;
    const status: ClaimStatus = confirmed ? 'confirmed' : 'hypothesis';
    nodes.push({ id: 'operator:1', kind: 'operator', label: 'Hipoteza operatora #1', sublabel: `wspólny operator ${members.length} kont — ${confirmed ? 'potwierdzony decyzją analityka' : 'do weryfikacji'}`, status, parent: subject.id });
    addEdge({ from: subject.id, to: 'operator:1', kind: 'operates', label: 'hipoteza: operator kont podmiotu', status, explanation: 'Konta zaliczone do badanego podmiotu mogą mieć wspólnego operatora — to wnioskowanie narzędzia, nie ustalenie tożsamości.' });
    for (const member of members) {
      operatorOf.set(member, 'operator:1');
      addEdge({ from: 'operator:1', to: member, kind: 'operates', label: 'hipoteza: operator obsługuje konto', status, explanation: 'Konto zaliczone do tej hipotezy operatora na podstawie przesłanek łączących konta — do weryfikacji.' });
    }
  }
  // Persony: deklarowane nazwy, pod którymi występują konta.
  for (const card of dossier.profiles) {
    const name = card.attributes.displayName?.trim();
    if (!name || !has(card.id)) continue;
    const id = `persona:${fold(name)}`;
    if (!has(id)) nodes.push({ id, kind: 'persona', label: name, sublabel: 'deklarowana nazwa konta', ...(operatorOf.get(card.id) ? { parent: operatorOf.get(card.id)! } : {}) });
    addEdge({ from: card.id, to: id, kind: 'declares', label: 'konto deklaruje nazwę', status: 'source_fact', evidence: [{ kind: 'url', value: card.url }], explanation: 'Nazwa wyświetlana podana w publicznym profilu konta. Deklaracja nie dowodzi tożsamości.' });
  }
  // Źródła dowodowe: publikacje z adresem — domyślnie schowane za licznikiem przy koncie.
  for (const finding of dossier.findings) {
    for (const item of finding.evidence) {
      const card = dossier.profiles.find((profile) => profile.evidenceIds.includes(item.id));
      const parent = card && has(card.id) ? card.id : `adres:${addressKey(finding)}`;
      if (!has(parent)) continue;
      const id = `zrodlo:${item.id}`;
      if (!has(id)) nodes.push({ id, kind: 'source', label: item.title || item.url, sublabel: item.service, url: item.url, parent });
      addEdge({ from: parent, to: id, kind: 'documented_by', label: 'publikacja z adresem', status: 'source_fact', evidence: [{ kind: 'url', value: item.url }, { kind: 'evidence_id', value: item.id }], explanation: 'Publikacja zapisana jako ślad: treść, czas pobrania i skrót SHA-256 są w karcie adresu.' });
    }
  }
  // Hipotezy wspólnego operatora między kontami.
  for (const hypothesis of hypotheses) {
    const [a, b] = hypothesis.accounts;
    addEdge({
      from: a,
      to: b,
      kind: 'same_operator',
      label: hypothesis.status === 'confirmed' ? 'wspólny operator potwierdzony decyzją analityka' : hypothesis.status === 'rejected' ? 'wspólny operator odrzucony decyzją analityka' : 'hipoteza wspólnego operatora (do weryfikacji)',
      weight: hypothesis.indicator.score,
      status: HYPOTHESIS_CLAIM[hypothesis.status],
      evidence: hypothesis.indicator.components.flatMap((component) => component.evidence).filter((item, index, all) => all.findIndex((other) => other.kind === item.kind && other.value === item.value) === index),
      explanation: hypothesis.statement,
    });
  }
  // Powiązane tożsamości i osoby: decyzja analityka zmienia status z hipotezy.
  for (const node of nodes) {
    if (node.kind !== 'person' || node.status) continue;
    const identity = dossier.linkedIdentities?.find((item) => node.id === `identity:${item.id}`);
    const decision = identity?.mergeWith.map((target) => latest(decisions, target.target, target.key)?.decision).find((value) => value !== undefined);
    node.status = decision ?? 'hypothesis';
  }
  return { nodes, edges };
}

/** Dokłada do teczki demo wskaźniki A/B/C, statusy osób i identyczności oraz graf ze statusami relacji. */
export function applyDemoInvestigation(dossier: FullDossier, decisions: AnalystDecision[]): FullDossier {
  const identityProfiles = (dossier.linkedIdentities ?? []).flatMap((identity) => identity.profiles);
  const accounts = [...dossier.profiles, ...identityProfiles.filter((card) => !dossier.profiles.some((item) => item.id === card.id))];
  const commonOperator = operatorHypotheses(dossier, accounts, decisions);
  const indicators: InvestigationIndicators = {
    accountWallet: accountWalletLinks(dossier.profiles, dossier.findings, decisions),
    commonOperator,
    cashOut: cashOutAssessments(dossier),
  };
  // Połączenia zablokowane kontrdowodem twardym — pokazane przy kandydacie, do którego należy pierwsze konto pary.
  const persons = dossier.persons.map((person) => {
    const blockedMerges = commonOperator
      .filter((item) => item.status === 'blocked' && person.profileIds.includes(item.accounts[0]))
      .map((item) => ({
        profileIds: item.accounts,
        weight: Math.max(0, ...item.indicator.components.filter((component) => component.direction === 'supports').map((component) => component.weight)),
        reason: item.indicator.components.find((component) => component.blocking)?.explanation ?? 'kontrdowód twardy',
      }));
    return { ...person, status: person.status ?? ('hypothesis' as const), ...(blockedMerges.length > 0 ? { blockedMerges } : {}) };
  });
  const linkedIdentities = dossier.linkedIdentities?.map((identity) => ({
    ...identity,
    status: identity.status ?? (identity.decision === 'rejected' ? ('rejected' as const) : ('hypothesis' as const)),
    accounts: identity.accounts ?? identity.profiles.map((card) => card.id),
  }));
  return { ...dossier, persons, indicators, ...(linkedIdentities ? { linkedIdentities } : {}), graph: investigationGraph(dossier, commonOperator, decisions) };
}
