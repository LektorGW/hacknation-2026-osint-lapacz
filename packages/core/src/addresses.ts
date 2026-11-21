// Wykrywanie i walidacja adresów kryptowalutowych w tekście.
// Kandydatów znajdują wyrażenia regularne, a o przyjęciu decyduje suma kontrolna —
// dzięki temu przypadkowe ciągi znaków nie trafiają do analizy.

import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';

/**
 * `lab` to sieć LABORATORYJNA (apps/identity-lab): lokalny, syntetyczny łańcuch testowy z tokenem LAB
 * bez wartości. To nie jest prawdziwa sieć — adresy `lab1…` nie istnieją poza laboratorium.
 */
export type Network = 'bitcoin' | 'bitcoin-testnet' | 'ethereum' | 'tron' | 'lab';

/** Identyfikator sieci laboratoryjnej (syntetycznej, bez wartości pieniężnej). */
export const LAB_NETWORK: Network = 'lab';
/** Czy sieć jest laboratoryjna — jej adresy nie są prawdziwe i nigdy nie są wyceniane. */
export const isLabNetwork = (network: Network): boolean => network === LAB_NETWORK;

export type AddressFormat =
  | 'p2pkh'
  | 'p2sh'
  | 'bech32'
  | 'bech32m'
  | 'evm'
  | 'tron-base58'
  /** Adres sieci laboratoryjnej: `lab1` + 40 znaków szesnastkowych (format bez sumy kontrolnej). */
  | 'lab-hex';

export interface DetectedAddress {
  /** Adres w postaci kanonicznej (EVM: z sumą kontrolną EIP-55). */
  address: string;
  /** Adres dokładnie tak, jak wystąpił w tekście. */
  raw: string;
  network: Network;
  format: AddressFormat;
  /**
   * `true`, gdy poprawność potwierdza suma kontrolna. Adres EVM zapisany jedną
   * wielkością liter nie niesie sumy kontrolnej, więc dostaje `false`.
   */
  checksumVerified: boolean;
  /** Pozycja w tekście źródłowym. */
  index: number;
  /** Fragment tekstu wokół adresu, do pokazania analitykowi jako dowód. */
  context: string;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function sha256(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

function base58Decode(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** Zwraca bajt wersji i ładunek, jeśli suma kontrolna Base58Check się zgadza. */
function base58CheckDecode(text: string): { version: number; payload: Uint8Array } | null {
  const bytes = base58Decode(text);
  if (!bytes || bytes.length < 5) return null;
  const body = bytes.subarray(0, bytes.length - 4);
  const checksum = bytes.subarray(bytes.length - 4);
  const expected = sha256(sha256(body)).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) return null;
  }
  return { version: body[0]!, payload: body.subarray(1) };
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

function convertBits(data: number[], from: number, to: number): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxValue = (1 << to) - 1;
  const maxAcc = (1 << (from + to - 1)) - 1;
  for (const value of data) {
    acc = ((acc << from) | value) & maxAcc;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxValue);
    }
  }
  // Dopełnienie musi być zerowe i krótsze niż jedna grupa wejściowa.
  if (bits >= from || ((acc << (to - bits)) & maxValue) !== 0) return null;
  return out;
}

/** Walidacja adresu SegWit (BIP-173 / BIP-350). */
function decodeSegwit(text: string): { hrp: string; format: 'bech32' | 'bech32m' } | null {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return null;
  const lower = text.toLowerCase();
  const separator = lower.lastIndexOf('1');
  if (separator < 1 || separator + 7 > lower.length || lower.length > 90) return null;
  const hrp = lower.slice(0, separator);
  const data: number[] = [];
  for (const char of lower.slice(separator + 1)) {
    const value = BECH32_CHARSET.indexOf(char);
    if (value < 0) return null;
    data.push(value);
  }
  const hrpExpanded = [
    ...[...hrp].map((c) => c.charCodeAt(0) >>> 5),
    0,
    ...[...hrp].map((c) => c.charCodeAt(0) & 31),
  ];
  const polymod = bech32Polymod([...hrpExpanded, ...data]);
  const witnessVersion = data[0]!;
  const program = convertBits(data.slice(1, -6), 5, 8);
  if (!program || program.length < 2 || program.length > 40) return null;
  if (witnessVersion > 16) return null;
  if (witnessVersion === 0) {
    if (polymod !== BECH32_CONST) return null;
    if (program.length !== 20 && program.length !== 32) return null;
    return { hrp, format: 'bech32' };
  }
  if (polymod !== BECH32M_CONST) return null;
  return { hrp, format: 'bech32m' };
}

/** Zapis adresu EVM z sumą kontrolną EIP-55. */
export function toChecksumAddress(address: string): string {
  const hex = address.slice(2).toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(hex));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = i % 2 === 0 ? hash[i >> 1]! >> 4 : hash[i >> 1]! & 0x0f;
    out += nibble >= 8 ? hex[i]!.toUpperCase() : hex[i]!;
  }
  return out;
}

type Validation = Omit<DetectedAddress, 'raw' | 'index' | 'context'>;

/** Adres sieci laboratoryjnej: jednolita wielkość liter, dokładnie 40 znaków hex po przedrostku `lab1`. */
const LAB_ADDRESS = /^(?:lab1[0-9a-f]{40}|LAB1[0-9A-F]{40})$/;

/** Sprawdza pojedynczy ciąg znaków. Zwraca `null`, gdy nie jest poprawnym adresem. */
export function validateAddress(candidate: string): Validation | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(candidate)) {
    const body = candidate.slice(2);
    const singleCase = body === body.toLowerCase() || body === body.toUpperCase();
    const canonical = toChecksumAddress(candidate);
    if (!singleCase && canonical !== candidate) return null;
    return {
      address: canonical,
      network: 'ethereum',
      format: 'evm',
      checksumVerified: !singleCase,
    };
  }

  // Sieć laboratoryjna (apps/identity-lab), nie prawdziwa: `lab1` + 40 znaków hex. Format nie ma
  // sumy kontrolnej, więc sprawdzamy sam kształt; zapis kanoniczny to małe litery.
  if (/^lab1/i.test(candidate)) {
    if (!LAB_ADDRESS.test(candidate)) return null;
    return { address: candidate.toLowerCase(), network: 'lab', format: 'lab-hex', checksumVerified: false };
  }

  if (/^(bc|tb)1/i.test(candidate)) {
    const decoded = decodeSegwit(candidate);
    if (!decoded || (decoded.hrp !== 'bc' && decoded.hrp !== 'tb')) return null;
    return {
      address: candidate.toLowerCase(),
      network: decoded.hrp === 'bc' ? 'bitcoin' : 'bitcoin-testnet',
      format: decoded.format,
      checksumVerified: true,
    };
  }

  const decoded = base58CheckDecode(candidate);
  if (!decoded || decoded.payload.length !== 20) return null;
  const byVersion: Record<number, { network: Network; format: AddressFormat }> = {
    0x00: { network: 'bitcoin', format: 'p2pkh' },
    0x05: { network: 'bitcoin', format: 'p2sh' },
    0x6f: { network: 'bitcoin-testnet', format: 'p2pkh' },
    0xc4: { network: 'bitcoin-testnet', format: 'p2sh' },
    0x41: { network: 'tron', format: 'tron-base58' },
  };
  const kind = byVersion[decoded.version];
  if (!kind) return null;
  return { address: candidate, ...kind, checksumVerified: true };
}

// Granice (?<![...]) / (?![...]) chronią przed wycinaniem adresu ze środka
// dłuższego ciągu, np. skrótu transakcji.
const CANDIDATE_PATTERNS: RegExp[] = [
  /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g,
  /(?<![0-9a-zA-Z])(?:bc|tb|BC|TB)1[0-9a-zA-Z]{11,87}(?![0-9a-zA-Z])/g,
  /(?<![0-9a-zA-Z])[1-9A-HJ-NP-Za-km-z]{26,35}(?![0-9a-zA-Z])/g,
  // Sieć laboratoryjna (syntetyczna): lab1 + 40 znaków hex.
  /(?<![0-9a-zA-Z])(?:lab1[0-9a-f]{40}|LAB1[0-9A-F]{40})(?![0-9a-zA-Z])/g,
];

const CONTEXT_RADIUS = 120;

/**
 * Wyszukuje w tekście wszystkie poprawne adresy. Ten sam adres w kilku miejscach
 * jest zwracany raz, z pozycją pierwszego wystąpienia.
 */
export function extractAddresses(text: string): DetectedAddress[] {
  const found = new Map<string, DetectedAddress>();
  for (const pattern of CANDIDATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      const valid = validateAddress(raw);
      if (!valid) continue;
      const key = `${valid.network}:${valid.address}`;
      const index = match.index;
      const existing = found.get(key);
      if (existing && existing.index <= index) continue;
      const start = Math.max(0, index - CONTEXT_RADIUS);
      const end = Math.min(text.length, index + raw.length + CONTEXT_RADIUS);
      found.set(key, {
        ...valid,
        raw,
        index,
        context: text.slice(start, end).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

/** Skrót, na który wskazuje adres — do porównania z kluczem publicznym odzyskanym z podpisu wiadomości. */
export interface AddressPayload {
  network: Network;
  format: AddressFormat;
  /** P2PKH/P2SH/Tron: 20 bajtów HASH160 (Tron: Keccak); SegWit: program świadka; EVM: 20 bajtów adresu. */
  payload: Uint8Array;
  /** Wersja programu świadka (tylko SegWit). */
  witnessVersion?: number;
}

/** Rozkłada poprawny adres na sieć, format i surowy skrót; `null`, gdy adres jest niepoprawny albo laboratoryjny. */
export function decodeAddressPayload(candidate: string): AddressPayload | null {
  const valid = validateAddress(candidate);
  if (!valid || valid.format === 'lab-hex') return null;
  if (valid.format === 'evm') {
    const hex = candidate.slice(2);
    return { network: valid.network, format: valid.format, payload: Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16))) };
  }
  if (valid.format === 'bech32' || valid.format === 'bech32m') {
    const lower = candidate.toLowerCase();
    const data = [...lower.slice(lower.lastIndexOf('1') + 1)].map((char) => BECH32_CHARSET.indexOf(char));
    const program = convertBits(data.slice(1, -6), 5, 8);
    if (!program) return null;
    return { network: valid.network, format: valid.format, payload: Uint8Array.from(program), witnessVersion: data[0]! };
  }
  const decoded = base58CheckDecode(candidate);
  return decoded ? { network: valid.network, format: valid.format, payload: decoded.payload } : null;
}
