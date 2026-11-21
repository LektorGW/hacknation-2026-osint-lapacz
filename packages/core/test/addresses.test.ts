import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAddresses, validateAddress } from '../src/addresses.ts';

test('rozpoznaje poprawne adresy w każdym obsługiwanym formacie', () => {
  const cases: [string, string, string][] = [
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'bitcoin', 'p2pkh'],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bitcoin', 'p2sh'],
    ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'bitcoin', 'bech32'],
    ['bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 'bitcoin', 'bech32m'],
    ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'bitcoin-testnet', 'bech32'],
    ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'ethereum', 'evm'],
    ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'tron', 'tron-base58'],
  ];
  for (const [address, network, format] of cases) {
    const result = validateAddress(address);
    assert.ok(result, `oczekiwano poprawnego adresu: ${address}`);
    assert.equal(result.network, network);
    assert.equal(result.format, format);
    assert.equal(result.checksumVerified, true);
  }
});

test('odrzuca adresy z błędną sumą kontrolną', () => {
  const invalid = [
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb',
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx',
    '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046'.replace('dA', 'Da'),
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u',
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdQ',
  ];
  for (const address of invalid) {
    assert.equal(validateAddress(address), null, address);
  }
});

test('adres EVM bez sumy kontrolnej jest przyjmowany jako niezweryfikowany', () => {
  const result = validateAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
  assert.ok(result);
  assert.equal(result.checksumVerified, false);
  assert.equal(result.address, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
});

test('wyodrębnia adresy z tekstu, pomija duplikaty i skróty transakcji', () => {
  const text = `
    Sprzedam laptopa, płatność BTC: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa (tylko on-chain).
    Można też ETH 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 albo USDT TRC20.
    Powtarzam adres: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
    tx: 0x4e3a3754410177e6937ef1f84bba68ea139e8d1a2258c5f85db9f1cd715a1bdd
    losowy ciąg: 1BoatSLRHtKNngkdXEeobR76b53LETtpyX9
  `;
  const found = extractAddresses(text);
  assert.deepEqual(
    found.map((item) => item.address),
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
  );
  assert.match(found[0]!.context, /Sprzedam laptopa/);
});
