// Miksery i CoinJoin: kształt `mixerExposure` z usługi analizy i czysta logika widoków (baner, odznaka, węzeł grafu).
import type { ClaimStatus, Dossier, GraphNode } from '@olcys/core';
import { fmtPlnCompact } from './format.ts';

export type MixerLevel = 'none' | 'possible' | 'confirmed';

export interface MixerTransfer {
  direction: 'to_mixer' | 'from_mixer';
  address: string;
  network: string;
  txid: string;
  time: string;
  asset: string;
  amount: number;
  valuePln?: number;
  rateNote?: string;
  mixerAddress: string;
  mixerLabel: string;
  mixerName: string;
  labelSource: string;
  status: ClaimStatus;
  explorerUrl: string;
}

export interface CoinJoinParticipation {
  address: string;
  network: string;
  txid: string;
  time?: string;
  explorerUrl?: string;
  basis: 'equal_outputs' | 'trace';
  equalOutputs?: number;
  denomination?: number;
  asset?: string;
  pattern?: 'whirlpool' | 'wasabi';
  via?: string;
  status: 'hypothesis';
  explanation: string;
}

export interface MixerTraceStop {
  address: string;
  network: string;
  mixerAddress: string;
  mixerLabel?: string;
  txid: string;
  coinjoin: boolean;
  direct: boolean;
  text: string;
}

export interface MixerSanctionHit {
  mixerAddress: string;
  list: string;
  entryId: string;
  entryName: string;
  retrievedAt: string;
  url?: string;
  caveat: string;
}

export interface MixerExposure {
  level: MixerLevel;
  statement: string;
  mixers: string[];
  outgoing: MixerTransfer[];
  incoming: MixerTransfer[];
  coinjoins: CoinJoinParticipation[];
  traceStops: MixerTraceStop[];
  sanctions: MixerSanctionHit[];
  totals: { transactions: number; outCount: number; inCount: number; outPln?: number; inPln?: number; unvalued: number };
  addresses: string[];
  limitations: string[];
}

/** Ekspozycja z teczki; brak pola (starsza usługa analizy) albo poziom „brak” → `undefined`. */
export function mixerExposureOf(dossier: Dossier): MixerExposure | undefined {
  const exposure = (dossier as Dossier & { mixerExposure?: MixerExposure }).mixerExposure;
  return exposure && exposure.level !== 'none' ? exposure : undefined;
}

const transakcje = (count: number): string => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = count === 1 ? 'transakcja' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'transakcje' : 'transakcji';
  return `${count} ${word}`;
};

/** Baner w podsumowaniu sprawy: spokojne zdanie, kolor zależny od poziomu (oznaczony mikser — czerwony, heurystyka — bursztynowy). */
export function mixerBanner(exposure: MixerExposure): { tone: 'confirmed' | 'possible'; text: string; note: string } {
  if (exposure.level === 'confirmed') {
    const labelled = new Set([...exposure.outgoing, ...exposure.incoming].map((item) => item.txid)).size;
    // Kwota: wartość przekazań DO miksera (a bez nich — Z miksera); obu kierunków nie sumujemy.
    const { outPln, inPln } = exposure.totals;
    const amount = outPln ? `ok. ${fmtPlnCompact(outPln)} do miksera` : inPln ? `ok. ${fmtPlnCompact(inPln)} z miksera` : '';
    const parts = [exposure.mixers.join(', '), transakcje(labelled), amount].filter(Boolean);
    return {
      tone: 'confirmed',
      text: `Środki przeszły przez mikser (${parts.join(', ')}) — dalsza droga nieustalona`,
      note: exposure.incoming.length > 0 ? 'Część środków przyszła z miksera — pochodzenie zatarte.' : 'Adres miksera ma publiczną etykietę.',
    };
  }
  const count = exposure.coinjoins.length + exposure.traceStops.filter((item) => !item.coinjoin && !item.direct).length;
  return {
    tone: 'possible',
    text: `Możliwy udział w mikserze lub CoinJoin (${transakcje(count)}) — hipoteza, dalsza droga nieustalona`,
    note: 'Heurystyka (np. wiele równych wyjść w jednej transakcji) — do weryfikacji.',
  };
}

/** Krótka odznaka na moście „Śledzenie w blockchainie”. */
export function mixerBadgeText(exposure: MixerExposure): string {
  return exposure.level === 'confirmed' ? 'mikser' : 'możliwy mikser';
}

/** Spirala — znak miksera (graf, odznaka, legenda); mieści się w promieniu ok. 12. */
export const SWIRL_PATH = 'M0,0 C2,-3 6,-1 5,3 C4,7 -3,8 -6,4 C-9,0 -7,-8 0,-9 C7,-10 12,-4 11,3';

/** Węzeł miksera w grafie (oznaczony przez usługę analizy). */
export function isMixerNode(node: GraphNode): boolean {
  return (node as GraphNode & { mixer?: unknown }).mixer !== undefined;
}

export const MIXER_STATUS_TEXT: Record<string, string> = {
  source_fact: 'etykieta z publicznego zbioru (fakt źródłowy)',
  computed: 'etykieta dostawcy danych',
  hypothesis: 'etykieta rozpoznana po nazwie (hipoteza)',
};
