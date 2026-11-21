// Dostawcy modelu za jednym, minimalnym interfejsem `complete`. Nowy dostawca = nowa
// implementacja `Provider`; reszta pakietu (polecenia, weryfikacja) się nie zmienia.
// Wyłącznie wbudowany `fetch`, bez bibliotek dostawców.

import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_ANTHROPIC_MODEL } from './config.ts';
import type { AiConfig } from './config.ts';
import type { JsonSchema } from './prompts.ts';

export interface CompletionRequest {
  system: string;
  user: string;
  jsonSchema: JsonSchema;
  /** Nazwa schematu (wymagana przez `response_format` w API zgodnym z OpenAI). */
  schemaName: string;
  /** Spodziewana długość odpowiedzi w tokenach. */
  maxTokens: number;
  signal?: AbortSignal;
}

export interface Completion {
  /** Tekst odpowiedzi — oczekiwany JSON, ale może mieć otoczkę; wycina go `extractJson`. */
  text: string;
  /** Model, który faktycznie odpowiedział, jeśli API go podaje. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Provider {
  id: string;
  model: string;
  /** Adres, pod który wysyłane są żądania — pokazywany analitykowi. */
  endpoint: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

export interface ProviderHooks {
  /** Wywoływane przed każdym żądaniem HTTP (także ponowionym). */
  onRequest(): void;
  log(message: string): void;
}

export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

const MAX_RETRY_WAIT_MS = 20_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(header: string | null, fallback: number): number {
  if (header === null) return fallback;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS) : fallback;
}

interface HttpContext {
  fetch: typeof fetch;
  hooks: ProviderHooks;
  retryDelayMs: number;
}

/** POST z jedną ponowną próbą po 429/5xx (po czasie z `retry-after`). */
async function postJson(
  context: HttpContext,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; raw: string }> {
  for (let attempt = 0; ; attempt += 1) {
    context.hooks.onRequest();
    const response = await context.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt === 0 && response.headers.get('x-should-retry') !== 'false') {
      const wait = retryAfterMs(response.headers.get('retry-after'), context.retryDelayMs);
      context.hooks.log(`Model: odpowiedź HTTP ${response.status}, ponowna próba za ${Math.round(wait)} ms.`);
      await sleep(wait, signal);
      continue;
    }
    return { status: response.status, raw };
  }
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  } catch {
    // niżej
  }
  throw new ProviderError('odpowiedź serwera nie jest obiektem JSON');
}

/** Krótki opis błędu z treści odpowiedzi (do dziennika; klucz jest usuwany przez wywołującego). */
function errorDetail(raw: string): string {
  try {
    const error = (JSON.parse(raw) as { error?: unknown }).error;
    if (typeof error === 'string') return error.slice(0, 300);
    if (error && typeof error === 'object') {
      const { type, message } = error as { type?: unknown; message?: unknown };
      return [type, message].filter((part) => typeof part === 'string').join(': ').slice(0, 300);
    }
  } catch {
    // niżej
  }
  return raw.replace(/\s+/g, ' ').slice(0, 300);
}

const schemaInstruction = (schema: JsonSchema): string =>
  `\n\nZwróć wyłącznie jeden obiekt JSON (bez komentarza i bez bloku kodu) zgodny ze schematem:\n${JSON.stringify(schema)}`;

const tokenCount = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

// ---------- API zgodne z OpenAI: OpenAI, Ollama, vLLM, llama.cpp, routery ----------

export function createOpenAiCompatibleProvider(
  config: AiConfig & { baseUrl: string; model: string },
  hooks: ProviderHooks,
): Provider {
  const context: HttpContext = { fetch: config.fetch ?? fetch, hooks, retryDelayMs: config.retryDelayMs ?? 1000 };
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};

  // Serwery różnią się obsługą parametrów. Zaczynamy od najściślejszego wariantu i po
  // błędzie 400/422 schodzimy niżej; ustalony wariant zostaje na kolejne wywołania.
  const dialect = {
    format: 'json_schema' as 'json_schema' | 'json_object' | 'text',
    temperature: true,
    tokenParam: 'max_tokens' as 'max_tokens' | 'max_completion_tokens',
  };

  function adapt(detail: string): boolean {
    const lower = detail.toLowerCase();
    if (dialect.tokenParam === 'max_tokens' && lower.includes('max_completion_tokens')) {
      dialect.tokenParam = 'max_completion_tokens';
    } else if (dialect.temperature && lower.includes('temperature')) {
      dialect.temperature = false;
    } else if (dialect.format === 'json_schema') {
      dialect.format = 'json_object';
    } else if (dialect.format === 'json_object') {
      dialect.format = 'text';
    } else {
      return false;
    }
    return true;
  }

  function body(request: CompletionRequest): Record<string, unknown> {
    const strict = dialect.format === 'json_schema';
    const payload: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: 'system', content: strict ? request.system : request.system + schemaInstruction(request.jsonSchema) },
        { role: 'user', content: request.user },
      ],
      [dialect.tokenParam]: request.maxTokens,
      stream: false,
    };
    // Temperatura 0 — możliwie powtarzalny wynik; modele, które jej nie przyjmują, dostają żądanie bez niej.
    if (dialect.temperature) payload.temperature = 0;
    if (strict) {
      payload.response_format = { type: 'json_schema', json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema } };
    } else if (dialect.format === 'json_object') {
      payload.response_format = { type: 'json_object' };
    }
    return payload;
  }

  return {
    id: 'openai-compatible',
    model: config.model,
    endpoint,
    async complete(request) {
      for (let attempt = 0; ; attempt += 1) {
        const { status, raw } = await postJson(context, endpoint, headers, body(request), request.signal);
        if (status === 400 || status === 422) {
          const detail = errorDetail(raw);
          if (attempt < 4 && adapt(detail)) {
            hooks.log(`Model: serwer odrzucił parametry żądania (HTTP ${status}) — ponawiam w trybie ${dialect.format}.`);
            continue;
          }
          throw new ProviderError(`HTTP ${status}: ${detail}`, status);
        }
        if (status < 200 || status >= 300) throw new ProviderError(`HTTP ${status}: ${errorDetail(raw)}`, status);

        const json = parseBody(raw);
        const choice = (json.choices as { message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }[] | undefined)?.[0];
        const content = choice?.message?.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join('')
              : '';
        if (!text.trim()) {
          throw new ProviderError(choice?.message?.refusal ? 'model odmówił odpowiedzi' : 'pusta odpowiedź modelu');
        }
        if (choice?.finish_reason === 'length') hooks.log('Model: odpowiedź ucięta limitem tokenów.');
        const usage = (json.usage ?? {}) as Record<string, unknown>;
        return {
          text,
          model: typeof json.model === 'string' ? json.model : undefined,
          inputTokens: tokenCount(usage.prompt_tokens),
          outputTokens: tokenCount(usage.completion_tokens),
        };
      }
    },
  };
}

// ---------- Anthropic Messages API ----------

const ANTHROPIC_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Modele, dla których API obsługuje serwerowy model zastępczy po odmowie (`fallbacks`). */
const FALLBACK_MODELS = /^claude-(fable-5-2|fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

export function createAnthropicProvider(config: AiConfig & { apiKey: string }, hooks: ProviderHooks): Provider {
  const context: HttpContext = { fetch: config.fetch ?? fetch, hooks, retryDelayMs: config.retryDelayMs ?? 1000 };
  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
  const base = (config.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
  const endpoint = `${base}/v1/messages`;
  const useFallback = config.refusalFallback !== false && FALLBACK_MODELS.test(model);

  // Tryb pełny: struktura wymuszona przez `output_config.format` (wymuszone `tool_choice`
  // jest odrzucane przez bieżące modele). Po błędzie 400 — np. organizacja bez ustrukturyzowanych
  // odpowiedzi albo starszy model — przechodzimy na zwykły tekst z instrukcją w poleceniu.
  let plain = false;

  function build(request: CompletionRequest): { headers: Record<string, string>; body: Record<string, unknown> } {
    const headers: Record<string, string> = { 'x-api-key': config.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
    // Bez `thinking` (bieżące modele same dobierają głębokość) i bez parametrów próbkowania
    // (w tej wersji API są odrzucane). Zapas tokenów obejmuje rozumowanie modelu.
    const body: Record<string, unknown> = {
      model,
      max_tokens: Math.max(8000, request.maxTokens * 4),
      system: plain ? request.system + schemaInstruction(request.jsonSchema) : request.system,
      messages: [{ role: 'user', content: request.user }],
    };
    if (!plain) {
      body.output_config = { effort: config.effort ?? 'low', format: { type: 'json_schema', schema: request.jsonSchema } };
      if (useFallback) {
        headers['anthropic-beta'] = FALLBACK_BETA;
        body.fallbacks = 'default';
      }
    }
    return { headers, body };
  }

  return {
    id: 'anthropic',
    model,
    endpoint,
    async complete(request) {
      for (;;) {
        const { headers, body } = build(request);
        const { status, raw } = await postJson(context, endpoint, headers, body, request.signal);
        if (status === 400 && !plain) {
          plain = true;
          hooks.log(`Model: API odrzuciło żądanie (HTTP 400: ${errorDetail(raw)}) — ponawiam bez parametrów dodatkowych.`);
          continue;
        }
        if (status < 200 || status >= 300) throw new ProviderError(`HTTP ${status}: ${errorDetail(raw)}`, status);

        const json = parseBody(raw);
        // Odmowa przychodzi z HTTP 200 — sprawdzamy `stop_reason`, zanim sięgniemy po treść.
        if (json.stop_reason === 'refusal') {
          const category = (json.stop_details as { category?: unknown } | null | undefined)?.category;
          throw new ProviderError(`model odmówił odpowiedzi${typeof category === 'string' ? ` (kategoria: ${category})` : ''}`);
        }
        const blocks = Array.isArray(json.content) ? (json.content as { type?: unknown; text?: unknown }[]) : [];
        const text = blocks.map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('');
        if (!text.trim()) throw new ProviderError('pusta odpowiedź modelu');
        if (json.stop_reason === 'max_tokens') hooks.log('Model: odpowiedź ucięta limitem tokenów.');
        const served = typeof json.model === 'string' ? json.model : undefined;
        if (served && served !== model) hooks.log(`Model: odpowiedzi udzielił ${served}, inny niż skonfigurowany ${model}.`);
        const usage = (json.usage ?? {}) as Record<string, unknown>;
        return { text, model: served, inputTokens: tokenCount(usage.input_tokens), outputTokens: tokenCount(usage.output_tokens) };
      }
    },
  };
}
