# API OŁCyŚ

Serwer HTTP (Fastify, Node 24 — TypeScript uruchamiany natywnie, bez kroku budowania).

```
node src/server.ts          # start (domyślnie 127.0.0.1:4000)
node --test test/*.test.ts  # testy: atrapy źródeł, baza w pamięci, bez internetu
```

## Baza danych

Domyślnie działa wbudowany PGlite (PostgreSQL w procesie) z katalogiem danych `./data/pg`
(`OLCYS_DATA_DIR`). To wygodne na jednym stanowisku, ale katalog może obsługiwać tylko jeden
proces naraz i nie znosi nagłego przerwania zapisu.

Do pracy na prawdziwych danych zalecany jest zwykły serwer PostgreSQL (14 lub nowszy):

```
createdb olcys
DATABASE_URL=postgres://uzytkownik:haslo@localhost:5432/olcys node src/server.ts
```

Schemat (`src/schema.sql`) jest zakładany i uzupełniany przy każdym starcie — wszystkie
polecenia są idempotentne, więc nie ma osobnego kroku migracji. Ten sam SQL działa na obu
sterownikach. Indeks publikacji (`corpus`) rośnie o kilkanaście tysięcy wierszy na cykl
monitoringu; przy takim obciążeniu PostgreSQL jest wyraźnie szybszy od PGlite.

`GET /api/health` zwraca także stan bazy: `{ status, version, time, database: 'ok' | 'error' }`.

## Zamykanie

Sygnały SIGINT, SIGTERM, SIGBREAK i SIGHUP zamykają serwer łagodnie: Fastify kończy bieżące
żądania, monitoring i analizy w tle są przerywane i zapisywane, a na końcu zamykany jest
sterownik bazy (PGlite `close()` albo pula połączeń). Procesu nie należy zabijać na siłę
(`kill -9`, „Zakończ zadanie”) — przy PGlite grozi to uszkodzeniem katalogu danych.

## Zmienne środowiskowe

| Zmienna | Znaczenie |
|---|---|
| `API_PORT`, `API_HOST` | port i adres nasłuchu (domyślnie 4000, 127.0.0.1) |
| `DATABASE_URL` | zewnętrzny PostgreSQL; bez niej PGlite w `OLCYS_DATA_DIR` |
| `SANDBOX_URL` | środowisko demonstracyjne (domyślnie `http://localhost:4100`) |
| `ENABLE_LIVE` | `1` włącza źródła w prawdziwym internecie |
| `GITHUB_TOKEN` | wyższy limit publicznego API GitHuba; nie jest logowany ani zapisywany |
| `TOR_PROXY_URL` | pośrednik dla źródeł w sieci Tor |
| `CORPUS_RETENTION_DAYS`, `CORPUS_MAX_ROWS` | przechowywanie indeksu publikacji (domyślnie 30 dni, 200 000 wierszy) |
| zmienne modelu językowego | opis w `packages/ai/README.md`; bez nich model jest wyłączony |

## Tryby analizy

`POST /api/cases/:id/runs` i `POST /api/quick` przyjmują `depth: 'standard' | 'deep'` oraz
`async: true`.

| | standardowy | głęboki |
|---|---|---|
| źródła | domyślnie włączone + indeks własny | dodatkowo `deep-search` i źródła `mon-*` z wyszukiwaniem |
| kroki odkrywania identyfikatorów | 3 | 4 |
| adresy z analizą blockchain | 15 | 40 (dostawcy w trybie `deep`) |
| limit czasu zapytania / całej analizy | 20 s / 120 s | 45 s (wyszukiwarka forów 60 s) / 240 s |

Po przekroczeniu limitu czasu analiza kończy się wynikiem częściowym (`Dossier.partial`), nie błędem.
Z `async: true` odpowiedź przychodzi od razu (`202 { id, status: 'running' }`), postęp jest pod
`GET /api/runs/:id/progress`, a wynik pod `GET /api/runs/:id`.

## Model językowy

Opcjonalny i wyłącznie pomocniczy: czyta publikacje, porównuje styl autorów i streszcza gotowe
ustalenia. O wyniku decydują jawne reguły (`GET /api/priority-rules` → `ai`); każdy wpływ modelu
ma wpis w księdze Wskaźnika Pewności i może zostać cofnięty decyzją analityka. Do modelu
działającego poza tą maszyną fakty do streszczenia trafiają bez danych osobowych i adresów
(znaczniki `[OSOBA-1]`, `[ADRES-1]`…). Stan: `GET /api/ai`.

## Próba całości bez otwierania portu

`node test/e2e-sandbox.manual.ts [identyfikator…]` wywołuje aplikację przez `app.inject`
na bazie w pamięci. `LIVE=1 DEPTH=deep SANDBOX_URL=off` uruchamia analizę głęboką na
prawdziwych źródłach; `MONITOR=1` — przebieg monitoringu; `SWEEP=<limit>` — przegląd źródeł.
