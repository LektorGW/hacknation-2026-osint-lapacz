// Scenariusz pokazowy piaskownicy: wspólny indywidualny adres wpłat giełdy.
// Odpowiedzi w układzie zapisanym z `GET /explorer/api/address/:address`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChainProviders, getActivityFromProviders } from '../src/index.ts';
import type { LinkedAddress } from '../src/links.ts';
import { mockFetch, testContext } from './helpers.ts';

const SANDBOX = 'http://localhost:4100';
const TOMASZ = '0xDA63b310B7B6c5e4A74A1F5AED0A7021B43B08a4';
const EWA = '0x5E0361698A0176E20F4Cb1a30484E43291EC90Db';
const DEPOSIT = '0xEdE699742C11336693768f40Ee09Cc3809c8A8aD';
const HOT = '0xeDCABEaF7845fb6f8d42D634acF7faea4449b5bf';
const FUNDER = '0x24F9036C2ae49E319947434868163172c57392d5';
const api = (address: string) => `${SANDBOX}/explorer/api/address/${address}`;
const toHot = { counterparty: HOT, counterpartyLabel: 'Giełda Bursztyn: Hot Wallet', counterpartyClass: 'exchange' };

const routes = {
  [api(TOMASZ)]: {
    address: TOMASZ, network: 'ethereum', isContract: false, addressClass: 'private',
    transfers: [
      { txid: '0xfund1', time: '2025-03-04T09:00:00Z', asset: 'ETH', amount: 1.3, direction: 'in', counterparty: FUNDER },
      { txid: '0xdep1', time: '2025-03-10T12:00:00Z', asset: 'ETH', amount: 1, direction: 'out', counterparty: DEPOSIT },
      { txid: '0xfund2', time: '2026-01-12T10:00:00Z', asset: 'ETH', amount: 0.6, direction: 'in', counterparty: FUNDER },
      { txid: '0xdep3', time: '2026-02-03T09:10:00Z', asset: 'ETH', amount: 0.5, direction: 'out', counterparty: DEPOSIT },
    ],
  },
  // Adres pośredni: bez etykiety i klasy, sześć transakcji; każdą wpłatę po 22–36 min przekazuje na giełdę.
  [api(DEPOSIT)]: {
    address: DEPOSIT, network: 'ethereum', isContract: false,
    transfers: [
      { txid: '0xdep1', time: '2025-03-10T12:00:00Z', asset: 'ETH', amount: 1, direction: 'in', counterparty: TOMASZ },
      { txid: '0xsweep1', time: '2025-03-10T12:22:00Z', asset: 'ETH', amount: 1, direction: 'out', ...toHot },
      { txid: '0xdep2', time: '2025-05-19T18:05:00Z', asset: 'ETH', amount: 0.8, direction: 'in', counterparty: EWA },
      { txid: '0xsweep2', time: '2025-05-19T18:41:00Z', asset: 'ETH', amount: 0.8, direction: 'out', ...toHot },
      { txid: '0xdep3', time: '2026-02-03T09:10:00Z', asset: 'ETH', amount: 0.5, direction: 'in', counterparty: TOMASZ },
      { txid: '0xsweep3', time: '2026-02-03T09:38:00Z', asset: 'ETH', amount: 0.5, direction: 'out', ...toHot },
    ],
  },
  [api(FUNDER)]: { address: FUNDER, network: 'ethereum', isContract: false, label: 'Giełda Bursztyn: Hot Wallet 2', addressClass: 'exchange', transfers: [] },
  [api(EWA)]: {
    address: EWA, network: 'ethereum', isContract: false, addressClass: 'private',
    transfers: [{ txid: '0xdep2', time: '2025-05-19T18:05:00Z', asset: 'ETH', amount: 0.8, direction: 'out', counterparty: DEPOSIT }],
  },
};

test('piaskownica, tryb standardowy: adres wpłat giełdy daje ścieżkę 2-krokową i powiązanie „współwpłacający”', async () => {
  const mock = mockFetch(routes);
  // Dokładnie tak tworzy dostawców API: sam `sandboxUrl`, bez trybu głębokiego i bez pełnej historii.
  const providers = createChainProviders({ sandboxUrl: SANDBOX, fetch: mock.fetch });
  const activity = await getActivityFromProviders(providers, 'ethereum', TOMASZ, testContext());

  assert.equal(activity.trails?.length, 2);
  for (const trail of activity.trails ?? []) {
    assert.deepEqual(trail.hops.map((hop) => [hop.from, hop.to]), [[TOMASZ, DEPOSIT], [DEPOSIT, HOT]]);
    assert.equal(trail.serviceName, 'Giełda Bursztyn: Hot Wallet');
    assert.equal(trail.serviceKind, 'exchange_deposit');
    assert.equal(trail.confidence, 90);
    assert.equal(trail.hops[1]?.inferred, true);
  }
  assert.match(activity.trails?.[0]?.hops[1]?.reason ?? '', /przekazał środki \(100% otrzymanej kwoty\) do portfela giełdy „Giełda Bursztyn: Hot Wallet” po 0,4 h — prawdopodobny indywidualny adres wpłat/);
  assert.deepEqual(activity.trails?.map((trail) => trail.amount), [1, 0.5]);
  // Wskaźniki wypłat z wyceną (tabela przykładowa — tryb bez sieci), oznaczone jako wnioskowanie.
  assert.deepEqual(activity.cashOuts.map((item) => [item.kind, item.txid, item.counterparty]), [
    ['exchange_deposit', '0xdep1', DEPOSIT],
    ['exchange_deposit', '0xdep3', DEPOSIT],
  ]);
  assert.match(activity.cashOuts[0]?.explanation ?? '', /^WNIOSKOWANIE \(nie ustalony fakt\)/);
  assert.ok((activity.cashOutPlnByYear['2025'] ?? 0) > 0 && (activity.cashOutPlnByYear['2026'] ?? 0) > 0);

  const links = (activity as { linkedAddresses?: LinkedAddress[] }).linkedAddresses ?? [];
  assert.deepEqual(links.map((link) => [link.kind, link.address, link.strength, link.txids]), [['co_depositor', EWA, 80, ['0xdep2']]]);
  assert.match(links[0]?.reason ?? '', /prawdopodobny indywidualny adres wpłat w giełdzie „Giełda Bursztyn: Hot Wallet”/);
  // Pierwsza wpłata przyszła z giełdy — to nie jest powiązanie z osobą.
  assert.ok(!links.some((link) => link.kind === 'funded_by'));
  // Historię adresu pośredniego dostawca ma z zapytania o etykietę kontrahenta: 3 żądania na całą analizę.
  assert.deepEqual(mock.calls.sort(), [api(TOMASZ), api(FUNDER), api(DEPOSIT)].sort());

  // Z perspektywy drugiej osoby powiązanie jest symetryczne.
  const other = await getActivityFromProviders(createChainProviders({ sandboxUrl: SANDBOX, fetch: mockFetch(routes).fetch }), 'ethereum', EWA, testContext());
  assert.equal(other.trails?.length, 1);
  assert.deepEqual((other as { linkedAddresses?: LinkedAddress[] }).linkedAddresses?.map((link) => [link.kind, link.address, link.txids]), [['co_depositor', TOMASZ, ['0xdep1', '0xdep3']]]);
});
