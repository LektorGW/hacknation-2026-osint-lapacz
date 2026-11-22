// Punkt startowy API: jedyne miejsce, w którym podłączane są prawdziwe łączniki
// źródeł i dostawcy danych blockchain. Konfiguracja wyłącznie ze zmiennych środowiskowych.

import { fileURLToPath } from 'node:url';
import * as ai from '@olcys/ai';
import * as chain from '@olcys/chain';
import type { AiAssistant, ChainProvider } from '@olcys/core';
import * as sources from '@olcys/sources';
import { buildApp } from './app.ts';
import { createDriverFromEnv, createStorage } from './storage.ts';
import { retentionDaysFromEnv } from './retention.ts';
import { registerAdminShutdown, securityFromEnv } from './security.ts';

const env = process.env;
const sandboxUrl = env.SANDBOX_URL ?? 'http://localhost:4100';
// Źródła w prawdziwym internecie są wyłączone, dopóki operator świadomie ich nie włączy.
const enableLive = ['1', 'true', 'yes'].includes((env.ENABLE_LIVE ?? '').toLowerCase());
const torProxyUrl = env.TOR_PROXY_URL || undefined;
// Laboratorium tożsamości (apps/identity-lab): symulacja lokalna na danych syntetycznych, domyślnie wyłączona.
const labUrl = env.LAB_URL || undefined;
const port = Number(env.API_PORT ?? 4000);
// Sprawdzenie konfiguracji (port, katalog danych, adresy, klucze) — błąd zatrzymuje start z opisem po polsku.
await (await import('./config-check.ts')).checkConfigOrExit(env);

// Zabezpieczenia i retencja ze zmiennych środowiskowych — błędna wartość zatrzymuje start (bez wypisywania tokenu ani klucza).
const security = securityFromEnv(env);
const retentionDays = retentionDaysFromEnv(env.OLCYS_RETENTION_DAYS_CLOSED);
const archiveDir = env.OLCYS_ARCHIVE_DIR?.trim() || undefined;

const storage = createStorage(await createDriverFromEnv(env, (message) => console.warn(message)));
await storage.migrate();

// Token służy tylko do podniesienia limitu zapytań publicznego API; nie jest logowany ani zapisywany.
const search = sources.searchConfigFromEnv(env);
const connectors = sources.createConnectors({
  sandboxUrl,
  labUrl,
  enableLive,
  torProxyUrl,
  githubToken: env.GITHUB_TOKEN || undefined,
  ceidgToken: env.CEIDG_API_TOKEN || undefined,
  search,
});
// Do ekranu „Typowanie”: które klucze źródeł są ustawione — same wartości logiczne, nigdy treść klucza.
const configuredKeys = {
  GITHUB_TOKEN: Boolean(env.GITHUB_TOKEN?.trim()),
  CEIDG_API_TOKEN: Boolean(env.CEIDG_API_TOKEN?.trim()),
  MARGINALIA_API_KEY: Boolean(search.marginaliaApiKey),
  // Mojeek działa tylko z potwierdzonym prawem przechowywania wyników (MOJEEK_STORAGE_RIGHTS=1).
  MOJEEK_API_KEY: Boolean(search.mojeekApiKey && search.mojeekStorageRights),
};
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
const loadLabelFile = (chain as { loadLabelFile?: (path: string) => { entries: { address: string; network: string; label: string; addressClass?: string }[] } }).loadLabelFile;
let serviceLabels: { address: string; network: string; label: string; addressClass?: string }[] = [];
try {
  if (typeof loadLabelFile === 'function') {
    const labelsPath = fileURLToPath(new URL('../data/labels.json', import.meta.resolve('@olcys/chain')));
    serviceLabels = loadLabelFile(labelsPath).entries.map(({ address, network, label, addressClass }) => ({ address, network, label, addressClass }));
  }
} catch {
  // Brak zbioru etykiet nie blokuje startu — wyjaśnienie pokaże pustą listę adresów.
}

const app = await buildApp({
  storage,
  connectors,
  monitorConnectors,
  // Dostawcy syntetyczni (piaskownica, laboratorium) osobno od prawdziwych: w trybie danych syntetycznych
  // wycena korzysta z tabeli przykładowej i nie pyta kursów w internecie (przełącznik: data-mode.ts).
  // SOLANA_RPC_URL: własny / zakontraktowany węzeł RPC Solany — publicznego węzła nie używamy (docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. „Sieci blockchain: Litecoin, Solana”).
  chainProviders: [...createProviders({ sandboxUrl, labUrl }), ...createProviders({ enableLive, blockscoutApiKey: env.BLOCKSCOUT_API_KEY || undefined, solanaRpcUrl: env.SOLANA_RPC_URL || undefined })],
  deepChainProviders: [...createProviders({ sandboxUrl, labUrl, depth: 'deep' }), ...createProviders({ enableLive, depth: 'deep', blockscoutApiKey: env.BLOCKSCOUT_API_KEY || undefined, solanaRpcUrl: env.SOLANA_RPC_URL || undefined })],
  resolveActivity: chain.getActivityFromProviders,
  matchService: chain.matchService,
  ai: assistant,
  serviceLabels,
  summaryAi: summaryAssistant,
  aiLocal,
  normalizeText: typeof normalizeText === 'function' ? normalizeText : undefined,
  // Przykładowa (syntetyczna) odpowiedź usługi do demonstracji pochodzi z piaskownicy.
  sandboxUrl,
  configuredKeys,
  corpus: {
    ...(env.CORPUS_RETENTION_DAYS ? { retentionDays: Number(env.CORPUS_RETENTION_DAYS) } : {}),
    ...(env.CORPUS_MAX_ROWS ? { maxRows: Number(env.CORPUS_MAX_ROWS) } : {}),
  },
  logger: true,
  security,
  lifecycle: { ...(retentionDays !== undefined ? { retentionDays } : {}), ...(archiveDir ? { archiveDir } : {}) },
});
app.log.info(
  `Zabezpieczenia: token API ${security.apiToken ? 'włączony' : 'wyłączony'}, szyfrowanie migawki ${storage.encryptedAtRest() ? 'włączone' : 'wyłączone'}, ` +
    `retencja zamkniętych spraw ${retentionDays === undefined ? 'wyłączona' : `${retentionDays} dni`}, archiwa na serwerze ${archiveDir ? 'tak' : 'nie'}.`,
);
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

// W systemie Windows zatrzymanie procesu z zewnątrz nie dostarcza sygnału, więc łagodne zamknięcie da się
// też wywołać żądaniem — wyłącznie wprost na porcie API z tej samej maszyny (nie przez proxy interfejsu
// ani z przeglądarki), a przy ustawionym OLCYS_API_TOKEN — także z tokenem.
registerAdminShutdown(app, { port, onShutdown: () => shutdown('żądanie lokalne') });

// Tryb produkcyjny jednym procesem: zbudowany interfejs (apps/web/dist) na tym samym porcie co API.
await (await import('./static.ts')).registerStaticWeb(app, env);

await app.listen({ port, host: env.API_HOST ?? '127.0.0.1' });
