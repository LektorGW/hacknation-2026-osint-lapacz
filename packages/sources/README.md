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
