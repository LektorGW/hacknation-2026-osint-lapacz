import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateAddress } from '@olcys/core';
import { classify, createLabelSet, getDefaultLabels, inferKind, loadLabelFile } from '../src/labels.ts';

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const PLAIN = '0x52908400098527886E0F7030069857D2E4169EE7';
const empty = createLabelSet([], 'pusty zbiór');

test('wbudowane etykiety mają poprawne adresy (suma kontrolna) i zgodną sieć', () => {
  const { entries } = loadLabelFile(fileURLToPath(new URL('../data/labels.json', import.meta.url)));
  assert.ok(entries.length >= 15);
  for (const entry of entries) {
    const valid = validateAddress(entry.address);
    assert.ok(valid, `niepoprawny adres w zbiorze etykiet: ${entry.address}`);
    assert.equal(valid.network, entry.network, entry.address);
  }
});

test('etykieta ze zbioru wygrywa z danymi źródła i flagą kontraktu', () => {
  const result = classify('ethereum', USDT, { sourceClass: 'exchange', sourceLabel: 'cokolwiek', isContract: true, txCount: 5 });
  assert.equal(result.addressClass, 'smart_contract');
  assert.match(result.label ?? '', /USDT/);
  assert.equal(result.classificationSource, getDefaultLabels().name);
});

test('adres EVM jest wyszukiwany bez względu na wielkość liter', () => {
  assert.equal(classify('ethereum', USDT.toLowerCase()).addressClass, 'smart_contract');
});

test('klasa podana przez źródło wygrywa z flagą kontraktu', () => {
  const result = classify('ethereum', PLAIN, {
    labels: empty,
    sourceClass: 'exchange',
    sourceLabel: 'Kraken: Hot Wallet',
    sourceName: 'Eksplorator',
    isContract: true,
  });
  assert.equal(result.addressClass, 'exchange');
  assert.equal(result.label, 'Kraken: Hot Wallet');
  assert.equal(result.kind, 'exchange_deposit');
  assert.match(result.classificationSource, /Eksplorator/);
});

test('kod pod adresem oznacza smart kontrakt', () => {
  const result = classify('ethereum', PLAIN, { labels: empty, isContract: true, txCount: 10 });
  assert.equal(result.addressClass, 'smart_contract');
  assert.match(result.classificationSource, /kod kontraktu/);
});

test('historia transakcji bez etykiety oznacza adres prywatny', () => {
  assert.equal(classify('ethereum', PLAIN, { labels: empty, isContract: false, txCount: 3 }).addressClass, 'private');
});

test('brak danych oznacza klasę nieznaną', () => {
  const result = classify('ethereum', PLAIN, { labels: empty });
  assert.equal(result.addressClass, 'unknown');
  assert.equal(classify('ethereum', PLAIN, { labels: empty, txCount: 0 }).addressClass, 'unknown');
  assert.match(result.classificationSource, /brak danych/);
});

test('sama nazwa ze źródła: giełda rozpoznana po nazwie, reszta do ręcznej weryfikacji', () => {
  assert.equal(classify('ethereum', PLAIN, { labels: empty, sourceLabel: 'Binance 14', txCount: 9 }).addressClass, 'exchange');
  const other = classify('ethereum', PLAIN, { labels: empty, sourceLabel: 'Fundusz XYZ', txCount: 9 });
  assert.equal(other.addressClass, 'unknown');
  assert.equal(other.label, 'Fundusz XYZ');
});

test('rodzaj usługi wypłaty wynika ze słów kluczowych etykiety', () => {
  assert.equal(inferKind('PayGate: bramka płatnicza', 'institutional'), 'payment_gateway');
  assert.equal(inferKind('LocalSwap P2P', 'institutional'), 'p2p_service');
  assert.equal(inferKind('KryptoKarta: doładowania karty', 'institutional'), 'crypto_card');
  assert.equal(inferKind('Giełda X', 'exchange'), 'exchange_deposit');
  assert.equal(inferKind('Uniswap V2: Router 2', 'smart_contract'), undefined);
});

test('analityk może dopisać własne etykiety; błędny wpis jest odrzucany z opisem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olcys-labels-'));
  const good = join(dir, 'labels.json');
  writeFileSync(
    good,
    JSON.stringify({ name: 'etykiety analityka', labels: [{ network: 'ethereum', address: PLAIN, label: 'Kantor Z', addressClass: 'exchange' }] }),
  );
  const file = loadLabelFile(good);
  const result = classify('ethereum', PLAIN, { labels: createLabelSet(file.entries, file.name) });
  assert.equal(result.addressClass, 'exchange');
  assert.equal(result.classificationSource, 'etykiety analityka');

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ labels: [{ network: 'ethereum', address: PLAIN, label: 'X', addressClass: 'gielda' }] }));
  assert.throws(() => loadLabelFile(bad), /wpis 1: nieznana klasa adresu "gielda"/);
});
