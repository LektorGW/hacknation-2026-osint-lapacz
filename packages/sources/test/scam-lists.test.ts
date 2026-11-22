// Zbiory ostrzeżeń o oszustwach (migawki lokalne, bez sieci): adresy MEW darklist i domeny MetaMask.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDefaultScamLists, loadScamLists, scamListAddressFlags, scamListDomainFlags } from '../src/scam/index.ts';

const lists = loadScamLists({
  addresses: { list: 'mew-darklist', retrievedAt: '2026-11-22T00:00:00.000Z', sourceUrl: 'https://example.invalid', entries: [{ address: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', comment: 'Fake giveaway', date: '2020-01-01' }] },
  domains: { list: 'metamask-phishing', retrievedAt: '2026-11-22T00:00:00.000Z', sourceUrl: 'https://example.invalid', blacklist: ['falszywa-gielda.example', 'phish.example'], whitelist: ['dobra.phish.example'] },
});

test('trafienie adresu w zbiorze ostrzeżeń: bez rozróżniania wielkości liter, fakt o liście z zastrzeżeniem', () => {
  const flags = scamListAddressFlags(['0xabcdef0123456789abcdef0123456789abcdef01', '0x0000000000000000000000000000000000000001', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'], lists);
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.status, 'source_fact');
  assert.equal(flags[0]!.comment, 'Fake giveaway');
  assert.match(flags[0]!.caveat, /nie wskazanie właściciela/);
});

test('domena phishingowa: ta sama domena albo nadrzędna, lista dozwolonych ma pierwszeństwo', () => {
  const flags = scamListDomainFlags(['https://www.falszywa-gielda.example/login', 'sub.phish.example', 'dobra.phish.example', 'https://zwykla.example/'], lists);
  assert.deepEqual(
    flags.map((item) => [item.domain, item.matched]),
    [
      ['falszywa-gielda.example', 'falszywa-gielda.example'],
      ['sub.phish.example', 'phish.example'],
    ],
  );
});

test('migawki w repozytorium wczytują się i mają wpisy', () => {
  const real = getDefaultScamLists();
  assert.deepEqual(real.missing, []);
  assert.ok(real.addresses.size > 500);
  assert.ok(real.blacklist.size > 10000);
});
