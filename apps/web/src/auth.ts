// Token API (OLCYS_API_TOKEN po stronie usługi) w karcie przeglądarki.
// Przechowywany w sessionStorage (znika po zamknięciu karty) oraz w ciasteczku sesyjnym SameSite=Strict
// ograniczonym do /api — ciasteczko jest potrzebne tylko do otwierania raportów i pobierania plików
// zwykłym odnośnikiem; usługa przyjmuje je wyłącznie dla żądań GET.

const STORAGE_KEY = 'olcys:token-api';
const COOKIE = 'olcys_token';
export const AUTH_EVENT = 'olcys:auth-required';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Prywatny tryb przeglądarki bez dostępu do sessionStorage — token zostaje tylko w ciasteczku.
  }
  try {
    document.cookie = token
      ? `${COOKIE}=${encodeURIComponent(token)}; path=/api; SameSite=Strict`
      : `${COOKIE}=; path=/api; SameSite=Strict; Max-Age=0`;
  } catch {
    // Brak dostępu do ciasteczek — działa sam nagłówek Authorization.
  }
}

/** Nagłówek uwierzytelnienia dla żądań fetch (pusty, gdy token nie jest ustawiony). */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Prośba o token — okno logowania nasłuchuje tego zdarzenia (odpowiedź 401 z usługi). */
export function requestToken(): void {
  window.dispatchEvent(new Event(AUTH_EVENT));
}
