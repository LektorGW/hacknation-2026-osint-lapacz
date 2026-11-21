// Weryfikacja podpisanych wiadomości: wektory opublikowane (niezależne od naszego kodu)
// oraz pary kluczy generowane w teście i podpisywane tą samą biblioteką krzywej.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeAddressPayload, validateAddress, verifyBitcoinMessage, verifyEthereumMessage, verifySignedMessage, verifyTronMessage } from '../src/index.ts';
import { createTestWallet, signBitcoinMessage, signEthereumMessage, signTronMessage } from './signing-helpers.ts';

describe('wektory opublikowane', () => {
  // README biblioteki bitcoinjs-message (https://github.com/bitcoinjs/bitcoinjs-message).
  test('Bitcoin P2PKH — przykład z dokumentacji bitcoinjs-message', () => {
    const address = '1HZwkjkeaoZfTSaJxDw6aKkxp45agDiEzN';
    const message = 'This is an example of a signed message.';
    const signature = 'HJLQlDWLyb1Ef8bQKEISzFbDAKctIlaqOpGbrk3YVtRsjmC61lpE5ErkPRUFtDKtx98vHFGUWlFhsh3DiW6N0rE=';
    assert.deepEqual(verifyBitcoinMessage(address, message, signature), { valid: true, scheme: 'bitcoin-message/p2pkh' });
    assert.equal(verifyBitcoinMessage(address, `${message} `, signature).valid, false);
  });

  // Testy jednostkowe Bitcoin Core (src/test/util_tests.cpp, przypadek message_verify).
  test('Bitcoin P2PKH — wektory z testów Bitcoin Core', () => {
    assert.equal(
      verifyBitcoinMessage('15CRxFdyRpGZLW9w8HnHvVduizdL5jKNbs', 'Trust no one', 'IPojfrX2dfPnH26UegfbGQQLrdK844DlHq5157/P6h57WyuS/Qsl+h/WSVGDF4MUi4rWSswW38oimDYfNNUBUOk=').valid,
      true,
    );
    assert.equal(
      verifyBitcoinMessage('11canuhp9X2NocwCq7xNrQYTmUgZAnLK3', 'Trust me', 'IIcaIENoYW5jZWxsb3Igb24gYnJpbmsgb2Ygc2Vjb25kIGJhaWxvdXQgZm9yIGJhbmtzIAaHRtbCeDZINyavx14=').valid,
      true,
    );
    // Ten sam podpis dla innej wiadomości albo innego adresu nie przechodzi.
    assert.equal(
      verifyBitcoinMessage('15CRxFdyRpGZLW9w8HnHvVduizdL5jKNbs', 'Trust me', 'IPojfrX2dfPnH26UegfbGQQLrdK844DlHq5157/P6h57WyuS/Qsl+h/WSVGDF4MUi4rWSswW38oimDYfNNUBUOk=').valid,
      false,
    );
  });

  // Dokumentacja web3.js, `web3.eth.accounts.sign('Some data', …)`.
  test('Ethereum EIP-191 — przykład z dokumentacji web3.js', () => {
    const address = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
    const signature =
      '0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c';
    assert.deepEqual(verifyEthereumMessage(address, 'Some data', signature), { valid: true, scheme: 'eip191-personal-sign' });
    assert.equal(verifyEthereumMessage(address.toLowerCase(), 'Some data', signature).valid, true);
    assert.equal(verifyEthereumMessage(address, 'Some other data', signature).valid, false);
  });
});

describe('pary kluczy generowane w teście', () => {
  const wallet = createTestWallet();
  const other = createTestWallet();
  const message = 'Ja, tester_olcys, potwierdzam, że dysponuję tym adresem. Zażółć gęślą jaźń — 2026-11-21';

  test('adresy portfela testowego mają poprawne sumy kontrolne', () => {
    for (const address of [wallet.p2pkh, wallet.p2pkhUncompressed, wallet.p2shP2wpkh, wallet.p2wpkh, wallet.ethereum, wallet.tron]) {
      assert.ok(validateAddress(address)?.checksumVerified, address);
      assert.ok(decodeAddressPayload(address), address);
    }
  });

  test('Bitcoin: P2PKH (klucz skompresowany i nieskompresowany), P2SH-P2WPKH, P2WPKH wg BIP-137', () => {
    const cases = [
      { address: wallet.p2pkhUncompressed, kind: 'p2pkh-uncompressed', scheme: 'bitcoin-message/p2pkh' },
      { address: wallet.p2pkh, kind: 'p2pkh', scheme: 'bitcoin-message/p2pkh' },
      { address: wallet.p2shP2wpkh, kind: 'p2sh-p2wpkh', scheme: 'bitcoin-message/p2sh-p2wpkh' },
      { address: wallet.p2wpkh, kind: 'p2wpkh', scheme: 'bitcoin-message/p2wpkh' },
    ] as const;
    for (const item of cases) {
      const signature = signBitcoinMessage(wallet.privateKey, message, item.kind);
      assert.deepEqual(verifyBitcoinMessage(item.address, message, signature), { valid: true, scheme: item.scheme }, item.kind);
      // Podpis innego klucza i zmieniona wiadomość są odrzucane.
      const foreign = verifyBitcoinMessage(item.address, message, signBitcoinMessage(other.privateKey, message, item.kind));
      assert.equal(foreign.valid, false, item.kind);
      assert.match(foreign.reason!, /nie weryfikuje się dla tego adresu/);
      assert.equal(verifyBitcoinMessage(item.address, `${message}!`, signature).valid, false, item.kind);
    }
  });

  test('Bitcoin: adres SegWit z nagłówkiem w stylu Electrum (31–34) też jest rozpoznawany', () => {
    assert.equal(verifyBitcoinMessage(wallet.p2wpkh, message, signBitcoinMessage(wallet.privateKey, message, 'p2wpkh', 31)).valid, true);
    assert.equal(verifyBitcoinMessage(wallet.p2shP2wpkh, message, signBitcoinMessage(wallet.privateKey, message, 'p2sh-p2wpkh', 31)).valid, true);
  });

  test('Bitcoin: podpis dla jednego rodzaju adresu nie przechodzi dla adresu innego portfela', () => {
    const signature = signBitcoinMessage(wallet.privateKey, message, 'p2wpkh');
    assert.equal(verifyBitcoinMessage(other.p2wpkh, message, signature).valid, false);
    assert.equal(verifyBitcoinMessage(other.p2pkh, message, signature).valid, false);
  });

  test('Ethereum: EIP-191 dla wiadomości ze znakami spoza ASCII; v = 27/28 oraz 0/1', () => {
    const signature = signEthereumMessage(wallet.privateKey, message);
    assert.equal(verifyEthereumMessage(wallet.ethereum, message, signature).valid, true);
    assert.equal(verifyEthereumMessage(wallet.ethereum.toUpperCase().replace('0X', '0x'), message, signature).valid, true);
    const v = parseInt(signature.slice(-2), 16) - 27;
    assert.equal(verifyEthereumMessage(wallet.ethereum, message, `${signature.slice(0, -2)}0${v}`).valid, true);
    assert.equal(verifyEthereumMessage(other.ethereum, message, signature).valid, false);
    assert.equal(verifyEthereumMessage(wallet.ethereum, message.toUpperCase(), signature).valid, false);
  });

  test('Tron: TIP-191 (signMessageV2)', () => {
    const signature = signTronMessage(wallet.privateKey, message);
    assert.deepEqual(verifyTronMessage(wallet.tron, message, signature), { valid: true, scheme: 'tip191-sign-message-v2' });
    assert.equal(verifyTronMessage(other.tron, message, signature).valid, false);
    // Podpis Ethereum tej samej wiadomości ma inny przedrostek — dla adresu Tron nie przechodzi.
    assert.equal(verifyTronMessage(wallet.tron, message, signEthereumMessage(wallet.privateKey, message)).valid, false);
  });

  test('verifySignedMessage dobiera schemat po adresie', () => {
    assert.equal(verifySignedMessage(wallet.p2wpkh, message, signBitcoinMessage(wallet.privateKey, message, 'p2wpkh')).scheme, 'bitcoin-message/p2wpkh');
    assert.equal(verifySignedMessage(wallet.ethereum, message, signEthereumMessage(wallet.privateKey, message)).valid, true);
    assert.equal(verifySignedMessage(wallet.tron, message, signTronMessage(wallet.privateKey, message)).valid, true);
    assert.equal(verifySignedMessage('to nie adres', message, 'AAAA').valid, false);
  });
});

describe('błędne dane wejściowe nie powodują wyjątku', () => {
  const wallet = createTestWallet();
  const good = signBitcoinMessage(wallet.privateKey, 'x', 'p2pkh');

  test('Bitcoin', () => {
    const bad: [string, string, string][] = [
      ['', 'x', good],
      ['nie-adres', 'x', good],
      [wallet.ethereum, 'x', good],
      [wallet.p2pkh, 'x', ''],
      [wallet.p2pkh, 'x', 'to nie jest base64 !!!'],
      [wallet.p2pkh, 'x', 'AAAA'],
      [wallet.p2pkh, 'x', Buffer.alloc(65).toString('base64')],
      [wallet.p2pkh, 'x', Buffer.alloc(65, 0xff).toString('base64')],
      // Taproot: poprawny adres, ale schemat nieobsługiwany.
      ['bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 'x', good],
    ];
    for (const [address, message, signature] of bad) {
      const result = verifyBitcoinMessage(address, message, signature);
      assert.equal(result.valid, false, `${address} | ${signature}`);
      assert.ok(result.reason, 'powód odrzucenia');
    }
    assert.equal(verifyBitcoinMessage(undefined as unknown as string, null as unknown as string, 5 as unknown as string).valid, false);
  });

  test('Ethereum i Tron', () => {
    for (const signature of ['', '0x', '0x1234', 'zzzz', `0x${'00'.repeat(65)}`, `0x${'ff'.repeat(65)}`, `0x${'11'.repeat(64)}63`]) {
      assert.equal(verifyEthereumMessage(wallet.ethereum, 'x', signature).valid, false, signature);
      assert.equal(verifyTronMessage(wallet.tron, 'x', signature).valid, false, signature);
    }
    assert.equal(verifyEthereumMessage('0x1234', 'x', signEthereumMessage(wallet.privateKey, 'x')).valid, false);
    assert.equal(verifyTronMessage(wallet.p2pkh, 'x', signTronMessage(wallet.privateKey, 'x')).valid, false);
  });
});
