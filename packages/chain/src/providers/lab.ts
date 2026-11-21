// Dostawca danych z testowego łańcucha laboratorium tożsamości (apps/identity-lab).
// To SIEĆ LABORATORYJNA: lokalny, syntetyczny łańcuch UTXO z adresami `lab1…` i tokenem LAB
// bez wartości pieniężnej. Zakres jest celowo minimalny — saldo i przelewy między adresami,
// tak aby teczka pokazała aktywność adresu. Bez wyceny w PLN, bez wskaźników wypłat,
// bez śledzenia ścieżek i bez szukania powiązanych adresów.

import type { ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import { buildChainActivity } from '../activity.ts';
import type { ActivityOptions, RawTransfer } from '../activity.ts';
import { ChainProviderError, fetchJson } from '../http.ts';
import type { FetchLike } from '../http.ts';
import type { RateSource } from '../valuation.ts';

interface LabOutput {
  address: string;
  amount: number;
}

interface LabTransaction {
  id: string;
  /** `genesis` i `coinbase` to emisja (bez nadawcy); `transfer` to przelew między adresami. */
  type: string;
  inputs?: { txId: string; index: number; publicKey?: string }[];
  outputs?: LabOutput[];
  fee?: number;
  createdAt?: string;
}

interface LabBlock {
  height?: number;
  timestamp?: string;
  transactions?: LabTransaction[];
}

interface LabWallet {
  id?: string;
  address: string;
  label?: string;
  publicKey?: string;
  balance?: number;
}

interface LabBlockchain {
  token?: string;
  wallets?: LabWallet[];
  blocks?: LabBlock[];
  mempool?: unknown[];
}

export interface LabProviderConfig extends ActivityOptions {
  /** Adres panelu laboratorium, np. `http://127.0.0.1:8787`. */
  labUrl: string;
  fetch?: FetchLike;
  /** Jak długo pamiętać pobrany łańcuch (analiza pyta o wiele adresów z rzędu); domyślnie 5 s, 0 wyłącza. */
  cacheMs?: number;
}

/** Token LAB nie ma wartości — żadna kwota z sieci laboratoryjnej nie jest wyceniana. */
const NO_RATES: RateSource = { getRatePln: async () => null };

export const LAB_LIMITATIONS = [
  'SIEĆ LABORATORYJNA: dane pochodzą z lokalnego, syntetycznego łańcucha testowego (laboratorium tożsamości), nie z prawdziwej sieci.',
  'Token LAB nie ma wartości pieniężnej — kwoty nie są wyceniane w PLN i nie tworzą wskaźników wypłat ani sum podatkowych.',
  'Zakres minimalny: saldo i przelewy między adresami z potwierdzonych bloków; bez transakcji oczekujących, śledzenia ścieżek środków i szukania powiązanych adresów.',
  'Emisja początkowa (genesis) i nagrody za bloki są wliczone do wpływów i salda, ale nie mają nadawcy, więc nie występują na liście przelewów.',
];

export class LabChainProvider implements ChainProvider {
  id = 'lab-chain';
  label = 'Łańcuch LAB (sieć laboratoryjna, symulacja lokalna)';
  baseUrl: string;
  fetchImpl: FetchLike;
  options: ActivityOptions;
  cacheMs: number;
  private cached: { at: number; data: Promise<LabBlockchain> } | undefined;

  constructor(config: LabProviderConfig) {
    this.baseUrl = config.labUrl.replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
    this.cacheMs = config.cacheMs ?? 5000;
    this.options = { labels: config.labels, sanctions: config.sanctions, rateSource: NO_RATES };
  }

  /** Wyłącznie sieć laboratoryjna — prawdziwe sieci obsługują inni dostawcy. */
  supports(network: Network): boolean {
    return network === 'lab';
  }

  async getActivity(network: Network, address: string, context: ConnectorContext): Promise<ChainActivity> {
    if (network !== 'lab') throw new ChainProviderError('not_found', `${this.label}: sieć ${network} nie jest obsługiwana.`);
    const chain = await this.load(context.signal);
    if (!Array.isArray(chain.blocks) || !Array.isArray(chain.wallets)) {
      throw new ChainProviderError('invalid_response', `${this.label}: odpowiedź bez listy bloków lub portfeli.`);
    }
    const wanted = address.toLowerCase();
    const wallet = chain.wallets.find((item) => item.address.toLowerCase() === wanted);
    const asset = chain.token ?? 'LAB';
    const byKey = new Map(chain.wallets.filter((item) => item.publicKey).map((item) => [item.publicKey!, item.address]));
    const transactions = new Map(chain.blocks.flatMap((block) => (block.transactions ?? []).map((tx) => [tx.id, tx] as const)));
    /** Nadawcy przelewu: właściciele wydawanych wyjść (z poprzedniej transakcji albo z rejestru kluczy). */
    const sendersOf = (tx: LabTransaction): string[] => [
      ...new Set(
        (tx.inputs ?? [])
          .map((input) => transactions.get(input.txId)?.outputs?.[input.index]?.address ?? (input.publicKey ? byKey.get(input.publicKey) : undefined))
          .filter((value): value is string => Boolean(value)),
      ),
    ];

    const transfers: RawTransfer[] = [];
    const involved = new Set<string>();
    let received = 0;
    let sent = 0;
    for (const block of chain.blocks) {
      for (const tx of block.transactions ?? []) {
        const outputs = tx.outputs ?? [];
        const time = block.timestamp ?? tx.createdAt ?? new Date(0).toISOString();
        const senders = tx.type === 'transfer' ? sendersOf(tx) : [];
        const explorerUrl = `${this.baseUrl}/?tx=${encodeURIComponent(tx.id)}#blockchain`;
        if (senders.some((sender) => sender.toLowerCase() === wanted)) {
          involved.add(tx.id);
          sent += tx.fee ?? 0;
          for (const output of outputs) {
            // Wyjście wracające do nadawcy to reszta, nie przelew.
            if (output.address.toLowerCase() === wanted) continue;
            sent += output.amount;
            transfers.push({ txid: tx.id, time, direction: 'out', counterparty: output.address, asset, amount: output.amount, explorerUrl });
          }
          continue;
        }
        for (const output of outputs) {
          if (output.address.toLowerCase() !== wanted) continue;
          involved.add(tx.id);
          received += output.amount;
          // Emisja nie ma nadawcy — zwiększa wpływy, ale nie jest przelewem między adresami.
          if (senders[0]) transfers.push({ txid: tx.id, time, direction: 'in', counterparty: senders[0], asset, amount: output.amount, explorerUrl });
        }
      }
    }
    if (!wallet && involved.size === 0) {
      throw new ChainProviderError('not_found', `${this.label}: adres nie występuje w rejestrze portfeli ani w żadnym bloku.`);
    }

    const limitations = [...LAB_LIMITATIONS];
    const pending = Array.isArray(chain.mempool) ? chain.mempool.length : 0;
    if (pending > 0) limitations.push(`W puli oczekujących jest ${pending} transakcji — nie zostały uwzględnione.`);

    return buildChainActivity(
      {
        network,
        address: wallet?.address ?? address,
        sourceName: this.label,
        isContract: false,
        // Nazwa portfela z rejestru łańcucha LAB — etykieta informacyjna, bez przypisanej klasy.
        ...(wallet?.label ? { label: wallet.label } : {}),
        nativeAsset: asset,
        txCount: involved.size,
        totalReceived: received,
        totalSent: sent,
        balance: wallet?.balance ?? received - sent,
        historyComplete: true,
        transfers,
        limitations,
      },
      this.options,
    );
  }

  /** Cały publiczny łańcuch jednym żądaniem; pamiętany krótko, żeby analiza kilku adresów nie pobierała go wielokrotnie. */
  private load(signal?: AbortSignal): Promise<LabBlockchain> {
    if (this.cached && this.cacheMs > 0 && Date.now() - this.cached.at < this.cacheMs) return this.cached.data;
    // Bez sygnału wywołującego: wynik jest współdzielony, więc przerwanie jednej analizy nie może go unieważnić innym.
    void signal;
    const data = fetchJson<LabBlockchain>(this.fetchImpl, `${this.baseUrl}/api/blockchain`, { source: this.label });
    if (this.cacheMs > 0) {
      const entry = { at: Date.now(), data };
      this.cached = entry;
      data.catch(() => {
        if (this.cached === entry) this.cached = undefined;
      });
    }
    return data;
  }
}
