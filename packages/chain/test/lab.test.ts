// Dostawca sieci laboratoryjnej (apps/identity-lab) na atrapie `/api/blockchain`.
// Kształt odpowiedzi zgodny z laboratorium, dane fikcyjne; żadnych połączeń sieciowych.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChainProviders, getActivityFromProviders } from '../src/index.ts';
import { ChainProviderError } from '../src/http.ts';
import { LabChainProvider } from '../src/providers/lab.ts';
import { mockFetch, testContext } from './helpers.ts';

const LAB = 'http://lab.example:8787';
const A = `lab1${'a'.repeat(40)}`;
const B = `lab1${'b'.repeat(40)}`;
const C = `lab1${'c'.repeat(40)}`;
const UNKNOWN = `lab1${'0'.repeat(40)}`;

const chain = {
  network: 'identity-lab-synthetic',
  token: 'LAB',
  wallets: [
    { id: 'wallet-1', address: A, label: 'Portfel LAB 01', publicKey: 'klucz-a', balance: 949 },
    { id: 'wallet-2', address: B, label: 'Portfel LAB 02', publicKey: 'klucz-b', balance: 1040 },
    { id: 'wallet-3', address: C, label: 'Portfel pośrednika LAB', publicKey: 'klucz-c', balance: 1061 },
  ],
  blocks: [
    {
      height: 0,
      timestamp: '2026-10-01T08:00:00.000Z',
      transactions: [{ id: 'genesis', type: 'genesis', inputs: [], outputs: [{ address: A, amount: 1000 }, { address: B, amount: 1000 }, { address: C, amount: 1000 }], fee: 0 }],
    },
    {
      height: 1,
      timestamp: '2026-10-01T08:10:00.000Z',
      transactions: [
        { id: 'coinbase-1', type: 'coinbase', inputs: [], outputs: [{ address: C, amount: 51 }], fee: 0 },
        // A wysyła 60 do B, 939 wraca jako reszta, opłata 1.
        { id: 'tx-1', type: 'transfer', inputs: [{ txId: 'genesis', index: 0, publicKey: 'klucz-a' }], outputs: [{ address: B, amount: 60 }, { address: A, amount: 939 }], fee: 1 },
      ],
    },
    {
      height: 2,
      timestamp: '2026-10-02T09:00:00.000Z',
      transactions: [
        // B wysyła 10 do A i 10 do C jedną transakcją (nadawca rozpoznany po poprzednim wyjściu).
        { id: 'tx-2', type: 'transfer', inputs: [{ txId: 'tx-1', index: 0 }], outputs: [{ address: A, amount: 10 }, { address: C, amount: 10 }, { address: B, amount: 40 }], fee: 0 },
      ],
    },
  ],
  mempool: [{ id: 'oczekujaca' }],
};

const routes = { [`${LAB}/api/blockchain`]: chain };

test('lab: saldo, przelewy między adresami, reszta pominięta, emisja bez pozycji na liście', async () => {
  const mock = mockFetch(routes);
  const provider = new LabChainProvider({ labUrl: `${LAB}/`, fetch: mock.fetch });
  assert.equal(provider.supports('lab'), true);
  assert.equal(provider.supports('bitcoin'), false);

  const activity = await provider.getActivity('lab', A, testContext());
  assert.equal(activity.profile.network, 'lab');
  assert.equal(activity.profile.nativeAsset, 'LAB');
  assert.equal(activity.profile.label, 'Portfel LAB 01');
  assert.equal(activity.profile.balance, 949);
  assert.equal(activity.profile.totalReceived, 1010);
  assert.equal(activity.profile.totalSent, 61);
  assert.equal(activity.profile.txCount, 3);
  assert.deepEqual(
    activity.transfers.map((transfer) => [transfer.txid, transfer.direction, transfer.counterparty, transfer.amount, transfer.asset]),
    [
      ['tx-1', 'out', B, 60, 'LAB'],
      ['tx-2', 'in', B, 10, 'LAB'],
    ],
  );
  assert.equal(activity.transfers[0]!.time, '2026-10-01T08:10:00.000Z');
  assert.match(activity.transfers[0]!.explorerUrl, /^http:\/\/lab\.example:8787\//);
});

test('lab: token bez wartości — brak wyceny w PLN, wskaźników wypłat i ścieżek; ograniczenia mówią o tym wprost', async () => {
  const provider = new LabChainProvider({ labUrl: LAB, fetch: mockFetch(routes).fetch });
  const activity = await provider.getActivity('lab', B, testContext());
  assert.deepEqual(activity.cashOuts, []);
  assert.deepEqual(activity.cashOutPlnByYear, {});
  assert.equal(activity.trails, undefined);
  const limitations = activity.limitations.join(' ');
  assert.match(limitations, /SIEĆ LABORATORYJNA/);
  assert.match(limitations, /Token LAB nie ma wartości/);
  assert.match(limitations, /nie są wyceniane w PLN/);
  assert.match(limitations, /oczekujących jest 1/);
  // B: 1000 z emisji + 60 od A; wysłane 10 + 10, opłata 0.
  assert.equal(activity.profile.totalReceived, 1060);
  assert.equal(activity.profile.totalSent, 20);
  assert.deepEqual(activity.transfers.map((transfer) => [transfer.direction, transfer.counterparty, transfer.amount]), [
    ['in', A, 60],
    ['out', A, 10],
    ['out', C, 10],
  ]);
});

test('lab: etykieta portfela z rejestru trafia do profilu; adres nieznany to błąd „not_found”', async () => {
  const provider = new LabChainProvider({ labUrl: LAB, fetch: mockFetch(routes).fetch });
  const activity = await provider.getActivity('lab', C.toUpperCase(), testContext());
  assert.equal(activity.profile.address, C);
  assert.equal(activity.profile.label, 'Portfel pośrednika LAB');
  assert.match(activity.profile.classificationSource, /sieć laboratoryjna/);
  await assert.rejects(provider.getActivity('lab', UNKNOWN, testContext()), (error) => error instanceof ChainProviderError && error.code === 'not_found');
  await assert.rejects(provider.getActivity('bitcoin', A, testContext()), (error) => error instanceof ChainProviderError);
});

test('lab: łańcuch pobierany raz dla kolejnych adresów; wyłącznie /api/blockchain', async () => {
  const mock = mockFetch(routes);
  const provider = new LabChainProvider({ labUrl: LAB, fetch: mock.fetch });
  await provider.getActivity('lab', A, testContext());
  await provider.getActivity('lab', B, testContext());
  assert.deepEqual(mock.calls, [`${LAB}/api/blockchain`]);
});

test('createChainProviders: dostawca laboratoryjny tylko po podaniu labUrl i tylko dla sieci lab', async () => {
  assert.deepEqual(createChainProviders({}).map((provider) => provider.id), []);
  const mock = mockFetch(routes);
  const providers = createChainProviders({ labUrl: LAB, sandboxUrl: 'http://localhost:4100', fetch: mock.fetch });
  assert.deepEqual(providers.map((provider) => provider.id), ['lab-chain', 'sandbox-explorer']);
  const activity = await getActivityFromProviders(providers, 'lab', A, testContext());
  assert.equal(activity.profile.balance, 949);
  // Adres sieci lab nieznany laboratorium: brak danych, bez wyjątku.
  const missing = await getActivityFromProviders(createChainProviders({ labUrl: LAB, fetch: mock.fetch }), 'lab', UNKNOWN, testContext());
  assert.equal(missing.profile.txCount, 0);
  assert.match(missing.limitations.join(' '), /Brak danych blockchain/);
});
