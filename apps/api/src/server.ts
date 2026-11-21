// Punkt startowy API: jedyne miejsce, w którym podłączane są prawdziwe łączniki
// źródeł i dostawcy danych blockchain. Konfiguracja wyłącznie ze zmiennych środowiskowych.

import { createChainProviders, getActivityFromProviders, matchService } from '@olcys/chain';
import { createConnectors } from '@olcys/sources';
import { buildApp } from './app.ts';
import { createDriverFromEnv, createStorage } from './storage.ts';

const env = process.env;
const sandboxUrl = env.SANDBOX_URL ?? 'http://localhost:4100';
// Źródła w prawdziwym internecie są wyłączone, dopóki operator świadomie ich nie włączy.
const enableLive = ['1', 'true', 'yes'].includes((env.ENABLE_LIVE ?? '').toLowerCase());
const torProxyUrl = env.TOR_PROXY_URL || undefined;
const port = Number(env.API_PORT ?? 4000);

const storage = createStorage(await createDriverFromEnv(env));
await storage.migrate();

const app = await buildApp({
  storage,
  // Token służy tylko do podniesienia limitu zapytań publicznego API; nie jest logowany ani zapisywany.
  connectors: createConnectors({ sandboxUrl, enableLive, torProxyUrl, githubToken: env.GITHUB_TOKEN || undefined }),
  chainProviders: createChainProviders({ sandboxUrl, enableLive }),
  resolveActivity: getActivityFromProviders,
  matchService,
  logger: true,
});
app.addHook('onClose', () => storage.close());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}

await app.listen({ port, host: env.API_HOST ?? '127.0.0.1' });
