# OŁCyŚ — OSINTowy Łapacz Cyfrowych Śladów

Narzędzie analityczne na HackNation 2026, zadanie Ministerstwa Finansów / Krajowej Administracji Skarbowej. Zespół: KryptoTrop.

Repozytorium: <https://github.com/LektorGW/hacknation-2026-osint-lapacz>

Stan dokumentu: 21.11.2026. Dokumentacja techniczna: [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md) oraz pliki README modułów ([sources](packages/sources/README.md), [chain](packages/chain/README.md), [ai](packages/ai/README.md), [api](apps/api/README.md), [sandbox](apps/sandbox/README.md), [identity-lab](apps/identity-lab/README.md)).

## Spis treści

1. [Problem i założenia](#problem-i-założenia)
2. [Co narzędzie robi](#co-narzędzie-robi)
3. [Wymagania i instalacja](#wymagania-i-instalacja)
4. [Uruchomienie krok po kroku](#uruchomienie-krok-po-kroku)
5. [Zmienne środowiskowe](#zmienne-środowiskowe)
6. [Źródła danych i usługi zewnętrzne](#źródła-danych-i-usługi-zewnętrzne)
7. [Parametry wyszukiwania](#parametry-wyszukiwania)
8. [Zasady legalności](#zasady-legalności)
9. [Rola modelu AI](#rola-modelu-ai)
10. [Wskaźnik Pewności i prawdopodobieństwa](#wskaźnik-pewności-i-prawdopodobieństwa)
11. [Scenariusz demonstracyjny](#scenariusz-demonstracyjny)
12. [Laboratorium tożsamości](#laboratorium-tożsamości)
13. [Testy](#testy)
14. [Dlaczego Node.js i TypeScript](#dlaczego-nodejs-i-typescript)
15. [Licencje](#licencje)
16. [Znane ograniczenia](#znane-ograniczenia)
17. [Zrzuty ekranu, prezentacja, film](#zrzuty-ekranu-prezentacja-film)

## Problem i założenia

Pracownicy KAS, sprawdzając rozliczenia przychodów z kryptowalut, ręcznie przeszukują publiczne źródła, żeby połączyć adresy kryptowalutowe z konkretnymi podmiotami. Praca jest czasochłonna i trudna do powtórzenia. OŁCyŚ automatyzuje ten przegląd: łączy ślady z otwartego internetu (Web2) z historią adresów w blockchainie (Web3) i pokazuje, na ile powiązanie jest wiarygodne.

Założenia:

- **Wyłącznie publiczne źródła.** Bez logowania, obchodzenia zabezpieczeń i skanowania.
- **Wynik z jawnych reguł.** Każda liczba ma księgę kroków, z której analityk odtworzy wynik. Model językowy jest dodatkiem, nie rozstrzyga.
- **Każdy ślad z metadanymi.** Źródło, adres URL, czas pozyskania, skrót SHA-256 i kopia treści.
- **Trzy warstwy w wyniku.** Fakt źródłowy, wynik obliczeń, wniosek do weryfikacji — oznaczone osobno w teczce i raporcie.
- **Domyślnie bez internetu.** Po instalacji narzędzie działa wyłącznie na danych syntetycznych; prawdziwe źródła, Tor i model językowy włącza się świadomie zmiennymi środowiskowymi.
- **Rozszerzalność.** Nowe źródło to nowy łącznik (`SourceConnector`) albo jeden wpis w rejestrze monitoringu; nowa sieć to nowy dostawca (`ChainProvider`).

## Co narzędzie robi

Wejście: co najmniej jeden identyfikator — imię i nazwisko, nick, login, e-mail, identyfikator komunikatora, adres profilu, nazwa ENS albo adres kryptowalutowy (Bitcoin, Ethereum, Tron).

Wynik: teczka podmiotu, czyli

- znalezione profile z oceną, czy należą do badanej osoby, oraz kandydaci na rzeczywistą osobę;
- adresy kryptowalutowe wykryte w treściach, każdy ze Wskaźnikiem Pewności (0–100%), księgą reguł i listą śladów;
- adresy wykluczone (giełdy, kontrakty, zbiórki, miksery, adresy instytucjonalne) — odnotowane, ale nieprzypisane;
- dane blockchain: wskaźniki możliwego wyjścia do walut tradycyjnych z szacunkową wyceną w PLN według lat, ścieżki środków do usług wymiany, zajęcia przez organy państwa, pochodzenie środków, inne adresy tego samego portfela;
- powiązane tożsamości (np. ta sama osoba pod innym nazwiskiem, wspólny adres wpłat giełdy) ze ścieżką dojścia;
- giełdy i usługi powiązane z podmiotem wraz z danymi do zapytania do usługi;
- raport HTML do druku i pakiet JSON do odtworzenia analizy.

Poza analizą pojedynczego podmiotu narzędzie umożliwia: analizy cykliczne i porównanie dwóch analiz (w tym wykrycie podmiany adresu w tym samym miejscu publikacji), decyzje analityka (potwierdzenie lub odrzucenie profilu, adresu, śladu), typowanie podmiotów z przeglądu świeżych publikacji oraz cykliczny monitoring źródeł.

## Wymagania i instalacja

- **Node.js 24 lub nowszy** (`engines` w `package.json`; TypeScript jest uruchamiany natywnie, bez kompilacji). Sprawdzone na Node 24.22.0.
- **pnpm** (sprawdzone na 12.21.0).
- Baza danych: nic do instalowania — domyślnie działa wbudowany PGlite (PostgreSQL w procesie). Opcjonalnie zewnętrzny PostgreSQL 14 lub nowszy (`DATABASE_URL`).
- Laboratorium tożsamości (`apps/identity-lab`) wymaga Node 22 lub nowszego i nie ma zależności.

```
git clone https://github.com/LektorGW/hacknation-2026-osint-lapacz.git
cd hacknation-2026-osint-lapacz
pnpm install
```

## Uruchomienie krok po kroku

Pełny opis wdrożenia (konfiguracja, bezpieczeństwo, kopie zapasowe, usługa systemowa): [docs/WDROZENIE.md](docs/WDROZENIE.md).

### Docker — bez instalowania Node

```
docker compose up -d --build
```

Interfejs i API: <http://127.0.0.1:4000>. Bez pliku `.env` — wyłącznie dane syntetyczne (piaskownica w tym samym kontenerze), bez połączeń z internetem. Zatrzymanie: `docker compose down` (łagodne, z zapisem bazy).

### Node.js 24 + pnpm

```
pnpm run setup     # zależności, budowa interfejsu, pytania o konfigurację → plik .env
pnpm start         # API + interfejs na jednym porcie: http://127.0.0.1:4000
```

Uwaga: `pnpm run setup`, nie `pnpm setup` (to wbudowane polecenie pnpm). Bez pytań: `pnpm run setup -- --yes`. Diagnoza konfiguracji: `pnpm run doctor`.

### Demonstracja na danych syntetycznych

```
pnpm start:demo    # API + interfejs + piaskownica (http://127.0.0.1:4100)
```

Interfejs bez API (dane wbudowane): `?demo=1`. Pasek u góry pokazuje tryb danych — **SANDBOX**, **LIVE** albo **DEMO** — i pozwala przełączać dane syntetyczne i prawdziwe bez restartu. Tryb deweloperski (piaskownica + API + Vite na :5173): `pnpm dev`.

### Zamykanie

Ctrl+C zamyka wszystko łagodnie: API kończy przebiegi i zapisuje migawkę bazy. Procesu nie należy zabijać na siłę. W Windows z zewnątrz: `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/admin/shutdown` (z nagłówkiem `Authorization: Bearer <token>`, gdy ustawiono `OLCYS_API_TOKEN`).


## Zmienne środowiskowe

Żadna zmienna nie jest wymagana do uruchomienia na danych syntetycznych. Wzór pliku: [.env.example](.env.example).

| Zmienna | Znaczenie | Wymagana | Domyślnie |
|---|---|---|---|
| `API_PORT` | port API | nie | `4000` |
| `API_HOST` | adres nasłuchu API | nie | `127.0.0.1` |
| `OLCYS_DATA_DIR` | katalog danych wbudowanej bazy PGlite; migawka w `<katalog>.migawka.tar.gz` | nie | `./data/pg` |
| `DATABASE_URL` | zewnętrzny PostgreSQL; gdy podana, PGlite nie jest używany | nie | — |
| `SANDBOX_URL` | adres piaskownicy dla łączników i dostawcy danych syntetycznych | nie | `http://localhost:4100` |
| `CEIDG_API_TOKEN` | token JWT API v3 Hurtowni danych CEIDG; tworzy łącznik `live-ceidg`; trafia tylko w nagłówku do `dane.biznes.gov.pl` | nie | wyłączone |
| `OLCYS_API_TOKEN` | token API (min. 16 znaków); każde żądanie `/api/*` poza `/api/health` wymaga `Authorization: Bearer <token>` | nie | wyłączony |
| `OLCYS_SNAPSHOT_KEY` | klucz AES-256-GCM migawki bazy (64 znaki hex albo base64 32 bajtów); stara jawna migawka wczytuje się i jest szyfrowana przy zapisie | nie | migawka jawna |
| `OLCYS_RETENTION_DAYS_CLOSED` | po ilu dniach od zamknięcia usuwać sprawy zarchiwizowane i niepowiązane z otwartymi (nigdy bez archiwum) | nie | wyłączona |
| `OLCYS_ARCHIVE_DIR` | katalog na pliki archiwów spraw; bez niego w bazie zostaje tylko skrót SHA-256 archiwum | nie | — |
| `OLCYS_WEB_ORIGIN` | adresy interfejsu dopuszczone przez CORS i ochronę przed żądaniami z obcych stron, po przecinku | nie | `http://localhost:5173`, `http://127.0.0.1:5173`, `:4173` |
| `OLCYS_ALLOWED_HOSTS` | dodatkowe nazwy hosta API (nagłówek Host); adresy IP i `localhost` zawsze dozwolone | nie | — |
| `OLCYS_RATE_LIMIT_PER_MIN` | limit kosztownych żądań na adres IP i trasę na minutę (`0` wyłącza) | nie | `30` |
| `OLCYS_CONTACT` | kontakt w nagłówku User-Agent zapytań do Wikimedia (wymaganie ich zasad) | przy źródłach live | — |
| `NOSTR_RELAYS` | przekaźniki Nostr (`wss://…`, po przecinku), których zasady operator zaakceptował; bez nich `live-nostr` używa tylko NIP-05 | nie | — |
| `MARGINALIA_API_KEY` | klucz Marginalia Search (`public` = klucz wspólny); włącza `web-search` | nie | — |
| `MOJEEK_API_KEY`, `MOJEEK_STORAGE_RIGHTS` | klucz Mojeek; dostawca powstaje tylko z `MOJEEK_STORAGE_RIGHTS=1` (plan z prawem przechowywania wyników) | nie | — |
| `FARCASTER_HUB_URL` | własny węzeł Snapchain dla `live-farcaster` | nie | — |
| `ENABLE_LIVE` | `1`, `true` lub `yes` włącza źródła i eksploratory w prawdziwym internecie | nie | wyłączone |
| `GITHUB_TOKEN` | token GitHub bez uprawnień — wyższy limit zapytań i wyszukiwarka GitHuba; trafia tylko w nagłówku do `api.github.com` | nie | — |
| `BLOCKSCOUT_API_KEY` | klucz API Blockscout — dostęp do sieci niedostępnych bez klucza (Arbitrum, Gnosis) i zapasowa droga dla Ethereum | nie | — |
| `TOR_PROXY_URL` | adres proxy HTTP Tora (np. `http://127.0.0.1:8118`); tworzy łącznik `tor-onion` | nie | wyłączone |
| `LAB_URL` | adres laboratorium tożsamości (np. `http://127.0.0.1:8787`); tworzy łączniki `lab-*` i dostawcę sieci laboratoryjnej | nie | wyłączone |
| `CORPUS_RETENTION_DAYS` | ile dni przechowywać indeks publikacji monitoringu | nie | `30` |
| `CORPUS_MAX_ROWS` | limit wierszy indeksu publikacji | nie | `200000` |
| `AI_PROVIDER` | `openai-compatible` (także `openai`), `anthropic` albo `none` | nie | model wyłączony |
| `AI_BASE_URL` | adres API modelu | tylko dla `openai-compatible` | — |
| `AI_MODEL` | nazwa modelu | tylko dla `openai-compatible` | dla `anthropic`: `claude-fable-5-2` |
| `AI_API_KEY` | klucz API modelu; zbędny dla serwerów lokalnych | tylko dla `anthropic` | — |
| `OPENAI_API_KEY` | skrót: sam ten klucz włącza `openai-compatible` z adresem OpenAI (`AI_MODEL` i tak trzeba podać) | nie | — |
| `ANTHROPIC_API_KEY` | skrót: sam ten klucz włącza `anthropic` | nie | — |
| `AI_TIMEOUT_MS`, `AI_MAX_INPUT_CHARS`, `AI_CONCURRENCY` | limit czasu zadania, długość treści wysyłanej do modelu, liczba zadań naraz | nie | `30000`, `6000`, `4` |
| `AI_EFFORT`, `AI_REFUSAL_FALLBACK` | tylko `anthropic`: głębokość rozumowania; `0` wyłącza model zastępczy po odmowie | nie | `low`, włączony |
| `SANDBOX_PORT`, `SANDBOX_HOST` | port i adres piaskownicy (proces `apps/sandbox`) | nie | `4100`, `localhost` |
| `VITE_DEMO` | `1` przy budowaniu interfejsu — tryb na danych wbudowanych, bez API | nie | — |
| `PORT`, `LAB_DATA_DIR` | port panelu i katalog danych laboratorium tożsamości (proces `apps/identity-lab`) | nie | `8787`, katalog `data/` laboratorium |

Gdy ustawione są oba klucze (`OPENAI_API_KEY` i `ANTHROPIC_API_KEY`), a `AI_PROVIDER` nie — model zostaje wyłączony: narzędzie nie zgaduje, dokąd wysłać treść.

## Źródła danych i usługi zewnętrzne

**Po instalacji narzędzie nie łączy się z niczym poza lokalną piaskownicą.** Wszystko poniżej poza pierwszym wierszem wymaga świadomego włączenia.

### Źródła Web2 (`packages/sources`)

| Grupa | Co odpytuje | Kiedy działa | Klucz |
|---|---|---|---|
| Piaskownica (`sandbox-*`, 7 łączników) | lokalne fikcyjne serwisy: GitPub, WWW, Targ, Forum, Społeczność, Komunikator, Archiwum | domyślnie (`SANDBOX_URL`) | — |
| Indeks własny (`corpus`) | publikacje zebrane wcześniej przez monitoring, w lokalnej bazie | zawsze | — |
| Keybase (`live-keybase`) | `keybase.io` — podpisane adresy i dowody kont | `ENABLE_LIVE` | — |
| ENS (`live-ens`) | `api.ensdata.net`, zapasowo `api.ensideas.com` | `ENABLE_LIVE` | — |
| GitHub (`live-github`, `-gists`, `-activity`) | `api.github.com` — profil, README, FUNDING.yml, gisty, publiczne zdarzenia | `ENABLE_LIVE` | opcjonalny `GITHUB_TOKEN` (bez niego 60 zapytań/h) |
| Wyszukiwarka GitHuba (`live-github-search`) | `api.github.com/search/*` | `ENABLE_LIVE` | **wymaga `GITHUB_TOKEN`** |
| Gravatar (`live-gravatar`) | `gravatar.com` — wysyłany jest sam skrót e-maila | `ENABLE_LIVE` | — |
| Fediwersum (`live-fediverse`) | instancje Mastodona z `config/fediverse-instances.json` (mastodon.social, mstdn.social, fosstodon.org, 101010.pl) | `ENABLE_LIVE` | — |
| Telegram (`live-telegram`) | publiczny podgląd kanału `t.me/s/<nazwa>` | `ENABLE_LIVE` | — |
| Bitcointalk (`live-bitcointalk`) | strona profilu `bitcointalk.org` — po adresie profilu albo po nicku (`action=profile;user=`), ≥ 1,5 s odstępu | `ENABLE_LIVE` | — |
| Bluesky (`live-bluesky`) | `public.api.bsky.app` — profil i ostatnie własne wpisy | `ENABLE_LIVE` | — |
| Nostr (`live-nostr`) | NIP-05 `https://<domena>/.well-known/nostr.json`; profil z przekaźników tylko z listy operatora | `ENABLE_LIVE`; przekaźniki: `NOSTR_RELAYS` | — |
| Serwer kluczy OpenPGP (`live-openpgp`) | `keys.openpgp.org` — e-mail → klucz opublikowany za zgodą właściciela, potwierdzone adresy | `ENABLE_LIVE` | — |
| Wykaz podatników VAT (`live-vat-whitelist`) | `wykazpodatnikowvat.mf.gov.pl` — NIP / rachunek → podmiot (≤ 80 zapytań/dobę) | `ENABLE_LIVE` | — |
| KRS (`live-krs`) | `api-krs.ms.gov.pl` — numer KRS → odpis aktualny | `ENABLE_LIVE` | — |
| CEIDG (`live-ceidg`) | `dane.biznes.gov.pl/api/ceidg/v3` — NIP → wpis przedsiębiorcy (≤ 200/h) | `ENABLE_LIVE` | **wymaga `CEIDG_API_TOKEN`** |
| Rejestry publiczne (`rejestry-publiczne`) | migawki lokalne: rejestr działalności w zakresie walut wirtualnych (IAS Katowice), ostrzeżenia publiczne KNF, rejestr MiCA ESMA — zapytanie nie opuszcza systemu | zawsze (bez sieci) | — |
| Farcaster (`live-farcaster`) | udokumentowane API Farcaster — nazwa konta → zweryfikowany adres ETH/SOL i zweryfikowane konto X/GitHub | `ENABLE_LIVE` | opcjonalny `FARCASTER_HUB_URL` |
| Wyszukiwarka (`web-search`) | API Marginalia i/lub Mojeek — **treść zapytania trafia do dostawcy**; tylko fragmenty wyników, stron nie pobiera; 3 zapytania na identyfikator | `ENABLE_LIVE` + klucz; bez klucza wyłączona | `MARGINALIA_API_KEY` / `MOJEEK_API_KEY` + `MOJEEK_STORAGE_RIGHTS=1` |

Podstawa prawna każdego źródła (z cytatem regulaminu) oraz źródła sprawdzone i odrzucone: [docs/ZRODLA-PODSTAWA-PRAWNA.md](docs/ZRODLA-PODSTAWA-PRAWNA.md). Podpisane wiadomości (BIP-137, EIP-191, TIP-191) w publikacjach są weryfikowane lokalnie: poprawny podpis, którego treść wskazuje publikujące konto, daje śladowi kategorię „dowód kryptograficzny”; podpis niepoprawny albo niewskazujący publikującego tylko dodaje adnotację.
| Strona WWW (`live-www`) | jedna strona pod adresem podanym przez analityka, po sprawdzeniu `robots.txt` | `ENABLE_LIVE` | — |
| Wayback Machine (`live-wayback`, `live-wayback-twitter`) | `web.archive.org` — CDX i do 3 kopii archiwalnych | `ENABLE_LIVE` | — |
| WalletExplorer, BitcoinWhosWho | `walletexplorer.com`, `bitcoinwhoswho.com` — strony adresu Bitcoin | `ENABLE_LIVE` | — |
| Głębokie wyszukiwanie (`deep-search`) | publiczne wyszukiwarki źródeł rejestru: 421 hostów (fora Discourse, instancje Mastodona i Lemmy, StackExchange, Hacker News) | `ENABLE_LIVE` **i** tryb głęboki analizy; w analizie standardowej wyłączone | — |
| Rejestr monitoringu (`mon-*`) | 843 włączone wpisy na 609 hostach: fora Discourse, kanały RSS, tagi Mastodona, kanały Telegram, Lemmy, działy Bitcointalk, StackExchange, Hacker News; w tym 114 wpisów z regionu PL | `ENABLE_LIVE`; tylko w monitoringu i typowaniu, monitoring domyślnie wyłączony | — |
| Reddit (77 wpisów rejestru) | `reddit.com` | **wyłączone w rejestrze** — Reddit odmawia dostępu | — |
| Tor (`tor-onion`) | wyłącznie strony `.onion` wpisane do `config/onion-sources.json` (lista domyślnie pusta) | **wyłączone**, dopóki nie podano `TOR_PROXY_URL` | — |
| Laboratorium tożsamości (`lab-*`, 27 łączników) | lokalne `apps/identity-lab` | **wyłączone**, dopóki nie podano `LAB_URL` | — |

Liczby rejestru pochodzą z próby 21.11.2026 zapisanej w [packages/sources/config/monitor-sources/STATUS.md](packages/sources/config/monitor-sources/STATUS.md).

### Dane blockchain (`packages/chain`)

| Usługa | Do czego | Kiedy działa | Klucz |
|---|---|---|---|
| Eksplorator piaskownicy „BlokSkan” | syntetyczna historia adresów Bitcoin, Ethereum, Tron | domyślnie (`SANDBOX_URL`) | — |
| Blockstream Esplora (`blockstream.info`), zapasowo `mempool.space` | Bitcoin | `ENABLE_LIVE` | — |
| Blockscout (`eth.blockscout.com` i publiczne instancje 10 innych sieci EVM: OP Mainnet, ZKsync Era, Scroll, Celo, Unichain, Soneium, Mode, Ink, Lisk, World Chain) | Ethereum i wykrywanie aktywności w innych sieciach EVM | `ENABLE_LIVE` | — |
| Usługa metadanych Blockscout (`metadata.services.blockscout.com`) | hurtowe znaczniki adresów | `ENABLE_LIVE` | — |
| API Blockscout z kluczem (`api.blockscout.com`) | Arbitrum One, Gnosis; zapasowa droga dla Ethereum | `ENABLE_LIVE` | **wymaga `BLOCKSCOUT_API_KEY`** |
| TronGrid (`api.trongrid.io`), TronScan (`apilist.tronscanapi.com`) | Tron, USDT TRC-20, znaczniki adresów | `ENABLE_LIVE` | — |
| WalletExplorer (`walletexplorer.com`) | nazwy portfeli Bitcoin (etykiety giełd) | `ENABLE_LIVE` | — |
| Binance (`api.binance.com`, dzienne świece) | cena dnia do wyceny | `ENABLE_LIVE` | — |
| NBP (`api.nbp.pl`, tabela A) | kurs średni USD/PLN | `ENABLE_LIVE` | — |
| Lista sankcyjna OFAC SDN | kopia lokalna (`data/ofac-addresses.json`, 1078 adresów, pobrana 21.11.2026); sprawdzenie bez wysyłania adresu | zawsze; odświeżenie ręczne `node scripts/update-ofac.ts` | — |

Do eksploratora trafia wyłącznie badany adres lub adres kontrahenta; do Binance — para i data; do NBP — zakres dat. Bez `ENABLE_LIVE` wycena używa tabeli przykładowej (`data/rates-pln.json`) i każda kwota ma dopisek „UWAGA: KURS PRZYKŁADOWY”.

Etykiety adresów: wbudowany zbiór `packages/chain/data/labels.json` (99 wpisów: giełdy, kontrakty, miksery, 5 adresów organów państwa, 49 adresów związanych z incydentami — każdy z podanym źródłem) uzupełniany znacznikami eksploratorów. Analityk może dodać własne w `data/labels.local.json`.

### Model językowy (`packages/ai`)

Domyślnie wyłączony. Po wskazaniu dostawcy narzędzie łączy się z adresem z `AI_BASE_URL` (serwer zgodny z API OpenAI, np. lokalna Ollama, vLLM, llama.cpp) albo z API Anthropic. Szczegóły w sekcji [Rola modelu AI](#rola-modelu-ai).

### Czego narzędzie nie wysyła

Interfejs nie ładuje zasobów z zewnętrznych adresów — nie ma telemetrii, zewnętrznych czcionek ani skryptów. Raporty HTML mają nagłówek `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`.

## Parametry wyszukiwania

- **Opis każdego łącznika** (co i jak przeszukuje, jakie typy identyfikatorów przyjmuje, czy jest domyślnie włączony) zwraca `GET /api/connectors` i pokazuje raport. Pełna tabela: [packages/sources/README.md](packages/sources/README.md).
- **Dopasowanie jest dokładne**: nazwa konta równa nickowi (nie podciąg), adres obecny w treści po normalizacji zapisu.
- **Zasady wobec źródeł**: nagłówek `User-Agent: OLCyS-research/0.1 (hackathon KAS; kontakt przez organizatora)`, limit czasu 10 s, limit odpowiedzi 1 MB, najwyżej 4 żądania na identyfikator na łącznik, co najmniej 400 ms między żądaniami do tego samego hosta. Odpowiedzi 403, 404, 429 kończą się pustym wynikiem z wpisem w dzienniku — bez ponawiania.
- **Tryby analizy**:

| | standardowy | głęboki |
|---|---|---|
| kroki odkrywania kolejnych identyfikatorów | 3 | 4 |
| adresy z analizą blockchain | 15 | 40 |
| limit czasu zapytania / całej analizy | 20 s / 120 s | 45 s / 240 s |
| pętla szukania powiązanych tożsamości | 2 kroki × 12 zapytań | 4 kroki × 20 zapytań |
| dodatkowe źródła | — | `deep-search` |

- **Okres analizy** (`period: { from, to }`) zawęża historię blockchain.
- Po przekroczeniu limitu czasu analiza zwraca wynik częściowy z oznaczeniem, nie błąd.
- Bieżące wartości wszystkich limitów i reguł: `GET /api/priority-rules` oraz strona „Zasady punktacji” w interfejsie.

## Zasady legalności

- **Tylko publiczne źródła.** Łączniki nie logują się, nie wysyłają formularzy i nie pobierają treści dostępnych po zalogowaniu.
- **Bez omijania zabezpieczeń.** Odmowa źródła (403, 429) jest przyjmowana: pusty wynik i wpis w dzienniku. Nagłówek `User-Agent` jest jawny i nie jest zmieniany, żeby przejść blokadę — z tego powodu sieci Base, Arbitrum i Polygon są niedostępne bez klucza, a Reddit jest wyłączony (uzasadnienie i sprawdzone warunki: [packages/chain/README.md](packages/chain/README.md)).
- **`robots.txt`** jest sprawdzany przed pobraniem strony wskazanej przez analityka (`live-www`) i przed czytaniem list wątków (`smf-board`, `html-list`).
- **Ochrona przed zapytaniami do sieci wewnętrznej.** Łączniki pobierające adres podany w identyfikatorze odrzucają adresy prywatne, loopback i link-local, także po przekierowaniu.
- **Tor jest domyślnie wyłączony.** Łącznik powstaje tylko po podaniu `TOR_PROXY_URL`, czyta wyłącznie strony z jawnej listy (domyślnie pustej), nie wysyła zapytań ani formularzy i nie podąża za odnośnikami.
- **Źródła w internecie są domyślnie wyłączone** (`ENABLE_LIVE`), podobnie monitoring i model językowy.
- **Minimalizacja danych.** Do źródła trafia tylko identyfikator potrzebny do zapytania. Sprawdzenie listy sankcyjnej jest lokalne.
- **Brak skanowania.** Narzędzie nie skanuje portów ani podatności i nie korzysta z wycieków danych.
- **Dane testowe są syntetyczne.** Osoby, konta i adresy w piaskownicy i laboratorium są zmyślone; próby na prawdziwych serwisach opisane w README modułów dotyczyły wyłącznie identyfikatorów osób i organizacji publicznych, które same je publikują.

## Rola modelu AI

Model językowy jest **pomocniczy i opcjonalny**. Bez niego narzędzie działa w pełni — wszystkie wyniki liczą reguły.

- **Co robi:** czyta publiczną publikację i podpowiada, czyj jest adres (własny autora, cudzy, ostrzeżenie, cytat), rozpoznaje ofertę i związek z Polską, porównuje styl dwóch autorów, streszcza gotowe ustalenia teczki.
- **Czego nie robi:** nie przyznaje punktów i niczego nie rozstrzyga. Jedyne miejsce, w którym odczyt modelu przekłada się na wynik, to jawne reguły w `apps/api/src/ai-rules.ts` (`GET /api/priority-rules` → `ai`): odczyt „adres cudzy / ostrzeżenie / cytat” przenosi ślad do niewliczonych, z wpisem w księdze zawierającym cytat, nazwę modelu i wersję polecenia. Decyzja analityka cofa ten wpływ.
- **Wymienny dostawca:** dwa adaptery za jednym interfejsem — `openai-compatible` (każdy serwer z API zgodnym z OpenAI: Ollama, vLLM, llama.cpp, wewnętrzny router) i `anthropic`. Zmiana modelu to zmiana zmiennych `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`. Docelowy wariant dla KAS to model lokalny (przykład z Bielikiem w [packages/ai/README.md](packages/ai/README.md)).
- **Weryfikacja cytatów:** odpowiedź modelu jest traktowana jak niezaufane dane. Cytat musi występować dosłownie w treści publikacji (co najmniej 12 znaków) — inaczej cały odczyt jest odrzucany. Kwota i miejscowość oferty muszą dać się odczytać z treści; streszczenie nie może zawierać liczby ani adresu spoza przekazanych faktów.
- **Anonimizacja:** do modelu działającego poza tą maszyną fakty do streszczenia trafiają bez danych osobowych i adresów — imiona, nicki, e-maile, telefony i adresy są zastępowane znacznikami (`[OSOBA-1]`, `[ADRES-1]`…), a po odpowiedzi przywracane lokalnie. Model pod adresem `localhost` dostaje fakty bez zmian. Przy odczycie publikacji do modelu trafia treść publicznej publikacji, jej tytuł, nazwa autora podana przez źródło i adres do oceny; nigdy nazwa sprawy, identyfikatory podane przez analityka, notatki ani wyniki punktacji.
- **Wstrzykiwanie poleceń:** treść publikacji trafia do modelu w oznaczonym bloku danych; model nie ma narzędzi i zwraca tylko obiekt o ustalonym schemacie.
- **Stan i zużycie:** `GET /api/ai`; interfejs pokazuje nazwę modelu i informację, gdzie działa.

## Wskaźnik Pewności i prawdopodobieństwa

Narzędzie liczy trzy osobne wskaźniki: **A. konto → portfel**, **B. wspólny operator**, **C. wyjście do walut tradycyjnych**. Wszystkie są liczbami porządkowymi 0–100 z jawnych reguł, a nie skalibrowanym prawdopodobieństwem. Pełny opis: [docs/WSKAZNIKI.md](docs/WSKAZNIKI.md); wyniki audytu silnika łączenia tożsamości: [docs/AUDYT.md](docs/AUDYT.md); przebieg demonstracji: [docs/DEMO-JURY.md](docs/DEMO-JURY.md).

Reguły są jawne i edytowalne; wartości zwraca `GET /api/rules` i `GET /api/priority-rules`, a każdy wynik w teczce ma księgę kroków. Kod: `packages/core/src/score.ts`.

**Wskaźnik Pewności adresu (0–100%)** — na ile adres jest powiązany z autorem śladów:

| Krok | Reguła |
|---|---|
| Wykluczenie | adres giełdy, smart kontrakt, zbiórka, mikser, adres instytucjonalny → 0%, odnotowany tylko fakt publikacji |
| Punkt wyjścia | najmocniejszy ślad: dowód kryptograficzny 95, własny profil 85, ogłoszenie / oferta P2P 70, wiadomość w kontekście rozliczenia 65, wypowiedź na forum 50, masowy komentarz 25 |
| Tożsamość profilu | potwierdzona lub unikalny identyfikator 0; profil wskazany przez inny profil −5; zgodny tylko nick −10; pospolity nick −20; tylko imię i nazwisko −20 |
| Synergia | drugie niezależne **pochodzenie** +15; każde kolejne +5, łącznie najwyżej +10. Ta sama treść w kilku serwisach, przedruk i kopia archiwalna liczą się jako jedno pochodzenie |
| Adres współdzielony | co najmniej 3 niepowiązane tożsamości publikują ten sam adres → −30 |
| Progi | 80–100 bardzo wysokie prawdopodobieństwo, 60–79 prawdopodobne, 40–59 średnie, 10–39 niskie / szum, 0 wykluczone |

Wartości bazowe odpowiadają przedziałom z załącznika pojęciowo-metodycznego zadania.

**Prawdopodobieństwa pochodne** (reguły w `apps/api/src`, zwracane przez `GET /api/priority-rules`):

- **Osoba (hipoteza operatora)** — konta są łączone w kandydatów po wspólnych cechach (ten sam e-mail lub telefon 100, wzajemne odnośniki 90, ten sam adres publikowany jako własny 80…; próg łączenia 50). Dwa skupienia łączą się tylko wtedy, gdy żadna para ich kont nie ma kontrdowodu twardego (sprzeczne deklarowane nazwiska, decyzja analityka), więc ścieżka A–B–C nie scala sprzecznych A i C. Sam zgodny nick niczego nie łączy. Kandydat pozostaje hipotezą, dopóki analityk go nie potwierdzi.
- **Wspólny operator pary kont** — najmocniejsza przesłanka + 20% każdej kolejnej niezależnej (najwyżej +15) − kontrdowody; najwyżej 95 bez decyzji analityka i najwyżej 45 przy kontrdowodzie twardym.
- **Wyjście do walut tradycyjnych** — cztery szczeble: transakcja w blockchainie, interakcja z usługą wymiany, potencjalny sygnał wypłaty, udokumentowane wyjście. Ostatni wymaga dokumentu spoza blockchaina.
- **Osoba–adres** — Wskaźnik Pewności adresu × pewność przynależności profilu do osoby.
- **Ścieżka środków** — 95 za bezpośredni przelew na adres z publiczną etykietą usługi; każde ogniwo pośrednie obniża wynik; ścieżka z ogniwem pośrednim najwyżej 90 (wzór w [packages/chain/README.md](packages/chain/README.md)).
- **Dowód spieniężenia** — P(osoba–adres) × P(ścieżka) / 100.
- **Powiązana tożsamość** — „prawdopodobnie ta sama osoba” 85–97, „możliwe: ta sama osoba albo bliska” 55–75, „powiązana” 30–45; do teczki trafiają wyniki od 50.
- **Priorytet sprawy** — 0,35·pewność + 0,30·skala wypłat + 0,15·usługi + 0,10·aktualność + 0,10·niezależne źródła. Porządkuje kolejkę spraw; nie jest oceną podmiotu.

Kwoty w PLN są zawsze szacunkiem (cena zamknięcia dnia z Binance × kurs średni NBP z ostatniego dnia roboczego przed transakcją) i nie są ustaleniem przychodu.

## Scenariusz demonstracyjny

Wszystkie osoby, konta i adresy są zmyślone (`apps/sandbox`, 32 fikcyjne osoby). Uruchom piaskownicę, API i interfejs, otwórz <http://localhost:5173> i wpisz identyfikator w polu nowej analizy. Oczekiwane wyniki dla domyślnych reguł (pełna tabela: [apps/sandbox/README.md](apps/sandbox/README.md)):

| Krok | Identyfikator | Co pokazuje | Oczekiwany wynik |
|---|---|---|---|
| 1 | login `kwrzosek_dev` | wykrycie adresów, synergia źródeł, wskaźniki wypłat | `bc1qxhvk…kl0ze`: własny profil GitPub (85), zgodny tylko nick (−10), ogłoszenie na Targu (+15) = **90**; `0x5214…e86a`: sam profil = **75**. W danych blockchain wpłaty na „Giełda Bursztyn: Hot Wallet” (2024–2026), „KantorKrypto P2P”, zamiana ETH→USDT, bramka płatnicza, karta |
| 2 | nick `bkruk_trader` | odrzucenie błędnych przypisań | adres gorącego portfela giełdy i kontrakt stablecoina: **wykluczone, 0%** |
| 3 | imię i nazwisko `Kacper Wrzosek` | imiennicy | adresy dwóch różnych osób po **65%** (85 − 20) ze wskazówką, by potwierdzić tożsamość |
| 4 | nick `oli_stepniak` | adres współdzielony | masowy komentarz (25) i 7 innych kont z tym samym adresem → **0%** |
| 5 | e-mail `m.zielonka@skrzynka.example` | łańcuch odkrywania identyfikatorów | profil bez adresu → odkryte nicki → adresy `0x3fb2…9D84` i `TETb8r…Tsv6` po **80%** |
| 6 | login `rkowalski_btc` (Rafał Kowalski) | hipoteza wspólnego operatora pod innym nazwiskiem | **Julia Kowalska** (`julka_k`): ten sam adres `bc1q43zh…2g98` publikowany jako własny przez oba konta; sprzeczne deklarowane nazwiska blokują scalenie (wskaźnik B ograniczony do 45), rozstrzyga analityk |
| 7 | nick `t_nowak_foto` (Tomasz Nowak) | wspólny indywidualny adres wpłat giełdy | **Ewa Wiśniewska** (`ewa_wisniewska`): oba adresy wysyłają środki na ten sam adres pośredni, który przekazuje całość na „Giełda Bursztyn: Hot Wallet” |
| 8 | nick `dsroka` | podmiana adresu w czasie | otwórz `http://localhost:4100/_demo/faza/before`, wykonaj analizę, otwórz `…/_demo/faza/after`, wykonaj ponownie i porównaj analizy: stary adres zastąpiony nowym w tym samym miejscu publikacji |
| 9 | nick `zosia_mielcarz` | brak kryptowalut | dokumenty znalezione, **zero adresów**, teczka wyjaśnia dlaczego |

Dalej: zakładka „Dowód spieniężenia” (osoba → adres → ścieżka → usługa), „Giełdy i portfele” (materiał do zapytania do usługi), raport do druku, strona „Typowanie” (przegląd ofert Targu z rankingiem wskazań) i „Monitoring” (ręczny przebieg na źródłach piaskownicy).

To samo bez interfejsu:

```bash
curl -X POST http://127.0.0.1:4000/api/quick -H "Content-Type: application/json" -d '{"value":"kwrzosek_dev"}'
```

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/quick -ContentType 'application/json' -Body '{"value":"kwrzosek_dev"}'
```

Próba całości bez otwierania portu API (piaskownica musi działać): `node test/e2e-sandbox.manual.ts [identyfikator…]` w katalogu `apps/api`.

## Laboratorium tożsamości

`apps/identity-lab` to osobne, niezależne środowisko testowe bez zewnętrznych zależności: 27 syntetycznych portali (5 społecznościowych, 7 aukcyjnych i ogłoszeniowych, 15 forów), 180 osób i 992 konta, kohorta 200 wpisów ujawniających testowe portfele, własny silnik hipotez z oddzielną prawdą wzorcową oraz testowy łańcuch UTXO z podpisami Ed25519. Uruchomienie: `pnpm --filter synthetic-identity-lab start` (panel <http://127.0.0.1:8787>), z 27 osobnymi portami: `pnpm --filter synthetic-identity-lab portals`; w Windows także `apps/identity-lab/Start-Lab.cmd`. Po ustawieniu `LAB_URL` API dostaje łączniki `lab-*` i dostawcę sieci laboratoryjnej (adresy `lab1…`, token bez wartości i bez wyceny); łączniki czytają tylko publiczne API laboratorium, nigdy prawdę wzorcową. Pomiar narzędzia względem prawdy wzorcowej laboratorium (łączenie kont jednej osoby, przypisanie adresów, czas analizy) wykonuje `node scripts/benchmark-lab.ts`; wynik jest generowany automatycznie do [docs/BENCHMARK-LAB.md](docs/BENCHMARK-LAB.md). Integracja jest w historii repozytorium oznaczona jako „w toku”, więc liczby z tego pliku należy traktować jako stan roboczy. Opis laboratorium: [apps/identity-lab/README.md](apps/identity-lab/README.md).

## Testy

Testy używają wbudowanego modułu `node:test`, atrap źródeł i bazy w pamięci; nie łączą się z internetem.

```
pnpm test
```

albo w katalogu modułu: `node --test test/*.test.ts` (laboratorium: `node --test tests/*.test.mjs`).

Wynik z 21.11.2026 po audycie (Windows 11), wszystkie zaliczone:

| Moduł | Testy | Zaliczone | Niezaliczone |
|---|---|---|---|
| `packages/core` | 19 | 19 | 0 |
| `packages/sources` | 135 | 135 | 0 |
| `packages/chain` | 127 | 127 | 0 |
| `packages/ai` | 36 | 36 | 0 |
| `apps/api` | 184 | 184 | 0 |
| `apps/web` | 91 | 91 | 0 |
| `apps/identity-lab` | 46 | 46 | 0 |
| **Razem** | **638** | **638** | **0** |

Scenariusz konkursowy od identyfikatora do raportu (trzy fikcyjne persony, decyzje analityka z wycofaniem, niedostępne źródło) jest w `apps/api/test/scenario.test.ts`; tabela scenariuszy regresyjnych — w [docs/AUDYT.md](docs/AUDYT.md). Sprawdzone 21.11.2026 także ręcznie: pełna ścieżka przez API i interfejs na piaskownicy oraz jedna analiza na publicznych źródłach (`LIVE=1 SANDBOX_URL=off node test/e2e-sandbox.manual.ts vitalik.eth`).

`apps/sandbox` nie ma własnych testów — jest sprawdzana przez testy `packages/sources`, które uruchamiają ją na losowym porcie. Sprawdzenie typów interfejsu: `pnpm --filter @olcys/web typecheck`.

Próby ręczne na prawdziwych serwisach (nie są testami, wymagają internetu): `packages/sources/scripts/live-check.ts`, `deep-check.ts`, `monitor-check.ts`; `packages/chain/scripts/live-check.ts`, `trace-check.ts`; `packages/ai/scripts/try.ts`.

## Dlaczego Node.js i TypeScript

- **Zgodność z zadaniem.** Node.js jest wymieniony wśród preferowanych technologii backendowych, React — wśród wiodących technologii webowych.
- **Praca narzędzia to głównie wejście-wyjście.** Analiza to dziesiątki do setek równoległych zapytań HTTP do źródeł i eksploratorów z limitami czasu, kolejkami na host i przerywaniem; model asynchroniczny Node obsługuje to bez dodatkowych bibliotek (wbudowane `fetch`, `AbortSignal`).
- **Jeden język i jedne typy w całym monorepo.** Kontrakty z `@olcys/core` są używane przez łączniki, dostawców, API i interfejs — zmiana kontraktu jest wykrywana w każdym module.
- **Bez kroku budowania po stronie serwera.** Node 24 uruchamia TypeScript natywnie; ten sam plik jest uruchamiany i testowany.
- **Mało zależności.** Serwer ma cztery zależności wykonawcze (Fastify, wtyczka CORS, PGlite, `pg`), reszta to biblioteka standardowa — w tym testy (`node:test`) i kryptografia (`node:crypto`). Mniej komponentów do audytu przy wdrożeniu.
- **Baza zgodna z wymaganiami.** PostgreSQL; wbudowany PGlite służy do uruchomienia bez instalacji, a ten sam SQL działa na zwykłym serwerze.

## Licencje

Kod projektu: pole `license` w plikach `package.json` wskazuje **MIT**. Pliku `LICENSE` w repozytorium nie ma — do uzupełnienia.

Zależności bezpośrednie (wersje zainstalowane, licencje z pola `license` w `node_modules/<pakiet>/package.json`):

| Pakiet | Wersja | Licencja | Gdzie używany |
|---|---|---|---|
| `fastify` | 5.12.8 | MIT | `apps/api`, `apps/sandbox` |
| `@fastify/cors` | 11.4.3 | MIT | `apps/api` |
| `@electric-sql/pglite` | 0.3.16 | Apache-2.0 | `apps/api` |
| `pg` | 8.23.1 | MIT | `apps/api` |
| `@noble/hashes` | 1.8.0 | MIT | `packages/core` |
| `undici` | 7.30.2 | MIT | `packages/sources` |
| `react` | 19.3.1 | MIT | `apps/web` |
| `react-dom` | 19.3.1 | MIT | `apps/web` |
| `vite` | 7.3.8 | MIT | `apps/web` (budowanie) |
| `@vitejs/plugin-react` | 5.2.0 | MIT | `apps/web` (budowanie) |
| `typescript` | 5.9.3 | Apache-2.0 | `apps/web` (sprawdzanie typów) |
| `@types/react`, `@types/react-dom` | 19.3.0 | MIT | `apps/web` (typy) |

`packages/chain`, `packages/ai` i `apps/identity-lab` nie mają zależności zewnętrznych. Zestawienie licencji zależności pośrednich — do uzupełnienia (`pnpm licenses list`).

Dane zewnętrzne w repozytorium: lista OFAC SDN (publiczny plik Departamentu Skarbu USA); etykiety adresów z podanym źródłem przy każdym wpisie kategorii `law_enforcement` i `incident`. Gotowe zbiory adresów incydentów nie zostały podłączone — ich licencje wymagają sprawdzenia ([packages/chain/README.md](packages/chain/README.md)).

## Znane ograniczenia

**Sieci i eksploratory**

- Obsługiwane sieci: Bitcoin, Ethereum (i 10 innych sieci EVM przez Blockscout), Tron. Inne łańcuchy nie są obsługiwane.
- **Base, Polygon i BNB Smart Chain są niedostępne.** Base i Polygon odmawiają dostępu bez klucza (HTTP 403), a na darmowym planie z kluczem wymagają płatnego planu (HTTP 402); BNB Smart Chain nie ma publicznego eksploratora z API bez klucza i nie jest obsługiwany przez API z kluczem (HTTP 404). Arbitrum i Gnosis działają tylko z `BLOCKSCOUT_API_KEY`. Niedostępne są też Linea, Zora, Mantle, Avalanche. Wypłata przez taką sieć jest dla narzędzia niewidoczna.
- Operator Blockscout zapowiedział wycofanie dostępu bez klucza do publicznych instancji — sieci działające dziś bez klucza mogą przestać odpowiadać.
- **Eksploratory bywają wolne.** Limit czasu żądania do eksploratorów EVM to 25 s; dla bardzo aktywnych adresów część danych bywa niedostępna. TronScan i TronGrid bez klucza odrzucają serie żądań — analiza adresu Tron w trybie głębokim trwa 10–40 s. Analiza głęboka całej sprawy może trwać do 4 minut i kończyć się wynikiem częściowym.
- Domyślnie analizowanych jest około 50 najnowszych transakcji adresu; pełna historia dotyczy adresu będącego przedmiotem sprawy i ma limit żądań.
- Ethereum: bez transakcji wewnętrznych. Bitcoin: transakcja jest sprowadzana do jednego przelewu.

**Etykiety i ścieżki**

- **Etykiety adresów są niepełne.** Wbudowany zbiór ma 99 wpisów, reszta zależy od znaczników eksploratorów. Kantory, mniejsze giełdy i pośrednicy OTC zwykle nie mają publicznej etykiety: brak ścieżki nie oznacza braku spieniężenia.
- Indywidualne adresy wpłat giełd są rozpoznawane heurystycznie — metoda może zarówno pominąć wypłatę, jak i wskazać ją błędnie. Ścieżki dłuższe niż jeden krok, klaster portfela i powiązane adresy to wnioskowanie, nie fakt.
- Lista OFAC jest kopią z dnia pobrania.
- Wycena w PLN to szacunek: cena zamknięcia dnia, nie cena z chwili transakcji. W trybie bez internetu kursy są przykładowe.

**Źródła**

- **Reddit odmawia dostępu** (404, przekierowanie na logowanie, 403) — wszystkie 77 subredditów w rejestrze jest wyłączonych; silnik jest przetestowany tylko na atrapach.
- Treści serwisów wymagających logowania (Facebook, X, Instagram, zamknięte grupy, większość portali ogłoszeniowych) nie są przeszukiwane. Treści Mastodona nie da się przeszukać bez logowania — tylko profile.
- GitHub bez tokenu: 60 zapytań na godzinę; wyszukiwarka GitHuba wymaga tokenu i nie była sprawdzana na żywo. Chainabuse, OpenSanctions i Blockchair wymagają klucza i nie są używane.
- Część forów odmawia dostępu (w próbie 21.11.2026: 6 hostów z odmową, 5 źródeł z błędem na 843).
- Lista kanałów Telegram do typowania i lista stron `.onion` są domyślnie puste.

**Monitoring**

- **Monitoring ma szum.** Związek z Polską i sygnały obrotu są oceniane słowami kluczowymi i wagami (`apps/api/data/signals.json`); bez modelu językowego o tym, czy autor podaje adres jako własny, decydują proste reguły. W próbie 21.11.2026 na 14 785 publikacji adres zawierało 326. Trafienie jest wskazówką do sprawdzenia, nie zarzutem.
- Indeks publikacji rośnie o kilkanaście tysięcy wierszy na cykl; przy takim obciążeniu zewnętrzny PostgreSQL jest wyraźnie szybszy od PGlite.

**Baza i wdrożenie**

- **PGlite w Windows.** Katalog roboczy nie otwiera się ponownie po zamknięciu procesu, dlatego trwałość zapewnia migawka zapisywana co minutę i przy zamknięciu. Katalog może obsługiwać tylko jeden proces naraz; po zabiciu procesu przepadają zmiany od ostatniej migawki. Do pracy na prawdziwych danych — zewnętrzny PostgreSQL.
- Brak kont użytkowników i uwierzytelniania: API nasłuchuje tylko lokalnie, autor decyzji jest stały („analityk”).
- Harmonogramy cyklicznych analiz spraw nie przetrwają restartu API.
- Obraz Docker (`Dockerfile`, `docker-compose.yml`) jest przygotowany i sprawdzony składniowo, ale nie był budowany na maszynie zespołu.

**Model językowy**

- Odpowiedzi bywają niedeterministyczne; weryfikacja chroni przed zmyślonym cytatem, kwotą i miejscowością, nie przed błędną interpretacją prawdziwego cytatu. Dostawcy nie byli sprawdzani na żywo w testach automatycznych.

**Tożsamość**

- Zgodność samego nicka albo samego imienia i nazwiska to słaba przesłanka — narzędzie obniża wtedy wynik i pokazuje kilku kandydatów, ale rozstrzyga analityk.
- Powiązane tożsamości i osoby powiązane są wskazówką do weryfikacji, nigdy ustaleniem.

## Zrzuty ekranu, prezentacja, film

Zrzuty ekranu — do uzupełnienia (katalog `docs/zrzuty/` jeszcze nie istnieje):

| Widok | Plik |
|---|---|
| Pulpit | `docs/zrzuty/pulpit.png` — do uzupełnienia |
| Teczka: dowód spieniężenia | `docs/zrzuty/teczka-dowod.png` — do uzupełnienia |
| Teczka: adresy i księga Wskaźnika Pewności | `docs/zrzuty/teczka-adresy.png` — do uzupełnienia |
| Teczka: powiązane tożsamości | `docs/zrzuty/teczka-tozsamosci.png` — do uzupełnienia |
| Teczka: graf powiązań | `docs/zrzuty/teczka-graf.png` — do uzupełnienia |
| Monitoring | `docs/zrzuty/monitoring.png` — do uzupełnienia |
| Raport do druku | `docs/zrzuty/raport.png` — do uzupełnienia |

- Prezentacja (PDF, do 10 slajdów) — do uzupełnienia.
- Film (do 3 minut) — do uzupełnienia.
- Wersja demonstracyjna online — do uzupełnienia.
