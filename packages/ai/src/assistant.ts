// Asystent językowy: trzy zadania pomocnicze nad dowolnym dostawcą modelu.
//
// Rola wyłącznie wspomagająca: każdy wynik jest sugestią z dosłownym cytatem, nazwą modelu
// i wersją polecenia; o punktach decydują jawne reguły poza tym pakietem. Każdy błąd
// dostawcy kończy się `null` i wpisem w dzienniku — analiza idzie dalej bez modelu.

import { createHash } from 'node:crypto';
import type { AiAssistant, ScoredSignal, SourceCategory, TextInsight } from '@olcys/core';
import type { AiConfig } from './config.ts';
import {
  AUTHORS_SCHEMA,
  AUTHORS_SYSTEM,
  OFFER_SIDES,
  OWNERSHIP_VALUES,
  PROMPT_VERSIONS,
  PUBLICATION_SCHEMA,
  PUBLICATION_SYSTEM,
  SUGGESTED_CATEGORIES,
  SUMMARY_SCHEMA,
  SUMMARY_SYSTEM,
  authorsUser,
  publicationUser,
  summaryUser,
} from './prompts.ts';
import type { JsonSchema } from './prompts.ts';
import { createAnthropicProvider, createOpenAiCompatibleProvider } from './providers.ts';
import type { Completion, Provider } from './providers.ts';
import { amountInText, extractJson, locationInText, unsupportedInSummary, verifyQuote } from './verify.ts';

export interface AiUsage {
  /** Zadania zlecone asystentowi (łącznie z obsłużonymi z pamięci podręcznej). */
  tasks: number;
  /** Żądania HTTP do dostawcy, także ponowione. */
  requests: number;
  cacheHits: number;
  /** Błędy dostawcy: sieć, limit czasu, HTTP, odmowa, odpowiedź bez JSON-a. */
  failures: number;
  /** Odpowiedzi odrzucone przez weryfikację (np. cytat spoza treści). */
  rejected: number;
  /** Tokeny — tylko jeśli API je podaje. */
  inputTokens: number;
  outputTokens: number;
}

export type AuthorComparison = { likelihood: number; reasons: string[]; model: string; promptVersion: string };

/** `AiAssistant` z licznikiem zużycia; wynik porównania autorów niesie dodatkowo wersję polecenia. */
export type OlcysAiAssistant = Omit<AiAssistant, 'compareAuthors'> & {
  usage(): AiUsage;
  compareAuthors(a: string[], b: string[]): Promise<AuthorComparison | null>;
};

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_INPUT_CHARS = 6000;
export const DEFAULT_CONCURRENCY = 4;

/** Zakres, do którego ograniczana jest ocena wspólnego autorstwa — stylometria niczego nie przesądza. */
export const AUTHOR_LIKELIHOOD_RANGE = { min: 5, max: 85 } as const;
export const AUTHOR_CAVEAT =
  'Zastrzeżenie: to słaba wskazówka stylometryczna z modelu językowego — nie dowód wspólnego autorstwa; wymaga potwierdzenia innymi śladami.';

const MAX_SUMMARY_WORDS = 160;
const MAX_REASONS = 8;

/** Fragment treści o długości `max` wokół adresu (albo początek, gdy adresu nie ma). */
export function windowAround(text: string, address: string | undefined, max: number): string {
  if (text.length <= max) return text;
  const at = address ? text.toLowerCase().indexOf(address.toLowerCase()) : -1;
  const center = at === -1 ? max / 2 : at + address!.length / 2;
  const start = Math.round(Math.min(Math.max(center - max / 2, 0), text.length - max));
  return text.slice(start, start + max);
}

function limiter(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (job) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await job();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

const isLocal = (endpoint: string): boolean => {
  try {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$)|\.(local|internal|lan)$/.test(host);
  } catch {
    return false;
  }
};

const strings = (value: unknown, maxItems: number, maxChars: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .slice(0, maxItems)
        .map((item) => item.trim().slice(0, maxChars))
    : [];

const shortText = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && value.trim().length <= max ? value.trim() : undefined;

/** Wynik weryfikacji: wartość albo odrzucenie z powodem do dziennika. */
type Checked<T> = { value: T } | { rejected: string };

interface Task<T> {
  name: string;
  promptVersion: string;
  /** Wszystko, od czego zależy wynik — do klucza pamięci podręcznej. */
  cacheInput: unknown;
  system: string;
  user: string;
  jsonSchema: JsonSchema;
  maxTokens: number;
  check(answer: Record<string, unknown>, completion: Completion): Checked<T>;
}

/**
 * Tworzy asystenta albo zwraca `null`, gdy moduł jest wyłączony (`provider: 'none'`, brak
 * konfiguracji) lub konfiguracja jest niepełna. Domyślnie wyłączony: bez jawnego wskazania
 * dostawcy żadna treść nie opuszcza narzędzia.
 */
export function createAiAssistant(config: AiConfig | null | undefined): OlcysAiAssistant | null {
  if (!config || config.provider === 'none') return null;

  // Klucz nie może trafić do dziennika, nawet jeśli serwer odeśle go w treści błędu.
  const secret = config.apiKey && config.apiKey.length >= 4 ? config.apiKey : undefined;
  const log = (message: string) => config.log?.(secret ? message.split(secret).join('[klucz]') : message);

  const counters: AiUsage = { tasks: 0, requests: 0, cacheHits: 0, failures: 0, rejected: 0, inputTokens: 0, outputTokens: 0 };
  const hooks = { onRequest: () => void (counters.requests += 1), log };

  let provider: Provider;
  if (config.provider === 'openai-compatible') {
    if (!config.baseUrl || !config.model) {
      log('Model językowy wyłączony: dostawca openai-compatible wymaga adresu (AI_BASE_URL) i nazwy modelu (AI_MODEL).');
      return null;
    }
    provider = createOpenAiCompatibleProvider({ ...config, baseUrl: config.baseUrl, model: config.model }, hooks);
  } else if (config.provider === 'anthropic') {
    if (!config.apiKey) {
      log('Model językowy wyłączony: dostawca anthropic wymaga klucza (AI_API_KEY lub ANTHROPIC_API_KEY).');
      return null;
    }
    provider = createAnthropicProvider({ ...config, apiKey: config.apiKey }, hooks);
  } else {
    log(`Model językowy wyłączony: nieznany dostawca „${String(config.provider)}”.`);
    return null;
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInputChars = config.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const cache = config.cache ?? new Map<string, unknown>();
  const inFlight = new Map<string, Promise<unknown>>();
  const limit = limiter(Math.max(1, Math.floor(config.concurrency ?? DEFAULT_CONCURRENCY)));

  /** `failed` = błąd dostawcy (nie zapamiętujemy); odrzucenie przez weryfikację to zwykły wynik `null`. */
  async function execute<T>(task: Task<T>): Promise<{ value: T | null; failed: boolean }> {
    let completion: Completion;
    try {
      completion = await limit(() =>
        provider.complete({
          system: task.system,
          user: task.user,
          jsonSchema: task.jsonSchema,
          schemaName: task.promptVersion.replace(/[^A-Za-z0-9_-]/g, '_'),
          maxTokens: task.maxTokens,
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch (error) {
      counters.failures += 1;
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `przekroczony limit czasu ${timeoutMs} ms`
          : error instanceof Error
            ? error.message
            : String(error);
      log(`Model (${task.name}): błąd dostawcy — ${reason}. Analiza trwa dalej bez modelu.`);
      return { value: null, failed: true };
    }
    counters.inputTokens += completion.inputTokens ?? 0;
    counters.outputTokens += completion.outputTokens ?? 0;

    const answer = extractJson(completion.text);
    if (!answer) {
      counters.failures += 1;
      log(`Model (${task.name}): w odpowiedzi nie ma obiektu JSON — pominięto.`);
      return { value: null, failed: true };
    }
    const checked = task.check(answer, completion);
    if ('rejected' in checked) {
      counters.rejected += 1;
      log(`Model (${task.name}): odpowiedź odrzucona — ${checked.rejected}.`);
      return { value: null, failed: false };
    }
    return { value: checked.value, failed: false };
  }

  /** Pamięć podręczna po skrócie: model + wersja polecenia + wejście. Błędy dostawcy nie są zapamiętywane. */
  async function run<T>(task: Task<T>): Promise<T | null> {
    counters.tasks += 1;
    const cacheKey = createHash('sha256')
      .update(JSON.stringify([provider.id, provider.model, task.promptVersion, task.cacheInput]))
      .digest('hex');
    if (cache.has(cacheKey)) {
      counters.cacheHits += 1;
      return structuredClone(cache.get(cacheKey)) as T | null;
    }
    // Takie samo zadanie już w toku — czekamy na jego wynik zamiast pytać drugi raz.
    const pending = inFlight.get(cacheKey);
    if (pending) {
      counters.cacheHits += 1;
      return structuredClone(await pending) as T | null;
    }
    const job = execute(task).then(({ value, failed }) => {
      // Odrzucenie przez weryfikację też zapamiętujemy — ta sama treść dałaby ten sam wynik.
      if (!failed) cache.set(cacheKey, value);
      return value;
    });
    inFlight.set(cacheKey, job);
    try {
      return structuredClone(await job);
    } finally {
      inFlight.delete(cacheKey);
    }
  }

  const where = isLocal(provider.endpoint) ? 'w sieci lokalnej' : 'w usłudze zewnętrznej';

  return {
    id: provider.id,
    model: provider.model,
    description:
      `Model ${provider.model} ${where} (${provider.endpoint}). Trafia do niego wyłącznie treść publicznej publikacji ` +
      `(do ${maxInputChars} znaków, z tytułem i nazwą autora) albo lista faktów do streszczenia — nigdy identyfikatory sprawy, ` +
      'dane analityka ani notatki. Odczyt jest sugestią z dosłownym cytatem; o wyniku decydują jawne reguły.',

    analyzePublication(input) {
      const text = windowAround(input.text, input.address, maxInputChars);
      if (text.length < input.text.length) {
        log(`Model (publikacja): treść skrócona z ${input.text.length} do ${text.length} znaków${input.address ? ' wokół adresu' : ''}.`);
      }
      const sent = { text, address: input.address, author: input.author, title: input.title };
      return run<TextInsight>({
        name: 'publikacja',
        promptVersion: PROMPT_VERSIONS.publication,
        cacheInput: sent,
        system: PUBLICATION_SYSTEM,
        user: publicationUser(sent),
        jsonSchema: PUBLICATION_SCHEMA,
        maxTokens: 4000,
        check(answer, completion) {
          // Cytat musi występować dosłownie w publikacji — inaczej cały odczyt jest bezwartościowy.
          const quote = verifyQuote(answer.quote, [input.text, input.title ?? '']);
          if (!quote) return { rejected: 'cytat nie występuje dosłownie w treści publikacji' };

          const ownership = (OWNERSHIP_VALUES as readonly unknown[]).includes(answer.ownership)
            ? (answer.ownership as TextInsight['ownership'])
            : 'unclear';
          const language = typeof answer.language === 'string' && /^[a-z]{2}$/i.test(answer.language.trim()) ? answer.language.trim().toLowerCase() : 'und';
          const insight: TextInsight = {
            ownership,
            language,
            quote,
            model: completion.model ?? provider.model,
            promptVersion: PROMPT_VERSIONS.publication,
          };

          if ((SUGGESTED_CATEGORIES as readonly unknown[]).includes(answer.suggestedCategory)) {
            insight.suggestedCategory = answer.suggestedCategory as SourceCategory;
          }
          const translation = language !== 'pl' ? shortText(answer.translationPl, maxInputChars * 3) : undefined;
          if (translation) insight.translationPl = translation;

          const nexus = answer.polishNexus as { score?: unknown; reasons?: unknown } | null | undefined;
          if (nexus && typeof nexus.score === 'number' && Number.isFinite(nexus.score)) {
            const signal: ScoredSignal = {
              score: Math.round(Math.min(100, Math.max(0, nexus.score))),
              reasons: strings(nexus.reasons, MAX_REASONS, 300),
            };
            insight.polishNexus = signal;
          }

          const offer = answer.offer as Record<string, unknown> | null | undefined;
          if (offer && typeof offer === 'object' && (OFFER_SIDES as readonly unknown[]).includes(offer.side)) {
            // Kwota i miejscowość muszą dać się odnaleźć w treści lub tłumaczeniu — inaczej pole znika.
            const sources = [input.text, input.title ?? '', translation ?? ''];
            const checkedOffer: NonNullable<TextInsight['offer']> = {
              side: offer.side as NonNullable<TextInsight['offer']>['side'],
              paymentMethods: strings(offer.paymentMethods, 10, 60),
            };
            const asset = shortText(offer.asset, 20);
            if (asset) checkedOffer.asset = asset;
            const currency = shortText(offer.currency, 20);
            if (currency) checkedOffer.currency = currency;
            if (typeof offer.amount === 'number') {
              if (amountInText(offer.amount, sources)) checkedOffer.amount = offer.amount;
              else log(`Model (publikacja): usunięto kwotę ${offer.amount} — nie ma jej w treści.`);
            }
            const location = shortText(offer.location, 80);
            if (location) {
              if (locationInText(location, sources)) checkedOffer.location = location;
              else log(`Model (publikacja): usunięto miejscowość „${location}” — nie ma jej w treści.`);
            }
            // Waluta bez kwoty nic nie znaczy.
            if (checkedOffer.amount === undefined) delete checkedOffer.currency;
            insight.offer = checkedOffer;
          }
          return { value: insight };
        },
      });
    },

    async summarize(facts) {
      const clean = facts.map((fact) => fact.trim()).filter(Boolean);
      // Limit wejścia: odcinamy całe fakty z końca listy (i odnotowujemy to), nigdy w połowie zdania.
      const budget = maxInputChars * 2;
      const used: string[] = [];
      let size = 0;
      for (const fact of clean) {
        if (size + fact.length > budget && used.length > 0) break;
        used.push(fact);
        size += fact.length;
      }
      if (used.length === 0) return null;
      if (used.length < clean.length) log(`Model (streszczenie): użyto ${used.length} z ${clean.length} faktów (limit wejścia).`);

      return run<{ text: string; model: string; promptVersion: string }>({
        name: 'streszczenie',
        promptVersion: PROMPT_VERSIONS.summary,
        cacheInput: used,
        system: SUMMARY_SYSTEM,
        user: summaryUser(used),
        jsonSchema: SUMMARY_SCHEMA,
        maxTokens: 800,
        check(answer, completion) {
          const text = typeof answer.text === 'string' ? answer.text.replace(/\s+/g, ' ').trim() : '';
          if (!text) return { rejected: 'puste streszczenie' };
          const words = text.split(' ').length;
          if (words > MAX_SUMMARY_WORDS) return { rejected: `streszczenie za długie (${words} słów)` };
          const unsupported = unsupportedInSummary(text, used);
          if (unsupported.length > 0) {
            return { rejected: `streszczenie zawiera liczby lub adresy spoza faktów: ${unsupported.slice(0, 5).join(', ')}` };
          }
          return { value: { text, model: completion.model ?? provider.model, promptVersion: PROMPT_VERSIONS.summary } };
        },
      });
    },

    async compareAuthors(a, b) {
      // Każdy zbiór dostaje połowę limitu wejścia; nadmiarowe wypowiedzi są pomijane w całości.
      const fit = (items: string[]) => {
        const kept: string[] = [];
        let size = 0;
        for (const item of items.map((value) => value.trim()).filter(Boolean)) {
          const piece = item.slice(0, maxInputChars / 2 - size);
          if (!piece) break;
          kept.push(piece);
          size += piece.length;
        }
        return kept;
      };
      const left = fit(a);
      const right = fit(b);
      if (left.length === 0 || right.length === 0) return null;

      return run<AuthorComparison>({
        name: 'porównanie autorów',
        promptVersion: PROMPT_VERSIONS.authors,
        cacheInput: [left, right],
        system: AUTHORS_SYSTEM,
        user: authorsUser(left, right),
        jsonSchema: AUTHORS_SCHEMA,
        maxTokens: 800,
        check(answer, completion) {
          if (typeof answer.likelihood !== 'number' || !Number.isFinite(answer.likelihood)) {
            return { rejected: 'brak liczbowej oceny' };
          }
          const { min, max } = AUTHOR_LIKELIHOOD_RANGE;
          return {
            value: {
              likelihood: Math.round(Math.min(max, Math.max(min, answer.likelihood))),
              reasons: [...strings(answer.reasons, MAX_REASONS, 300), AUTHOR_CAVEAT],
              model: completion.model ?? provider.model,
              promptVersion: PROMPT_VERSIONS.authors,
            },
          };
        },
      });
    },

    usage: () => ({ ...counters }),
  };
}
