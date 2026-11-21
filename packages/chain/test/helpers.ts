// Atrapa `fetch`: odpowiada z tabeli adres → odpowiedź i zapisuje wywołania.
// Adres spoza tabeli daje 404, więc test nigdy nie łączy się z internetem.

import type { ConnectorContext } from '@olcys/core';
import type { FetchLike } from '../src/http.ts';

export interface MockFetch {
  fetch: FetchLike;
  calls: string[];
}

export function mockFetch(routes: Record<string, unknown | { status: number }>): MockFetch {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (typeof route === 'object' && route !== null && 'status' in route && Object.keys(route).length === 1) {
      return new Response('error', { status: (route as { status: number }).status });
    }
    return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchImpl, calls };
}

export function testContext(): ConnectorContext & { messages: string[] } {
  const messages: string[] = [];
  return { messages, log: (message) => messages.push(message) };
}
