# Bezpieczeństwo, retencja i cykl życia sprawy

Dokument opisuje przegląd bezpieczeństwa usługi analizy (apps/api) i interfejsu (apps/web), wprowadzone poprawki,
ryzyka pozostawione świadomie oraz konfigurację: token API, szyfrowanie migawki bazy, retencję i archiwa spraw.

Zasada nadrzędna: **aktualizacja niczego nie usuwa**. Bez nowych zmiennych środowiskowych narzędzie działa jak
dotąd (brak tokenu, migawka jawna, retencja wyłączona); jedyne zmiany odczuwalne bez konfiguracji to ściślejszy
CORS, nagłówki bezpieczeństwa i limit kosztownych żądań.

## 1. Wyniki przeglądu

| # | Obszar | Stan przed | Ocena | Co zrobiono |
|---|---|---|---|---|
| 1 | Adres nasłuchu | `API_HOST` domyślnie `127.0.0.1` | dobrze | bez zmian; opisano ryzyko proxy (pkt 4) |
| 2 | CORS | `origin: true` — **każda** strona w przeglądarce analityka mogła czytać odpowiedzi API z `localhost:4000` (sprawy, teczki, dane osobowe) | **luka** | tylko adresy interfejsu: domyślnie `http://localhost:5173`, `http://127.0.0.1:5173`, `:4173`; zmiana przez `OLCYS_WEB_ORIGIN` |
| 3 | CSRF | trasy bez treści (np. `POST /api/monitor/run`, `/api/admin/shutdown`) dało się wywołać formularzem z obcej strony | **luka** | żądanie zmieniające dane (POST/PUT/PATCH/DELETE) z nagłówkiem `Origin` spoza listy → 403; ta sama strona (interfejs z portu API) dozwolona |
| 4 | `/api/admin/shutdown` | „tylko lokalnie” po `request.ip` — ale interfejs Vite działa z `--host 0.0.0.0` i proxuje `/api` z `127.0.0.1`, więc **komputer w sieci lokalnej mógł zamknąć API przez port 5173**; przeglądarka (CSRF) także | **luka** | zamknięcie tylko wprost na porcie API: IP pętli zwrotnej, nagłówek `Host` = `localhost:<port>`/`127.0.0.1:<port>`, bez `X-Forwarded-For`/`Forwarded`, bez `Origin`/`Sec-Fetch-Site`; przy `OLCYS_API_TOKEN` także token |
| 5 | DNS rebinding | brak kontroli nagłówka `Host` — obca domena wskazująca na 127.0.0.1 rozmawiałaby z API jak „ta sama strona” | **luka** | `Host` musi być adresem IP, `localhost` albo nazwą z konfiguracji (`OLCYS_WEB_ORIGIN`, `OLCYS_ALLOWED_HOSTS`) — jak w serwerze Vite |
| 6 | Uwierzytelnianie | brak — każdy z dostępem do portu (także przez proxy Vite w sieci lokalnej) widzi wszystkie sprawy | ryzyko | opcjonalny `OLCYS_API_TOKEN` (pkt 2) — **zalecany, gdy interfejs działa z `--host 0.0.0.0`** |
| 7 | Limit treści żądania | domyślny Fastify 1 MiB — za mało na odpowiedź usługi z dokumentem 500 000 znaków UTF-8 (do ~1,5 MB) | błąd | jawne `bodyLimit` 2 MiB |
| 8 | Walidacja wejścia | każda trasa z parametrami lub treścią ma schemat JSON (długości, enumeracje, `additionalProperties: false`); trasy bez schematu treści jej nie czytają | dobrze | nowe trasy też mają schematy |
| 9 | Path traversal | jedyne trasy plikowe: eksport (`:file` — enumeracja), materiał do zapytania (`:file` → identyfikator usługi z teczki, bez dostępu do dysku), interfejs statyczny (`static.ts` — `resolve` + sprawdzenie katalogu) | dobrze | archiwa: nazwa pliku wyłącznie z czasu i skrótu (`olcys-archiwum-<czas>-<sha256>.zip`), wzorzec + sprawdzenie, że ścieżka nie wychodzi poza `OLCYS_ARCHIVE_DIR` |
| 10 | XSS w raportach HTML | `report-html.ts`: każda wartość przez `esc` (`& < > " '`), odnośniki tylko `http(s)` (`javascript:` → tekst); CSP `default-src 'none'; style-src 'unsafe-inline'` | dobrze | CSP uzupełniona o `frame-ancestors 'none'; base-uri 'none'; form-action 'none'` |
| 11 | Nagłówki | brak `nosniff`, `Referrer-Policy`, zakazu osadzania | uzupełniono | każda odpowiedź: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`; odpowiedzi `/api`: ścisła CSP i `Cache-Control: no-store` |
| 12 | Komunikaty błędów | obsługa błędów zwraca wyłącznie komunikat po polsku; 500 → „Błąd wewnętrzny serwera.”, szczegóły tylko w dzienniku serwera | dobrze | test potwierdza brak stosu wywołań w odpowiedzi |
| 13 | Sekrety w dziennikach | klucze tylko w nagłówkach (`GITHUB_TOKEN`, `BLOCKSCOUT_API_KEY` — maskowany, klucze modeli); Fastify loguje metodę, URL i adres — bez nagłówków. Wyjątek: Mojeek wymaga klucza w adresie — klient HTTP loguje tylko host | dobrze | token API nigdy nie jest logowany ani zwracany; `/api/security/status` podaje tylko „włączony / wyłączony” |
| 14 | Ruch wychodzący | wyłącznie skonfigurowane źródła (`ENABLE_LIVE`, piaskownica, laboratorium, model językowy); brak telemetrii (przeszukano kod) | dobrze | bez zmian |
| 15 | SSRF | `packages/sources/src/http.ts`: `publicOnly` blokuje adresy prywatne, pętlę zwrotną, link-local, CGNAT, multiemisję, IPv6 ULA/link-local, IPv4 w IPv6 i NAT64; przekierowania sprawdzane ręcznie na każdym skoku; używane dla hostów od użytkownika (`www`, fediwersum z jawnym hostem, Nostr NIP-05, monitoring HTML) | dobrze | **ryzyko szczątkowe**: sprawdzenie DNS i połączenie to dwa kroki (TOCTOU / DNS rebinding po stronie serwera) — do ewentualnego domknięcia przez przypięcie adresu IP w agencie HTTP; pakietu nie zmieniano |
| 16 | Limit żądań | brak — kosztowne trasy (analiza, rozwinięcie sieci, eksporty, przegląd źródeł) bez ograniczeń | uzupełniono | 30 żądań / min / adres IP / trasa (`OLCYS_RATE_LIMIT_PER_MIN`, `0` wyłącza); 429 z `Retry-After` |
| 17 | Dane w spoczynku | migawka PGlite (`<OLCYS_DATA_DIR>.migawka.tar.gz`) jawna; zapis przez `.tmp` + zmiana nazwy | uzupełniono | opcjonalne AES-256-GCM (`OLCYS_SNAPSHOT_KEY`), sprawdzenie po zapisie, kopia `.bak` do czasu weryfikacji (pkt 3) |
| 18 | Audyt | decyzje / odpowiedzi usług / rozwinięcia sieci mają ślad wycofań, ale brak dziennika pobrań i zmian stanu | uzupełniono | tabela `audit_log` (pkt 5) |

Uwaga do pkt 2: przy proxy Vite (interfejs na 5173) przeglądarka i tak rozmawia z API jako „ta sama strona”
interfejsu, więc ograniczenie CORS niczego w interfejsie nie psuje.

## 2. Token API (`OLCYS_API_TOKEN`)

- Ustawiony (min. 16 znaków, zalecane 32 losowe bajty szesnastkowo) → każde żądanie `/api/*` wymaga
  `Authorization: Bearer <token>`; porównanie w stałym czasie (`crypto.timingSafeEqual` na skrótach SHA-256).
- `/api/health` działa bez tokenu, ale zwraca wtedy tylko `{ "status": "ok", "authRequired": true }` — bez wersji,
  źródeł i konfiguracji.
- Interfejs: przy odpowiedzi 401 pokazuje okno „Wymagane uwierzytelnienie”; token trafia do `sessionStorage` karty
  (znika po jej zamknięciu) i do sesyjnego ciasteczka `olcys_token` (`SameSite=Strict`, `path=/api`). Ciasteczko
  usługa przyjmuje **wyłącznie dla GET/HEAD** (otwarcie raportu HTML, pobranie eksportu zwykłym odnośnikiem) —
  zmiana danych zawsze wymaga nagłówka, więc ciasteczko nie otwiera drogi dla CSRF.
- Zamykanie serwera z tokenem:
  `curl -X POST -H "Authorization: Bearer $OLCYS_API_TOKEN" http://localhost:4000/api/admin/shutdown`.
- Wylogowanie: ekran „Bezpieczeństwo i retencja” → „Wyloguj”.

## 3. Szyfrowanie migawki (`OLCYS_SNAPSHOT_KEY`)

- Klucz: 32 bajty — 64 znaki szesnastkowe albo base64. Generowanie:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Format pliku: znacznik `OLCYS-MIGAWKA-AES256GCM-1`, IV (12 B), znacznik GCM (16 B), szyfrogram tar.gz.
- **Zgodność wstecz**: migawka jawna (starsza) wczytuje się zawsze; z ustawionym kluczem przy najbliższym zapisie
  (co minutę) zostaje zaszyfrowana — dziennik: „Migawka bazy została zaszyfrowana (AES-256-GCM)…”. Bez klucza
  migawka pozostaje jawna jak dotąd.
- **Bez utraty danych**: zapis do `.tmp` → odczyt i odszyfrowanie → porównanie SHA-256 z treścią bazy →
  poprzednia migawka staje się `.bak` → `.tmp` zajmuje jej miejsce → ponowne sprawdzenie → dopiero wtedy `.bak`
  jest usuwany. Nieudane sprawdzenie przywraca poprzednią migawkę. Brak pliku głównego przy starcie → wczytanie `.bak`.
- **Start odmawia**, gdy migawka jest zaszyfrowana, a klucza brak albo jest zły — zamiast wystartować na pustej
  bazie i nadpisać dane przy pierwszym zapisie.
- Klucz przechowuj poza repozytorium (np. menedżer haseł); utrata klucza = utrata dostępu do migawki.
- Zewnętrzny PostgreSQL (`DATABASE_URL`) nie używa migawki — szyfrowanie w spoczynku zapewnia serwer bazy.

## 4. Cykl życia sprawy

Stany: **otwarta** → **zamknięta** (z powodem; tylko do odczytu) → **zarchiwizowana** (zamknięta + archiwum).
Istniejące sprawy dostają stan `open` (kolumny dodawane `ADD COLUMN IF NOT EXISTS`).

| Trasa | Opis |
|---|---|
| `POST /api/cases/:id/close` `{ reason }` | zamknięcie; wyłącza obserwację sprawy; 409, gdy trwa analiza |
| `POST /api/cases/:id/reopen` | przywrócenie |
| `POST /api/cases/:id/archive` | archiwum ZIP (tylko sprawa zamknięta); nagłówek `X-Olcys-Archive-Sha256`; w bazie tylko skrót i metadane |
| `GET /api/cases/:id/archive/latest` | ostatnie archiwum — z pamięci procesu albo z `OLCYS_ARCHIVE_DIR` (ze sprawdzeniem skrótu); inaczej 404 |
| `GET /api/cases/:id/links` | powiązania z innymi sprawami: `{ links[], blocking, deletable, message? }` |
| `DELETE /api/cases/:id` `{ confirm: "<nazwa sprawy>" }` | usunięcie; 400 bez zgodnej nazwy, 409 dla otwartej, trwającej analizy albo powiązań (`{ error, links }`) |
| `GET /api/audit?caseId=&limit=` | dziennik audytu |
| `GET /api/retention/preview` | podgląd retencji (bez zmian w bazie) |
| `GET /api/security/status` | token / szyfrowanie / retencja / archiwa / CORS / limit — wartości logiczne, bez sekretów |

**Tylko do odczytu**: każde żądanie zmieniające dane pod `/api/cases/:id/…` (analiza, identyfikatory, decyzje,
odpowiedzi usług, rozwinięcia sieci, włączenie obserwacji) dla sprawy zamkniętej zwraca 409 z komunikatem po
polsku. Wyjątki: zamknięcie, przywrócenie, archiwum, usunięcie, wyłączenie obserwacji. Automatyczna analiza
obserwowanej sprawy, która została zamknięta, nie startuje (obserwacja wygasa).

**Archiwum** (`olcys-archiwum-sprawy/1`): `MANIFEST.json` (każdy plik z SHA-256 i rozmiarem, czas generowania,
wersja narzędzia, SHA-256 reguł oceny, liczby), `CZYTAJ-MNIE.txt` (sumy w formacie `sha256sum`), `sprawa.json`,
`pakiet.zip` (istniejący eksport ostatniej analizy), `raport.html`, `raport.json`, `analizy/<id>.json`,
`dowody/<id>/<sha256>.txt` (kopie treści źródeł — nazwa = skrót treści, zgodny ze skrótem śladu) ze `spis.json`,
`decyzje.json`, `odpowiedzi-uslug.json`, `rozwiniecia-sieci.json`, `dziennik-audytu.json`.

**Powiązania blokujące usunięcie** (tylko z sprawami **otwartymi**; z zamkniętymi są pokazywane informacyjnie):
wspólny adres kryptowalutowy (wyniki, identyfikatory wejściowe i odkryte, adresy depozytowe z odpowiedzi usług),
bezpośredni przelew (adres jednej sprawy jest kontrahentem drugiej), wspólny identyfikator, wspólny profil
(konto w serwisie), ta sama odpowiedź usługi (usługa + sygnatura), osoba powiązana w teczce wskazująca drugą
sprawę, rozwinięcie sieci, które dotarło do bytu drugiej sprawy (w obie strony).

**Usunięcie** — jedna transakcja: wszystkie tabele z kolumną `case_id` (także dodane w przyszłości), dane analiz
po `run_id` (kopie treści dokumentów), analizy, sprawa; odniesienia w obserwacji, przeglądach źródeł i trafieniach
monitoringu są czyszczone. Zostaje ślad w `case_tombstones` (identyfikator, czas, tryb, skrót archiwum, liczby
usuniętych wierszy — **bez nazw i identyfikatorów osób**) i wpis w dzienniku audytu. Po usunięciu migawka jest
zapisywana od razu. Indeks publikacji monitoringu (`corpus`) nie należy do sprawy — obowiązuje go
`CORPUS_RETENTION_DAYS`.

## 5. Dziennik audytu

Tabela `audit_log` (tylko dopisywanie; bez klucza obcego — wpisy zostają po usunięciu sprawy): czas, wykonawca
(`analityk` — narzędzie nie ma kont), czynność, sprawa, cel (identyfikator techniczny), szczegóły JSON **bez danych
osobowych** (rodzaje, liczby, skróty; z powodu zamknięcia zapisywana jest tylko długość).

Czynności: `sprawa.zamknieta`, `sprawa.przywrocona`, `sprawa.zarchiwizowana`, `archiwum.pobrane`,
`sprawa.usunieta`, `sprawa.usunieta-retencja`, `sprawa.usuniecie-odmowa`, `decyzja.dodana`, `decyzja.wycofana`,
`odpowiedz-uslugi.dodana`, `odpowiedz-uslugi.wycofana`, `siec.rozwinieta`, `siec.rozwiniecie-wycofane`,
`eksport.pobrany`, `raport.pobrany`, `material-zapytania.pobrany`. Żądania wewnętrzne (np. pakiet ZIP składany
z raportu JSON) nie dublują wpisów.

## 6. Retencja (`OLCYS_RETENTION_DAYS_CLOSED`)

- **Domyślnie wyłączona** — bez zmiennej nic nie jest usuwane automatycznie.
- Włączona (liczba dni 1–36500): raz na dobę (pierwszy przebieg 10 min po starcie) zadanie usuwa sprawę wyłącznie,
  gdy jest **zarchiwizowana archiwum utworzonym po zamknięciu**, zamknięta co najmniej N dni temu i **niepowiązana**
  z żadną otwartą sprawą. Spraw bez archiwum zadanie nigdy nie usuwa. Tuż przed usunięciem warunki są sprawdzane
  ponownie. Każde usunięcie: ślad (`mode: retencja`), wpis audytu, wiersz dziennika serwera.
- Podgląd: `GET /api/retention/preview` i ekran „Bezpieczeństwo i retencja” — każda zamknięta sprawa z decyzją
  i powodami (dlaczego tak / dlaczego nie).

## 7. Zmienne środowiskowe

| Zmienna | Opis | Domyślnie |
|---|---|---|
| `OLCYS_API_TOKEN` | token API (min. 16 znaków); wymagany nagłówek `Authorization: Bearer` dla `/api/*` (bez `/api/health`) | wyłączony |
| `OLCYS_SNAPSHOT_KEY` | klucz AES-256-GCM migawki PGlite (64 znaki hex albo base64 32 bajtów) | migawka jawna |
| `OLCYS_RETENTION_DAYS_CLOSED` | po ilu dniach od zamknięcia zarchiwizowana, niepowiązana sprawa jest usuwana | wyłączona |
| `OLCYS_ARCHIVE_DIR` | katalog na pliki archiwów spraw (nazwy bez danych z żądania) | plik nie jest przechowywany |
| `OLCYS_WEB_ORIGIN` | adresy interfejsu dopuszczone przez CORS/CSRF, po przecinku | `http://localhost:5173`, `http://127.0.0.1:5173`, `:4173` |
| `OLCYS_ALLOWED_HOSTS` | dodatkowe nazwy hosta API (nagłówek `Host`); adresy IP i `localhost` zawsze dozwolone | — |
| `OLCYS_RATE_LIMIT_PER_MIN` | limit kosztownych żądań na adres IP i trasę na minutę (`0` wyłącza) | `30` |

Błędna wartość (za krótki token, zły klucz, niepoprawna liczba dni) zatrzymuje start z opisem po polsku — bez
wypisywania wartości tokenu ani klucza.

## 8. Ryzyka pozostawione świadomie

- SSRF: TOCTOU między sprawdzeniem DNS a połączeniem (pkt 1.15).
- Proxy Vite w sieci lokalnej: wszystkie żądania widać jako `127.0.0.1` — limit żądań działa wtedy na całe proxy;
  dostęp z sieci lokalnej zabezpiecza dopiero `OLCYS_API_TOKEN`.
- Brak kont użytkowników: dziennik audytu zapisuje stałego wykonawcę `analityk`.
- Archiwum bez `OLCYS_ARCHIVE_DIR` istnieje tylko u analityka, który je pobrał; baza ma jego skrót do weryfikacji.
