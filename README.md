# OŁCyŚ — OSINTowy Łapacz Cyfrowych Śladów (HackNation 2026, MF / KAS)

Narzędzie, które na podstawie identyfikatora podmiotu (imię i nazwisko, nick, login, e-mail, adres krypto) przeszukuje publiczne źródła, znajduje powiązane adresy kryptowalutowe i ocenia wiarygodność powiązania Wskaźnikiem Pewności (0–100%).

Status: szkielet monorepo (21.11.2026).

## Struktura
- `packages/core/` — logika niezależna od źródeł: wykrywanie i walidacja adresów, Wskaźnik Pewności (gotowe, z testami)
- `apps/` — API, interfejs analityka i syntetyczne źródła do demo (w przygotowaniu)
- `docs/` — architektura, scenariusze testowe, licencje komponentów

## Uruchomienie testów
Wymagany Node 24+ i pnpm.

```
pnpm install
pnpm test
```

## Zasady zadania, których pilnujemy
- wyłącznie publiczne źródła; bez skanowania, logowania na cudze konta i obchodzenia zabezpieczeń
- każdy wynik ze źródłem, URL, datą i czasem pozyskania
- raport rozróżnia fakty źródłowe, wyniki obliczeń i wnioski do weryfikacji
- dane testowe i wyniki nie są wysyłane do niezatwierdzonych usług zewnętrznych
- model AI wymienialny przez konfigurację; komponenty open source ze wskazaną licencją
