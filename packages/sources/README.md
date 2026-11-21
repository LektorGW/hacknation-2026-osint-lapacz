# @olcys/sources

Łączniki `SourceConnector` do publicznych źródeł Web2.

```ts
import { createConnectors, htmlToText } from '@olcys/sources';

const connectors = createConnectors({
  sandboxUrl: 'http://localhost:4100', // łączniki piaskownicy
  enableLive: false,                   // łączniki do prawdziwych serwisów (tabela niżej)
  githubToken: undefined,              // opcjonalny token GitHub — tylko wyższy limit zapytań
  torProxyUrl: undefined,              // np. 'http://127.0.0.1:8118'
});
```

Pozostałe pola konfiguracji: `fediverseInstances` (nadpisuje `config/fediverse-instances.json`), `telegramChannels` (nadpisuje `config/telegram-channels.json`), a wyłącznie dla testów — `fetcher` (atrapa `fetch`), `minRequestIntervalMs` i `allowPrivateHosts`.

## Łączniki piaskownicy i Tor

| id | service | Kiedy powstaje | Co przeszukuje | `discover` |
|---|---|---|---|---|
| `sandbox-gitpub` | `gitpub.sandbox` | `sandboxUrl` | profile programistów | profile (z danymi kontaktowymi) |
| `sandbox-www` | `www.sandbox` | `sandboxUrl` | strony osobiste | strony osobiste |
| `sandbox-targ` | `targ.sandbox` | `sandboxUrl` | ogłoszenia i oferty P2P | najnowsze ogłoszenia |
| `sandbox-forum` | `forum.sandbox` | `sandboxUrl` | posty forum, lista dyskusyjna | najnowsze posty i wiadomości listy |
| `sandbox-spolecznosc` | `spolecznosc.sandbox` | `sandboxUrl` | profile, wpisy, komentarze | najnowsze wpisy i komentarze |
| `sandbox-komunikator` | `komunikator.sandbox` | `sandboxUrl` | publiczne kanały grupowe | najnowsze wiadomości |
| `sandbox-archiwum` | `archiwum.sandbox` | `sandboxUrl` | archiwalne kopie stron | — |
| `tor-onion` | host `.onion` | `torProxyUrl` | jawne strony .onion z listy; domyślnie wyłączony | strony z listy zawierające adresy |

## Łączniki do prawdziwych serwisów (`enableLive`)

| id | service dokumentów | Przyjmuje | Kategoria | Co odpytuje |
|---|---|---|---|---|
| `live-keybase` | `keybase.io` | nick, login, profile_url | `cryptographic_proof` | `user/lookup.json` po nazwie oraz po dowodach kont GitHub / Twitter / Reddit (Hacker News tylko dla adresu profilu); podpisane adresy i dowody kont |
| `live-ens` | `ens.domains` | ens_name, nick, login, crypto_address | `cryptographic_proof`; `own_profile` dla odgadniętej nazwy | `api.ensdata.net/<nazwa lub adres>`, zapasowo `api.ensideas.com` |
| `live-github` | `github.com` | login, nick, profile_url | `own_profile` | REST API: profil, README profilu, FUNDING.yml |
| `live-github-gists` | `github.com` | login, nick, profile_url | `own_profile` | REST API: lista gistów i treść pierwszego pliku z 3 najnowszych |
| `live-github-activity` | `github.com` | login, nick, profile_url | `own_profile` | REST API: publiczne zdarzenia (`/users/<login>/events/public`) → imię, nazwisko i e-mail autora commitów (bez adresów „noreply") |
| `live-gravatar` | `gravatar.com` | email, nick, profile_url | `own_profile` | `gravatar.com/<SHA-256 e-maila>.json` (zapasowo MD5) lub `<nick>.json` |
| `live-fediverse` | host instancji | nick, login, profile_url | `own_profile` | `/api/v1/accounts/lookup` na instancjach z `config/fediverse-instances.json` albo na instancji wskazanej w identyfikatorze |
| `live-telegram` | `t.me` | messenger_id, nick, profile_url | `own_profile` (opis), `settlement_message` (wiadomości) | publiczny podgląd kanału `t.me/s/<nazwa>`; ma `discover` |
| `live-bitcointalk` | `bitcointalk.org` | profile_url | `own_profile` | strona profilu `index.php?action=profile;u=<numer>` |
| `live-www` | host strony | profile_url | `own_profile` | `robots.txt`, potem jedna strona pod podanym adresem |
| `live-wayback` | host oryginału | login, nick, profile_url | `own_profile` | CDX API i do 3 kopii rozłożonych w czasie |

| `live-wayback-twitter` | `twitter.com` | nick, login | `own_profile` | CDX API dla `twitter.com/<nick>` i do 3 kopii archiwalnych profilu |
| `live-walletexplorer` | `walletexplorer.com` | crypto_address (Bitcoin) | `forum_post` | strona `walletexplorer.com/address/<adres>` — nazwa portfela, do którego serwis zalicza adres (dokument tylko dla portfela nazwanego; `author` = nazwa portfela) |
| `live-bitcoinwhoswho` | `bitcoinwhoswho.com` | crypto_address (Bitcoin) | `forum_post` | strona `bitcoinwhoswho.com/address/<adres>` — „Scam Alert” i lista stron, na których widziano adres (dokument bez autora) |
| `live-github-search` | `github.com` | crypto_address, email, nick, login | `own_profile` / `forum_post` | wyszukiwarka GitHuba (tylko z tokenem): `/search/code`, `/search/issues`, `/search/commits`, `/search/users`; najwyżej 3 zapytania na identyfikator |
| `deep-search` | host trafienia | nick, login, email, crypto_address, full_name, ens_name | `forum_post`; `own_profile` dla profili | wyszukiwarki wszystkich źródeł rejestru monitoringu — opis niżej; domyślnie wyłączony |

Uwagi:

- Łącznik z typem `profile_url` reaguje tylko na adresy swojego serwisu (np. `live-github` na `github.com/<login>`); `live-www` pomija serwisy, które mają własny łącznik.
- `live-ens` dla `crypto_address` (adres EVM) zwraca nazwę główną adresu; `author` to nazwa ENS, dzięki czemu analiza rozpoznaje adres podmiotu, gdy zna jego nazwę.
- Telegram: dokumentem jest opis kanału oraz każda widoczna na stronie podglądu wiadomość zawierająca adres kryptowalutowy.
- GitHub bez tokenu ma limit 60 zapytań na godzinę na adres IP; po 403/429 w dzienniku pojawia się „limit zapytań GitHub — ustaw GITHUB_TOKEN". Token trafia wyłącznie w nagłówku `Authorization` do `api.github.com`.
- Wayback: limit 4 żądań na identyfikator oznacza zapytanie CDX i najwyżej 3 kopie.

## Jak łączniki opisują dokument

- `identityMatch` ustawiany przez łącznik:
  - `verified_link` — wyłącznie wtedy, gdy samo źródło potwierdza tożsamość: Keybase ma dowód kryptograficzny dla konta podanego adresem profilu (np. `github.com/<login>`), albo rekord tekstowy nazwy ENS odgadniętej z nicka wskazuje ten właśnie nick;
  - `name_only` — zgodne samo imię i nazwisko, dokument cudzego autorstwa zawierający szukany adres, albo nazwa `<nick>.eth` odgadnięta z nicka, której rekordy niczego nie potwierdzają;
  - `exact_identifier` — pozostałe trafienia po identyfikatorze. To, czy sam nick wystarcza do przypisania profilu (`same_handle`, `common_handle`), ocenia przebieg analizy w API, nie łącznik.
  - `linked_profile` — w piaskownicy: konto w tym samym serwisie, które potwierdzony profil sam wskazał odnośnikiem `rel="me"` (jeden krok).
- `profile` (`ProfileAttributes`) zawiera wszystko, co źródło ujawnia o autorze: `handle`, `displayName`, `emails`, `phones`, `urls`, `location`, `avatarUrl`, `bio`, `createdAt`. W piaskownicy to dane konta zwracane przez API serwisu uzupełnione o e-maile i telefony („tel. …") z treści dokumentu oraz odnośniki `rel="me"`.
- Wyszukiwanie po adresie kryptowalutowym (`crypto_address`) zwraca dokumenty **cudzego autorstwa** zawierające ten adres — służy do policzenia niepowiązanych publikujących. Takie dokumenty mają `identityMatch: 'name_only'` i `matchedIdentifier.type === 'crypto_address'`.
- Źródła pól `profile` w łącznikach live: GitHub — `name`, publiczny `email`, `location`, `company` (dopisane do `bio`), `blog`, `twitter_username`, `created_at`, `avatar_url`, a w `live-github-activity` najczęstszy autor commitów; Keybase — `full_name`, `location`, `bio`, konta potwierdzone dowodem; Gravatar — `name.formatted` / `displayName`, `currentLocation`, `emails`, `phoneNumbers`, konta i odnośniki; Mastodon — `display_name`, opis, odnośniki z pól, `created_at`, awatar; ENS — rekordy `name`, `email`, `url`, `location`, `description`, `com.github`, `com.twitter`; strona WWW — `<meta name="author">`, `og:title`, osoba schema.org w JSON-LD (`name`, `email`, `telephone`, `address`, `sameAs`), odnośniki `mailto:` / `tel:`, `rel="me"`.
- `discoveredIdentifiers` nie zawierają powtórzeń (ten sam adres z http/https i „www." to jedna pozycja), adresów e-mail „noreply" ani odnośników do samego serwisu.
- `discoveredIdentifiers` pochodzą tylko z dokumentów powiązanych pewnie — konto imiennika, odgadnięta nazwa ENS ani profil Keybase znaleziony przez dowód konta o nazwie równej samemu nickowi nie uruchamiają dalszego wyszukiwania.
- Kopie archiwalne mają `archivedAt` i `service` oryginału (np. `www.sandbox`, `github.com`), żeby ta sama strona na żywo i w archiwum nie liczyła się jako dwa niezależne źródła.

## Typowanie: `discover(context, limit)`

Łączniki piaskownicy (wszystkie poza archiwum), `live-telegram` i `tor-onion` implementują `DiscoveringConnector`: zwracają najnowsze publikacje bez podawania identyfikatora osoby. Dokumenty mają tę samą postać co w `search`, z `author`, `profile` i `matchedIdentifier = { type: 'nick', value: <autor> }`.

- Piaskownica: `GET /<serwis>/api/recent?limit=` — od najświeższych.
- Telegram: wiadomości z adresem kryptowalutowym z publicznych kanałów wymienionych w `config/telegram-channels.json` (`{ "channels": ["nazwa_kanalu"] }`, domyślnie pusta lista; najwyżej 10 kanałów, jedno żądanie na kanał).
- Tor: strony z `config/onion-sources.json`, na których występują adresy; autorem jest host witryny.

## Głębokie wyszukiwanie (`deep-search`)

Łącznik `deep-search` (`enabledByDefault: false`) rozsyła jedno zapytanie do publicznych wyszukiwarek wszystkich włączonych źródeł rejestru monitoringu, które mają je bez logowania — po jednym celu na host (obecnie 421 hostów: 303 fora Discourse, 86 instancji Mastodona, 27 instancji Lemmy, 4 serwisy StackExchange, Hacker News):

| Źródło | Adres, e-mail, nazwa ENS | Nick / login | Imię i nazwisko |
|---|---|---|---|
| Discourse | `/search.json?q=<fraza>` | `/u/<nick>.json` (profil), a dla forów, na których konto istnieje — `/search.json?q=@<nick>` (wypowiedzi; najwyżej 8 forów) | `/search.json?q="<nazwisko>"` (konta o dokładnie takiej nazwie) |
| Lemmy | `/api/v3/search?q=…&type_=All` | `/api/v3/user?username=` (profil, wpisy, komentarze) | `/api/v3/search?type_=Users` |
| Mastodon | — (treści nie da się przeszukać bez logowania) | `/api/v1/accounts/lookup?acct=` | `/api/v2/search?type=accounts` |
| StackExchange | `/search/excerpts?q=`, potem `/posts/{id}` (autor i treść) | `/users?inname=` | `/users?inname=` |
| Hacker News | Algolia `search_by_date?query="<fraza>"` | `tags=author_<nick>` | `query="<nazwisko>"` |

Dopasowanie jest dokładne: nazwa konta równa nickowi (nie podciąg), adres obecny w treści trafienia (po normalizacji zapisu). Zwracani są **wszyscy** autorzy trafień — dla adresu z `identityMatch: 'name_only'`; kto jest właścicielem, a kto niepowiązanym publikującym, rozstrzyga analiza. Trafienia po nicku mają `exact_identifier`, wzmianki e-maila, nazwy ENS i nazwiska — `name_only`. Każde trafienie jest od razu wpisywane do `context.log` („znaleziono w …”), a na końcu podsumowanie: ile hostów odpowiedziało, odmówiło, ile pominięto po wyczerpaniu budżetu.

Ustawienia (`createConnectors({ deepSearch: { … } })`): `budgetMs` (domyślnie 45 000), `concurrency` (12 hostów naraz), `requestTimeoutMs` (8000), `stackSites` (4 — API StackExchange bez klucza ma limit 300 żądań dziennie na adres IP), `maxDocuments` (300). Jedno żądanie na host na zapytanie (StackExchange: dwa na serwis). Uwaga dla wywołującego: łącznik potrzebuje do 45 s, więc limit czasu jednego łącznika w przebiegu analizy musi być dla niego dłuższy niż zwykłe 20 s (albo trzeba zmniejszyć `budgetMs`).

Próba na prawdziwych danych: `node scripts/deep-check.ts <typ> <wartość> [--budget 45] [--connectors …]` — wyłącznie dla identyfikatorów osób i organizacji publicznych; wyniki nie są zapisywane.

Próba z 2026-11-21 (`deep-search`, po jednym przebiegu na przypadek, 421 hostów, bez tokenu GitHub; identyfikatory publiczne, same publikowane przez właścicieli):

| Przypadek | Hosty: odpowiedziały / z trafieniami / odmowa / błąd | Dokumenty | Autorzy | Serwisy | Czas |
|---|---|---|---|---|---|
| adres BTC darowizn Internet Archive (`1Archive1n2C5…`) | 334 / 2 / 1 / 0 | 3 | 3 | 2 | 19,2 s |
| adres ETH `vitalik.eth` (`0xd8dA6BF2…`) | 334 / 7 / 1 / 0 | 19 | 18 | 7 | 19,3 s |
| nazwa ENS `vitalik.eth` | 332 / 38 / 1 / 2 | 300 (limit) | 205 | 43 | 19,9 s |
| nick `vbuterin` | 391 / 16 / 29 / 1 | 153 | 16 | 16 | 15,5 s |
| nick `gavinandresen` | 391 / 4 / 29 / 1 | 4 | 4 | 4 | 13,9 s |
| adres BTC darowizn WikiLeaks (`1HB5XMLmzF…`) | 333 / 10 / 1 / 1 | 27 | 9 | 4 | 18,5 s |

Przy wyszukiwaniu adresu instancje Mastodona (86) nie są odpytywane, stąd około 334 odpowiedzi. Przy nicku 28 forów Discourse odpowiada 403 na `/u/<nick>.json` (profile tylko dla zalogowanych) — liczone jako odmowa, bez ponawiania. Dodatkowo w tej samej próbie: `live-bitcoinwhoswho` zwrócił dla obu adresów BTC listę stron z wystąpieniami (19 dla adresu Internet Archive), `live-walletexplorer` — portfele bez nazwy (brak dokumentu), `live-wayback-twitter` — 1 i 2 kopie archiwalne profili; `live-github-search` nie był sprawdzany na żywo (brak tokenu).

### Serwisy wiedzy o adresach — co działa bez klucza (sprawdzone 2026-11-21, po jednym żądaniu)

| Serwis | Wynik | Decyzja |
|---|---|---|
| WalletExplorer (`walletexplorer.com/address/<adres>`) | 200, HTML z nazwą portfela; brak `robots.txt` | łącznik `live-walletexplorer` |
| BitcoinWhosWho (`bitcoinwhoswho.com/address/<adres>`) | 200, HTML ze „Scam Alert” i listą stron z wystąpieniami adresu | łącznik `live-bitcoinwhoswho` |
| Wayback Machine CDX (`twitter.com/<nick>`) | 200, lista kopii | łącznik `live-wayback-twitter` |
| Chainabuse (`chainabuse.com/address/<adres>`) | 200, ale sama powłoka aplikacji — dane ładuje JavaScript z API wymagającego klucza | pominięty |
| OpenSanctions (`api.opensanctions.org/search`) | 401 „No API key provided” | pominięty |
| Blockchair (`api.blockchair.com/…/dashboards/address`) | 430 — adres IP na czarnej liście, wymagany klucz | pominięty |

## Rozpoznawanie adresów w nietypowych zapisach

Pomocniki eksportowane dla API (stosowane też w `htmlToText`, monitoringu i głębokim wyszukiwaniu):

- `normalizeAddressText(text)` — tekst przygotowany do `extractAddresses`: usuwa znaki niewidoczne (miękki łącznik, znaki zerowej szerokości), rozwija encje numeryczne, **skleja adresy rozbite odstępami lub łamaniem wiersza** (tylko gdy wynik ma poprawną sumę kontrolną; nie skleja przez pusty wiersz) i dopisuje adresy z odnośników płatności oraz odnośników do eksploratorów, jeśli sam adres nie występuje w tekście w czytelnej postaci;
- `addressFromHref(href)` — adres z `bitcoin:` / `ethereum:` / `tron:` albo z odnośnika do eksploratora (`etherscan.io/address/…`, `blockchair.com/bitcoin/address/…`, `tronscan.org/#/address/…`, `mempool.space/address/…`, `blockstream.info/address/…` i podobnych);
- `findEnsNames(text)` — nazwy `*.eth` w treści (trafiają do `discoveredIdentifiers` jako `ens_name`);
- `htmlToText(html)` zachowuje adres z atrybutu `href` takich odnośników jako dopisek „[adres z odnośnika: …]”, bo widoczny napis to często tylko „wpłać tutaj”.

## Monitoring: rejestr źródeł i silniki

Cykliczny monitoring korzysta z łączników tworzonych z **rejestru źródeł** — wszystkich plików `config/monitor-sources/*.json` (każdy to tablica wpisów; własne ręczne wpisy są w `core.json`, który ma pierwszeństwo przy powtórzeniach). Adapter obsługuje silnik, nie pojedynczą stronę: nowe źródło to jeden wpis, bez zmian w kodzie. Wpisy błędne oraz powtórzone po `id` lub po znormalizowanym adresie są pomijane z ostrzeżeniem.

```json
{ "id": "krotki-unikalny", "engine": "discourse", "label": "nazwa dla analityka", "url": "https://forum.example",
  "language": "pl", "region": "PL", "category": "forum_post", "enabled": true, "note": "…", "verifiedAt": "2026-11-21", "verifiedItems": 20 }
```

| Silnik | Pola wpisu | Żądanie w `discover` | `search` (adres / nick) |
|---|---|---|---|
| `rss` | `url` | GET `url` (RSS 2.0 lub Atom) | — |
| `discourse` | `url` (adres bazowy forum) | `{url}/posts.json`; gdy niedostępne — `{url}/latest.json` | `/search.json?q=`, `/u/<nick>.json` |
| `reddit` | `sub` | `https://www.reddit.com/r/{sub}/new/.rss`; zapas: `old.reddit.com` | `/r/{sub}/search.json?restrict_sr=1` |
| `mastodon-tag` | `instance`, `tag` | `https://{instance}/api/v1/timelines/tag/{tag}?limit=20` | — |
| `telegram` | `channel` | `https://t.me/s/{channel}` | — |
| `stackexchange` | `site` | `api.stackexchange.com/2.3/questions?order=desc&sort=creation&site={site}&filter=withbody&pagesize=20` | `/search/advanced`, `/users?inname=` |
| `hn` | `query` | `hn.algolia.com/api/v1/search_by_date?query={query}&tags=comment&hitsPerPage=20` | fraza w cudzysłowie, `tags=author_<nick>` |
| `lemmy` | `instance`, `community` | `https://{instance}/api/v3/post/list?community_name={community}&sort=New&limit=20` | — |
| `smf-board` | `url` działu (`…index.php?board=<id>.0`) | `robots.txt`, lista wątków działu i pierwsze strony najwyżej 5 najnowszych nieprzypiętych wątków (Bitcointalk wyłączył RSS); min. 2 s odstępu, najwyżej 6 żądań na dział i ok. 40 na host na przebieg | — |
| `html-list` | `url`, `selectors` (`item`, `link`, opcjonalnie `author`, `date`) | `robots.txt` (raz na 6 godzin na host), potem strona listy wątków | — |
| `github-search` | `query` | `api.github.com/search/issues` — tylko z tokenem | — |

Selektory `html-list` to mały podzbiór CSS: `tag`, `.klasa`, `tag.klasa`, `[atr]`, `[atr=…]`, `[atr*=…]`, `[atr^=…]`, `[atr$=…]` i spacja (potomek). Silnik czyta wyłącznie stronę listy (tytuł, autor, data) — treści wątków nie pobiera.

Łączniki z rejestru mają id `mon-<id>`, `enabledByDefault: false` (nie spowalniają zwykłej analizy osoby) i metodę `discover`. Dokument z `discover` zawiera `author` (nick autora posta), `profile` (to, co ujawnia źródło: nazwa, awatar, adres profilu, lokalizacja), `publishedAt`, `title`, `text` bez cytatów innych osób (`<blockquote>`, bloki „quote”, wiersze `>` w Markdown), bezpośredni `url` posta i `discoveredIdentifiers`. Zwracane są wszystkie świeże posty do limitu; tani filtr wstępny włącza `onlyWithAddresses` we wpisie albo `monitorOnlyWithAddresses` w konfiguracji. Pamięć „widzianych” adresów należy do API.

```ts
import { createConnectors, listMonitorConnectors, loadMonitorSources, runMonitorPass, summarizeMonitorSources } from '@olcys/sources';

const connectors = createConnectors({ enableLive: true });          // rejestr wczytywany z config/monitor-sources/
const monitors = listMonitorConnectors(connectors);                 // tylko łączniki mon-*
const pass = await runMonitorPass(connectors, { limit: 20, concurrency: 8, budgetMs: 10 * 60_000 });
const numbers = summarizeMonitorSources(loadMonitorSources().sources); // { entries, enabledEntries, hosts, communities, byEngine, byLanguage, byRegion }
```

`runMonitorPass` to oszczędny przebieg po wszystkich źródłach: jedno żądanie na źródło (drugie tylko jako zapas dla Discourse i Reddita), kolejka na host, najwyżej `concurrency` hostów naraz, odstęp między żądaniami do hosta co najmniej 1 s (Reddit i t.me: 2 s), łączny budżet czasu. Odmowa hosta (403/429) kończy resztę jego kolejki w danym przebiegu; błędy 5xx i przekroczenia czasu dają pusty wynik z wpisem w wynikach — nigdy wyjątek.

Cudzy wpis można wyłączyć albo poprawić bez edytowania cudzego pliku — wpisem-nadpisaniem w `core.json`: `{ "id": "<id wpisu>", "override": true, "enabled": false, "note": "powód" }` (nadpisywane pola: `enabled`, `note`, `label`, `category`; nadpisanie nie jest źródłem).

Ten sam dział forum SMF podany kilkoma sposobami (kanał RSS, lista HTML, `smf-board`) to jedno źródło; wyłączony odpowiednik wpisu, który już jest w rejestrze, znika przy scalaniu bez ostrzeżenia.

`summarizeMonitorSources` podaje trzy liczby: odrębne hosty i odrębne społeczności wśród wpisów włączonych oraz liczbę wpisów — oraz te same trzy liczby po odjęciu wpisów, których `note` zawiera „niska trafność” lub „niższa trafność” (`relevantHosts`, `relevantCommunities`, `relevantEntries`). Host to host strony (Reddit i Telegram — po jednym; Mastodon i Lemmy — instancja); społeczność to host forum, subreddit, kanał Telegram albo społeczność Lemmy na instancji.

### Monitoring: sprawdzone źródła

Aktualny stan rejestru i wynik ostatniej próby na żywo zapisuje `node scripts/monitor-check.ts` w pliku [`config/monitor-sources/STATUS.md`](config/monitor-sources/STATUS.md).

Próba z 2026-11-21 (jeden przebieg, limit 20 postów na źródło, 8 hostów naraz, 162 s, 876 żądań):

| | Odrębne hosty | Odrębne społeczności | Wpisy |
|---|---|---|---|
| Rejestr — wpisy włączone | 609 | 734 | 843 (wszystkich: 992) |
| Rejestr — bez wpisów o niskiej trafności | 528 | 653 | 760 |
| Odpowiedziały w próbie (zwróciły publikacje) | 599 | 724 | 831 |
| Odpowiedziały w próbie — bez wpisów o niskiej trafności | 518 | 643 | 749 |

| Silnik | Wpisy włączone | Odpowiedziały | Publikacje | Z adresem | Żądania |
|---|---|---|---|---|---|
| `discourse` | 304 | 303 | 5819 | 247 | 317 |
| `rss` | 202 | 196 | 3288 | 11 | 202 |
| `mastodon-tag` | 133 | 132 | 2185 | 4 | 133 |
| `telegram` | 82 | 82 | 1499 | 28 | 82 |
| `lemmy` | 71 | 71 | 1105 | 1 | 71 |
| `smf-board` (Bitcointalk) | 20 | 19 | 380 | 18 | 40 |
| `stackexchange` | 17 | 14 | 280 | 6 | 17 |
| `hn` | 14 | 14 | 229 | 11 | 14 |
| `reddit` | 0 (77 wyłączonych) | — | — | — | — |

Reddit blokuje tę sieć (404 / przekierowanie na logowanie / 403), więc wszystkie 77 subredditów jest w rejestrze wyłączonych; silnik jest gotowy i przetestowany na atrapach. Pełna lista źródeł, błędów i ostrzeżeń rejestru jest w `STATUS.md`.

## Zasady wobec źródeł

Wspólny klient HTTP (`src/http.ts`): nagłówek `User-Agent: OLCyS-research/0.1 (hackathon KAS; kontakt przez organizatora)`, limit czasu 10 s (Tor: 30 s), limit odpowiedzi 1 MB, najwyżej 4 żądania na identyfikator na łącznik, co najmniej 400 ms między żądaniami do tego samego hosta (łączniki live). Odpowiedzi 403, 404, 429 i przekroczenie czasu kończą się pustym wynikiem z wpisem w dzienniku analizy — bez ponawiania, obchodzenia i wyjątków. Łączniki nie logują się i wysyłają do źródła wyłącznie identyfikator potrzebny do zapytania (Gravatar: sam skrót e-maila).

Łączniki pobierające adres podany w identyfikatorze (`live-www`, instancja wskazana w `live-fediverse`) rozwiązują nazwę hosta i odrzucają adresy prywatne, loopback i link-local — także po przekierowaniu (najwyżej 3, śledzone ręcznie). `live-www` przed pobraniem strony sprawdza `robots.txt` (reguły dla `*` lub dla `OLCyS-research`).

## Tor

Łącznik powstaje tylko po podaniu `torProxyUrl` — adresu proxy HTTP Tora (`HTTPTunnelPort` w `torrc`). Pobiera wyłącznie strony wymienione w `config/onion-sources.json` i tworzy dokument tylko wtedy, gdy strona zawiera badany identyfikator (do dokumentu trafiają fragmenty tekstu wokół wystąpień). Nie wysyła zapytań ani formularzy i nie podąża za odnośnikami. Adresy inne niż `.onion` są pomijane; czytanych jest najwyżej 5 pozycji.

Lista jest domyślnie pusta — plik JSON nie może zawierać komentarzy, więc format opisany jest tutaj:

```json
{
  "sources": [
    { "url": "http://przykladowyadres.onion/forum/ogloszenia", "label": "Forum X — ogłoszenia" }
  ]
}
```

Wpisuj tylko jawne, dostępne bez logowania strony.

## Testy

`node --test test/*.test.ts` — `htmlToText`, łączniki piaskownicy na serwerze `apps/sandbox` uruchamianym w teście na losowym porcie (`test/sandbox.test.ts`, `test/market.test.ts`) oraz łączniki live na przykładowych odpowiedziach z atrapą `fetch` (`test/live.test.ts`). Testy nie łączą się z internetem.

Próba na prawdziwych serwisach (ręczna, nie test): `node scripts/live-check.ts [--record plik.json] [--replay plik.json] [<id łącznika> <typ>=<wartość> …]`. Bez argumentów wykonuje po jednym zapytaniu na serwis. Używaj wyłącznie kont osób i organizacji publicznych, które same publikują te dane.
