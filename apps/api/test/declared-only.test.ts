// Konta zadeklarowane na stronie w serwisach, których narzędzie nie pobiera (LinkedIn, X…):
// widoczne w ścieżce dojścia, ale bez dalszego wyszukiwania i bez zajmowania limitu identyfikatorów.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECLARED_ONLY_NOTE } from '@olcys/sources';
import { runAnalysis } from '../src/analysis.ts';
import { BTC_A, fakeConnector, fakeProvider } from './helpers.ts';

test('konto zadeklarowane na stronie w serwisie nieobsługiwanym nie jest wyszukiwane, ale zostaje w ścieżce dojścia', async () => {
  const site = fakeConnector('www', 'strona.example', ['nick', 'profile_url'], (identifier) =>
    identifier.type === 'nick'
      ? [
          {
            url: 'https://strona.example/',
            author: 'jan_testowy',
            text: `Strona Jana. Wsparcie: ${BTC_A}`,
            discoveredIdentifiers: [
              { type: 'profile_url' as const, value: 'https://www.linkedin.com/in/jan-testowy', note: DECLARED_ONLY_NOTE } as never,
              { type: 'profile_url' as const, value: 'https://kod.example/jan_testowy' },
            ],
          },
        ]
      : [],
  );
  const query = { identifiers: [{ type: 'nick' as const, value: 'jan_testowy' }] };
  const result = await runAnalysis({ query, connectors: [site], chainProviders: [fakeProvider()] });

  const declared = result.intel.trail.find((step) => step.identifier.value.includes('linkedin.com'))!;
  assert.equal(declared.followed, false);
  assert.equal(declared.stopReason, 'declared_only');
  // Zwykły odnośnik nadal jest śledzony.
  assert.equal(result.intel.trail.find((step) => step.identifier.value === 'https://kod.example/jan_testowy')!.followed, true);
  // Nikt nie pytał o adres LinkedIna.
  assert.ok(!site.calls.some((call) => call.value.includes('linkedin.com')));
  assert.ok(result.intel.expansion!.stops.some((stop) => stop.reason === 'declared_only' && /linkedin\.com/.test(stop.detail)));
});
