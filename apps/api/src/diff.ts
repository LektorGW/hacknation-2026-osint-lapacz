// Porównywanie analiz: co doszło, co zniknęło, jak zmienił się wynik
// i gdzie w tym samym miejscu publikacji podmieniono adres.

import type { AnalysisRun, Network, RunDiff } from '@olcys/core';

/** Podmiana adresu między starszą a nowszą wersją tej samej publikacji. */
export interface AddressReplacement {
  url: string;
  network: Network;
  from: string;
  to: string;
  /** Czas zapisania starszej wersji w archiwum. */
  archivedAt: string;
  /** Czas nowszej wersji: kolejnej kopii archiwalnej albo pobrania wersji bieżącej. */
  observedAt: string;
}

/**
 * Sprowadza adres kopii archiwalnej do adresu oryginału, żeby wersję z archiwum
 * dało się zestawić z wersją bieżącą (format Wayback Machine: `/web/<czas>/<url>`).
 */
export function normalizeProfileUrl(url: string): string {
  // Wayback Machine oraz każde archiwum o tym samym układzie ścieżki, w którym
  // po znaczniku czasu następuje pełny adres oryginału.
  const archived =
    /^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\/(.+)$/i.exec(url) ??
    /^https?:\/\/[^/]+\/(?:[^/]+\/)?web\/[^/]+\/(https?:\/\/.+)$/i.exec(url);
  return (archived ? archived[1]! : url).replace(/#.*$/, '').replace(/\/+$/, '');
}

interface AddressRef {
  network: Network;
  address: string;
}

const refKey = (ref: AddressRef) => `${ref.network}:${ref.address}`;

function difference(left: Map<string, AddressRef>, right: Map<string, AddressRef>): AddressRef[] {
  return [...left.entries()].filter(([key]) => !right.has(key)).map(([, ref]) => ref);
}

/** Adres zniknął, a w jego miejscu pojawił się inny w tej samej sieci. */
function pairReplacements(older: Map<string, AddressRef>, newer: Map<string, AddressRef>) {
  const pairs: { network: Network; from: string; to: string }[] = [];
  const added = difference(newer, older);
  for (const removed of difference(older, newer)) {
    for (const candidate of added) {
      if (candidate.network === removed.network) {
        pairs.push({ network: removed.network, from: removed.address, to: candidate.address });
      }
    }
  }
  return pairs;
}

/** Podmiany adresu między wersją archiwalną a bieżącą w obrębie jednej analizy. */
export function detectReplacements(run: AnalysisRun): AddressReplacement[] {
  // publikacja → wersja (czas archiwizacji; '' = bieżąca) → adresy
  const pages = new Map<string, Map<string, { observedAt: string; addresses: Map<string, AddressRef> }>>();
  for (const finding of run.findings) {
    for (const evidence of finding.evidence) {
      const url = normalizeProfileUrl(evidence.url);
      const versions = pages.get(url) ?? new Map();
      pages.set(url, versions);
      const versionKey = evidence.archivedAt ?? '';
      const version = versions.get(versionKey) ?? {
        observedAt: evidence.archivedAt ?? evidence.capturedAt,
        addresses: new Map<string, AddressRef>(),
      };
      versions.set(versionKey, version);
      version.addresses.set(refKey(finding), { network: finding.network, address: finding.address });
    }
  }

  const replacements: AddressReplacement[] = [];
  for (const [url, versions] of pages) {
    const archived = [...versions.entries()].filter(([key]) => key !== '').sort(([a], [b]) => a.localeCompare(b));
    const current = versions.get('');
    const ordered = [...archived.map(([, version]) => version), ...(current ? [current] : [])];
    for (let i = 1; i < ordered.length; i++) {
      const older = ordered[i - 1]!;
      const newer = ordered[i]!;
      for (const pair of pairReplacements(older.addresses, newer.addresses)) {
        replacements.push({ url, ...pair, archivedAt: older.observedAt, observedAt: newer.observedAt });
      }
    }
  }
  return replacements;
}

/** Adresy widoczne w bieżących (niearchiwalnych) wersjach publikacji. */
function currentAddressesByUrl(run: AnalysisRun): Map<string, Map<string, AddressRef>> {
  const byUrl = new Map<string, Map<string, AddressRef>>();
  for (const finding of run.findings) {
    for (const evidence of finding.evidence) {
      if (evidence.archivedAt) continue;
      const url = normalizeProfileUrl(evidence.url);
      const addresses = byUrl.get(url) ?? new Map<string, AddressRef>();
      byUrl.set(url, addresses);
      addresses.set(refKey(finding), { network: finding.network, address: finding.address });
    }
  }
  return byUrl;
}

/** Przelew do giełdy lub usługi, którego nie było w poprzedniej analizie. */
export interface CashOutChange {
  /** Adres sprawy, z którego wyszedł przelew. */
  address: string;
  network: Network;
  txid: string;
  time: string;
  kind: string;
  counterparty: string;
  counterpartyLabel?: string;
  asset: string;
  amount: number;
  valuePln?: number;
  explorerUrl?: string;
}

/**
 * Nowe przelewy do giełd i usług: wskaźniki wypłat z nowszej analizy (adresy nieodrzucone),
 * których nie było w starszej. Klucz: adres sprawy, transakcja i odbiorca.
 */
export function diffCashOuts(from: AnalysisRun, to: AnalysisRun): CashOutChange[] {
  const key = (address: string, txid: string, counterparty: string) => `${address}|${txid}|${counterparty}`.toLowerCase();
  const before = new Set(from.findings.flatMap((finding) => (finding.chain?.cashOuts ?? []).map((item) => key(finding.address, item.txid, item.counterparty))));
  return to.findings
    .filter((finding) => !finding.confidence.excluded)
    .flatMap((finding) =>
      (finding.chain?.cashOuts ?? [])
        .filter((item) => !before.has(key(finding.address, item.txid, item.counterparty)))
        .map((item) => ({
          address: finding.address,
          network: finding.network,
          txid: item.txid,
          time: item.time,
          kind: item.kind,
          counterparty: item.counterparty,
          ...(item.counterpartyLabel ? { counterpartyLabel: item.counterpartyLabel } : {}),
          asset: item.asset,
          amount: item.amount,
          ...(typeof item.valuePln === 'number' ? { valuePln: item.valuePln } : {}),
          ...(item.explorerUrl ? { explorerUrl: item.explorerUrl } : {}),
        })),
    )
    .sort((a, b) => b.time.localeCompare(a.time));
}

/** Różnice między starszą (`from`) a nowszą (`to`) analizą tego samego podmiotu. */
export function diffRuns(from: AnalysisRun, to: AnalysisRun): RunDiff {
  const before = new Map(from.findings.map((finding) => [refKey(finding), finding]));
  const after = new Map(to.findings.map((finding) => [refKey(finding), finding]));

  const scoreChanges: RunDiff['scoreChanges'] = [];
  for (const [key, finding] of after) {
    const previous = before.get(key);
    if (previous && previous.confidence.score !== finding.confidence.score) {
      scoreChanges.push({ address: finding.address, from: previous.confidence.score, to: finding.confidence.score });
    }
  }

  const replacedAddresses: RunDiff['replacedAddresses'] = [];
  const urlsBefore = currentAddressesByUrl(from);
  for (const [url, addressesAfter] of currentAddressesByUrl(to)) {
    const addressesBefore = urlsBefore.get(url);
    if (!addressesBefore) continue;
    for (const pair of pairReplacements(addressesBefore, addressesAfter)) {
      replacedAddresses.push({ url, from: pair.from, to: pair.to });
    }
  }

  return {
    fromRunId: from.id,
    toRunId: to.id,
    addedAddresses: [...after.entries()].filter(([key]) => !before.has(key)).map(([, finding]) => finding.address),
    removedAddresses: [...before.entries()].filter(([key]) => !after.has(key)).map(([, finding]) => finding.address),
    scoreChanges,
    replacedAddresses,
  };
}
