// Próba śledzenia środków na PRAWDZIWYCH danych (NIE test; wymaga internetu).
//
//   node scripts/trace-check.ts [--depth=deep|standard] [--history=full|recent] [--since=RRRR-MM-DD] [--until=RRRR-MM-DD]
//                               [--budget=N] [--history-requests=N] [--hops=N] [--verbose] sieć:adres[:oczekiwana_usługa] …
//
// Adresy podaje się wyłącznie w wierszu poleceń — skrypt ich nie zapisuje, a na
// ekranie pokazuje skróty. `oczekiwana_usługa` (np. `Binance`) to fragment nazwy
// usługi, do której — jak wiadomo z góry z samego łańcucha — trafiły środki
// z adresu; pozwala policzyć trafność.

import type { ChainActivity, Network } from '@olcys/core';
import { createChainProviders, getActivityFromProviders } from '../src/index.ts';

const args = process.argv.slice(2);
const depth = args.includes('--depth=standard') ? 'standard' : 'deep';
const verbose = args.includes('--verbose');
const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
const history = flag('history') === 'full' ? ('full' as const) : ('recent' as const);
const since = flag('since');
const until = flag('until');
const budgetFlag = flag('budget');
const historyRequests = flag('history-requests');
const hops = flag('hops');
const targets = args
  .filter((arg) => !arg.startsWith('--'))
  .map((arg) => {
    const [network, address, expected] = arg.split(':');
    return { network: network as Network, address: address ?? '', expected };
  });
if (targets.length === 0) {
  console.error('Podaj adresy: sieć:adres[:oczekiwana_usługa] (sieć: bitcoin | ethereum | tron).');
  process.exit(1);
}

const short = (value: string) => (value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);
/** Zamienia pełne adresy i identyfikatory transakcji w tekście na skróty. */
const redact = (text: string) =>
  text.replace(/\b(0x[0-9a-fA-F]{40,64}|bc1[0-9a-z]{20,}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|T[1-9A-HJ-NP-Za-km-z]{33}|[0-9a-f]{64})\b/g, (match) => short(match));

const requests: string[] = [];
const countingFetch = (input: string, init?: RequestInit) => {
  requests.push(new URL(input).host);
  return fetch(input, init);
};
const providers = createChainProviders({
  enableLive: true,
  depth,
  fetch: countingFetch,
  politeFetch: true,
  rateCacheFile: false,
  ...(hops ? { trace: { maxHops: Number(hops), maxCandidates: 10 } } : {}),
});

interface Row {
  address: string;
  network: string;
  expected: string;
  hit: string;
  trails: number;
  inferred: number;
  services: string;
  confidence: string;
  hops: string;
  cluster: number;
  seconds: string;
  requests: number;
  problems: string;
}
const rows: Row[] = [];

for (const target of targets) {
  requests.length = 0;
  const started = Date.now();
  let activity: ChainActivity;
  try {
    // Zakres historii podajemy w kontekście wywołania — osobno dla każdego adresu.
    activity = await getActivityFromProviders(providers, target.network, target.address, {
      log: () => undefined,
      history,
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(historyRequests ? { maxHistoryRequests: Number(historyRequests) } : {}),
      ...(budgetFlag ? { requestBudget: Number(budgetFlag) } : {}),
    });
  } catch (error) {
    console.log(`\n== ${target.network} ${short(target.address)}: BŁĄD ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const seconds = (Date.now() - started) / 1000;
  const trails = activity.trails ?? [];
  const matching = target.expected ? trails.filter((trail) => trail.serviceName.toLowerCase().includes(target.expected!.toLowerCase())) : [];
  const perHost: Record<string, number> = {};
  for (const host of requests) perHost[host] = (perHost[host] ?? 0) + 1;

  console.log(`\n== ${target.network} ${short(target.address)} (tryb ${depth}) ==`);
  const outgoing = activity.transfers.filter((transfer) => transfer.direction === 'out');
  console.log(`klasa: ${activity.profile.addressClass} | etykieta: ${activity.profile.label ?? '—'} | transakcji: ${activity.profile.txCount} | przelewów pobranych: ${activity.transfers.length} (wychodzących ${outgoing.length}) | historia: ${history}`);
  console.log(`otrzymano: ${activity.profile.totalReceived} ${activity.profile.nativeAsset} | wysłano: ${activity.profile.totalSent} | saldo: ${activity.profile.balance} | pierwsza transakcja: ${activity.profile.firstSeen ?? 'nieustalona'} | ostatnia: ${activity.profile.lastSeen ?? '—'}`);
  console.log(`ścieżki: ${trails.length} | wskaźniki wypłat: ${activity.cashOuts.length} | sumy PLN: ${JSON.stringify(activity.cashOutPlnByYear)} | klaster: ${activity.cluster?.addresses.length ?? 0} adresów`);
  for (const trail of trails.slice(0, verbose ? 20 : 4)) {
    const value = trail.valuePln !== undefined ? `${trail.valuePln.toLocaleString('pl-PL')} PLN` : 'bez wyceny';
    console.log(`  • ${trail.serviceName} [${trail.serviceKind}] ${trail.amount} ${trail.asset} (${value}) — pewność ${trail.confidence}/100, kroków ${trail.hops.length}`);
    for (const [index, hop] of trail.hops.entries()) {
      console.log(`      ${index + 1}. ${hop.time.slice(0, 16)} ${short(hop.from)} → ${short(hop.to)}${hop.toLabel ? ` „${hop.toLabel}”` : ''} ${hop.amount} ${hop.asset} tx ${short(hop.txid)}${hop.inferred ? ' [wnioskowanie]' : ''}`);
      if (hop.reason) console.log(`         ${redact(hop.reason)}`);
    }
    if (verbose) {
      for (const reason of trail.reasons) console.log(`      powód: ${redact(reason)}`);
      for (const question of trail.openQuestions) console.log(`      do potwierdzenia: ${redact(question)}`);
      if (trail.valuation) console.log(`      wycena: ${trail.valuation}`);
    }
  }
  for (const member of (activity.cluster?.addresses ?? []).slice(0, verbose ? 25 : 3)) console.log(`  klaster: ${short(member.address)} — ${redact(member.reason)}`);
  for (const question of (activity as { openQuestions?: string[] }).openQuestions ?? []) console.log(`  do wyjaśnienia: ${redact(question)}`);
  console.log('  ograniczenia:');
  for (const item of activity.limitations.filter((entry) => !entry.startsWith('Do wyjaśnienia: '))) console.log(`    - ${redact(item).slice(0, verbose ? 2000 : 260)}`);
  console.log(`  żądania: ${requests.length} ${JSON.stringify(perHost)}; czas ${seconds.toFixed(1)} s`);

  const problems = activity.limitations
    .filter((item) => /przerwano|Nie udało się|bez ustalonego końca|OSTRZEŻENIE|KURSEM PRZYKŁADOWYM|nie zwrócił/.test(item))
    .map((item) => redact(item).replace(/^Śledzenie środków: ścieżki bez ustalonego końca w usłudze wymiany — /, 'bez końca: ').slice(0, 110));
  rows.push({
    address: short(target.address),
    network: target.network,
    expected: target.expected ?? '—',
    hit: target.expected ? (matching.length > 0 ? 'TAK' : 'NIE') : '—',
    trails: trails.length,
    inferred: trails.filter((trail) => trail.hops.length > 1).length,
    services: [...new Set(trails.map((trail) => trail.serviceName))].slice(0, 3).join(', ') || '—',
    confidence: trails.length > 0 ? `${Math.min(...trails.map((t) => t.confidence))}–${Math.max(...trails.map((t) => t.confidence))}` : '—',
    hops: trails.length > 0 ? `${Math.min(...trails.map((t) => t.hops.length))}–${Math.max(...trails.map((t) => t.hops.length))}` : '—',
    cluster: activity.cluster?.addresses.length ?? 0,
    seconds: seconds.toFixed(1),
    requests: requests.length,
    problems: problems.join(' | ') || '—',
  });
}

console.log('\n== Podsumowanie ==');
console.log('| adres | sieć | oczekiwana usługa | odtworzono | ścieżki (w tym pośrednie) | usługi | pewność | kroki | klaster | czas s | żądania | co się nie udało |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  console.log(`| ${row.address} | ${row.network} | ${row.expected} | ${row.hit} | ${row.trails} (${row.inferred}) | ${row.services} | ${row.confidence} | ${row.hops} | ${row.cluster} | ${row.seconds} | ${row.requests} | ${row.problems} |`);
}
const expected = rows.filter((row) => row.hit !== '—');
if (expected.length > 0) {
  const hits = expected.filter((row) => row.hit === 'TAK').length;
  console.log(`\nTrafność: ${hits} z ${expected.length} adresów ze znaną z góry wpłatą do usługi (${Math.round((hits / expected.length) * 100)}%).`);
}
