// Generator fikcyjnych adresów do scenariusza demo.
// Adresy powstają z losowych 20-bajtowych ładunków, więc nikt nie zna do nich
// kluczy — nie należą do żadnej osoby — ale mają poprawne sumy kontrolne
// i przechodzą `validateAddress`. Wynik wkleja się na stałe do data/scenario.ts.
//
// Użycie: node scripts/generate-addresses.ts [liczba_na_format]

import { createHash, randomBytes } from 'node:crypto';
import { toChecksumAddress, validateAddress } from '@olcys/core';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  // Wiodące bajty zerowe zapisuje się jako znaki „1".
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** Base58Check: bajt wersji + ładunek + 4 bajty podwójnego SHA-256. */
function base58Check(version: number, payload: Uint8Array): string {
  const body = Uint8Array.from([version, ...payload]);
  const checksum = sha256(sha256(body)).subarray(0, 4);
  return base58Encode(Uint8Array.from([...body, ...checksum]));
}

function bech32Polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) checksum ^= generators[i]!;
    }
  }
  return checksum >>> 0;
}

/** Adres SegWit v0 (P2WPKH) wg BIP-173. */
function bech32Address(hrp: string, program: Uint8Array): string {
  // Przepakowanie bajtów na grupy 5-bitowe, z dopełnieniem zerami.
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

  const hrpExpanded = [
    ...[...hrp].map((c) => c.charCodeAt(0) >>> 5),
    0,
    ...[...hrp].map((c) => c.charCodeAt(0) & 31),
  ];
  const polymod = bech32Polymod([...hrpExpanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (polymod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((value) => BECH32_CHARSET[value]).join('')}`;
}

const GENERATORS: Record<string, () => string> = {
  'bitcoin-p2pkh': () => base58Check(0x00, randomBytes(20)),
  'bitcoin-p2sh': () => base58Check(0x05, randomBytes(20)),
  'bitcoin-bech32': () => bech32Address('bc', randomBytes(20)),
  ethereum: () => toChecksumAddress(`0x${randomBytes(20).toString('hex')}`),
  tron: () => base58Check(0x41, randomBytes(20)),
};

const count = Number(process.argv[2] ?? 5);
const result: Record<string, string[]> = {};
for (const [format, generate] of Object.entries(GENERATORS)) {
  result[format] = Array.from({ length: count }, () => {
    const address = generate();
    const valid = validateAddress(address);
    if (!valid?.checksumVerified) throw new Error(`Wygenerowano niepoprawny adres (${format}): ${address}`);
    return address;
  });
}
console.log(JSON.stringify(result, null, 2));
