// Dowód spieniężenia i postęp analizy: lokalne rozszerzenia kontraktu oraz czysta logika widoków.
import type { FundingSource, Mention, RelatedAddress, Seizure } from './funds.ts';
import type { LinkedIdentity } from './identities.ts';
import type { ServiceReplyRef, ServiceReplyView } from './service-reply.ts';
import type { CashOutTrail, Dossier, Finding, Identifier, Network, StoredEvidence, TextInsight } from '@olcys/core';

// ---------- Kształty zwracane przez usługę analizy poza typami `@olcys/core` ----------

export interface CashOutProof {
  id: string;
  person: { id: string; fullName?: string; probability: number } | null;
  address: string;
  network: Network;
  /** Skąd wiadomo o adresie: publikacja, wskazanie analityka albo klaster portfela. */
  addressBasis: 'published' | 'analyst' | 'cluster' | 'confirmed';
  cluster?: { seed: string; reason: string };
  personAddressProbability: number;
  trailConfidence: number;
  combinedConfidence: number;
  tier: string;
  components: string[];
  layer: 'calculation' | 'inference';
  serviceName: string;
  statement: string;
  trail: CashOutTrail;
  /** Własność adresu nie jest potwierdzona — ustalenie warunkowe. */
  ownerUnconfirmed?: boolean;
  /** Łączna pewność po potwierdzeniu własności adresu. */
  confidenceIfConfirmed?: number;
  /** Odpowiedź usługi (dokument spoza OSINT) dotycząca tego ustalenia: potwierdzony właściciel konta albo inna osoba. */
  serviceReply?: ServiceReplyRef & { outcome: 'confirmed' | 'other_person' | 'holder_unverified'; holderName?: string; fiatExitDocumented: boolean; note: string };
}

export type EvidenceWithInsight = StoredEvidence & { insight?: TextInsight };

export type DossierFinding = Finding & {
  annotations?: string[];
  excludedEvidence?: EvidenceWithInsight[];
  /** Prawdopodobieństwo, że adres należy do osoby ze sprawy. */
  subjectProbability?: number;
  widelyCited?: boolean;
  chainSkipped?: boolean;
  /** Inne adresy, które łączy z tym adresem sam blockchain. */
  relatedAddresses?: RelatedAddress[];
  /** Własność adresu potwierdziła odpowiedź usługi (dokument spoza OSINT). */
  confirmedByReply?: ServiceReplyRef;
};

export interface DossierExtras {
  cashOutProof?: CashOutProof[];
  /** Wynik częściowy — analizę przerwał limit czasu. */
  partial?: boolean;
  mentions?: (Mention & { identifier: Identifier })[];
  /** Przelewy na adresy organów państwa (zajęcia) — nie są spieniężeniem. */
  seizures?: Seizure[];
  fundingSources?: FundingSource[];
  /** Liczba słabych tropów pominiętych na liście powiązanych tożsamości. */
  weakLeadsHidden?: number;
  summary?: { text: string; model: string; promptVersion: string } | null;
  explanations?: Explanation[];
  unconfirmedAddresses?: UnconfirmedAddress[];
  linkedIdentities?: LinkedIdentity[];
  /** Odpowiedzi usług wprowadzone przez analityka — dokumenty spoza OSINT; brak pola = usługa analizy bez tej funkcji. */
  serviceReplies?: ServiceReplyView[];
}

export type FullDossier = Dossier & DossierExtras;

export type Depth = 'standard' | 'deep';

export type ProgressStage = 'search' | 'occurrences' | 'chain' | 'counterparties' | 'scoring' | 'ai' | 'saving' | 'done' | 'failed';

export interface RunProgress {
  status: 'running' | 'completed' | 'failed';
  depth?: Depth;
  stage: ProgressStage;
  connectorsDone: number;
  connectorsTotal: number;
  documents: number;
  addresses: number;
  error?: string;
}

export interface AiStatus {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  description: string;
  usage?: Record<string, number>;
}

export interface CorpusStats {
  documents: number;
  addresses: number;
  services: number;
  newestFetchedAt?: string;
  retentionDays: number;
}

// ---------- Postęp analizy ----------

const STAGES: { id: ProgressStage; label: string }[] = [
  { id: 'search', label: 'Wyszukiwanie w publicznych źródłach' },
  { id: 'occurrences', label: 'Wyodrębnianie adresów i łączenie profili w osobę' },
  { id: 'chain', label: 'Pobieranie danych blockchain' },
  { id: 'counterparties', label: 'Śledzenie ścieżek środków do giełd i usług' },
  { id: 'scoring', label: 'Wycena i Wskaźnik Pewności' },
  { id: 'ai', label: 'Odczyt treści przez model językowy' },
  { id: 'saving', label: 'Zapis wyników i dowodów' },
];

/** Udział etapu wyszukiwania w pasku postępu — trwa najdłużej i ma własne liczniki. */
const SEARCH_SHARE = 45;

export interface ProgressView {
  percent: number;
  /** Indeks bieżącego etapu; równy liczbie etapów, gdy analiza się zakończyła. */
  current: number;
  failed: boolean;
  steps: { label: string; state: 'done' | 'active' | 'pending'; detail?: string }[];
}

/** Stan paska i listy etapów wyliczony z odpowiedzi `GET /api/runs/:id/progress`. */
export function progressView(progress: RunProgress): ProgressView {
  const finished = progress.status === 'completed' || progress.stage === 'done';
  const failed = progress.status === 'failed' || progress.stage === 'failed';
  const index = STAGES.findIndex((stage) => stage.id === progress.stage);
  // Nieznany etap (nowsza usługa) albo błąd: zostajemy na początku, bez zgadywania.
  const current = finished ? STAGES.length : Math.max(0, index);
  const searched = progress.connectorsTotal > 0 ? Math.min(1, progress.connectorsDone / progress.connectorsTotal) : 0;
  const percent = finished
    ? 100
    : current === 0
      ? Math.round(searched * SEARCH_SHARE)
      : Math.round(SEARCH_SHARE + ((current - 1) / (STAGES.length - 1)) * (100 - SEARCH_SHARE));
  return {
    percent,
    current,
    failed,
    steps: STAGES.map((stage, position) => ({
      label: stage.label,
      state: position < current ? 'done' : position === current ? 'active' : 'pending',
      detail:
        stage.id === 'search' && progress.connectorsTotal > 0
          ? `${progress.connectorsDone} z ${progress.connectorsTotal} źródeł · dokumenty: ${progress.documents}`
          : stage.id === 'occurrences' && progress.addresses > 0
            ? `adresy: ${progress.addresses}`
            : undefined,
    })),
  };
}

// ---------- Łańcuch kroków ----------

export interface ChainNode {
  address: string;
  /** Rola w ścieżce: adres osoby, adres przelotowy albo adres usługi. */
  role: 'source' | 'intermediate' | 'service';
  label?: string;
}

export interface ChainStep {
  txid: string;
  time: string;
  asset: string;
  amount: number;
  explorerUrl: string;
  inferred: boolean;
  reason?: string;
  to: ChainNode;
}

/** Ścieżka jako ciąg: adres początkowy, a po nim kroki prowadzące do kolejnych adresów. */
export function buildChain(trail: CashOutTrail): { source: ChainNode; steps: ChainStep[] } {
  return {
    source: { address: trail.sourceAddress, role: 'source' },
    steps: trail.hops.map((hop, index) => ({
      txid: hop.txid,
      time: hop.time,
      asset: hop.asset,
      amount: hop.amount,
      explorerUrl: hop.explorerUrl,
      inferred: hop.inferred === true,
      reason: hop.reason,
      to: {
        address: hop.to,
        role: index === trail.hops.length - 1 ? 'service' : 'intermediate',
        label: hop.toLabel ?? (index === trail.hops.length - 1 ? trail.serviceName : undefined),
      },
    })),
  };
}

export interface ProofSummary {
  totalPln: number;
  /** Liczba ustaleń bez wyceny w PLN. */
  unvalued: number;
  services: string[];
  topConfidence: number;
  strongest?: CashOutProof;
}

/** Ustalenia od najpewniejszego; przy remisie wyżej to o większej wartości. */
export function sortProofs(proofs: CashOutProof[]): CashOutProof[] {
  return [...proofs].sort(
    (a, b) => b.combinedConfidence - a.combinedConfidence || (b.trail.valuePln ?? 0) - (a.trail.valuePln ?? 0) || a.id.localeCompare(b.id),
  );
}

export function proofSummary(proofs: CashOutProof[]): ProofSummary {
  const sorted = sortProofs(proofs);
  return {
    totalPln: proofs.reduce((total, proof) => total + (proof.trail.valuePln ?? 0), 0),
    unvalued: proofs.filter((proof) => proof.trail.valuePln == null).length,
    services: [...new Set(proofs.map((proof) => proof.serviceName))],
    topConfidence: sorted[0]?.combinedConfidence ?? 0,
    strongest: sorted[0],
  };
}

/** Nazwa poziomu łącznej pewności — te same progi co w usłudze analizy. */
export function proofTier(confidence: number): string {
  return confidence >= 80 ? 'bardzo wysoka' : confidence >= 60 ? 'wysoka' : confidence >= 40 ? 'średnia' : 'niska';
}

// ---------- Wyjaśnienia braków, adresy do potwierdzenia, okres analizy ----------

export type ExplanationKind = 'service_name' | 'no_addresses' | 'only_unconfirmed' | 'widely_cited' | 'chain_skipped' | 'partial' | 'no_cash_out' | 'source_errors' | 'seized';

export interface Explanation {
  kind: ExplanationKind;
  text: string;
  suggestions: string[];
  /** Tylko `service_name`: publicznie oznaczone adresy tej usługi. */
  addresses?: { address: string; network: string; label: string }[];
}

export interface UnconfirmedAddress {
  address: string;
  network: Network;
  sources: { url: string; service: string; author?: string; profileId?: string; personId?: string }[];
  reasons: string[];
  personAddressProbability: number;
  /** Skrót aktywności w blockchainie; `null`, gdy łańcucha nie analizowano. */
  chain: {
    transfers: number;
    totalReceived: number;
    totalSent: number;
    asset: string;
    services: string[];
    cashOutPlnTotal: number;
    trails: number;
  } | null;
  /** Decyzje („confirmed”), które przypiszą adres podmiotowi. */
  confirmWith: { target: 'profile' | 'address'; key: string }[];
}

export interface Period {
  from?: string;
  to?: string;
}

/** Działanie, które interfejs potrafi wykonać dla sugestii z wyjaśnienia; `null` — sama podpowiedź tekstowa. */
export type SuggestionAction = 'add_identifier' | 'deep' | 'confirm' | null;

/** Rozpoznaje działanie po treści sugestii — usługa podaje je zwykłym zdaniem. */
export function suggestionAction(text: string): SuggestionAction {
  const lower = text.toLowerCase();
  if (/tryb(ie|u)? głębok/.test(lower)) return 'deep';
  if (/potwierd(ź|z)/.test(lower)) return 'confirm';
  if (/(dodaj|podaj|dopisz|wpisz).*(identyfikator|nick|e-mail|adres|profil)/.test(lower)) return 'add_identifier';
  return null;
}

/** Ustalenia pewne i warunkowe (zależne od potwierdzenia własności adresu), każda grupa od najmocniejszego. */
export function splitProofs(proofs: CashOutProof[]): { firm: CashOutProof[]; conditional: CashOutProof[] } {
  const sorted = sortProofs(proofs);
  return {
    firm: sorted.filter((proof) => !proof.ownerUnconfirmed),
    conditional: sorted
      .filter((proof) => proof.ownerUnconfirmed)
      .sort((a, b) => (b.confidenceIfConfirmed ?? b.combinedConfidence) - (a.confidenceIfConfirmed ?? a.combinedConfidence)),
  };
}

/** Okres do wysłania: puste pola pomijamy; błąd, gdy początek jest po końcu. */
export function cleanPeriod(from: string, to: string): { period?: Period; error?: string } {
  if (from && to && from > to) return { error: 'Początek okresu analizy nie może być późniejszy niż koniec.' };
  if (!from && !to) return {};
  return { period: { ...(from ? { from } : {}), ...(to ? { to } : {}) } };
}

export function periodLabel(period: Period | undefined): string | undefined {
  if (!period?.from && !period?.to) return undefined;
  const day = (value?: string) => value?.slice(0, 10);
  return period.from && period.to ? `${day(period.from)} – ${day(period.to)}` : period.from ? `od ${day(period.from)}` : `do ${day(period.to)}`;
}

/** Stronicowanie długich list: numer strony przycinany do zakresu. */
export function paginate<T>(items: T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { items: items.slice((current - 1) * size, current * size), page: current, pages };
}
