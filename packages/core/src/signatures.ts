// Weryfikacja podpisanych wiadomości — jedyny publiczny dowód, że ktoś faktycznie
// dysponuje kluczem prywatnym adresu. Wszystko liczone lokalnie, bez sieci:
//   • Bitcoin: „Bitcoin Signed Message" (podpis 65 bajtów w Base64, bajt nagłówka wg BIP-137)
//     dla adresów P2PKH, P2SH-P2WPKH i P2WPKH (bech32),
//   • Ethereum: EIP-191 `personal_sign` (podpis 65 bajtów w zapisie szesnastkowym),
//   • Tron: TIP-191 `signMessageV2` (jak EIP-191, z przedrostkiem „TRON Signed Message").
// Funkcje nigdy nie rzucają wyjątku: błędne dane wejściowe dają `valid: false` z powodem.
// Krzywa secp256k1 pochodzi z biblioteki @noble/curves (MIT), skróty z @noble/hashes (MIT).

import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { decodeAddressPayload } from './addresses.ts';

export interface SignatureCheck {
  valid: boolean;
  /** Zastosowany schemat, np. `bitcoin-message/p2wpkh`, `eip191-personal-sign`. */
  scheme: string;
  /** Dlaczego podpis nie został uznany (tylko gdy `valid` jest `false`). */
  reason?: string;
}

const encoder = new TextEncoder();

const sha256 = (data: Uint8Array): Uint8Array => createHash('sha256').update(data).digest();
const hash160 = (data: Uint8Array): Uint8Array => ripemd160(sha256(data));

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Liczba w zapisie CompactSize (varint Bitcoina). */
function compactSize(value: number): Uint8Array {
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, value >>> 8);
  return Uint8Array.of(0xfe, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** Skrót podpisywany przez portfele Bitcoina: podwójne SHA-256 z przedrostkiem „Bitcoin Signed Message". */
export function bitcoinMessageHash(message: string): Uint8Array {
  const magic = encoder.encode('Bitcoin Signed Message:\n');
  const body = encoder.encode(message);
  return sha256(sha256(concat(compactSize(magic.length), magic, compactSize(body.length), body)));
}

/** Skrót EIP-191 (`personal_sign`): keccak256 z przedrostkiem i długością wiadomości w bajtach. */
export function ethereumMessageHash(message: string): Uint8Array {
  const body = encoder.encode(message);
  return keccak_256(concat(encoder.encode(`\u0019Ethereum Signed Message:\n${body.length}`), body));
}

/** Skrót TIP-191 (`signMessageV2` w TronWeb). */
export function tronMessageHash(message: string): Uint8Array {
  const body = encoder.encode(message);
  return keccak_256(concat(encoder.encode(`\u0019TRON Signed Message:\n${body.length}`), body));
}

function decodeBase64(text: string): Uint8Array | null {
  const compact = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) return null;
  return Uint8Array.from(atob(compact), (char) => char.charCodeAt(0));
}

function decodeHex(text: string): Uint8Array | null {
  const compact = text.trim().replace(/^0x/i, '');
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(compact)) return null;
  return hexToBytes(compact);
}

/** Klucz publiczny odzyskany z podpisu (r‖s, bit odzyskiwania) i skrótu; `null`, gdy podpis jest niepoprawny. */
function recoverPublicKey(compactSignature: Uint8Array, recovery: number, hash: Uint8Array, compressed: boolean): Uint8Array | null {
  try {
    return secp256k1.Signature.fromCompact(compactSignature).addRecoveryBit(recovery).recoverPublicKey(hash).toRawBytes(compressed);
  } catch {
    return null;
  }
}

const BITCOIN_SCHEME = 'bitcoin-message';

/**
 * Sprawdza podpis „Bitcoin Signed Message" (Base64, 65 bajtów). Bajt nagłówka wg BIP-137:
 * 27–30 P2PKH z kluczem nieskompresowanym, 31–34 P2PKH z kluczem skompresowanym,
 * 35–38 P2SH-P2WPKH, 39–42 P2WPKH (bech32). Portfele (np. Electrum) podpisują adresy SegWit także
 * z nagłówkiem 31–34, dlatego o wyniku decyduje zgodność odzyskanego klucza z rodzajem ADRESU.
 * Adresy Taproot i skrypty P2SH inne niż P2SH-P2WPKH wymagają BIP-322 — nieobsługiwane.
 */
export function verifyBitcoinMessage(address: string, message: string, signatureBase64: string): SignatureCheck {
  const fail = (reason: string, scheme = BITCOIN_SCHEME): SignatureCheck => ({ valid: false, scheme, reason });
  try {
    if (typeof address !== 'string' || typeof message !== 'string' || typeof signatureBase64 !== 'string') return fail('niepoprawne dane wejściowe');
    const target = decodeAddressPayload(address.trim());
    if (!target || (target.network !== 'bitcoin' && target.network !== 'bitcoin-testnet')) return fail('to nie jest poprawny adres Bitcoin');
    const signature = decodeBase64(signatureBase64);
    if (!signature || signature.length !== 65) return fail('podpis nie jest 65-bajtowym ciągiem Base64');
    const header = signature[0]!;
    if (header < 27 || header > 42) return fail(`nieznany bajt nagłówka podpisu (${header})`);
    const recovery = (header - 27) & 3;
    const hash = bitcoinMessageHash(message);
    const compact = signature.subarray(1);

    if (target.format === 'p2pkh') {
      const scheme = `${BITCOIN_SCHEME}/p2pkh`;
      // Nagłówek 27–30 oznacza klucz nieskompresowany; każdy inny — skompresowany.
      const key = recoverPublicKey(compact, recovery, hash, header >= 31);
      if (!key) return fail('nie udało się odzyskać klucza publicznego z podpisu', scheme);
      return equalBytes(hash160(key), target.payload) ? { valid: true, scheme } : fail('podpis nie weryfikuje się dla tego adresu', scheme);
    }
    const key = recoverPublicKey(compact, recovery, hash, true);
    if (target.format === 'p2sh') {
      const scheme = `${BITCOIN_SCHEME}/p2sh-p2wpkh`;
      if (!key) return fail('nie udało się odzyskać klucza publicznego z podpisu', scheme);
      const redeemScript = concat(Uint8Array.of(0x00, 0x14), hash160(key));
      return equalBytes(hash160(redeemScript), target.payload)
        ? { valid: true, scheme }
        : fail('podpis nie weryfikuje się dla tego adresu (obsługiwane są tylko adresy P2SH-P2WPKH)', scheme);
    }
    if (target.format === 'bech32' && target.witnessVersion === 0 && target.payload.length === 20) {
      const scheme = `${BITCOIN_SCHEME}/p2wpkh`;
      if (!key) return fail('nie udało się odzyskać klucza publicznego z podpisu', scheme);
      return equalBytes(hash160(key), target.payload) ? { valid: true, scheme } : fail('podpis nie weryfikuje się dla tego adresu', scheme);
    }
    return fail('ten rodzaj adresu (Taproot lub skrypt P2WSH) wymaga podpisu BIP-322 — nieobsługiwany');
  } catch (error) {
    return fail(`błąd weryfikacji: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Wspólna część EIP-191 i TIP-191: 65 bajtów r‖s‖v, v = 27/28 albo 0/1; zwraca 20 bajtów adresu podpisującego. */
function recoverKeccakSigner(hash: Uint8Array, signatureHex: string): { signer?: Uint8Array; reason?: string } {
  const signature = decodeHex(signatureHex);
  if (!signature || signature.length !== 65) return { reason: 'podpis nie jest 65-bajtowym ciągiem szesnastkowym' };
  const v = signature[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return { reason: `nieobsługiwana wartość v podpisu (${v})` };
  const key = recoverPublicKey(signature.subarray(0, 64), recovery, hash, false);
  if (!key) return { reason: 'nie udało się odzyskać klucza publicznego z podpisu' };
  return { signer: keccak_256(key.subarray(1)).subarray(12) };
}

/** Sprawdza podpis EIP-191 (`personal_sign`): odzyskuje adres podpisującego i porównuje bez względu na wielkość liter. */
export function verifyEthereumMessage(address: string, message: string, signatureHex: string): SignatureCheck {
  const scheme = 'eip191-personal-sign';
  const fail = (reason: string): SignatureCheck => ({ valid: false, scheme, reason });
  try {
    if (typeof address !== 'string' || typeof message !== 'string' || typeof signatureHex !== 'string') return fail('niepoprawne dane wejściowe');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) return fail('to nie jest poprawny adres Ethereum');
    const { signer, reason } = recoverKeccakSigner(ethereumMessageHash(message), signatureHex);
    if (!signer) return fail(reason!);
    const recovered = `0x${bytesToHex(signer)}`;
    return recovered === address.trim().toLowerCase() ? { valid: true, scheme } : fail('podpis nie weryfikuje się dla tego adresu');
  } catch (error) {
    return fail(`błąd weryfikacji: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Sprawdza podpis TIP-191 (`signMessageV2`) dla adresu Tron w zapisie Base58 (`T…`). */
export function verifyTronMessage(address: string, message: string, signatureHex: string): SignatureCheck {
  const scheme = 'tip191-sign-message-v2';
  const fail = (reason: string): SignatureCheck => ({ valid: false, scheme, reason });
  try {
    if (typeof address !== 'string' || typeof message !== 'string' || typeof signatureHex !== 'string') return fail('niepoprawne dane wejściowe');
    const target = decodeAddressPayload(address.trim());
    if (!target || target.network !== 'tron') return fail('to nie jest poprawny adres Tron');
    const { signer, reason } = recoverKeccakSigner(tronMessageHash(message), signatureHex);
    if (!signer) return fail(reason!);
    return equalBytes(signer, target.payload) ? { valid: true, scheme } : fail('podpis nie weryfikuje się dla tego adresu');
  } catch (error) {
    return fail(`błąd weryfikacji: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sprawdza podpis wiadomości dla adresu dowolnej obsługiwanej sieci — schemat wynika z adresu.
 * Podpis Bitcoina podaje się w Base64, podpis Ethereum i Tron — szesnastkowo.
 */
export function verifySignedMessage(address: string, message: string, signature: string): SignatureCheck {
  const target = typeof address === 'string' ? decodeAddressPayload(address.trim()) : null;
  if (!target) return { valid: false, scheme: 'nieznany', reason: 'niepoprawny adres albo nieobsługiwana sieć' };
  if (target.network === 'ethereum') return verifyEthereumMessage(address, message, signature);
  if (target.network === 'tron') return verifyTronMessage(address, message, signature);
  return verifyBitcoinMessage(address, message, signature);
}
