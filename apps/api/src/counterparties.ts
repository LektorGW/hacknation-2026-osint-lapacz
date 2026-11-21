// Kontrahenci bez etykiety: adresy, z którymi adres podmiotu wymieniał środki, a o
// których dane blockchain nic nie mówią. To kandydaci na adresy innych osób albo
// pośredników — sprawdzamy w źródłach, czy ktoś je opublikował.

import type { ChainActivity, Network, Transfer } from '@olcys/core';
import { addressKey } from './intel.ts';

export interface AddressActivity {
  network: Network;
  address: string;
  chain?: ChainActivity;
}

export interface CounterpartyCandidate {
  network: Network;
  address: string;
  /** Suma kwot przelewów w jednostkach aktywów (przybliżona miara znaczenia kontrahenta). */
  total: number;
  /** Adresy podmiotu, które miały z nim przelewy (`network:address`). */
  subjectAddresses: string[];
}

/** Kontrahent, o którym dane blockchain nie mówią nic: brak etykiety i klasy pośrednika. */
export const isUnlabeled = (transfer: Transfer): boolean =>
  !transfer.counterpartyLabel && (transfer.counterpartyClass === 'unknown' || transfer.counterpartyClass === 'private');

/**
 * Kontrahenci bez etykiety uporządkowani malejąco po łącznej kwocie przelewów.
 * Pomija adresy z `ownKeys` (własne adresy podmiotu).
 */
export function unlabeledCounterparties(items: AddressActivity[], ownKeys: Set<string>): CounterpartyCandidate[] {
  const byKey = new Map<string, CounterpartyCandidate>();
  for (const item of items) {
    for (const transfer of item.chain?.transfers ?? []) {
      if (!isUnlabeled(transfer) || !transfer.counterparty) continue;
      const key = addressKey({ network: item.network, address: transfer.counterparty });
      if (ownKeys.has(key)) continue;
      const candidate = byKey.get(key) ?? { network: item.network, address: transfer.counterparty, total: 0, subjectAddresses: [] };
      byKey.set(key, candidate);
      candidate.total += transfer.amount;
      const subjectKey = addressKey(item);
      if (!candidate.subjectAddresses.includes(subjectKey)) candidate.subjectAddresses.push(subjectKey);
    }
  }
  return [...byKey.values()].sort((a, b) => b.total - a.total);
}
