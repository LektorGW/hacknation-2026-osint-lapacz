// Atrapy łączników i dostawców danych blockchain — testy nie korzystają z sieci.

import { DEFAULT_RULES } from '@olcys/core';
import type { AnalysisResult } from '../src/analysis.ts';
import { buildDossier } from '../src/dossier.ts';
import type { DossierView } from '../src/dossier.ts';
import type { OtherCase } from '../src/relations.ts';
import type { DecisionRecord } from '../src/storage.ts';
import type {
  AddressClass,
  AnalysisRun,
  CashOutIndicator,
  ChainActivity,
  ChainProvider,
  Finding,
  Identifier,
  IdentifierType,
  Network,
  SourceConnector,
  SourceDocument,
  StoredEvidence,
  SubjectQuery,
  Transfer,
} from '@olcys/core';

// Prawdziwe, publicznie znane adresy z poprawną sumą kontrolną.
export const BTC_A = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
export const BTC_B = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
export const BTC_EXCHANGE = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
export const ETH_A = '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';

export const FIXED_NOW = () => new Date('2026-11-21T10:00:00.000Z');

type DocInput = Partial<SourceDocument> & { url: string; text: string };

export interface FakeConnector extends SourceConnector {
  calls: Identifier[];
}

export function fakeConnector(
  id: string,
  service: string,
  accepts: IdentifierType[],
  respond: (identifier: Identifier) => DocInput[],
): FakeConnector {
  const calls: Identifier[] = [];
  return {
    id,
    service,
    label: `Atrapa ${id}`,
    description: `Opis łącznika ${id}`,
    accepts,
    enabledByDefault: true,
    calls,
    async search(identifier) {
      calls.push(identifier);
      return respond(identifier).map((doc) => ({
        connectorId: id,
        service,
        title: `Dokument ${doc.url}`,
        fetchedAt: '2026-11-21T09:00:00.000Z',
        category: 'own_profile',
        identityMatch: 'exact_identifier',
        matchedIdentifier: identifier,
        ...doc,
      }));
    },
  };
}

export function fakeActivity(network: Network, address: string, addressClass: AddressClass): ChainActivity {
  return {
    profile: {
      address,
      network,
      addressClass,
      label: addressClass === 'exchange' ? 'Giełda Testowa: Hot Wallet' : undefined,
      classificationSource: 'atrapa etykiet',
      isContract: false,
      txCount: 1,
      totalReceived: 1,
      totalSent: 0.4,
      balance: 0.6,
      nativeAsset: 'BTC',
    },
    transfers: [
      {
        txid: 'a'.repeat(64),
        time: '2025-03-14T10:22:00.000Z',
        direction: 'out',
        counterparty: BTC_EXCHANGE,
        counterpartyClass: 'exchange',
        counterpartyLabel: 'Giełda Testowa',
        asset: 'BTC',
        amount: 0.4,
        explorerUrl: `https://explorer.example/tx/${'a'.repeat(64)}`,
      },
    ],
    cashOuts: [
      {
        kind: 'exchange_deposit',
        txid: 'a'.repeat(64),
        time: '2025-03-14T10:22:00.000Z',
        asset: 'BTC',
        amount: 0.4,
        counterparty: BTC_EXCHANGE,
        counterpartyLabel: 'Giełda Testowa',
        valuePln: 132000,
        valuation: 'kurs 330 000 zł/BTC z 2025-03-14 (atrapa)',
        explanation: 'Przelew na adres depozytowy giełdy.',
        explorerUrl: `https://explorer.example/tx/${'a'.repeat(64)}`,
      },
    ],
    cashOutPlnByYear: { '2025': 132000 },
    limitations: ['Dane testowe.'],
  };
}

/** Dostawca zwracający klasę adresu z mapy; adresy spoza mapy są prywatne. */
export function fakeProvider(classes: Record<string, AddressClass> = {}): ChainProvider {
  return {
    id: 'atrapa-chain',
    label: 'Atrapa eksploratora',
    supports: () => true,
    getActivity: async (network, address) => fakeActivity(network, address, classes[address] ?? 'private'),
  };
}

export function evidence(url: string, extra: Partial<StoredEvidence> = {}): StoredEvidence {
  return {
    id: `ev-${url}-${extra.archivedAt ?? 'now'}`,
    category: 'own_profile',
    service: 'github.com',
    url,
    capturedAt: '2026-11-21T09:00:00.000Z',
    identityMatch: 'exact_identifier',
    title: 'Profil',
    excerpt: '…',
    contentHash: '0'.repeat(64),
    connectorId: 'github',
    matchedIdentifier: { type: 'nick', value: 'janek' },
    ...extra,
  };
}

export function finding(address: string, score: number, items: StoredEvidence[], network: Network = 'bitcoin'): Finding {
  return {
    address,
    network,
    checksumVerified: true,
    evidence: items,
    confidence: { score, tier: 'test', excluded: false, ledger: [], nextSteps: [] },
    unrelatedPublishers: 0,
  };
}

export function run(id: string, findings: Finding[]): AnalysisRun {
  return {
    id,
    caseId: 'sprawa-1',
    startedAt: '2026-11-21T09:00:00.000Z',
    finishedAt: '2026-11-21T09:00:05.000Z',
    status: 'completed',
    query: { identifiers: [{ type: 'nick', value: 'janek' }] },
    connectors: ['github'],
    findings,
    log: [{ time: '2026-11-21T09:00:00.000Z', message: 'Start' }],
  };
}

// ---------- Pomoc do testów teczki ----------

export const BTC_C = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
export const BTC_D = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

type TransferInput = Partial<Transfer> & { counterparty: string; time: string; amount: number };

/** Przelew testowy; identyfikator transakcji wynika z numeru, żeby dało się go sprawdzić w wyniku. */
export function transfer(index: number, input: TransferInput): Transfer {
  const txid = index.toString(16).padStart(64, '0');
  return {
    txid,
    direction: 'out',
    counterpartyClass: 'unknown',
    asset: 'BTC',
    explorerUrl: `https://explorer.example/tx/${txid}`,
    ...input,
  };
}

/** Wskaźnik wypłaty odpowiadający przelewowi wychodzącemu. */
export function cashOut(source: Transfer, valuePln: number, extra: Partial<CashOutIndicator> = {}): CashOutIndicator {
  return {
    kind: 'exchange_deposit',
    txid: source.txid,
    time: source.time,
    asset: source.asset,
    amount: source.amount,
    counterparty: source.counterparty,
    counterpartyLabel: source.counterpartyLabel,
    valuePln,
    valuation: 'kurs testowy',
    explanation: 'Przelew na adres giełdy.',
    explorerUrl: source.explorerUrl,
    ...extra,
  };
}

/** Dostawca z ręcznie opisaną aktywnością wybranych adresów; pozostałe są prywatne i bez przelewów. */
export function chainWith(
  activities: Record<string, { transfers?: Transfer[]; cashOuts?: CashOutIndicator[]; addressClass?: AddressClass; label?: string }>,
): ChainProvider {
  return {
    id: 'atrapa-chain',
    label: 'Atrapa eksploratora',
    supports: () => true,
    getActivity: async (network, address) => {
      const spec = activities[address] ?? {};
      const cashOuts = spec.cashOuts ?? [];
      const byYear: Record<string, number> = {};
      for (const item of cashOuts) byYear[item.time.slice(0, 4)] = (byYear[item.time.slice(0, 4)] ?? 0) + (item.valuePln ?? 0);
      return {
        ...fakeActivity(network, address, spec.addressClass ?? 'private'),
        profile: { ...fakeActivity(network, address, spec.addressClass ?? 'private').profile, label: spec.label },
        transfers: spec.transfers ?? [],
        cashOuts,
        cashOutPlnByYear: byYear,
      };
    },
  };
}

/** Teczka z wyniku analizy — tak, jak składa ją API, ale bez bazy. */
export function dossierOf(
  result: AnalysisResult,
  query: SubjectQuery,
  options: { decisions?: DecisionRecord[]; otherCases?: OtherCase[]; now?: Date } = {},
): DossierView {
  const analysisRun: AnalysisRun = { ...run('run-test', result.findings), query, log: result.log };
  return buildDossier({
    caseSummary: { id: 'sprawa-1', name: 'Sprawa testowa', createdAt: '2026-11-21T08:00:00.000Z', query, runs: [] },
    run: analysisRun,
    intel: result.intel,
    decisions: options.decisions ?? [],
    otherCases: options.otherCases ?? [],
    rules: DEFAULT_RULES,
    now: options.now ?? FIXED_NOW(),
  });
}

export function decision(target: 'profile' | 'address', key: string, value: 'confirmed' | 'rejected', note?: string): DecisionRecord {
  return { id: `d-${target}-${key}-${value}`, caseId: 'sprawa-1', target, key, decision: value, note, decidedAt: '2026-11-21T10:00:00.000Z', author: 'analityk' };
}
