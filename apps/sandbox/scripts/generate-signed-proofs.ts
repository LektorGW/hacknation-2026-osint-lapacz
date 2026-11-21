// Generator danych do scenariuszy „podpisana wiadomość" (data/proofs.ts).
// Tworzy LOSOWĄ parę kluczy wyłącznie w pamięci procesu, wyprowadza z niej fikcyjne adresy
// (Bitcoin P2WPKH i Ethereum), podpisuje podane wiadomości i wypisuje TYLKO adres, wiadomość
// i podpis. Klucz prywatny nie jest nigdzie zapisywany ani wypisywany — po zakończeniu skryptu
// przestaje istnieć, więc adresami nikt nie dysponuje (jak pozostałymi adresami piaskownicy).
// Wynik wkleja się na stałe do data/proofs.ts; poprawność podpisów sprawdzają testy.
//
// Użycie: node scripts/generate-signed-proofs.ts [nick_konta] [serwis]

import { verifyBitcoinMessage, verifyEthereumMessage } from '@olcys/core';
import { createTestWallet, signBitcoinMessage, signEthereumMessage } from '../../../packages/core/test/signing-helpers.ts';

const handle = process.argv[2] ?? 'szpak_nody';
const service = process.argv[3] ?? 'GitPub';
const wallet = createTestWallet();

const btcMessage = `Ja, ${handle} (${service}), potwierdzam, że dysponuję adresem ${wallet.p2wpkh}. Data: 2026-05-20.`;
const btcSignature = signBitcoinMessage(wallet.privateKey, btcMessage, 'p2wpkh');
const ethMessage = `Konto ${handle} w serwisie ${service} należy do właściciela adresu ${wallet.ethereum}. 2026-05-20`;
const ethSignature = signEthereumMessage(wallet.privateKey, ethMessage);

if (!verifyBitcoinMessage(wallet.p2wpkh, btcMessage, btcSignature).valid || !verifyEthereumMessage(wallet.ethereum, ethMessage, ethSignature).valid) {
  throw new Error('Wygenerowany podpis nie przechodzi weryfikacji.');
}

console.log(JSON.stringify({ btcAddress: wallet.p2wpkh, btcMessage, btcSignature, ethAddress: wallet.ethereum, ethMessage, ethSignature }, null, 2));
