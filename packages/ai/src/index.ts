// Wsparcie modelu językowego — rola wyłącznie pomocnicza, domyślnie wyłączone.
// Opis, zasady przekazywania danych i sposób weryfikacji odpowiedzi: README.md.

export { aiConfigFromEnv, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_ANTHROPIC_MODEL, OPENAI_BASE_URL } from './config.ts';
export type { AiConfig, AiProviderId } from './config.ts';
export {
  createAiAssistant,
  windowAround,
  AUTHOR_CAVEAT,
  AUTHOR_LIKELIHOOD_RANGE,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_TIMEOUT_MS,
} from './assistant.ts';
export type { AiUsage, AuthorComparison, OlcysAiAssistant } from './assistant.ts';
export { createAnthropicProvider, createOpenAiCompatibleProvider, ProviderError } from './providers.ts';
export type { Completion, CompletionRequest, Provider, ProviderHooks } from './providers.ts';
export {
  PROMPT_VERSIONS,
  PUBLICATION_SCHEMA,
  PUBLICATION_SYSTEM,
  SUMMARY_SCHEMA,
  SUMMARY_SYSTEM,
  AUTHORS_SCHEMA,
  AUTHORS_SYSTEM,
  OWNERSHIP_VALUES,
  SUGGESTED_CATEGORIES,
  OFFER_SIDES,
  dataBlock,
  publicationUser,
  summaryUser,
  authorsUser,
} from './prompts.ts';
export type { JsonSchema } from './prompts.ts';
export { amountInText, extractJson, locationInText, normalizeWhitespace, unsupportedInSummary, verifyQuote } from './verify.ts';
