// Punkt startowy API: jedyne miejsce, w którym podłączane są prawdziwe łączniki
// źródeł i dostawcy danych blockchain. Konfiguracja wyłącznie ze zmiennych środowiskowych.

import { fileURLToPath } from 'node:url';
import * as ai from '@olcys/ai';
import * as chain from '@olcys/chain';
import type { AiAssistant, ChainProvider } from '@olcys/core';
import * as sources from '@olcys/sources';
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

// Token służy tylko do podniesienia limitu zapytań publicznego API; nie jest logowany ani zapisywany.
const connectors = sources.createConnectors({ sandboxUrl, enableLive, torProxyUrl, githubToken: env.GITHUB_TOKEN || undefined });
// Rejestr źródeł monitoringu jest w module źródeł; starsza wersja modułu go nie ma —
// wtedy monitoring obejmuje wszystkie łączniki z metodą `discover`.
const listMonitorConnectors = (sources as { listMonitorConnectors?: (all: typeof connectors) => typeof connectors }).listMonitorConnectors;
const registered = typeof listMonitorConnectors === 'function' ? listMonitorConnectors(connectors) : [];
// Źródła piaskownicy zostają w monitoringu obok rejestru, żeby tryb demonstracyjny miał co przeglądać.
const monitorConnectors =
  registered.length > 0
    ? [...new Set([...registered, ...connectors.filter((connector) => connector.id.startsWith('sandbox-'))])]
    : undefined;

// Tryb głęboki dostawców blockchain (dłuższe ścieżki środków). Starsza wersja modułu
// pomija nieznaną opcję — wtedy analiza głęboka korzysta z tych samych danych co standardowa.
const createProviders = chain.createChainProviders as (config: Record<string, unknown>) => ChainProvider[];

// Model językowy jest opcjonalny: brak konfiguracji w zmiennych środowiskowych = brak modelu.
const aiConfigFromEnv = (ai as { aiConfigFromEnv?: (source: NodeJS.ProcessEnv) => unknown }).aiConfigFromEnv;
const createAiAssistant = (ai as { createAiAssistant?: (config: unknown) => AiAssistant | null }).createAiAssistant;
const aiConfig = typeof aiConfigFromEnv === 'function' ? aiConfigFromEnv(env) : null;
const assistant = aiConfig && typeof createAiAssistant === 'function' ? createAiAssistant(aiConfig) : null;
// Streszczenie całej teczki trwa dłużej niż odczyt jednej publikacji — osobny, dłuższy limit czasu.
const summaryAssistant = assistant && typeof createAiAssistant === 'function' ? createAiAssistant({ ...(aiConfig as object), timeoutMs: 90_000 }) : null;
// Fakty do streszczenia są anonimizowane, chyba że model działa na tej samej maszynie.
const aiBaseUrl = String((aiConfig as { baseUrl?: string } | null)?.baseUrl ?? '');
const aiLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(aiBaseUrl);
const normalizeText = (sources as { normalizeAddressText?: (text: string) => string }).normalizeAddressText;

// Publiczne etykiety adresów usług — do wyjaśnienia, gdy analityk wpisze nazwę giełdy zamiast osoby.
const loadLabelFile = (chain as { loadLabelFile?: (path: string) => { entries: { address: string; network: string; label: string }[] } }).loadLabelFile;
let serviceLabels: { address: string; network: string; label: string }[] = [];
try {
  if (typeof loadLabelFile === 'function') {
    const labelsPath = fileURLToPath(new URL('../data/labels.json', import.meta.resolve('@olcys/chain')));
    serviceLabels = loadLabelFile(labelsPath).entries.map(({ address, network, label }) => ({ address, network, label }));
  }
} catch {
  // Brak zbioru etykiet nie blokuje startu — wyjaśnienie pokaże pustą listę adresów.
}

const app = await buildApp({
  storage,
  connectors,
  monitorConnectors,
  chainProviders: createProviders({ sandboxUrl, enableLive }),
  deepChainProviders: createProviders({ sandboxUrl, enableLive, depth: 'deep' }),
  resolveActivity: chain.getActivityFromProviders,
  matchService: chain.matchService,
  ai: assistant,
  serviceLabels,
  summaryAi: summaryAssistant,
  aiLocal,
  normalizeText: typeof normalizeText === 'function' ? normalizeText : undefined,
  corpus: {
    ...(env.CORPUS_RETENTION_DAYS ? { retentionDays: Number(env.CORPUS_RETENTION_DAYS) } : {}),
    ...(env.CORPUS_MAX_ROWS ? { maxRows: Number(env.CORPUS_MAX_ROWS) } : {}),
  },
  logger: true,
});
app.addHook('onClose', () => storage.close());

// Łagodne zamykanie: najpierw Fastify (dokańcza żądania, zatrzymuje monitoring i analizy w tle),
// potem — w `onClose` — sterownik bazy. Bez tego wbudowana baza PGlite może zostać uszkodzona.
let closing = false;
const shutdown = (reason: string) => {
  if (closing) return;
  closing = true;
  app.log.info(`Zamykanie (${reason}): kończenie przebiegów i zamykanie bazy.`);
  app
    .close()
    .then(() => process.exit(0))
    .catch((error) => {
      app.log.error(error, 'Zamknięcie nie powiodło się.');
      process.exit(1);
    });
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
  process.on(signal, () => shutdown(signal));
}

// W systemie Windows zatrzymanie procesu z zewnątrz nie dostarcza sygnału, więc łagodne
// zamknięcie da się też wywołać żądaniem — wyłącznie z tego samego komputera.
app.post('/api/admin/shutdown', async (request, reply) => {
  if (request.ip !== '127.0.0.1' && request.ip !== '::1') {
    return reply.code(403).send({ error: 'Zamknięcie jest dostępne tylko lokalnie.' });
  }
  setImmediate(() => shutdown('żądanie lokalne'));
  return { status: 'closing' };
});

await app.listen({ port, host: env.API_HOST ?? '127.0.0.1' });
