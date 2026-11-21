// Atrapy do testów: `fetch` z kolejką zapisanych odpowiedzi obu dostawców. Bez internetu.

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** Obiekt zostanie zapisany jako JSON; napis trafia do odpowiedzi bez zmian. */
  body: unknown;
}

/** `fetch`, który zwraca kolejne odpowiedzi z listy i zapisuje żądania. Brak odpowiedzi = błąd testu. */
export function fakeFetch(replies: Reply[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...replies];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: JSON.parse(String(init?.body)),
    });
    const reply = queue.shift();
    if (!reply) throw new Error('fakeFetch: nieoczekiwane żądanie — brak zapisanej odpowiedzi');
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

/** Odpowiedź w formacie `POST /chat/completions`. */
export const openaiReply = (content: unknown, extra: Record<string, unknown> = {}): Reply => ({
  body: {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model-2026',
    choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 420, completion_tokens: 80, total_tokens: 500 },
    ...extra,
  },
});

/** Odpowiedź w formacie Anthropic Messages API (z pustym blokiem rozumowania, jak w bieżących modelach). */
export const anthropicReply = (content: unknown, extra: Record<string, unknown> = {}): Reply => ({
  body: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-fable-5-2',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 510, output_tokens: 95 },
    ...extra,
  },
});

export const ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

export const PUBLICATION =
  'Sprzedam 0.5 BTC za gotówkę, odbiór osobisty Kraków.\n' +
  'Cena 150 000 zł, możliwy BLIK.\n' +
  `Wpłaty na mój adres:   ${ADDRESS}\n` +
  'Kontakt: janek_krypto';

/** Poprawna odpowiedź modelu dla `PUBLICATION`. */
export const goodAnswer = () => ({
  ownership: 'own_address',
  suggestedCategory: 'sale_offer',
  offer: { side: 'sell', asset: 'BTC', amount: 150000, currency: 'PLN', paymentMethods: ['gotówka', 'BLIK'], location: 'Kraków' },
  language: 'pl',
  polishNexus: { score: 90, reasons: ['Treść po polsku: „Sprzedam 0.5 BTC za gotówkę”', 'Polskie miasto: „Kraków”'] },
  translationPl: null,
  quote: `Wpłaty na mój adres: ${ADDRESS}`,
});
