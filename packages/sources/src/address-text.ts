// Rozpoznawanie adresów w nietypowych zapisach — przygotowanie tekstu przed
// `extractAddresses` z @olcys/core: adresy rozbite odstępami lub znakami podziału
// wiersza, encje HTML, odnośniki płatności (`bitcoin:`, `ethereum:`, `tron:`),
// odnośniki do eksploratorów bloków oraz nazwy ENS w treści.
// Każdy kandydat przechodzi `validateAddress` (suma kontrolna), więc sklejenie
// przypadkowych słów w „adres" jest praktycznie niemożliwe.

import { extractAddresses, validateAddress } from '@olcys/core';

/** Eksploratory bloków, których odnośnik `…/address/<adres>` wskazuje konkretny adres. */
const EXPLORER_HOSTS = [
  'etherscan.io',
  'blockchair.com',
  'tronscan.org',
  'tronscan.io',
  'mempool.space',
  'blockstream.info',
  'blockchain.com',
  'blockchain.info',
  'btcscan.org',
  'ethplorer.io',
  'blockscout.com',
  'walletexplorer.com',
  'oklink.com',
  'bitinfocharts.com',
  'blockcypher.com',
];

const PAYMENT_URI = /^(?:bitcoin|ethereum|tron|btc|eth|trx|usdt):(?:\/\/)?([A-Za-z0-9]{25,90})/i;
const ADDRESS_SEGMENT = /(?:\/|#\/|=)(?:address|addresses|addr|account)\/(?:[a-z]{2,10}\/)?([A-Za-z0-9]{25,90})(?![A-Za-z0-9])/i;

/** Adres wskazany przez odnośnik płatności albo odnośnik do eksploratora bloków; `null`, gdy to zwykły odnośnik. */
export function addressFromHref(href: string): string | null {
  const value = href.trim().replace(/&amp;/g, '&');
  const payment = PAYMENT_URI.exec(value);
  if (payment) return validateAddress(payment[1]!)?.address ?? null;
  if (!/^https?:\/\//i.test(value)) return null;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!EXPLORER_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) return null;
  const segment = ADDRESS_SEGMENT.exec(value);
  return segment ? validateAddress(segment[1]!)?.address ?? null : null;
}

const INVISIBLE = /[­​-‍⁠﻿]/g;

function decodeNumericEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(?:nbsp|thinsp|ensp|emsp);/g, ' ')
    .replace(/&(?:shy|zwnj|zwj);/g, '');
}

/** Początek adresu którejś z obsługiwanych sieci — od takiego fragmentu próbujemy sklejać. */
const ADDRESS_START = /^(?:0x[0-9a-fA-F]{2,}|(?:bc|tb)1[0-9a-z]{2,}|[13][1-9A-HJ-NP-Za-km-z]{3,}|T[1-9A-HJ-NP-Za-km-z]{3,})$/;
const ADDRESS_PIECE = /^[0-9A-Za-z]{1,60}$/;
const MAX_PIECES = 12;
const MAX_LENGTH = 90;

/** Skleja adresy rozbite odstępami lub łamaniem wiersza („bc1q xhvk 23us …"), o ile wynik ma poprawną sumę kontrolną. */
function joinSplitAddresses(text: string): string {
  // Dzielimy z zachowaniem odstępów, żeby reszta tekstu wróciła w niezmienionej postaci.
  const parts = text.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    // Znaki interpunkcyjne przyklejone do końców (nawias, przecinek) nie należą do adresu.
    const lead = /^[("'„«[]*/.exec(token)![0];
    const first = token.slice(lead.length);
    if (i % 2 === 1 || !ADDRESS_START.test(first) || validateAddress(first)) {
      out.push(token);
      continue;
    }
    let joined = first;
    let merged = -1;
    let tail = '';
    for (let j = i + 2, pieces = 1; j < parts.length && pieces < MAX_PIECES; j += 2, pieces++) {
      // Sklejamy tylko przez pojedynczy odstęp albo jedno łamanie wiersza — nie przez pusty wiersz.
      if (/\n\s*\n/.test(parts[j - 1]!)) break;
      const trailing = /[)\]"'”».,;:!?]*$/.exec(parts[j]!)![0];
      const piece = parts[j]!.slice(0, parts[j]!.length - trailing.length);
      if (!ADDRESS_PIECE.test(piece) || joined.length + piece.length > MAX_LENGTH) break;
      joined += piece;
      if (validateAddress(joined)) {
        merged = j;
        tail = trailing;
        break;
      }
      if (trailing) break;
    }
    if (merged < 0) {
      out.push(token);
      continue;
    }
    out.push(`${lead}${joined}${tail}`);
    i = merged;
  }
  return out.join('');
}

/**
 * Tekst przygotowany do `extractAddresses`: bez znaków niewidocznych, z rozwiniętymi encjami,
 * ze sklejonymi adresami rozbitymi odstępami oraz z dopisanymi adresami z odnośników płatności
 * i odnośników do eksploratorów bloków (gdy sam adres nie występuje w tekście w czytelnej postaci).
 */
export function normalizeAddressText(text: string): string {
  let normalized = joinSplitAddresses(decodeNumericEntities(text).replace(INVISIBLE, ''));
  const known = new Set(extractAddresses(normalized).map((found) => found.address));
  const extra: string[] = [];
  for (const match of normalized.matchAll(/(?:https?:\/\/|\b(?:bitcoin|ethereum|tron|btc|eth|trx|usdt):)[^\s<>"')\]]+/gi)) {
    const address = addressFromHref(match[0]);
    if (address && !known.has(address)) {
      known.add(address);
      extra.push(address);
    }
  }
  if (extra.length > 0) normalized += `\n${extra.map((address) => `[adres z odnośnika: ${address}]`).join('\n')}`;
  return normalized;
}

const ENS_NAME = /(?<![A-Za-z0-9@._/-])((?:[a-z0-9][a-z0-9-]{1,40}\.){0,2}[a-z0-9][a-z0-9-]{2,40}\.eth)(?![A-Za-z0-9-]|\.[a-z])/gi;

/** Nazwy ENS (`*.eth`) wymienione w treści — bez powtórzeń, małymi literami. */
export function findEnsNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(ENS_NAME)) names.add(match[1]!.toLowerCase());
  return [...names];
}
