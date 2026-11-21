// Ręczna próba z prawdziwym modelem (testy automatyczne nie łączą się z siecią).
//
//   node --env-file=.env scripts/try.ts                      — wbudowany przykład
//   node scripts/try.ts sciezka/do/publikacji.txt [adres]    — treść z pliku
//   node scripts/try.ts "Sprzedam BTC, wpłaty na bc1q…" [adres]
//
// Konfiguracja ze zmiennych środowiskowych (AI_PROVIDER, AI_BASE_URL, AI_API_KEY, AI_MODEL
// albo OPENAI_API_KEY / ANTHROPIC_API_KEY) — patrz README.md. UWAGA: treść trafi do
// wskazanego dostawcy; używaj wyłącznie treści publicznych.

import { existsSync, readFileSync } from 'node:fs';
import { aiConfigFromEnv, createAiAssistant } from '../src/index.ts';

const SAMPLE_ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const SAMPLE =
  'Sprzedam 0.5 BTC za gotówkę, odbiór osobisty Kraków. Cena 150 000 zł, możliwy BLIK.\n' +
  `Wpłaty na mój adres: ${SAMPLE_ADDRESS}\nKontakt: janek_krypto`;

const [source, addressArg] = process.argv.slice(2);
const text = source ? (existsSync(source) ? readFileSync(source, 'utf8') : source) : SAMPLE;
const address = addressArg ?? (source ? undefined : SAMPLE_ADDRESS);

const config = aiConfigFromEnv(process.env);
if (!config) {
  console.error('Moduł wyłączony: ustaw AI_PROVIDER (+ AI_BASE_URL, AI_MODEL, AI_API_KEY) albo OPENAI_API_KEY / ANTHROPIC_API_KEY.');
  process.exit(1);
}
// Pierwsze wywołanie mocnego modelu bywa wolniejsze niż domyślne 30 s — przy ręcznej próbie dajemy zapas.
const assistant = createAiAssistant({ timeoutMs: 120_000, ...config, log: (message) => console.error(`[dziennik] ${message}`) });
if (!assistant) process.exit(1);

console.error(`[asystent] ${assistant.description}\n`);

const started = Date.now();
const insight = await assistant.analyzePublication({ text, address });
console.log('analyzePublication →', JSON.stringify(insight, null, 2));

if (insight) {
  const facts = [
    `Autor publikacji podaje adres jako: ${insight.ownership}.`,
    `Cytat z publikacji: „${insight.quote}”.`,
    ...(insight.offer?.amount !== undefined ? [`Kwota w ofercie: ${insight.offer.amount} ${insight.offer.currency ?? ''}.`] : []),
  ];
  console.log('\nsummarize →', JSON.stringify(await assistant.summarize(facts), null, 2));
}

const authors = await assistant.compareAuthors(
  ['siema, sprzedam btc, pisz na priv!!', 'no elo, kurs jak zawsze :) odbior krk'],
  ['Dzień dobry. Oferuję sprzedaż kryptowalut; proszę o kontakt e-mailowy.', 'Szanowni Państwo, kurs ustalany jest indywidualnie.'],
);
console.log('\ncompareAuthors →', JSON.stringify(authors, null, 2));

console.error(`\n[zużycie] ${JSON.stringify(assistant.usage())} — ${Date.now() - started} ms`);
