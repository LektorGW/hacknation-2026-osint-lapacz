// Krótka próba na żywo (NIE test): prawdziwe kursy i prawdziwe publiczne API.
// Uruchomienie: `node scripts/live-check.ts`. Wymaga internetu.

import { createChainProviders, getActivityFromProviders, MarketRateSource, valueAmount } from '../src/index.ts';
import type { RequestBudget } from '../src/index.ts';

const requests: string[] = [];
const countingFetch = (input: string, init?: RequestInit) => {
  requests.push(new URL(input).host);
  return fetch(input, init);
};

console.log('== Wycena (Binance × NBP) ==');
const rates = new MarketRateSource({ fetch: countingFetch });
for (const [asset, amount, time] of [
  ['BTC', 0.3, '2024-06-15T12:00:00Z'],
  ['BTC', 0.3, '2025-03-15T12:00:00Z'],
  ['ETH', 2, '2024-06-17T12:00:00Z'],
  ['ETH', 2, '2025-03-17T12:00:00Z'],
] as const) {
  const valued = await valueAmount(rates, asset, amount, time);
  console.log(valued ? valued.valuation : `${amount} ${asset} ${time}: BRAK KURSU`);
}
console.log(`żądania: ${requests.length}`);

const providers = createChainProviders({ enableLive: true, fetch: countingFetch, politeFetch: true, rateCacheFile: false });
for (const [network, address] of [
  ['ethereum', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
  ['bitcoin', '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo'],
  ...process.argv.slice(2).map((arg) => arg.split(':') as [string, string]),
] as const) {
  requests.length = 0;
  const started = Date.now();
  const log: string[] = [];
  const activity = await getActivityFromProviders(providers, network as 'ethereum', address, { log: (message) => log.push(message) });
  const { profile } = activity;
  console.log(`\n== ${network} ${address} ==`);
  console.log(`klasa: ${profile.addressClass} | etykieta: ${profile.label ?? '—'} | źródło klasyfikacji: ${profile.classificationSource}`);
  console.log(`kontrakt: ${profile.isContract} | transakcji: ${profile.txCount} | saldo: ${profile.balance} ${profile.nativeAsset}`);
  const labelled = activity.transfers.filter((transfer) => transfer.counterpartyLabel);
  console.log(`przelewy: ${activity.transfers.length} (z etykietą kontrahenta: ${labelled.length})`);
  for (const transfer of labelled.slice(0, 5)) {
    console.log(`  ${transfer.time} ${transfer.direction} ${transfer.amount} ${transfer.asset} ↔ ${transfer.counterpartyLabel} [${transfer.counterpartyClass}]`);
  }
  console.log(`wykryte wypłaty: ${activity.cashOuts.length}; sumy PLN per rok: ${JSON.stringify(activity.cashOutPlnByYear)}`);
  for (const cashOut of activity.cashOuts.slice(0, 3)) {
    console.log(`  ${cashOut.time} ${cashOut.kind} ${cashOut.amount} ${cashOut.asset} → ${cashOut.counterpartyLabel ?? cashOut.counterparty}`);
    console.log(`    ${cashOut.explanation}`);
    console.log(`    ${cashOut.valuation ?? 'bez wyceny'}`);
  }
  console.log('ograniczenia:');
  for (const item of activity.limitations) console.log(`  - ${item}`);
  const perHost: Record<string, number> = {};
  for (const host of requests) perHost[host] = (perHost[host] ?? 0) + 1;
  console.log(`żądania: ${requests.length} ${JSON.stringify(perHost)}; czas: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const message of log) console.log(`  dziennik: ${message}`);
}

export type { RequestBudget };
