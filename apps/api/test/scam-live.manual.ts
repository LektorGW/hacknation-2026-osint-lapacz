// Sprawdzenie ręczne NA ŻYWO (wysyła adres do publicznego eksploratora Bitcoin): adres z ataku na Twittera
// z 15.07.2020 — wzorzec fałszywego rozdania w blockchainie i zbiory ostrzeżeń. Uruchomienie: node test/scam-live.manual.ts

import { createChainProviders, getActivityFromProviders } from '@olcys/chain';
import { buildScamWarnings, giveawayChainPattern } from '../src/scam.ts';

const ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const providers = createChainProviders({ enableLive: true });
// Pełna historia z okresu ataku (15.07.2020) — domyślnie dostawcy zwracają tylko ~50 najnowszych transakcji.
const activity = await getActivityFromProviders(providers, 'bitcoin', ADDRESS, {
  log: (message: string) => console.log('  [log]', message),
  history: 'full',
  since: '2020-07-14T00:00:00Z',
  until: '2020-07-20T00:00:00Z',
  maxHistoryRequests: 60,
});
if (!activity) {
  console.log('Brak danych blockchain.');
} else {
  const transfers = activity.transfers;
  const times = transfers.map((item) => item.time).sort();
  console.log(`Przelewy pobrane: ${transfers.length} (od ${times[0]} do ${times[times.length - 1]}), pierwsza aktywność wg profilu: ${activity.profile.firstSeen}`);
  console.log('Ograniczenia:', activity.limitations);
  const pattern = giveawayChainPattern({ chain: activity });
  console.log('Wzorzec rozdania:', pattern ? pattern.explanation : 'nie wykryto (w pobranych przelewach)');
  const warnings = buildScamWarnings({ findings: [{ address: ADDRESS, network: 'bitcoin', checksumVerified: true, evidence: [], confidence: { score: 0, tier: '', excluded: false, ledger: [], nextSteps: [] }, unrelatedPublishers: 0, chain: activity }] });
  console.log('Poziom:', warnings.level, warnings.addresses.map((item) => item.components.map((component) => component.rule)));
}
