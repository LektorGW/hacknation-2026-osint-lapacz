# Źródła — podstawa prawna dróg dostępu

Stan na 21.11.2026. Dokument odpowiada na pytanie: **którą drogą wolno narzędziu sięgać do danego źródła i na jakiej podstawie**. Celem było znalezienie dróg legalnych (oficjalne API, otwarty zbiór z licencją, punkt końcowy wprost udostępniony), a nie sposobów obejścia zakazu.

**Jak czytać werdykt**

| Werdykt | Znaczenie |
|---|---|
| **tak** | droga dozwolona bez klucza; warunki źródła przeczytane |
| **tak-z-kluczem** | dozwolona po uzyskaniu klucza / spełnieniu warunku planu |
| **nie** | regulamin zabrania, jest niejasny albo droga wymagałaby obejścia zabezpieczeń |
| **nie zweryfikowano** | regulaminu nie udało się pobrać — do czasu przeczytania traktować jak „nie” |

**Zastrzeżenie o cytatach.** Regulaminy czytano 21.11.2026 narzędziem pobierającym strony; cytaty są krótkimi fragmentami wskazanymi przez to narzędzie. Przed złożeniem projektu cytaty, na których opiera się włączony łącznik (Marginalia, Mojeek, Farcaster, KNF, ESMA, gov.pl), warto otworzyć w przeglądarce i potwierdzić. To nie jest opinia prawna.

**Zasada nadrzędna.** Każde zapytanie do zewnętrznej usługi wynosi z systemu identyfikator badanego podmiotu. Regulamin konkursu zabrania wysyłania danych analizy do niezatwierdzonych usług, więc każda droga oznaczona niżej „wysyła zapytanie na zewnątrz” jest domyślnie wyłączona i wymaga świadomego włączenia zmienną środowiskową.

---

## 1. Oficjalne API wyszukiwarek internetowych

Wyszukiwarka z własnym indeksem odpowiada z danych, które sama zebrała na własną odpowiedzialność. Zapytanie do jej oficjalnego API jest korzystaniem z jej usługi na jej warunkach — pod warunkiem, że regulamin pozwala na zapytania automatyczne **i** na przechowanie wyników (narzędzie zapisuje ślady w bazie jako materiał dowodowy, więc zakaz przechowywania wyklucza dostawcę).

| Źródło | Werdykt | Podstawa (adres i klauzula) | Limity | Identyfikatory |
|---|---|---|---|---|
| **Marginalia Search API** | **tak-z-kluczem** (wdrożone) | https://about.marginalia-search.com/article/api/ — klucze niekomercyjne: „Provided under CC-BY-NC-SA 4.0.”; klucz wspólny: „you can use the key `public`” | klucz `public` wspólny dla wszystkich, często 429/503; własny klucz niekomercyjny bezpłatnie po e-mailu | imię i nazwisko, nick, e-mail, adres — fraza |
| **Mojeek Search API** | **tak-z-kluczem**, tylko plan z prawem przechowywania (wdrożone) | https://www.mojeek.com/about/legal/api-terms.html — 1.6.6: „You may retain Data indefinitely only if you subscribe to a plan with storage rights.”; 1.4.4 dopuszcza dostęp automatyczny dla „authorised Services user” | Startup £2 / 1000 zapytań, 5/s (bez prawa przechowywania — pamięć podręczna do 1 h); Business £3 / 1000 z przechowywaniem | jw. |
| Brave Search API | **nie** | https://api-dashboard.search.brave.com/terms-of-service (wersja z 1.09.2026) — §3(b)(i): nie wolno „store, cache, or create a database of Search Results, in whole or in part” poza przechowaniem przejściowym | — | — |
| Google Programmable Search (Custom Search JSON API) | **nie** | https://developers.google.com/custom-search/v1/overview — „The Custom Search JSON API is closed to new customers.”; wygaszenie 1.01.2027 | 100 zapytań/dzień tylko dla dotychczasowych klientów | — |
| Bing Web Search API / Grounding with Bing | **nie** | https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement — „Bing Search APIs will be retired on August 11, 2025.”; następca zabrania „Copy, store, cache, archive, or create a database of Output.” | — | — |
| Kagi Search API | **nie** (dla naszego użycia) | https://kagi.com/privacy/api — zakazane: „Store, cache, or build a database of Results beyond the transient caching needed to operate your application.” | 12 USD / 1000 zapytań | — |
| Publiczne instancje SearXNG | **nie** | https://docs.searxng.org/admin/searx.limiter.html — „the requests from bots to SearXNG must also be blocked, this is the task of the limiter.” Poza tym SearXNG sam pobiera strony wyników cudzych wyszukiwarek. | — | — |
| Tavily, Exa, Perplexity API | **nie** (niejasne / zakaz kopiowania) | Exa https://exa.ai/terms-of-service §4.2(a): nie wolno „download, modify, copy, distribute… any information… obtained from or through, the Services”; Tavily i Perplexity przerzucają na klienta zgodność z regulaminami stron trzecich i nie mówią nic o przechowywaniu | — | — |
| SerpAPI i podobne | **nie** (pośrednik pobierający strony wyników) | https://serpapi.com/legal — §13: „SerpApi will assume the liabilities of scraping and parsing search engine results” | — | — |
| Strony wyników Google / Bing / DuckDuckGo | **nie** | https://policies.google.com/terms — zakaz „using automated means to access content from any of our services in violation of the machine-readable instructions”; regulamin konkursu zakazuje tego wprost | — | — |

**Wnioski dla wdrożenia (`web-search`):**

- Zapytanie do API **wysyła zapytanie na zewnątrz** — do hosta dostawcy trafia identyfikator podmiotu. Łącznik powstaje tylko po podaniu klucza i mówi o tym w opisie, nazywając dostawcę.
- Wynik to **fragment z wyszukiwarki, nie pełna treść strony**: tytuł, opis, adres. Łącznik **nie pobiera** wskazanych stron. Strona wraca jako identyfikator `profile_url` tylko wtedy, gdy leży na hoście, który narzędzie i tak odpytuje własnym łącznikiem na własnych zasadach (github.com, gist.github.com, keybase.io, t.me, gravatar.com, bitcointalk.org). Pobranie strony spoza tej listy byłoby naszą własną odpowiedzialnością wobec jej `robots.txt` i regulaminu — robi to wyłącznie łącznik `live-www`, po sprawdzeniu `robots.txt`, dla adresu podanego przez analityka.
- Żaden z przeczytanych regulaminów nie zawiera klauzuli o organach publicznych. Marginalia wymaga użycia niekomercyjnego i podania źródła (jest w treści każdego śladu); Mojeek zastrzega, że nie udziela praw do treści stron („You are responsible for complying with copyright law and with publishers' terms and permissions”).
- Wyniki **nie są powtarzalne** w czasie (indeks się zmienia). Ślad z wyszukiwarki ma najsłabsze dopasowanie tożsamości i wymaga obejrzenia strony przez analityka.

### Pośrednik nie zmienia regulaminu źródła

Rozróżnienie, którego trzymamy się w całym projekcie:

1. **Dozwolone:** zapytać dostawcę o to, co **już ma we własnym indeksie**, na warunkach jego regulaminu (Marginalia, Mojeek). Dostawca sam odpowiada za to, jak indeks powstał; my odpowiadamy za zgodność z jego regulaminem API.
2. **Niedozwolone:** polecić pośrednikowi, żeby **pobrał dla nas strony** z serwisu, który zabrania dostępu automatycznego (OLX, Allegro, Facebook, LinkedIn, strony wyników Google). To to samo naruszenie wykonane cudzymi rękami — zmienia się tylko adres IP, nie regulamin źródła. Dotyczy to usług typu SerpAPI, „scraping API”, serwerów proxy, a także modelu językowego z narzędziem przeglądania, któremu każe się „wejść na stronę X”.
3. **Konsekwencja:** zapytanie nigdy nie zawiera polecenia odwiedzenia konkretnego serwisu ani operatora `site:` wskazującego serwis z listy „nie”. Dla źródeł z rozdziału 5 nie ma drogi „przez kogoś”.

### Wyszukiwanie u dostawcy modelu językowego (OpenAI web search, Anthropic) — **nie**

Sprawdzone jako kandydat na kolejnego dostawcę `web-search`; **nie wdrożono**, bo nie da się zagwarantować warunków:

| Warunek | Ustalenie | Źródło |
|---|---|---|
| użycie zgodne z zasadami dostawcy | OpenAI zabrania użycia „for national security, law enforcement, or intelligence purposes without our review and approval” oraz „to aggregate, monitor, profile, or distribute individuals' private or sensitive information without their authorization”. Anthropic zabrania „Make or suggest decisions in law enforcement or criminal justice processes, including decisions to investigate” oraz „Compile, aggregate, or enrich personal data from multiple sources to build profiles of individuals”. Typowanie osób przez organ skarbowy mieści się w tych klauzulach albo co najmniej jest niejasne → „nie”. | https://openai.com/policies/usage-policies/ (20.11.2026); https://www.anthropic.com/legal/aup (12.11.2026) |
| tylko cytowania: adres + tytuł + **dosłowny** fragment strony | Odpowiedź OpenAI zawiera adnotacje `url_citation` (`url`, `title`, `start_index`, `end_index`) wskazujące miejsce **w tekście napisanym przez model**; dosłownego fragmentu strony dokumentacja nie opisuje. Fragment byłby więc twierdzeniem modelu, nie źródła. | https://developers.openai.com/api/docs/guides/tools-web-search |
| brak pobierania stron na nasze zlecenie | Narzędzie domyślnie pobiera strony na żywo (akcje `open_page`, `find_in_page`); tryb tylko z indeksu wymaga `external_web_access: false` — a o tym, które strony otworzyć, decyduje model. | jw. |
| przechowywanie wyników, odpowiedzialność | „Customer is solely responsible for all use of the Outputs”; dostawca nie odpowiada za „Third-Party Content”. Przechowywanie wyników nie jest zakazane, ale wymagane jest pokazywanie cytowań jako klikalnych odnośników. | https://openai.com/policies/services-agreement/ §4.3, §12.2 |
| powtarzalność | Wyniki różnią się między uruchomieniami (model decyduje, czy i czego szukać), a regulamin konkursu wymaga powtarzalności i zabrania wysyłania danych analizy do niezatwierdzonych usług. | — |

Gdyby organizator zatwierdził takiego dostawcę, a dostawca zatwierdził zastosowanie, interfejs `WebSearchProvider` pozwala go dodać pod warunkami: włączenie zmienną środowiskową, tryb wyłącznie z indeksu, wynik bez adresu źródła odrzucany, żadnej treści napisanej przez model w śladzie, kategoria najsłabsza, oznaczenie „fragment z wyszukiwarki (dostawca modelu)”, domyślnie wyłączony.

---

## 2. Otwarte zbiory, archiwa, API serwisów społecznościowych

| Źródło | Werdykt | Podstawa | Limity | Identyfikatory / uwagi |
|---|---|---|---|---|
| Common Crawl (indeks CDX) | **tak** | https://commoncrawl.org/terms-of-use — „Please do not overload the URL index server.” | bez klucza | tylko wzorce adresów URL, **bez pełnego tekstu**; przydatne dla znanego adresu profilu. Nie wdrożono (pokrywa się z Wayback). |
| Internet Archive — CDX | **tak** dla CDX (już używane w `live-wayback`); regulamin ogólny **nie zweryfikowano** | https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md — „the only required param for the CDX server is the **url** param.” | brak publicznego pełnotekstowego wyszukiwania kopii stron | adres profilu / strony. https://archive.org/about/terms nie dało się pobrać — do przeczytania ręcznie. |
| GitHub API, GH Archive | **tak** (klucz opcjonalny; już używane) | https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies — „Scraping does not refer to the collection of information through our API.” | 60/h bez tokenu, 5000/h z tokenem | nick, e-mail (commity), adres (wyszukiwarka kodu z tokenem). GH Archive nie podaje licencji na swojej stronie — nie wdrożono. |
| Software Heritage API | **tak**, tylko pojedyncze sprawdzenia | https://www.softwareheritage.org/legal/api-terms-of-use/ — „Use of the public API to extract significant parts of the contents of the Archive is not authorized.”; zakaz „building developer profiles to be used without the developer's consent” | 120/h anonimowo | brak wyszukiwania w treści; klauzula o profilach deweloperów → nie wdrożono. |
| Zbiory forów krypto (Hugging Face, Kaggle, Zenodo) | **tak** dla jednego zbioru z licencją | https://zenodo.org/records/7813450 — „Creative Commons Attribution 4.0 International” (10 mln komentarzy z działu bounty Bitcointalk) | pobranie jednorazowe | nick, adres — wyszukiwanie lokalne. Na Hugging Face nie znaleziono zbioru z jasną licencją. Nie wdrożono (rozmiar). |
| Telegram — podgląd kanału `t.me/s/<kanał>` | **niejasne — do decyzji zespołu** (istniejący `live-telegram`) | https://telegram.org/tos — „Telegram additionally prohibits data scraping as part of its Content Licensing and AI Scraping Terms”; żadna przeczytana strona nie mówi wprost o podglądach `t.me/s` | — | Łącznik czyta wyłącznie stronę udostępnioną publicznie bez logowania, po jednym żądaniu na kanał. **Ryzyko do odnotowania w README**: klauzula o „data scraping” nie rozróżnia podglądów. |
| Telegram — grupy prywatne, konto użytkownika (MTProto) | **nie** | https://core.telegram.org/api/terms — §1.5 zakaz „using, accessing or aggregating data obtained from the Telegram platform” (do trenowania modeli); §1.4 działania bez wiedzy użytkownika | — | — |
| Reddit Data API | **nie zweryfikowano → nie** | redditinc.com/policies/data-api-terms — pobranie zablokowane | — | w rejestrze monitoringu Reddit jest wyłączony — tak ma zostać. |
| Stack Exchange API | **nie zweryfikowano** (używane w `deep-search`) | https://stackoverflow.com/legal/api-terms-of-use — pobranie zablokowane | — | **do przeczytania ręcznie**; API jest oficjalne i udokumentowane, treści na CC BY-SA. |
| Hacker News | **tak** dla API Firebase; Algolia **nie zweryfikowano** (używane w `deep-search`) | https://github.com/HackerNews/API — „There is currently no rate limit.” | — | Firebase nie ma wyszukiwania; wyszukiwarka Algolia do przeczytania ręcznie. |
| Mastodon — API instancji | **tak** (ograniczone; już używane) | https://docs.joinmastodon.org/methods/search/ — „full text search is not available to unauthenticated users.” | 40 wyników | nick → konto; regulaminy instancji różne. |
| Lemmy — API | **nie zweryfikowano** (używane w `deep-search`) | https://join-lemmy.org/docs/contributors/04-api.html — „Lemmy does rate limiting for many actions based on the client IP.” | limity per instancja | regulaminy instancji nieczytane. |

---

## 3. Polskie i unijne dane publiczne

Podstawa ogólna: ustawa z 11.08.2021 r. o otwartych danych i ponownym wykorzystywaniu informacji sektora publicznego (Dz.U. 2023 poz. 1524, https://api.sejm.gov.pl/eli/acts/DU/2023/1524/text.html) — art. 5: „Każdemu przysługuje prawo do ponownego wykorzystywania informacji sektora publicznego”; art. 14 ust. 1: „Informacje sektora publicznego udostępnia się lub przekazuje w celu ponownego wykorzystywania bezwarunkowo”.

| Źródło | Werdykt | Podstawa | Limity | Identyfikatory / uwagi |
|---|---|---|---|---|
| **Rejestr działalności w zakresie walut wirtualnych** (Dyrektor IAS w Katowicach) | **tak** — plik opublikowany (wdrożone lokalnie) | https://www.gov.pl/web/ias-katowice/rejestr-dzialalnosci-w-zakresie-walut-wirtualnych — „Dyrektor Izby Administracji Skarbowej w Katowicach prowadzi Rejestr działalności w zakresie walut wirtualnych.”; plik „Wersja archiwalna Rejestru … na 2 lipca 2026r.” (PDF, 3,24 MB, https://www.gov.pl/attachment/8756421f-bfab-4404-8448-2ca7954ffbb9) | brak API; tylko PDF | nazwa, NIP, KRS → wpis (1841 wpisów, rodzaj usług, wykreślenie). Rejestr zawiera też osoby fizyczne prowadzące działalność (imię, nazwisko, NIP) — dane opublikowane przez organ. Stopka gov.pl: treści na CC BY-NC-ND 4.0, „o ile nie jest to stwierdzone inaczej” — przechowujemy fakty z rejestru z podaniem źródła, nie rozpowszechniamy pliku. Przepisu o jawności rejestru w rozdz. 11a ustawy AML nie udało się potwierdzić w tekście urzędowym — opieramy się na fakcie publikacji przez organ i ustawie o otwartych danych. |
| **KNF — lista ostrzeżeń publicznych** | **tak**, z podaniem źródła (wdrożone lokalnie) | https://www.knf.gov.pl/o_nas/urzad_komisji/nota_prawna — „Przy wykorzystywaniu materiałów ze strony internetowej KNF wymagane jest podanie źródła”; `robots.txt`: `User-agent: * Allow: /` | jedna strona HTML, brak eksportu i API | nazwa, KRS/NIP/REGON, domena → wpis (669 wpisów w 13 tabelach). Źródło i odnośnik są w treści każdego śladu. |
| **ESMA — tymczasowy rejestr MiCA (CASP)** | **tak** (wdrożone lokalnie) | https://www.esma.europa.eu/legal-notice — „Reproduction of all information on this site (ESMA Library) is authorised except as otherwise stated” … „provided the source is acknowledged” | plik CSV aktualizowany co tydzień | nazwa, nazwa handlowa, domena → licencjonowany dostawca usług krypto, państwa świadczenia usług (409 wpisów). Rejestru CASP po stronie KNF nie znaleziono. |
| dane.gov.pl API | **tak** (regulamin nie zweryfikowano) | https://api.dane.gov.pl/1.4/datasets — licencja per zbiór (`license_name`: „CC0 1.0”, „CC BY 4.0”) | bez klucza | nie znaleziono zbioru o działalności krypto — nie wdrożono. |
| KRS — otwarte API | **tak** (łącznik drugiego zespołu) | https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/{krs}?rejestr=P&format=json — odpowiada bez klucza; dokumentacji nie udało się pobrać | brak opublikowanych limitów | tylko numer KRS. |
| CEIDG API | **tak-z-kluczem** (łącznik drugiego zespołu) | https://dane.biznes.gov.pl/api/ceidg/v3 — 401 bez tokenu | token z konta biznes.gov.pl | NIP, REGON, nazwa. |
| REGON BIR1 | **tak-z-kluczem** | https://api.stat.gov.pl/Home/RegonApi — „Usługa i dane udostępniane są bezpłatnie.” | klucz e-mailem; 6000/h, 120/min, 3/s | NIP, REGON, KRS. |
| Biała lista VAT | **tak** (łącznik drugiego zespołu) | https://www.gov.pl/web/kas/api-wykazu-podatnikow-vat — „Przy wykorzystaniu metody „search” możesz złożyć 100 zapytań dziennie o maksymalnie 30 podmiotów jednocześnie” | search 100/dzień, check 5000/dzień; po przekroczeniu blokada do 0:00 | NIP, REGON, rachunek. Uwaga: stary adres `wl-api.mf.gov.pl` działa do 1.12.2026. |
| e-KRS — Przeglądarka dokumentów finansowych | **nie** | https://www.gov.pl/web/sprawiedliwosc/bezplatne-wyszukanie-i-pobranie-dokumentu-finansowego-podmiotu-wpisanego-do-rejestru-przedsiebiorcow-krajowego-rejestru-sadowego — „Wyszukiwanie jest zabezpieczone przed działaniem robotów pobierających dokumenty.” | — | zabezpieczenie przed robotami = nie obchodzimy. |
| UOKiK | **nie zweryfikowano** | nie znaleziono API ani zbioru | — | decyzje jako PDF. |

**Odświeżanie migawek** (`packages/sources/src/search/data/`): `node packages/sources/src/search/data/odswiez.ts` pobiera stronę KNF i plik CSV ESMA (po jednym żądaniu). Rejestr walut wirtualnych: pobrać PDF ze strony IAS i uruchomić `rdww-z-pdf.py` (wymaga `pymupdf` tylko do konwersji). Data migawki jest w treści każdego śladu.

---

## 4. Otwarte dane atrybucyjne po stronie blockchain

| Źródło | Werdykt | Podstawa | Limity | Identyfikatory / uwagi |
|---|---|---|---|---|
| **Farcaster — API klienta i rejestr nazw** | **tak** (wdrożone) | https://docs.farcaster.xyz/reference/farcaster/api — punkty `/fc/primary-address` i `/fc/account-verifications` oznaczone „Not authenticated”; https://docs.farcaster.xyz/reference/fname/api — `GET /transfers` rejestru nazw | brak opublikowanych limitów; łącznik: do 7 żądań na identyfikator | nick → fid → zweryfikowany adres główny ETH i SOL, zweryfikowane konto X / GitHub. **Uwagi:** (1) `api.farcaster.xyz/robots.txt` ma `Disallow: /` — dotyczy robotów indeksujących; opieramy się na tym, że dokumentacja wprost publikuje te punkty jako dostępne bez uwierzytelnienia. (2) Używamy **wyłącznie** punktów z dokumentacji; nieudokumentowane `/v2/user-by-username` i `/v2/verifications` działają, ale ich nie używamy. (3) Wyszukiwanie odwrotne adres → konto wymaga uwierzytelnienia (401) — nie ma go. |
| Farcaster — własny węzeł Snapchain | **tak** (opcjonalne, wdrożone) | https://snapchain.farcaster.xyz/reference/httpapi/verification — `/v1/verificationsByFid` (przykład na `127.0.0.1:3381`) | własna infrastruktura | pełna lista zweryfikowanych adresów z podpisami; nazwy ENS jako nazwa konta. |
| Neynar (Farcaster) | **tak-z-kluczem**, warunki przechowywania nie zweryfikowano | https://docs.neynar.com/reference/what-are-the-rate-limits-on-neynar-apis — „Free plan rate limits are 600 RPM” | klucz | adres → konto (`bulk-by-address`). Nie wdrożono — regulamin (neynar.com/terms) zwracał 404. |
| OFAC SDN | **tak** (już używane, kopia lokalna) | https://ofac.treasury.gov/faqs/topic/1626 — „OFAC may include as identifiers on the SDN List specific digital currency addresses associated with blocked persons.” | pobranie pliku | adres, nazwa. Wprost sformułowanego oświadczenia o domenie publicznej nie znaleziono. |
| MyEtherWallet/ethereum-lists | **tak** | https://github.com/MyEtherWallet/ethereum-lists — licencja MIT, listy zgłaszane przez społeczność | plik statyczny | adres → oznaczenie oszustwa. Nie wdrożono (należy do `packages/chain`). |
| scamsniffer/scam-database | **tak** (domeny), GPL-3.0 | https://github.com/scamsniffer/scam-database — „Cache the list locally and refresh at most once a day” | opóźnienie 7 dni | domeny phishingowe. Nie wdrożono. |
| brianleect/etherscan-labels, dawsbot/eth-labels | **nie** | https://github.com/dawsbot/eth-labels — „includes an automated scraper that logs into Etherscan and pulls label data”; licencja MIT repozytorium nie obejmuje danych zebranych wbrew regulaminowi Etherscan | — | to dane „wyprane” przez pośrednika — patrz „Pośrednik nie zmienia regulaminu źródła”. |
| Etherscan — etykiety adresów | **nie** | https://etherscan.io/apiterms — zakaz „Bulk-download, mirror, replicate or archive our datasets”; etykiety tylko w planie Pro Plus | — | — |
| WalletExplorer | **niejasne — do decyzji zespołu** (istniejące łączniki) | https://www.walletexplorer.com/info — serwis nie publikuje regulaminu; podaje, że „there is JSON API” | — | brak warunków ≠ zgoda; **ryzyko do odnotowania**. |
| Arkham Intelligence | **nie zweryfikowano → nie** | arkm.com/api-terms-of-service — 403 | klucz po zgłoszeniu | — |
| Chainabuse | **tak-z-kluczem** (marginalne) | https://docs.trmlabs.com/guides/chainabuse/getting-started-2-1 — „a standard API Key with a usage limit of 10 calls per month” | 10 wywołań/miesiąc | adres → zgłoszenia oszustw. Nie wdrożono (limit). |
| ENS | **tak** (już używane: `live-ens`) | publiczne API ensdata.net | — | nazwa ↔ adres, rekordy tekstowe. |
| Unstoppable Domains | **tak-z-kluczem** | https://docs.unstoppabledomains.com/resolution/quickstart/reverse-resolution/ — „There is a 20 call/second/key limit on the Resolution Service API.” | klucz | adres → domena. Nie wdrożono. |
| Lens Protocol | **tak** dla punktu API, regulamin **nie zweryfikowano** | https://lens.xyz/docs/protocol/getting-started/graphql — klucz opcjonalny | limity nieopublikowane | nick lub adres → konto. Nie wdrożono do czasu przeczytania regulaminu. |
| Human (Gitcoin) Passport | **tak-z-kluczem**, regulamin nie znaleziony | https://docs.passport.human.tech/building-with-passport/stamps/passport-api/api-reference | 125 żądań / 15 min | adres → pieczęcie. Nie wdrożono. |
| EAS (poświadczenia), POAP | **nie zweryfikowano** | docs.attest.org, documentation.poap.tech — strony nie dały się pobrać | — | — |

---

## 5. Źródła, których NIE odpytujemy

| Źródło | Werdykt | Podstawa |
|---|---|---|
| OLX | **nie** | https://www.olx.pl/robots.txt — `Disallow: /api/`, `Disallow: */ajax/`, `Disallow: /oferta/kontakt/`; API partnerskie (https://developer.olx.pl/) służy sprzedawcy do własnych ogłoszeń: „Publish ads, manage replies and sync stock from your own system.” Regulaminu serwisu nie udało się pobrać. |
| Allegro, Allegro Lokalnie | **nie** | https://developer.allegro.pl/rules — §2: API służy „wyłącznie wspieranie lub promowanie korzystania z Allegro przez Użytkowników”; §4.1(e) zakaz „dokonywania ekstrakcji (ang. scraping) tych materiałów”. Regulaminów głównych nie udało się pobrać (403/404). |
| Facebook, Instagram | **nie** | https://www.facebook.com/legal/terms §3.2 — „Użytkownik nie może uzyskiwać dostępu ani gromadzić danych z naszych Produktów sposobem zautomatyzowanym (bez naszej uprzedniej zgody)”. Meta Content Library tylko dla instytucji badawczych. |
| X / Twitter | **nie** | https://docs.x.com/developer-terms/agreement — XIV.B: zakaz użycia treści do „conducting or providing surveillance or gathering intelligence”; XIV.C: podmioty rządowe — wyłącznie plan Enterprise za zgodą. Oficjalne API jest płatne za użycie (odczyt wpisu 0,005 USD, odczyt profilu 0,010 USD), ale warunki wykluczają nasze zastosowanie. Regulaminu serwisu nie udało się pobrać. Istniejący `live-wayback-twitter` czyta kopie w Internet Archive, nie X. |
| LinkedIn | **nie** | https://www.linkedin.com/legal/user-agreement §8.2 — zakaz „Use bots or other unauthorized automated methods to access the Services”. |
| Discord | **nie** | https://discord.com/terms — zakaz „scraping our services without our written consent, including by using any robot, spider, crawler, scraper, or other automatic device”. Brak publicznego wyszukiwania; bot wymaga zaproszenia na serwer. |
| Telegram — grupy prywatne | **nie** | patrz rozdz. 2; treści niedostępne publicznie. |
| Bazy wycieków | **nie** | zakazane wprost regulaminem konkursu. API Have I Been Pwned (https://haveibeenpwned.com/API/v3) zwraca tylko nazwę wycieku i samo jest legalne, ale to nadal korzystanie z danych o wyciekach — nie używamy. |
| Agregatory osób (Spokeo, Pipl, PeekYou) | **nie** | https://www.spokeo.com/terms-of-use §2(b) — „You are prohibited from scraping, crawling, data-mining, or using any robot, spider, or other automatic device”; brak podstawy z RODO dla danych z takich serwisów. |
| Strony wyników wyszukiwarek, SerpAPI | **nie** | patrz rozdz. 1. |

---

## 6. Co wdrożono na podstawie tego dokumentu

| Łącznik | Droga dostępu | Zapytanie wychodzi na zewnątrz? | Włączenie |
|---|---|---|---|
| `rejestry-publiczne` | migawki lokalne: rejestr walut wirtualnych (IAS Katowice), lista ostrzeżeń KNF, rejestr MiCA ESMA | **nie** — sprawdzenie lokalne | zawsze |
| `live-farcaster` | udokumentowane publiczne API Farcaster (`fnames.farcaster.xyz`, `api.farcaster.xyz/fc/*`), opcjonalnie własny węzeł | tak — nazwa konta do Farcaster | `ENABLE_LIVE`; węzeł: `FARCASTER_HUB_URL` |
| `web-search` | API Marginalia Search i/lub Mojeek | **tak — identyfikator podmiotu do dostawcy wyszukiwarki** | `ENABLE_LIVE` **i** `MARGINALIA_API_KEY` albo `MOJEEK_API_KEY` + `MOJEEK_STORAGE_RIGHTS=1`; bez klucza łącznik jest wyłączony |

---

## Jak dodać źródło zgodnie z regulaminem

1. **Przeczytaj aktualny regulamin i dokumentację API** — nie polegaj na pamięci ani na cudzym opisie. Zapisz adres strony, datę i jedną klauzulę, na której opierasz werdykt. Jeśli strony nie da się pobrać albo klauzula jest niejasna: werdykt „nie”.
2. **Sprawdź cztery rzeczy:** czy wolno pytać automatycznie; czy wolno przechowywać wyniki (narzędzie zapisuje ślady jako materiał dowodowy); czy są ograniczenia celu (inwigilacja, organy publiczne, profilowanie osób); kto odpowiada za treść stron trzecich.
3. **Tylko udokumentowane punkty końcowe.** Punkt, który „działa”, ale nie ma go w dokumentacji albo jest zasłonięty przez `robots.txt` bez wyraźnego udostępnienia, nie jest drogą dostępu.
4. **Żadnego pośrednika dla źródeł z listy „nie”.** Usługa, model językowy ani zbiór danych, który pobrał treść wbrew regulaminowi źródła, nie czyni jej dozwoloną.
5. **Odmowa kończy sprawę.** 401, 403, 429, CAPTCHA, logowanie — pusty wynik i wpis w dzienniku; bez ponawiania, zmiany nagłówków i szukania obejścia. Używaj wspólnego klienta `http.ts` (jawny `User-Agent`, limit żądań i tempa).
6. **Klucz i zapytanie.** Klucz tylko ze zmiennej środowiskowej, wysyłany wyłącznie do hosta dostawcy, nigdy do dziennika ani do treści śladu. Jeśli zapytanie wynosi identyfikator podmiotu poza system — łącznik domyślnie wyłączony, a opis łącznika nazywa odbiorcę.
7. **Uczciwa siła dowodu.** Fragment z wyszukiwarki i wpis odnaleziony po samej nazwie to „tylko nazwa”; dowód kryptograficzny tylko tam, gdzie protokół faktycznie weryfikuje podpis. Opisz w `description` łącznika, co i z jakimi parametrami jest przeszukiwane.
8. **Dane offline** — z datą migawki, adresem źródła i skryptem odświeżania; wymóg podania źródła spełnij w treści śladu.
9. **Test bez internetu** (atrapa `fetch`) i wiersz w tym dokumencie oraz w tabeli źródeł README.
