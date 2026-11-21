// Konfiguracja modułu. Dostawca i adres usługi są zawsze jawne; bez konfiguracji moduł
// jest wyłączony i żadna treść nie opuszcza narzędzia.

export type AiProviderId = 'openai-compatible' | 'anthropic' | 'none';

export interface AiConfig {
  provider: AiProviderId;
  /** Adres API. Wymagany dla `openai-compatible`; dla `anthropic` domyślnie `https://api.anthropic.com`. */
  baseUrl?: string;
  /** Wymagany dla `anthropic`; dla serwerów lokalnych (Ollama, vLLM) zwykle zbędny. */
  apiKey?: string;
  /** Wymagany dla `openai-compatible`; dla `anthropic` domyślnie `claude-fable-5-2`. */
  model?: string;
  /** Limit czasu jednego zadania razem z ponowieniami (domyślnie 30 000 ms). */
  timeoutMs?: number;
  /** Ile znaków treści publikacji trafia do modelu (domyślnie 6000). */
  maxInputChars?: number;
  fetch?: typeof fetch;
  /** Pamięć podręczna; można podać własną mapę, by współdzielić ją między analizami. */
  cache?: Map<string, unknown>;
  /** Ile zadań naraz (domyślnie 4). */
  concurrency?: number;
  /** Dziennik — klucz API nigdy do niego nie trafia. */
  log?: (message: string) => void;
  /** Tylko `anthropic`: `output_config.effort` (domyślnie `low` — odczyt krótkiej treści). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Tylko `anthropic`: przy odmowie modelu pozwól API użyć modelu zastępczego (domyślnie tak). */
  refusalFallback?: boolean;
  /** Odstęp przed ponowieniem po 429/5xx, gdy serwer nie poda `retry-after` (domyślnie 1000 ms). */
  retryDelayMs?: number;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-fable-5-2';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

type Env = Record<string, string | undefined>;

const text = (value: string | undefined): string | undefined => (value && value.trim() ? value.trim() : undefined);
const positive = (value: string | undefined): number | undefined => {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * Konfiguracja ze zmiennych środowiskowych. `null` = moduł wyłączony.
 *
 * - `AI_PROVIDER` = `openai-compatible` (także `openai`) | `anthropic` | `none`,
 *   z `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`.
 * - Bez `AI_PROVIDER`: sam `OPENAI_API_KEY` włącza `openai-compatible` z adresem OpenAI,
 *   sam `ANTHROPIC_API_KEY` włącza `anthropic`. Oba naraz bez `AI_PROVIDER` → `null`
 *   (nie zgadujemy, dokąd wysłać treść).
 * - Opcjonalnie: `AI_TIMEOUT_MS`, `AI_MAX_INPUT_CHARS`, `AI_CONCURRENCY`, `AI_EFFORT`,
 *   `AI_REFUSAL_FALLBACK=0`.
 */
export function aiConfigFromEnv(env: Env): AiConfig | null {
  const openaiKey = text(env.OPENAI_API_KEY);
  const anthropicKey = text(env.ANTHROPIC_API_KEY);
  const requested = text(env.AI_PROVIDER)?.toLowerCase();

  let provider: AiProviderId;
  if (requested === 'none' || requested === 'off' || requested === 'disabled') return null;
  if (requested === 'openai-compatible' || requested === 'openai') provider = 'openai-compatible';
  else if (requested === 'anthropic') provider = 'anthropic';
  else if (requested) return null; // nieznana wartość — bezpieczniej wyłączyć niż zgadywać
  else if (openaiKey && !anthropicKey) provider = 'openai-compatible';
  else if (anthropicKey && !openaiKey) provider = 'anthropic';
  else return null;

  const baseUrl = text(env.AI_BASE_URL)?.replace(/\/+$/, '');
  const config: AiConfig = { provider };
  const set = <K extends keyof AiConfig>(name: K, value: AiConfig[K] | undefined) => {
    if (value !== undefined) config[name] = value;
  };
  if (provider === 'openai-compatible') {
    // Klucz OpenAI trafia wyłącznie do OpenAI: przy własnym adresie liczy się tylko AI_API_KEY.
    set('baseUrl', baseUrl ?? (openaiKey ? OPENAI_BASE_URL : undefined));
    set('apiKey', text(env.AI_API_KEY) ?? (config.baseUrl === OPENAI_BASE_URL ? openaiKey : undefined));
  } else {
    set('baseUrl', baseUrl);
    set('apiKey', text(env.AI_API_KEY) ?? anthropicKey);
  }
  set('model', text(env.AI_MODEL));
  set('timeoutMs', positive(env.AI_TIMEOUT_MS));
  set('maxInputChars', positive(env.AI_MAX_INPUT_CHARS));
  set('concurrency', positive(env.AI_CONCURRENCY));
  const effort = text(env.AI_EFFORT)?.toLowerCase();
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') config.effort = effort;
  if (['0', 'false', 'no', 'off'].includes(text(env.AI_REFUSAL_FALLBACK)?.toLowerCase() ?? '')) config.refusalFallback = false;
  return config;
}
