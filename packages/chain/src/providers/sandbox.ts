// Dostawca danych z fikcyjnego eksploratora bloków w `apps/sandbox`.

import type { AddressClass, CashOutKind, ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import { buildChainActivity } from '../activity.ts';
import type { ActivityOptions, RawTransfer } from '../activity.ts';
import { accountCluster } from '../cluster.ts';
import { DEFAULT_REQUEST_BUDGET } from '../deposit.ts';
import { linkBudgetLimit, traceBudgetLimit } from '../history.ts';
import { ChainProviderError, RequestBudget, fetchJson } from '../http.ts';
import { DEFAULT_LINK_BUDGET, findLinkedAddresses } from '../links.ts';
import type { LinkOptions } from '../links.ts';
import { traceAccountFlows } from '../trace.ts';
import type { FetchLike } from '../http.ts';
import { getDefaultLabels } from '../labels.ts';

interface SandboxTransfer {
  txid: string;
  time: string;
  direction: 'in' | 'out';
  counterparty: string;
  asset: string;
  amount: number;
  // Pola opcjonalne: eksplorator może od razu opisać kontrahenta.
  counterpartyLabel?: string;
  counterpartyClass?: AddressClass;
  counterpartyKind?: CashOutKind;
}

interface SandboxAddress {
  address: string;
  network: Network;
  isContract?: boolean;
  label?: string;
  addressClass?: AddressClass;
  kind?: CashOutKind;
  transfers?: SandboxTransfer[];
}

/** Ilu kontrahentów najwyżej sprawdzamy w eksploratorze, żeby poznać ich etykiety. */
const MAX_COUNTERPARTY_LOOKUPS = 25;

export interface SandboxProviderConfig extends ActivityOptions {
  sandboxUrl: string;
  fetch?: FetchLike;
  /** Śledzenie środków w głąb (adres wpłat giełdy, adres przelotowy); domyślnie włączone. */
  followDeposits?: boolean;
  /** Szukanie powiązanych adresów (m.in. współwpłacających); domyślnie włączone. */
  findLinks?: boolean;
  requestBudget?: number;
  linkBudget?: number;
  links?: LinkOptions;
}

export class SandboxChainProvider implements ChainProvider {
  id = 'sandbox-explorer';
  label = 'Eksplorator sandbox (dane syntetyczne)';
  baseUrl: string;
  fetchImpl: FetchLike;
  options: ActivityOptions;
  followDeposits: boolean;
  findLinks: boolean;
  requestBudget: number;
  linkBudget: number;
  linkOptions: LinkOptions | undefined;

  constructor(config: SandboxProviderConfig) {
    this.followDeposits = config.followDeposits ?? true;
    this.findLinks = config.findLinks ?? true;
    this.requestBudget = config.requestBudget ?? DEFAULT_REQUEST_BUDGET;
    this.linkBudget = config.linkBudget ?? DEFAULT_LINK_BUDGET;
    this.linkOptions = config.links;
    this.baseUrl = config.sandboxUrl.replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
    this.options = {
      labels: config.labels,
      rateSource: config.rateSource,
      cashOut: config.cashOut,
      sanctions: config.sanctions,
      deposit: config.deposit,
      trace: config.trace,
    };
  }

  /** Sandbox może znać adres w każdej sieci; o tym, czy go zna, mówi dopiero odpowiedź (404). */
  supports(): boolean {
    return true;
  }

  async getActivity(network: Network, address: string, context: ConnectorContext): Promise<ChainActivity> {
    const data = await this.fetchAddress(address, context.signal);
    if (!Array.isArray(data.transfers)) {
      throw new ChainProviderError('invalid_response', `${this.label}: odpowiedź bez listy przelewów.`);
    }
    const limitations = ['Dane pochodzą z syntetycznego środowiska demonstracyjnego, nie z prawdziwej sieci.'];
    const counterparties = await this.describeCounterparties(network, data.transfers, context, limitations);

    const toRaw = (transfer: SandboxTransfer, known: SandboxAddress | undefined): RawTransfer => ({
      txid: transfer.txid,
      time: transfer.time,
      direction: transfer.direction,
      counterparty: transfer.counterparty,
      asset: transfer.asset,
      amount: transfer.amount,
      explorerUrl: `${this.baseUrl}/explorer/address/${encodeURIComponent(transfer.counterparty)}`,
      counterpartyLabel: transfer.counterpartyLabel ?? known?.label,
      counterpartyClass: transfer.counterpartyClass ?? known?.addressClass,
      counterpartyKind: transfer.counterpartyKind ?? known?.kind,
      counterpartyIsContract: known?.isContract,
    });
    const transfers: RawTransfer[] = data.transfers.map((transfer) => toRaw(transfer, counterparties.get(transfer.counterparty)));

    // Historia adresu pośredniego to ta sama odpowiedź eksploratora, którą pobraliśmy dla etykiety kontrahenta —
    // śledzenie i szukanie powiązań zwykle nie wymagają więc dodatkowych żądań.
    const history = new Map<string, Promise<SandboxAddress>>([...counterparties.entries()].map(([key, value]) => [key, Promise.resolve(value)]));
    const load = (other: string) => {
      let pending = history.get(other);
      if (!pending) {
        pending = this.fetchAddress(other, context.signal);
        history.set(other, pending);
      }
      return pending;
    };
    const side = async (other: string, asset: string, direction: 'in' | 'out') => {
      const node = await load(other);
      const list = (node.transfers ?? []).filter((item) => item.direction === direction && item.asset === asset).map((item) => toRaw(item, undefined));
      return { list, txCount: (node.transfers ?? []).length };
    };
    const traceOptions = { ...this.options.deposit, ...this.options.trace };
    const labels = this.options.labels ?? getDefaultLabels();

    let found: Awaited<ReturnType<typeof traceAccountFlows>> | undefined;
    if (this.followDeposits) {
      found = await traceAccountFlows({
        network,
        address,
        transfers,
        labels,
        sourceName: this.label,
        budget: new RequestBudget(traceBudgetLimit(context, this.requestBudget)),
        options: traceOptions,
        signal: context.signal,
        expand: async (other, asset) => {
          const { list, txCount } = await side(other, asset, 'out');
          return { outgoing: list, txCount };
        },
      });
      limitations.push(...found.limitations);
    }

    let linked: Awaited<ReturnType<typeof findLinkedAddresses>> | undefined;
    if (this.findLinks) {
      linked = await findLinkedAddresses({
        network,
        address,
        transfers,
        deposits: found?.deposits ?? [],
        historyComplete: true,
        labels,
        sourceName: this.label,
        budget: new RequestBudget(linkBudgetLimit(context, this.linkBudget)),
        options: this.linkOptions,
        signal: context.signal,
        fetchIncoming: async (other, asset) => {
          const { list, txCount } = await side(other, asset, 'in');
          return { incoming: list, txCount };
        },
        countTransactions: async (other) => ((await load(other)).transfers ?? []).length,
      });
      limitations.push(...linked.limitations);
    }

    return buildChainActivity(
      {
        network,
        address,
        sourceName: this.label,
        isContract: data.isContract === true,
        label: data.label,
        addressClass: data.addressClass,
        transfers,
        ...(found ? { inferredDeposits: found.deposits, trails: found.trails, openQuestions: found.openQuestions } : {}),
        ...(linked ? { linkedAddresses: linked.links } : {}),
        ...(network !== 'bitcoin' && network !== 'bitcoin-testnet' ? { cluster: accountCluster(network, address) } : {}),
        limitations,
      },
      this.options,
    );
  }

  private fetchAddress(address: string, signal?: AbortSignal): Promise<SandboxAddress> {
    return fetchJson<SandboxAddress>(
      this.fetchImpl,
      `${this.baseUrl}/explorer/api/address/${encodeURIComponent(address)}`,
      { source: this.label, signal },
    );
  }

  /**
   * Eksplorator opisuje etykietą tylko pytany adres, więc etykiety kontrahentów
   * (giełda, bramka płatnicza…) pobieramy osobnymi zapytaniami o ich adresy.
   * Pomijamy kontrahentów opisanych już w przelewie lub w zbiorze etykiet.
   */
  private async describeCounterparties(
    network: Network,
    transfers: SandboxTransfer[],
    context: ConnectorContext,
    limitations: string[],
  ): Promise<Map<string, SandboxAddress>> {
    const labels = this.options.labels ?? getDefaultLabels();
    const pending = new Set<string>();
    for (const transfer of transfers) {
      if (transfer.counterpartyLabel || transfer.counterpartyClass || transfer.counterpartyKind) continue;
      if (labels.lookup(network, transfer.counterparty)) continue;
      pending.add(transfer.counterparty);
    }
    const selected = [...pending].slice(0, MAX_COUNTERPARTY_LOOKUPS);
    if (pending.size > selected.length) {
      limitations.push(
        `Sprawdzono etykiety ${selected.length} z ${pending.size} kontrahentów (limit zapytań) — ` +
          'przelewy do pozostałych mogły nie zostać rozpoznane jako wypłaty.',
      );
    }
    const described = new Map<string, SandboxAddress>();
    await Promise.all(
      selected.map(async (counterparty) => {
        try {
          described.set(counterparty, await this.fetchAddress(counterparty, context.signal));
        } catch {
          // Kontrahent nieznany eksploratorowi zostaje bez etykiety.
        }
      }),
    );
    return described;
  }
}
