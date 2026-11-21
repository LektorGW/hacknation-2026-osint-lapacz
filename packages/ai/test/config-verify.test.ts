import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiConfigFromEnv, amountInText, createAiAssistant, extractJson, locationInText, unsupportedInSummary, verifyQuote } from '../src/index.ts';

test('aiConfigFromEnv: brak konfiguracji i none → null', () => {
  assert.equal(aiConfigFromEnv({}), null);
  assert.equal(aiConfigFromEnv({ AI_PROVIDER: 'none', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x' }), null);
  assert.equal(aiConfigFromEnv({ AI_PROVIDER: ' NONE ' }), null);
  assert.equal(aiConfigFromEnv({ AI_PROVIDER: '' }), null);
  assert.equal(aiConfigFromEnv({ AI_BASE_URL: 'http://localhost:11434/v1', AI_MODEL: 'bielik' }), null, 'sam adres nie włącza modułu');
  assert.equal(aiConfigFromEnv({ AI_PROVIDER: 'gemini', AI_API_KEY: 'x' }), null, 'nieznany dostawca');
});

test('aiConfigFromEnv: openai-compatible', () => {
  assert.deepEqual(
    aiConfigFromEnv({ AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'http://localhost:11434/v1/', AI_MODEL: 'SpeakLeash/bielik-11b-v2.3-instruct:Q4_K_M' }),
    { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'SpeakLeash/bielik-11b-v2.3-instruct:Q4_K_M' },
  );
  assert.deepEqual(aiConfigFromEnv({ AI_PROVIDER: 'openai', AI_BASE_URL: 'https://router.example/v1', AI_API_KEY: 'k', AI_MODEL: 'm' }), {
    provider: 'openai-compatible',
    baseUrl: 'https://router.example/v1',
    apiKey: 'k',
    model: 'm',
  });
  // Alias: sam OPENAI_API_KEY → OpenAI; nazwy modelu nie zakładamy.
  assert.deepEqual(aiConfigFromEnv({ OPENAI_API_KEY: 'sk-x' }), { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' });
  assert.equal(createAiAssistant(aiConfigFromEnv({ OPENAI_API_KEY: 'sk-x' })), null, 'bez AI_MODEL asystent nie powstaje');
  assert.deepEqual(aiConfigFromEnv({ OPENAI_API_KEY: 'sk-x', AI_MODEL: 'gpt-x' }), {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    model: 'gpt-x',
  });
  // Klucz OpenAI nie jest wysyłany pod inny adres.
  assert.deepEqual(aiConfigFromEnv({ AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'http://10.0.0.5:8000/v1', AI_MODEL: 'pllum', OPENAI_API_KEY: 'sk-x' }), {
    provider: 'openai-compatible',
    baseUrl: 'http://10.0.0.5:8000/v1',
    model: 'pllum',
  });
});

test('aiConfigFromEnv: anthropic', () => {
  assert.deepEqual(aiConfigFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' }), { provider: 'anthropic', apiKey: 'sk-ant-x' });
  assert.equal(createAiAssistant(aiConfigFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' }))?.model, 'claude-fable-5-2');
  assert.deepEqual(aiConfigFromEnv({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'sk-ant-y', AI_MODEL: 'claude-haiku-5-5', ANTHROPIC_API_KEY: 'sk-ant-x' }), {
    provider: 'anthropic',
    apiKey: 'sk-ant-y',
    model: 'claude-haiku-5-5',
  });
  assert.deepEqual(aiConfigFromEnv({ AI_PROVIDER: 'anthropic' }), { provider: 'anthropic' });
  assert.equal(createAiAssistant(aiConfigFromEnv({ AI_PROVIDER: 'anthropic' })), null, 'bez klucza asystent nie powstaje');
});

test('aiConfigFromEnv: dwa klucze bez AI_PROVIDER → null; z AI_PROVIDER wybór jest jawny', () => {
  const both = { OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x' };
  assert.equal(aiConfigFromEnv(both), null);
  assert.deepEqual(aiConfigFromEnv({ ...both, AI_PROVIDER: 'anthropic' }), { provider: 'anthropic', apiKey: 'sk-ant-x' });
  assert.deepEqual(aiConfigFromEnv({ ...both, AI_PROVIDER: 'openai-compatible', AI_MODEL: 'gpt-x' }), {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    model: 'gpt-x',
  });
});

test('aiConfigFromEnv: ustawienia dodatkowe', () => {
  assert.deepEqual(
    aiConfigFromEnv({ ANTHROPIC_API_KEY: 'k', AI_TIMEOUT_MS: '90000', AI_MAX_INPUT_CHARS: '4000', AI_CONCURRENCY: '2', AI_EFFORT: 'Medium', AI_REFUSAL_FALLBACK: '0' }),
    { provider: 'anthropic', apiKey: 'k', timeoutMs: 90000, maxInputChars: 4000, concurrency: 2, effort: 'medium', refusalFallback: false },
  );
  assert.deepEqual(aiConfigFromEnv({ ANTHROPIC_API_KEY: 'k', AI_TIMEOUT_MS: 'abc', AI_EFFORT: 'turbo' }), { provider: 'anthropic', apiKey: 'k' });
});

test('extractJson', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('tekst {"a":{"b":"}"}} tekst'), { a: { b: '}' } });
  assert.deepEqual(extractJson('{nie json} potem {"a":"\\"{"}'), { a: '"{' });
  assert.deepEqual(extractJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.equal(extractJson('[1,2,3]'), undefined);
  assert.equal(extractJson('brak'), undefined);
  assert.equal(extractJson('{"a": 1'), undefined);
});

test('verifyQuote', () => {
  const text = 'Wpłaty  proszę\nkierować na adres bc1qabc. Dziękuję za wsparcie!';
  assert.equal(verifyQuote('Wpłaty proszę kierować na adres bc1qabc.', [text]), 'Wpłaty proszę kierować na adres bc1qabc.');
  assert.equal(verifyQuote('wpłaty proszę kierować na adres bc1qabc.', [text]), undefined, 'wielkość liter ma znaczenie');
  assert.equal(verifyQuote('Wpłaty prosze kierować na adres', [text]), undefined, 'poprawiona pisownia to nie cytat');
  assert.equal(verifyQuote('adres', [text]), undefined, 'za krótki');
  assert.equal(verifyQuote(undefined, [text]), undefined);
  assert.equal(verifyQuote('Mój BTC', ['Mój BTC']), 'Mój BTC', 'krótka treść może być zacytowana w całości');
});

test('amountInText: zapisy liczb', () => {
  const yes: [number, string][] = [
    [150000, 'Cena 150 000 zł'],
    [150000, 'Cena 150.000 zł'],
    [150000, 'price 150,000 USD'],
    [150000, 'cena 150 tys. zł'],
    [150000, '150k PLN'],
    [0.5, 'sprzedam 0.5 BTC'],
    [0.5, 'sprzedam 0,5 BTC'],
    [1234.56, 'kwota 1 234,56 zł'],
    [1234.56, 'amount 1,234.56 USD'],
    [2000000, '2 mln zł'],
    [1500, '1.500 zł'],
    [1.5, '1.500 BTC'],
    [100, '100USDT'],
  ];
  for (const [amount, text] of yes) assert.equal(amountInText(amount, [text]), true, `${amount} w „${text}”`);
  const no: [number, string][] = [
    [250000, 'Cena 150 000 zł'],
    [15, 'Cena 150 000 zł'],
    [125, 'kurs 12,5'],
    [42, 'adres bc1q42xyzabcdefghijk42mnoprstuwxyz42'],
    [7, 'adres 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'],
  ];
  for (const [amount, text] of no) assert.equal(amountInText(amount, [text]), false, `${amount} w „${text}”`);
});

test('locationInText: odmiana i znaki diakrytyczne', () => {
  assert.equal(locationInText('Kraków', ['odbiór w Krakowie']), true);
  assert.equal(locationInText('Łódź', ['spotkanie w Lodzi']), true);
  assert.equal(locationInText('Zielona Góra', ['tylko Zielona Gora']), true);
  assert.equal(locationInText('Warszawa', ['Продам, Варшава', 'Sprzedam, Warszawa']), true);
  assert.equal(locationInText('Gdańsk', ['odbiór w Krakowie']), false);
  assert.equal(locationInText('Zielona Góra', ['zielona herbata']), false);
  assert.equal(locationInText('', ['cokolwiek']), false);
});

test('unsupportedInSummary', () => {
  const facts = ['Adres 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D ma 3 ślady.', 'Wypłaty: 12,5 tys. zł w dniu 2025-03-14.'];
  assert.deepEqual(unsupportedInSummary('Adres 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D ma 3 ślady, wypłaty 12 500 zł (2025-03-14).', facts), []);
  assert.deepEqual(unsupportedInSummary('Adres 0x7a25…488D ma 3 ślady.', facts), []);
  assert.deepEqual(unsupportedInSummary('Adres ma 4 ślady.', facts), ['4']);
  assert.deepEqual(unsupportedInSummary('Wypłaty 12,5 zł.', facts), [], 'ta sama liczba — jednostki nie są porównywane');
  assert.deepEqual(unsupportedInSummary('Wypłaty to 80% środków.', facts), ['80']);
  assert.deepEqual(unsupportedInSummary('Adres 0x0000000000000000000000000000000000000001.', facts), ['0x0000000000000000000000000000000000000001']);
  assert.deepEqual(unsupportedInSummary('Bez liczb i adresów.', facts), []);
});
