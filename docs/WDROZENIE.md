# Wdrożenie OŁCyŚ na serwerze

Stan dokumentu: 22.11.2026. Dokument opisuje instalację na stanowisku lub serwerze w sieci wewnętrznej, konfigurację, kopie zapasowe, aktualizację i rozwiązywanie problemów.

**Wszystkie składniki działają lokalnie** — API, interfejs, baza (wbudowany PGlite albo własny PostgreSQL), piaskownica z danymi syntetycznymi i opcjonalny model językowy (np. Ollama na tej samej maszynie). Narzędzie nie korzysta z żadnej usługi chmurowej. Połączenia wychodzące powstają wyłącznie wtedy, gdy operator świadomie włączy źródła publiczne (`ENABLE_LIVE=1`) albo wskaże zewnętrzny model językowy.

## Spis treści

1. [Wymagania](#wymagania)
2. [Ścieżka A: Docker](#ścieżka-a-docker)
3. [Ścieżka B: jedno polecenie (Node + pnpm)](#ścieżka-b-jedno-polecenie-node--pnpm)
4. [Ścieżka C: ręcznie](#ścieżka-c-ręcznie)
5. [Polecenia](#polecenia)
6. [Konfiguracja](#konfiguracja)
7. [Przełączanie danych syntetycznych i prawdziwych](#przełączanie-danych-syntetycznych-i-prawdziwych)
8. [Lista kontrolna bezpieczeństwa](#lista-kontrolna-bezpieczeństwa)
9. [Usługa systemowa](#usługa-systemowa)
10. [Kopie zapasowe i przywracanie](#kopie-zapasowe-i-przywracanie)
11. [Aktualizacja](#aktualizacja)
12. [Rozwiązywanie problemów](#rozwiązywanie-problemów)

## Wymagania

| Składnik | Wymaganie | Uwagi |
|---|---|---|
| System | Linux (x86-64, arm64) albo Windows 10/11, Windows Server | sprawdzone: Windows 11, Node 24.22.0 |
| Node.js | 24 lub nowszy | TypeScript uruchamiany natywnie — bez kroku kompilacji serwera |
| pnpm | 12 (zalecany 12.21.0) | `corepack enable && corepack prepare pnpm@12.21.0 --activate` albo `npm install -g pnpm@12` |
| Docker (ścieżka A) | Docker Engine 24+ z Compose v2.20+ | zamiast Node i pnpm |
| Baza | nic (PGlite w procesie) albo PostgreSQL 14+ | PostgreSQL zalecany przy monitoringu i pracy na prawdziwych danych |
| Pamięć | 1 GB RAM dla API; z PGlite + ok. rozmiar bazy | migawka bazy jest trzymana w pamięci przy zapisie |
| Dysk | 1 GB + dane + kopie | indeks monitoringu rośnie o kilkanaście tysięcy wierszy na cykl |
| Sieć | żadna (dane syntetyczne) | przy `ENABLE_LIVE=1` — wyjście HTTPS do źródeł z [README](../README.md#źródła-danych-i-usługi-zewnętrzne) |

Porty: `4000` (API i interfejs), `4100` (piaskownica, tylko tryb danych syntetycznych), `5173` (tylko tryb deweloperski).

> **`pnpm setup` i `pnpm doctor` to wbudowane polecenia pnpm.** Kreator i diagnozę uruchamia się przez `pnpm run setup` i `pnpm run doctor`. Pozostałe polecenia (`pnpm start`, `pnpm build`, `pnpm dev`) działają bez `run`.

## Ścieżka A: Docker

Bez instalowania Node i pnpm na serwerze. Obraz zawiera API, zbudowany interfejs i piaskownicę; działa jako użytkownik bez uprawnień administratora, dane trzyma w wolumenie `/data`.

```bash
git clone https://github.com/LektorGW/hacknation-2026-osint-lapacz.git olcys
cd olcys
docker compose up -d --build
```

Interfejs: <http://127.0.0.1:4000>. Bez pliku `.env` kontener działa na danych syntetycznych (piaskownica w tym samym kontenerze), bez połączeń z internetem.

Konfiguracja przez plik `.env` obok `docker-compose.yml` (wzór: [.env.example](../.env.example); może go też przygotować kreator — `pnpm run setup -- --skip-install --skip-build`, jeśli na maszynie jest Node). Ścieżki i porty wewnątrz kontenera ustawia `docker-compose.yml` — wartości `API_PORT`, `API_HOST`, `OLCYS_DATA_DIR` z `.env` nie mają w kontenerze znaczenia.

| Cel | Ustawienie w `.env` |
|---|---|
| inny port hosta | `OLCYS_PORT=8080` |
| dostęp z sieci (domyślnie tylko 127.0.0.1 hosta) | `OLCYS_BIND=0.0.0.0` + `OLCYS_API_TOKEN=…` + `OLCYS_ALLOWED_HOSTS=nazwa-serwera` |
| źródła publiczne | `ENABLE_LIVE=1`, `OLCYS_CONTACT=…`; bez danych syntetycznych: `OLCYS_START_SANDBOX=0` i `SANDBOX_URL=` |
| PostgreSQL w osobnym kontenerze | `POSTGRES_PASSWORD=…`, `DATABASE_URL=postgres://olcys:…@postgres:5432/olcys`, uruchomienie: `docker compose --profile postgres up -d --build` |
| model lokalny na hoście (Ollama) | `AI_PROVIDER=openai-compatible`, `AI_BASE_URL=http://host.docker.internal:11434/v1`, `AI_MODEL=…` (w Linuksie dodaj do usługi `extra_hosts: ["host.docker.internal:host-gateway"]`) |
| osobny kontener piaskownicy | `OLCYS_START_SANDBOX=0`, `SANDBOX_URL=http://sandbox:4100`, uruchomienie z `--profile sandbox` |

Obsługa:

```bash
docker compose logs -f olcys                       # dziennik
docker compose ps                                  # stan (HEALTHCHECK na /api/health)
docker compose exec olcys node scripts/doctor.ts   # diagnoza w kontenerze
docker compose exec olcys node scripts/backup.ts   # kopia do wolumenu: /data/kopie
docker compose down                                # łagodne zatrzymanie, dane zostają w wolumenie olcys-dane
```

Zatrzymanie kontenera wysyła `SIGTERM`; skrypt uruchomieniowy zamyka API łagodnie (kończy przebiegi, zapisuje migawkę bazy) i dopiero potem piaskownicę. `stop_grace_period` wynosi 150 s — nie skracaj go i nie używaj `docker kill`.

## Ścieżka B: jedno polecenie (Node + pnpm)

```bash
git clone https://github.com/LektorGW/hacknation-2026-osint-lapacz.git olcys
cd olcys
pnpm run setup     # wersje → pnpm install --frozen-lockfile → budowa interfejsu → pytania → .env
pnpm start         # API + interfejs na jednym porcie (domyślnie http://127.0.0.1:4000)
```

Kreator pyta o: dane (syntetyczne / publiczne / oba — domyślnie oba, przełączane w interfejsie), port, adres nasłuchu (domyślnie `127.0.0.1`), katalog danych, bazę (PGlite albo adres PostgreSQL), token API (generuje losowy), klucz szyfrowania migawki (generuje), retencję zamkniętych spraw (domyślnie wyłączona), kontakt do nagłówka User-Agent, klucze opcjonalne (GitHub, CEIDG, Marginalia, Blockscout) i model językowy (brak / model lokalny / usługa zewnętrzna). Istniejący `.env` nie jest nadpisywany bez `--force` (wtedy powstaje kopia `.env.kopia-<data>`).

Bez pytań, np. w skrypcie instalacyjnym:

```bash
pnpm run setup -- --yes --mode both --port 4000 --dir /srv/olcys --contact zespol@example.org
pnpm run setup -- --yes --config /etc/olcys/olcys.env --mode live --host 0.0.0.0 --allowed-hosts olcys.kas.local \
  --database-url postgres://olcys:haslo@localhost:5432/olcys --ai local --ai-model bielik-11b-v2.3-instruct
```

Wszystkie opcje: nagłówek pliku [scripts/setup.ts](../scripts/setup.ts) (`--skip-install`, `--skip-build`, `--force`, `--no-token`, `--no-snapshot-key`, `--retention-days`, `--github-token`, `--ceidg-token`, `--marginalia-key`, `--blockscout-key`, `--ai none|local|external`, `--ai-base-url`, `--ai-model`, `--ai-api-key`, `--ai-provider`).

## Ścieżka C: ręcznie

```bash
pnpm install --frozen-lockfile
pnpm build                       # interfejs → apps/web/dist
cp .env.example .env             # i odkomentuj potrzebne zmienne (tabela niżej)
pnpm run doctor                  # sprawdzenie konfiguracji
pnpm start
```

Bez skryptu uruchomieniowego (np. własny nadzorca procesów): w katalogu `apps/api`

```bash
NODE_ENV=production OLCYS_SERVE_WEB=1 node --env-file=../../.env src/server.ts
```

Wtedy ścieżki względne w `.env` liczone są od `apps/api` — używaj ścieżek bezwzględnych. Piaskownicę uruchamia się osobno: `node src/server.ts` w `apps/sandbox`.

## Polecenia

| Polecenie | Co robi |
|---|---|
| `pnpm build` | buduje interfejs do `apps/web/dist` |
| `pnpm start` | produkcja: API + interfejs na jednym porcie; z `OLCYS_START_SANDBOX=1` także piaskownica |
| `pnpm start:demo` | jak `start`, zawsze z piaskownicą (dane syntetyczne) i `SANDBOX_URL` ustawionym na nią |
| `pnpm dev` | tryb deweloperski: piaskownica + API + Vite (<http://localhost:5173>) z prefiksami w dzienniku |
| `pnpm run setup` | kreator instalacji (zob. wyżej) |
| `pnpm run doctor` | diagnoza: instalacja, konfiguracja, działające API; `-- --online` — także łączność z usługami z konfiguracji |
| `pnpm run backup` | kopia zapasowa bazy z rotacją; `restore <plik>` — przywracanie |
| `pnpm run service` | instrukcja instalacji jako usługa systemowa (niczego nie instaluje) |
| `pnpm test` | testy wszystkich modułów |

Wspólne opcje skryptów: `--config <plik>` (zamiast `.env`; przez pnpm: `pnpm start -- --config /etc/olcys/olcys.env`), `--port`, `--host`. Zmienne ustawione w terminalu mają pierwszeństwo przed plikiem.

Ctrl+C (albo `SIGTERM`) zamyka wszystko łagodnie: skrypt wysyła do API żądanie zamknięcia (`POST /api/admin/shutdown`, z tokenem, jeśli jest ustawiony) i czeka, aż API zapisze migawkę bazy — dopiero potem zatrzymuje piaskownicę i Vite. API nie jest zabijane na siłę (wyjątek: brak reakcji przez `OLCYS_STOP_TIMEOUT_MS`, domyślnie 120 s, z ostrzeżeniem w dzienniku).

## Konfiguracja

Pełny wzór z opisem każdej zmiennej: [.env.example](../.env.example). Najważniejsze:

| Zmienna | Znaczenie | Domyślnie |
|---|---|---|
| `API_PORT`, `API_HOST` | port i adres nasłuchu API i interfejsu | `4000`, `127.0.0.1` |
| `OLCYS_SERVE_WEB` | `1` — API podaje zbudowany interfejs (powrót do `index.html` dla ścieżek aplikacji); `0` — nie | tak przy `NODE_ENV=production` i zbudowanym interfejsie |
| `OLCYS_WEB_DIR` | katalog zbudowanego interfejsu | `apps/web/dist` |
| `OLCYS_START_SANDBOX` | `1` — `pnpm start` uruchamia też piaskownicę | `0` (kreator: `1` dla danych syntetycznych) |
| `OLCYS_API_TOKEN` | token API (≥ 16 znaków); każde żądanie `/api/*` z `Authorization: Bearer …` (poza `/api/health`); interfejs prosi o token | brak (bez uwierzytelniania) |
| `OLCYS_ALLOWED_HOSTS` | dodatkowe nazwy hosta w adresie (nagłówek `Host`); IP i `localhost` zawsze dozwolone | — |
| `OLCYS_WEB_ORIGIN` | adresy osobno hostowanego interfejsu (CORS) | serwer Vite `:5173`, `:4173` |
| `OLCYS_RATE_LIMIT_PER_MIN` | limit kosztownych żądań na IP na minutę; `0` wyłącza | `30` |
| `OLCYS_DATA_DIR` | katalog bazy PGlite; migawka `<katalog>.migawka.tar.gz` | `./data/pg` względem `apps/api` |
| `OLCYS_SNAPSHOT_KEY` | klucz AES-256-GCM migawki (64 znaki hex albo base64 32 bajtów) | brak (migawka jawna) |
| `DATABASE_URL` | zewnętrzny PostgreSQL 14+ (PGlite wtedy nieużywany) | — |
| `OLCYS_BACKUP_DIR`, `OLCYS_BACKUP_KEEP` | katalog kopii zapasowych i liczba zachowanych kopii | `<katalog nad OLCYS_DATA_DIR>/kopie`, `7` |
| `OLCYS_RETENTION_DAYS_CLOSED` | po ilu dniach od zamknięcia usuwać sprawy (1–36500) | wyłączona |
| `OLCYS_ARCHIVE_DIR` | katalog plików archiwów spraw na serwerze | brak (archiwum tylko do pobrania) |
| `SANDBOX_URL` | adres piaskownicy; pusta wartość wyłącza | `http://localhost:4100` |
| `ENABLE_LIVE` | `1` — źródła i eksploratory w internecie | wyłączone |
| `OLCYS_CONTACT` | kontakt w nagłówku User-Agent (wymagany przez zasady Wikimedia) | — |
| `GITHUB_TOKEN`, `CEIDG_API_TOKEN`, `MARGINALIA_API_KEY`, `BLOCKSCOUT_API_KEY`, `MOJEEK_API_KEY` | klucze źródeł (opcjonalne) | — |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | model językowy (opcjonalny) | wyłączony |
| `OLCYS_STOP_TIMEOUT_MS` | czas na łagodne zamknięcie API w skrypcie uruchomieniowym | `120000` |
| `OLCYS_SKIP_CONFIG_CHECK` | `1` pomija sprawdzenie konfiguracji przy starcie | — |

Model językowy: kreator proponuje trzy możliwości — brak (domyślnie), model lokalny (Ollama, LM Studio, vLLM — serwer zgodny z API OpenAI pod adresem `AI_BASE_URL`, np. `http://127.0.0.1:11434/v1`) albo usługę zewnętrzną, do której wysyłane są dane analizy (fragmenty publikacji). Szczegóły: [README — Rola modelu AI](../README.md#rola-modelu-ai).

### Sprawdzenie konfiguracji przy starcie

API przed otwarciem bazy sprawdza konfigurację i przy błędzie kończy pracę z opisem po polsku (pełny raport: `pnpm run doctor`):

| Błąd (start przerwany) | Ostrzeżenie (start trwa) |
|---|---|
| zajęty port API | API dostępne z sieci bez tokenu |
| katalog danych bez prawa zapisu | źródła publiczne bez `OLCYS_CONTACT` (zasady Wikimedia) |
| katalog danych używany przez inny proces OŁCyŚ (plik `<OLCYS_DATA_DIR>.blokada`) | model językowy poza tą maszyną — dane analizy są wysyłane do dostawcy |
| niepoprawny `DATABASE_URL` | `OLCYS_SERVE_WEB=1` bez zbudowanego interfejsu |
| za krótki token, klucz migawki złej długości | `SANDBOX_URL=off` zamiast pustej wartości |
| zaszyfrowana migawka bez klucza | niepełna konfiguracja modelu (brak `AI_MODEL` / `AI_BASE_URL`) |
| niepoprawne liczby (retencja, limity) i adresy URL | |

`pnpm run doctor -- --online` sprawdza dodatkowo łączność: piaskownicę, laboratorium, proxy Tora, PostgreSQL (`select version()`), listę modeli serwera modelu językowego, a przy `ENABLE_LIVE=1` — wybrane źródła publiczne (GitHub, Blockstream, Blockscout, TronScan, NBP, Binance, Wikidata, Wykaz podatników VAT, KRS). Wysyła tylko zapytania kontrolne, bez danych spraw.

## Przełączanie danych syntetycznych i prawdziwych

Serwer rejestruje każdą rodzinę źródeł, którą umożliwia konfiguracja, a analityk wybiera w interfejsie, z której korzystają **nowe** analizy — bez restartu. Wcześniejsze analizy zachowują tryb, w którym je wykonano.

| Tryb | Łączniki i dostawcy blockchain | Warunek w konfiguracji |
|---|---|---|
| **Syntetyczne** (`synthetic`) | `sandbox-*` (piaskownica, w tym eksplorator „BlokSkan”) i `lab-*` (laboratorium tożsamości) | `SANDBOX_URL` (w `pnpm start`: `OLCYS_START_SANDBOX=1`) albo `LAB_URL` |
| **Prawdziwe** (`live`) | źródła publiczne, eksploratory blockchain, Tor | `ENABLE_LIVE=1` |
| **Oba** (`both`) | wszystkie powyższe; wyniki ze źródeł syntetycznych mają znacznik „dane syntetyczne” | obie rodziny jednocześnie |

Źródła lokalne — indeks własny monitoringu, migawki rejestrów publicznych, lista sankcyjna — działają bez sieci i są dostępne w każdym trybie.

- **Włączenie obu rodzin:** kreator w trybie „oba” (domyślnym) ustawia `ENABLE_LIVE=1`, `SANDBOX_URL` i `OLCYS_START_SANDBOX=1`. Ręcznie: te same trzy zmienne. Docker: `ENABLE_LIVE=1` w `.env` (piaskownica startuje w kontenerze domyślnie).
- **Przełącznik w interfejsie:** pasek trybu „Dane: Syntetyczne | Prawdziwe | Oba”. Przejście na dane prawdziwe wymaga potwierdzenia („Nowe analizy będą odpytywać publiczne źródła w internecie”). Tryb niedostępny w bieżącym uruchomieniu jest wyszarzony z podpowiedzią, czego brakuje.
- **Jedna analiza w innym trybie:** lista „Dane:” obok przycisku „Ustal” w formularzu wyszukiwania zmienia tryb tylko dla tej analizy (w API: pole `dataMode` w `POST /api/cases/:id/runs` i `POST /api/quick`). Łączniki wskazane wprost, ale spoza trybu, są pomijane; na stronie sprawy są wyszarzone z dopiskiem „poza trybem danych”.
- **Historia spraw** pokazuje przy każdej sprawie znacznik SANDBOX albo LIVE (z jej ostatniej analizy), a historia analiz sprawy — przy każdej analizie. Analizy sprzed wprowadzenia przełącznika nie mają znacznika.
- **Zakres:** tryb dotyczy nowych analiz, analiz cyklicznych spraw i listy źródeł w przeglądzie świeżych publikacji. Monitoring i rozwijanie sieci powiązań działają jak dotąd.
- **Wycena:** dostawcy syntetyczni nie korzystają z kursów rynkowych — kwoty z danych syntetycznych zawsze mają dopisek „UWAGA: KURS PRZYKŁADOWY”, także w trybie „oba”.
- **Trwałość:** wybór jest zapisany w bazie i obowiązuje po restarcie. Jeśli serwer wystartuje bez rodziny źródeł potrzebnej dla zapisanego trybu (np. bez `ENABLE_LIVE`), obowiązuje tryb dostępny, a `GET /api/settings/data-mode` wyjaśnia dlaczego.
- **Bez zapisanego wyboru** obowiązuje dotychczasowe zachowanie: obie rodziny dostępne → oba; tylko prawdziwe → prawdziwe; w pozostałych przypadkach syntetyczne.
- **API:** `GET /api/settings/data-mode` (tryb bieżący, dostępność trybów z powodem niedostępności), `PUT /api/settings/data-mode` z treścią `{"dataMode": "synthetic" | "live" | "both"}` — przy ustawionym `OLCYS_API_TOKEN` wymaga tokenu; zmiana trafia do dziennika serwera i dziennika audytu. `GET /api/health` podaje `dataMode`, `dataModeTag`, `dataModesAvailable` oraz `mode` (`sandbox` dla danych syntetycznych, `live` dla prawdziwych i obu). Przykład: `curl -X PUT http://127.0.0.1:4000/api/settings/data-mode -H "Content-Type: application/json" -H "Authorization: Bearer <token>" -d '{"dataMode":"synthetic"}'`.
- **Tryb DEMO** (`?demo=1`, dane wbudowane w interfejs, bez API) jest osobny i przełącznik go nie dotyczy.

## Lista kontrolna bezpieczeństwa

Szczegóły mechanizmów: [docs/BEZPIECZENSTWO.md](BEZPIECZENSTWO.md).

- [ ] API nasłuchuje na `127.0.0.1`, a dostęp z sieci idzie przez serwer pośredniczący z TLS (nginx, Caddy) — albo, przy `API_HOST=0.0.0.0`, ustawiony jest `OLCYS_API_TOKEN` i port jest ograniczony zaporą do sieci analityków.
- [ ] `OLCYS_API_TOKEN` wygenerowany losowo (kreator: 32 bajty), przekazany analitykom bezpiecznym kanałem.
- [ ] `OLCYS_ALLOWED_HOSTS` zawiera wyłącznie nazwy, pod którymi narzędzie jest otwierane.
- [ ] `.env` ma uprawnienia `600` (Linux) i należy do konta usługi; nie trafia do repozytorium ani do obrazu Docker (`.gitignore`, `.dockerignore`).
- [ ] Przy PGlite ustawiony jest `OLCYS_SNAPSHOT_KEY`, a **kopia klucza** jest przechowywana osobno od kopii bazy.
- [ ] Do pracy na prawdziwych danych — PostgreSQL z szyfrowaniem dysku i własnym hasłem; port bazy niedostępny z sieci.
- [ ] Usługa działa z konta bez uprawnień administratora (systemd: `User=`, Docker: użytkownik `node`).
- [ ] Kopie zapasowe są wykonywane cyklicznie i próbnie przywracane (zob. niżej).
- [ ] Retencja (`OLCYS_RETENTION_DAYS_CLOSED`) ustawiona zgodnie z zasadami przechowywania danych jednostki.
- [ ] Model językowy wyłączony albo lokalny; zewnętrzny tylko po świadomej decyzji (dane analizy trafiają do dostawcy).
- [ ] `ENABLE_LIVE` włączone świadomie; ustawiony `OLCYS_CONTACT`.
- [ ] `pnpm run doctor` nie zgłasza błędów ani ostrzeżeń.

## Usługa systemowa

`pnpm run service` (albo `node scripts/install-service.ts`) wypisuje gotowy plik usługi z bieżącymi ścieżkami. Skrypt niczego nie instaluje.

**Linux (systemd):**

```bash
node scripts/install-service.ts --user olcys --config /etc/olcys/olcys.env --output olcys.service
sudo cp olcys.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now olcys
journalctl -u olcys -f
```

Jednostka uruchamia `scripts/run.ts start` z `KillMode=mixed` i `TimeoutStopSec=150`: `systemctl stop` wysyła `SIGTERM` do skryptu, który zamyka API łagodnie.

**Windows:** zalecany [NSSM](https://nssm.cc) — skrypt wypisuje komplet poleceń `nssm install/set`, w tym zatrzymanie przez Ctrl+C z czasem 150 s (`AppStopMethodConsole`). Alternatywa: Harmonogram zadań (uruchomienie przy starcie systemu); zatrzymanie wtedy wyłącznie przez `POST /api/admin/shutdown`. `sc.exe` nie uruchomi skryptu Node bezpośrednio.

## Kopie zapasowe i przywracanie

```bash
pnpm run backup                         # kopia do OLCYS_BACKUP_DIR, zostaje 7 najnowszych
pnpm run backup -- --keep 30 --wait-fresh
pnpm run backup -- restore /srv/olcys/kopie/olcys-migawka-20261122-021500.tar.gz
```

**PGlite.** Trwałym zapisem bazy jest migawka `<OLCYS_DATA_DIR>.migawka.tar.gz`, zapisywana przez API co minutę, przy zamknięciu i po operacjach wymagających natychmiastowego zapisu (np. usunięcie sprawy). Zapis idzie przez plik tymczasowy i jest sprawdzany przed podmianą, więc skopiowanie migawki w dowolnej chwili daje spójną kopię — także przy działającym API (stan sprzed najwyżej minuty; `--wait-fresh` czeka na następny zapis). Skrypt sprawdza każdą kopię: odszyfrowanie (przy `OLCYS_SNAPSHOT_KEY`) i rozpakowanie. Kopia ma nazwę z datą i godziną; rotacja usuwa najstarsze.

Przywracanie (`restore`) wymaga zatrzymanego API (skrypt to sprawdza), sprawdza plik kopii, odkłada bieżącą migawkę jako `…przed-przywroceniem-<data>` i kładzie kopię na jej miejsce. Następny start API wczytuje przywróconą bazę. Zaszyfrowana kopia wymaga tego samego `OLCYS_SNAPSHOT_KEY`.

Ręcznie (bez skryptu): zatrzymaj API, skopiuj plik kopii na miejsce `<OLCYS_DATA_DIR>.migawka.tar.gz`, uruchom API.

**PostgreSQL.** Skrypt wywołuje `pg_dump --format=custom` (hasło przez `PGPASSWORD`, nie w wierszu poleceń). Bez klienta PostgreSQL na maszynie wypisuje polecenie do wykonania na serwerze bazy. Przywracanie: `pg_restore --clean --if-exists --no-owner --dbname "<DATABASE_URL>" <plik>` przy zatrzymanym API. W Dockerze: `docker compose exec postgres pg_dump -U olcys --format=custom olcys > olcys.dump`.

**Plik `.env` nie jest kopiowany** (zawiera sekrety) — przechowuj go osobno, w bezpiecznym miejscu. Bez `OLCYS_SNAPSHOT_KEY` zaszyfrowanych kopii nie da się odczytać.

Cykliczna kopia: `node scripts/install-service.ts` wypisuje wpis crontab (Linux) i zadanie Harmonogramu (Windows).

## Aktualizacja

```bash
pnpm run backup                 # najpierw kopia
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm run doctor
# restart: systemctl restart olcys | nssm restart OLCYS | Ctrl+C i pnpm start
```

Docker: `pnpm run backup` niedostępne poza kontenerem — `docker compose exec olcys node scripts/backup.ts`, potem `git pull && docker compose up -d --build`. Schemat bazy aktualizuje się sam przy starcie (zmiany tylko addytywne).

## Rozwiązywanie problemów

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| `Port 4000 … jest zajęty` | działa inna kopia OŁCyŚ albo inny program. Sprawdź `http://127.0.0.1:4000/api/health`; zmień port: `pnpm start -- --port 4010` |
| `Katalog danych … jest używany przez inny proces` | dwie kopie na jednej bazie PGlite uszkodziłyby dane. Zatrzymaj tamten proces albo wskaż inny `OLCYS_DATA_DIR`. Plik `<OLCYS_DATA_DIR>.blokada` po martwym procesie jest pomijany automatycznie |
| `Brak zbudowanego interfejsu` | `pnpm build` |
| interfejs pod `http://nazwa-serwera:4000` odpowiada „Niedozwolona nazwa hosta” | dopisz nazwę do `OLCYS_ALLOWED_HOSTS` |
| interfejs prosi o token | wpisz wartość `OLCYS_API_TOKEN` z `.env` |
| `Migawka … jest zaszyfrowana, a OLCYS_SNAPSHOT_KEY nie jest ustawiony` / nie udało się odszyfrować | ustaw ten sam klucz, którym zapisano migawkę (kopia `.env`). Serwer nie startuje celowo — pusta baza nadpisałaby dane |
| `pnpm setup` zmienia konfigurację pnpm zamiast uruchomić kreator | to wbudowane polecenie pnpm — użyj `pnpm run setup` (analogicznie `pnpm run doctor`) |
| źródła publiczne zwracają 403/429 | limity źródeł; ustaw `OLCYS_CONTACT`, `GITHUB_TOKEN`; zob. `pnpm run doctor -- --online` |
| model językowy nie działa w Dockerze z Ollamą na hoście | `127.0.0.1` w kontenerze to kontener — użyj `http://host.docker.internal:11434/v1` |
| kontener zatrzymuje się po 10 s i traci zmiany | uruchamiaj przez `docker compose` (ma `stop_grace_period: 150s`); przy `docker run` dodaj `--stop-timeout 150` |
| po nagłym wyłączeniu brakuje ostatnich zmian | PGlite zapisuje migawkę co minutę — przepadają zmiany od ostatniego zapisu. Przy pracy na prawdziwych danych użyj PostgreSQL |
| Windows: proces API nie reaguje na „Zakończ zadanie” łagodnie | nie zabijaj procesu — Ctrl+C w terminalu albo `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/admin/shutdown -Headers @{Authorization = "Bearer <token>"}` |
