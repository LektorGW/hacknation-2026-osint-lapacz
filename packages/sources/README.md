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
| `sandbox-gitpub` | `gitpub.sandbox` | `sandboxUrl` | profile programistów | — |
| `sandbox-www` | `www.sandbox` | `sandboxUrl` | strony osobiste | — |
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

Łączniki `sandbox-targ`, `sandbox-forum`, `sandbox-spolecznosc`, `sandbox-komunikator`, `live-telegram` i `tor-onion` implementują `DiscoveringConnector`: zwracają najnowsze publikacje bez podawania identyfikatora osoby. Dokumenty mają tę samą postać co w `search`, z `author`, `profile` i `matchedIdentifier = { type: 'nick', value: <autor> }`.

- Piaskownica: `GET /<serwis>/api/recent?limit=` — od najświeższych.
- Telegram: wiadomości z adresem kryptowalutowym z publicznych kanałów wymienionych w `config/telegram-channels.json` (`{ "channels": ["nazwa_kanalu"] }`, domyślnie pusta lista; najwyżej 10 kanałów, jedno żądanie na kanał).
- Tor: strony z `config/onion-sources.json`, na których występują adresy; autorem jest host witryny.

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
