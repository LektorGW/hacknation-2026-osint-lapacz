// Wykrywanie powiązań między sprawami (czysta logika): każdy rodzaj powiązania z właściwym powodem,
// blokada tylko przez sprawy otwarte.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCaseLinks, linkDataOf } from '../src/lifecycle.ts';
import type { CaseLinkData } from '../src/lifecycle.ts';
import type { CaseSummary } from '../src/storage.ts';
import { BTC_A, BTC_B, ETH_A } from './helpers.ts';

const summary = (id: string, status: CaseSummary['status'], identifiers: CaseSummary['query']['identifiers'] = []): CaseSummary => ({
  id,
  name: `Sprawa ${id}`,
  createdAt: '2026-11-01T00:00:00.000Z',
  query: { identifiers },
  runs: [],
  status,
});

const empty = (id: string, status: CaseSummary['status'] = 'open', extra: Partial<CaseLinkData> = {}): CaseLinkData => ({
  ...linkDataOf({ summary: summary(id, status) }),
  ...extra,
});

test('każdy rodzaj powiązania daje właściwy powód', () => {
  const target = empty('a', 'closed', {
    addresses: new Set([BTC_A]),
    counterparties: new Set([BTC_B]),
    identifiers: new Set(['email:jan@poczta.example']),
    profiles: new Set(['github.com|janek']),
    replyRefs: new Set(['gielda-x|gx/1']),
    expansionKeys: new Set(['adres:' + ETH_A.toLowerCase()]),
    relatedCaseIds: new Set(['f']),
  });
  const others = [
    empty('b', 'open', { addresses: new Set([BTC_A]) }),
    empty('c', 'open', { addresses: new Set([BTC_B]) }),
    empty('d', 'open', { identifiers: new Set(['email:jan@poczta.example']), profiles: new Set(['github.com|janek']) }),
    empty('e', 'open', { replyRefs: new Set(['gielda-x|gx/1']) }),
    empty('f', 'open'),
    empty('g', 'open', { addresses: new Set([ETH_A.toLowerCase()]) }),
    empty('h', 'open'),
  ];
  const links = findCaseLinks(target, others);
  const kinds = Object.fromEntries(links.map((link) => [link.caseId, link.reasons.map((reason) => reason.kind).sort()]));
  assert.deepEqual(kinds, {
    b: ['adres'],
    c: ['przelew'],
    d: ['identyfikator', 'profil'],
    e: ['odpowiedz-uslugi'],
    f: ['osoba-powiazana'],
    g: ['rozwiniecie-sieci'],
  });
  assert.ok(links.every((link) => link.blocking));
  assert.ok(!links.some((link) => link.caseId === 'h'), 'sprawa bez wspólnych bytów nie jest powiązana');
});

test('powiązanie z zamkniętą sprawą nie blokuje; rozwinięcie drugiej sprawy działa w obie strony', () => {
  const target = empty('a', 'closed', { addresses: new Set([BTC_A]) });
  const closed = empty('b', 'archived', { addresses: new Set([BTC_A]) });
  const reaching = empty('c', 'open', { expansionKeys: new Set([`adres:${BTC_A}`]) });
  const links = findCaseLinks(target, [closed, reaching]);
  assert.deepEqual(
    links.map((link) => [link.caseId, link.blocking, link.reasons[0]!.kind]),
    [
      ['c', true, 'rozwiniecie-sieci'],
      ['b', false, 'adres'],
    ],
  );
});

test('dane sprawy: adresy EVM bez rozróżniania wielkości liter, wycofane odpowiedzi i rozwinięcia pomijane', () => {
  const data = linkDataOf({
    summary: summary('a', 'open', [
      { type: 'crypto_address', value: ETH_A },
      { type: 'nick', value: '@Janek' },
    ]),
    replies: [
      { id: 'r1', caseId: 'a', serviceName: 'X', serviceId: 'gielda-x', reference: 'GX/1', receivedAt: '', recordedAt: '', recordedBy: 'analityk', payload: { matches: [{ network: 'bitcoin', depositAddress: BTC_B, txids: [] }] } } as never,
      { id: 'r2', caseId: 'a', serviceName: 'Y', serviceId: 'gielda-y', reference: 'GY/1', receivedAt: '', recordedAt: '', recordedBy: 'analityk', payload: {}, withdrawnAt: '2026-11-02T00:00:00.000Z' } as never,
    ],
  });
  assert.ok(data.addresses.has(ETH_A.toLowerCase()));
  assert.ok(data.addresses.has(BTC_B), 'adres depozytowy z odpowiedzi usługi');
  assert.ok(data.identifiers.has('nick:janek'));
  assert.deepEqual([...data.replyRefs], ['gielda-x|gx/1']);
});
