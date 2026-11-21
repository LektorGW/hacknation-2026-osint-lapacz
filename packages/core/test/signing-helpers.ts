// Pomocnicze PODPISYWANIE wiadomości — wyłącznie dla testów i dla skryptu generującego
// dane piaskownicy (apps/sandbox/scripts/generate-signed-proofs.ts). Kod produkcyjny
// niczego nie podpisuje: @olcys/core eksportuje tylko weryfikację.

import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { keccak_256 } from '@noble/hashes/sha3';
import { bitcoinMessageHash, ethereumMessageHash, toChecksumAddress, tronMessageHash } from '../src/index.ts';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const sha256 = (data: Uint8Array): Uint8Array => createHash('sha256').update(data).digest();
const hash160 = (data: Uint8Array): Uint8Array => ripemd160(sha256(data));

function base58Check(version: number, payload: Uint8Array): string {
  const body = Uint8Array.from([version, ...payload]);
  const bytes = Uint8Array.from([...body, ...sha256(sha256(body)).subarray(0, 4)]);
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

function bech32Polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) checksum ^= generators[i]!;
  }
  return checksum >>> 0;
}

/** Adres SegWit v0 (P2WPKH) wg BIP-173. */
function bech32Address(hrp: string, program: Uint8Array): string {
  const data: number[] = [0];
  let acc = 0;
  let bits = 0;
  for (const byte of program) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) data.push((acc << (5 - bits)) & 31);
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const polymod = bech32Polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (polymod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((value) => BECH32_CHARSET[value]).join('')}`;
}

export interface TestWallet {
  privateKey: Uint8Array;
  p2pkh: string;
  p2pkhUncompressed: string;
  p2shP2wpkh: string;
  p2wpkh: string;
  ethereum: string;
  tron: string;
}

/** Portfel testowy: z podanego klucza albo z losowego (klucz istnieje tylko w pamięci procesu). */
export function createTestWallet(privateKey: Uint8Array = secp256k1.utils.randomPrivateKey()): TestWallet {
  const compressed = secp256k1.getPublicKey(privateKey, true);
  const uncompressed = secp256k1.getPublicKey(privateKey, false);
  const keccakTail = keccak_256(uncompressed.subarray(1)).subarray(12);
  return {
    privateKey,
    p2pkh: base58Check(0x00, hash160(compressed)),
    p2pkhUncompressed: base58Check(0x00, hash160(uncompressed)),
    p2shP2wpkh: base58Check(0x05, hash160(Uint8Array.from([0x00, 0x14, ...hash160(compressed)]))),
    p2wpkh: bech32Address('bc', hash160(compressed)),
    ethereum: toChecksumAddress(`0x${Buffer.from(keccakTail).toString('hex')}`),
    tron: base58Check(0x41, keccakTail),
  };
}

export type BitcoinAddressKind = 'p2pkh-uncompressed' | 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';

/** Pierwszy bajt nagłówka wg BIP-137 dla danego rodzaju adresu. */
const HEADER_BASE: Record<BitcoinAddressKind, number> = { 'p2pkh-uncompressed': 27, p2pkh: 31, 'p2sh-p2wpkh': 35, p2wpkh: 39 };

/** Podpis „Bitcoin Signed Message" w Base64; `headerBase` pozwala wymusić nagłówek (np. 31 w stylu Electrum dla SegWit). */
export function signBitcoinMessage(privateKey: Uint8Array, message: string, kind: BitcoinAddressKind, headerBase = HEADER_BASE[kind]): string {
  const signature = secp256k1.sign(bitcoinMessageHash(message), privateKey);
  return Buffer.from(Uint8Array.from([headerBase + signature.recovery, ...signature.toCompactRawBytes()])).toString('base64');
}

function signKeccak(privateKey: Uint8Array, hash: Uint8Array): string {
  const signature = secp256k1.sign(hash, privateKey);
  return `0x${Buffer.from(Uint8Array.from([...signature.toCompactRawBytes(), 27 + signature.recovery])).toString('hex')}`;
}

/** Podpis EIP-191 (`personal_sign`) w zapisie szesnastkowym. */
export const signEthereumMessage = (privateKey: Uint8Array, message: string): string => signKeccak(privateKey, ethereumMessageHash(message));

/** Podpis TIP-191 (`signMessageV2`) w zapisie szesnastkowym. */
export const signTronMessage = (privateKey: Uint8Array, message: string): string => signKeccak(privateKey, tronMessageHash(message));
