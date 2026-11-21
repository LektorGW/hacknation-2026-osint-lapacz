// Klaster adresów portfela Bitcoin — HEURYSTYKI, nie pewniki:
// 1) wspólne wejścia: adresy, których środki wydano w tej samej transakcji co
//    środki adresu podmiotu, zwykle kontroluje ten sam portfel;
// 2) adres reszty: w transakcji o dwóch wyjściach jedno bywa resztą wracającą
//    do nadawcy (rozpoznanie po typie skryptu i „nieokrągłej” kwocie).
// Ethereum i Tron to model kont — tam klastra nie budujemy.

import type { AddressCluster, Network } from '@olcys/core';

export interface UtxoOutput {
  scriptpubkey_address?: string;
  scriptpubkey_type?: string;
  value?: number;
}

export interface UtxoInput {
  txid?: string;
  vout?: number;
  is_coinbase?: boolean;
  prevout?: UtxoOutput | null;
}

/** Transakcja w układzie API Esplora. */
export interface UtxoTx {
  txid: string;
  status?: { confirmed?: boolean; block_time?: number };
  vin?: UtxoInput[];
  vout?: UtxoOutput[];
}

export const DEFAULT_CLUSTER_LIMIT = 25;

const inputAddresses = (tx: UtxoTx) =>
  [...new Set((tx.vin ?? []).map((input) => input.prevout?.scriptpubkey_address).filter((a): a is string => !!a))];

/**
 * Transakcja wyglądająca na CoinJoin: co najmniej trzy różne adresy na wejściach
 * i co najmniej trzy wyjścia o identycznej kwocie. Wspólne wejścia takiej
 * transakcji NIE świadczą o wspólnym portfelu, a dalszej drogi środków nie da się ustalić.
 */
export function looksLikeCoinJoin(tx: UtxoTx): boolean {
  if (inputAddresses(tx).length < 3) return false;
  const counts = new Map<number, number>();
  for (const output of tx.vout ?? []) {
    if (!output.value) continue;
    counts.set(output.value, (counts.get(output.value) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values()) >= 3;
}

/**
 * Adresy współwystępujące z podanym adresem na wejściach transakcji (bez transakcji typu CoinJoin).
 * `isService` wskazuje adresy z publiczną etykietą (giełda, usługa, mikser, instytucja): taki adres
 * nigdy nie trafia do klastra, a transakcja, w której wydaje on środki razem z adresem podmiotu, jest
 * transakcją usługi (wypłata zbiorcza, konsolidacja) — nie świadczy o wspólnym portfelu, więc pomijamy ją całą.
 */
export function commonInputAddresses(txs: UtxoTx[], address: string, isService?: (address: string) => boolean): { address: string; txid: string }[] {
  const found = new Map<string, string>();
  for (const tx of txs) {
    const inputs = inputAddresses(tx);
    if (!inputs.includes(address) || looksLikeCoinJoin(tx)) continue;
    if (isService && inputs.some((other) => other !== address && isService(other))) continue;
    for (const other of inputs) {
      if (other !== address && !found.has(other)) found.set(other, tx.txid);
    }
  }
  return [...found.entries()].map(([other, txid]) => ({ address: other, txid }));
}

/** Kwota „okrągła”: wielokrotność 0,0001 BTC — tak zwykle wygląda kwota płatności, a nie reszta. */
export function isRoundAmount(satoshi: number): boolean {
  return satoshi > 0 && satoshi % 10_000 === 0;
}

export interface ChangeGuess {
  /** Indeks wyjścia uznanego za resztę. */
  changeIndex: number;
  /** Indeks wyjścia uznanego za płatność. */
  paymentIndex: number;
  changeAddress: string;
  /** Użyte heurystyki, w brzmieniu dla analityka. */
  heuristics: string[];
}

/**
 * Wskazuje wyjście-resztę w transakcji o dokładnie dwóch wyjściach, której
 * wszystkie wejścia należą do portfela (`own`). Wynik tylko wtedy, gdy co najmniej
 * jedna heurystyka wskazuje resztę, a żadna jej nie przeczy.
 */
export function detectChange(tx: UtxoTx, own: ReadonlySet<string>): ChangeGuess | undefined {
  const inputs = tx.vin ?? [];
  const outputs = tx.vout ?? [];
  if (outputs.length !== 2 || inputs.length === 0) return undefined;
  if (!inputs.every((input) => input.prevout?.scriptpubkey_address && own.has(input.prevout.scriptpubkey_address))) return undefined;
  const [a, b] = outputs as [UtxoOutput, UtxoOutput];
  if (!a.scriptpubkey_address || !b.scriptpubkey_address || !a.value || !b.value) return undefined;
  if (a.scriptpubkey_address === b.scriptpubkey_address) return undefined;

  const votes: [string[], string[]] = [[], []];
  // Reszta wracająca wprost na adres portfela rozstrzyga sprawę.
  const ownA = own.has(a.scriptpubkey_address);
  const ownB = own.has(b.scriptpubkey_address);
  if (ownA !== ownB) votes[ownA ? 0 : 1].push('reszta wraca na adres tego samego portfela');

  const inputTypes = new Set(inputs.map((input) => input.prevout?.scriptpubkey_type));
  if (inputTypes.size === 1) {
    const type = [...inputTypes][0];
    const sameA = a.scriptpubkey_type === type;
    const sameB = b.scriptpubkey_type === type;
    if (type && sameA !== sameB) votes[sameA ? 0 : 1].push(`typ skryptu zgodny z wejściem (${type}), drugie wyjście ma inny typ`);
  }
  const roundA = isRoundAmount(a.value);
  const roundB = isRoundAmount(b.value);
  if (roundA !== roundB) votes[roundA ? 1 : 0].push('kwota „nieokrągła”, podczas gdy drugie wyjście ma kwotę okrągłą');

  if (votes[0].length > 0 === votes[1].length > 0) return undefined;
  const changeIndex = votes[0].length > 0 ? 0 : 1;
  return {
    changeIndex,
    paymentIndex: 1 - changeIndex,
    changeAddress: outputs[changeIndex]!.scriptpubkey_address!,
    heuristics: votes[changeIndex],
  };
}

export const CLUSTER_METHOD_UTXO = [
  'HEURYSTYKA wspólnych wejść: adresy, których środki wydano w jednej transakcji razem ze środkami adresu podmiotu, ' +
    'uznajemy za należące do tego samego portfela. Zawodzi przy transakcjach wspólnych (CoinJoin, PayJoin, wypłaty zbiorcze usług) — ' +
    'transakcje z co najmniej trzema adresami wejściowymi i trzema równymi wyjściami są pomijane jako wyglądające na CoinJoin, ' +
    'a transakcje, w których wśród wejść jest adres z publiczną etykietą usługi (giełda, mikser, instytucja), nie budują klastra. ' +
    'Klastra nie budujemy też, gdy sam badany adres ma etykietę usługi.',
  'HEURYSTYKA adresu reszty: w transakcji o dwóch wyjściach za resztę uznajemy wyjście o typie skryptu zgodnym z wejściem ' +
    'lub o „nieokrągłej” kwocie (gdy drugie jest okrągłe); adres dotąd nieużywany wzmacnia przesłankę. Sprzeczne przesłanki = brak wskazania.',
  'Klaster jest przypuszczeniem analitycznym: przynależność adresu do portfela podmiotu wymaga potwierdzenia innymi dowodami.',
];

export const CLUSTER_METHOD_ACCOUNT =
  'Sieć w modelu kont (Ethereum, Tron): jeden adres to jedno konto, transakcja ma jednego nadawcę — heurystyki wspólnych wejść ' +
  'i adresu reszty nie mają zastosowania, więc klaster nie jest budowany. Inne adresy tej samej osoby trzeba ustalić źródłami poza łańcuchem.';

/** Klaster dla sieci w modelu kont: tylko opis, bez adresów. */
export function accountCluster(network: Network, seed: string): AddressCluster {
  return { seed, network, addresses: [], method: [CLUSTER_METHOD_ACCOUNT] };
}
