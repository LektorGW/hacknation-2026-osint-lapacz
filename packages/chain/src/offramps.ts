// Usługi wyjścia do walut tradycyjnych (off-ramp) rozpoznawane po NAZWIE.
// Lista jest jawna i edytowalna: `data/fiat-offramps.json`. Nie zawiera adresów — adres usługi
// oznacza się wyłącznie w zbiorze etykiet (`data/labels.json`) z publicznym źródłem wymieniającym
// dokładny adres. Rozpoznanie nazwy w treści albo etykiecie jest poszlaką, nie ustaleniem.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OfframpKind } from '@olcys/core';

export interface OfframpService {
  name: string;
  kind: OfframpKind;
  keywords: string[];
  /** Dokładne nazwy podmiotów w migawkach rejestrów (RDWW — IAS Katowice, CASP — ESMA). */
  registry?: { rdww?: string[]; casp?: string[] };
  /** Nazwa liczy się tylko w zdaniu o kryptowalutach (marki płatności ogólnego przeznaczenia). */
  cryptoContext?: boolean;
}

export interface OfframpMatch {
  service: OfframpService;
  /** Dopasowane słowo w postaci z treści. */
  keyword: string;
  /** Położenie dopasowania w tekście znormalizowanym (ta sama długość co oryginał). */
  index: number;
}

export const OFFRAMP_KINDS: OfframpKind[] = ['exchange_with_pln', 'crypto_atm_operator', 'crypto_card_issuer', 'payment_gateway', 'p2p_escrow'];

/** Nazwy rodzajów usług po polsku — jedno miejsce dla API i raportu. */
export const OFFRAMP_KIND_LABEL: Record<OfframpKind, string> = {
  exchange_with_pln: 'giełda lub kantor z wypłatą w walucie tradycyjnej',
  crypto_atm_operator: 'operator bitomatów (wypłata gotówki)',
  crypto_card_issuer: 'wydawca karty zasilanej kryptowalutami',
  payment_gateway: 'bramka płatnicza',
  p2p_escrow: 'platforma wymiany bezpośredniej (P2P)',
};

/**
 * Tekst do porównań: małe litery, bez znaków diakrytycznych (ł → l). Długość tekstu się nie zmienia,
 * więc położenie dopasowania wskazuje to samo miejsce w oryginale.
 */
export function foldText(text: string): string {
  return [...text]
    .map((char) => {
      const lower = char.toLowerCase();
      if (lower === 'ł') return 'l';
      const folded = lower.normalize('NFD').replace(/[̀-ͯ]/g, '');
      return folded.length === 1 ? folded : lower.length === 1 ? lower : char;
    })
    .join('');
}

interface Compiled extends OfframpService {
  pattern: RegExp;
}

let compiled: Compiled[] | undefined;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function loadOfframpServices(path = fileURLToPath(new URL('../data/fiat-offramps.json', import.meta.url))): OfframpService[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { services?: Partial<OfframpService>[] };
  return (parsed.services ?? []).map((raw, index) => {
    const where = `Plik usług wyjścia do fiat ${path}, wpis ${index + 1}`;
    if (typeof raw.name !== 'string' || raw.name === '') throw new Error(`${where}: brak pola "name".`);
    if (!OFFRAMP_KINDS.includes(raw.kind as OfframpKind)) throw new Error(`${where}: nieznany rodzaj "${raw.kind}".`);
    if (!Array.isArray(raw.keywords) || raw.keywords.length === 0) throw new Error(`${where}: brak słów kluczowych.`);
    return raw as OfframpService;
  });
}

function getCompiled(): Compiled[] {
  if (compiled) return compiled;
  compiled = loadOfframpServices().map((service) => {
    // Dłuższe słowa najpierw: „binance p2p” ma pierwszeństwo przed „binance”.
    const words = [...service.keywords].sort((a, b) => b.length - a.length).map((word) => escape(foldText(word))).join('|');
    return { ...service, pattern: new RegExp(`(?<![a-z0-9])(?:${words})(?![a-z0-9])`, 'g') };
  });
  return compiled;
}

/** Wszystkie usługi z listy, których nazwy występują w tekście (każda usługa raz, pierwsze wystąpienie). */
export function matchOfframps(text: string): OfframpMatch[] {
  const folded = foldText(text);
  const result: OfframpMatch[] = [];
  for (const service of getCompiled()) {
    service.pattern.lastIndex = 0;
    const hit = service.pattern.exec(folded);
    if (!hit) continue;
    const { pattern: _pattern, ...plain } = service;
    result.push({ service: plain, keyword: text.slice(hit.index, hit.index + hit[0].length), index: hit.index });
  }
  // Nazwa szczegółowa wygrywa z nakładającą się ogólniejszą („Binance P2P” zamiast „Binance” w tym samym miejscu).
  return result.filter(
    (item) =>
      !result.some(
        (other) => other !== item && other.keyword.length > item.keyword.length && other.index <= item.index && other.index + other.keyword.length >= item.index + item.keyword.length,
      ),
  );
}

/** Usługa wyjścia do fiat dla nazwy lub etykiety (np. „Zonda (BitBay)”, „Binance: Hot Wallet”) — pierwsza pasująca. */
export function offrampFor(label: string | undefined): OfframpService | undefined {
  if (!label) return undefined;
  return matchOfframps(label)[0]?.service;
}
