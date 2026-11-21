// Dowód spieniężenia i postęp analizy: lokalne rozszerzenia kontraktu oraz czysta logika widoków.
import type { CashOutTrail, Dossier, Finding, Identifier, Network, StoredEvidence, TextInsight } from '@olcys/core';

// ---------- Kształty zwracane przez usługę analizy poza typami `@olcys/core` ----------

export interface CashOutProof {
  id: string;
  person: { id: string; fullName?: string; probability: number } | null;
  address: string;
  network: Network;
  /** Skąd wiadomo o adresie: publikacja, wskazanie analityka albo klaster portfela. */
  addressBasis: 'published' | 'analyst' | 'cluster';
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
}

export type EvidenceWithInsight = StoredEvidence & { insight?: TextInsight };

export type DossierFinding = Finding & {
  annotations?: string[];
  excludedEvidence?: EvidenceWithInsight[];
  /** Prawdopodobieństwo, że adres należy do osoby ze sprawy. */
  subjectProbability?: number;
  widelyCited?: boolean;
  chainSkipped?: boolean;
};

export interface DossierExtras {
  cashOutProof?: CashOutProof[];
  /** Wynik częściowy — analizę przerwał limit czasu. */
  partial?: boolean;
  mentions?: { identifier: Identifier; documents: number; authors: number; services: string[] }[];
  summary?: { text: string; model: string; promptVersion: string } | null;
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
