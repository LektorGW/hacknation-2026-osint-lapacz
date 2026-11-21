# @olcys/sources

Łączniki `SourceConnector` do publicznych źródeł Web2.

```ts
import { createConnectors, htmlToText } from '@olcys/sources';

const connectors = createConnectors({
  sandboxUrl: 'http://localhost:4100', // łączniki piaskownicy
  enableLive: false,                   // GitHub, Wayback Machine
  torProxyUrl: undefined,              // np. 'http://127.0.0.1:8118'
});
```

| id | service | Kiedy powstaje | Co przeszukuje |
|---|---|---|---|
| `sandbox-gitpub` | `gitpub.sandbox` | `sandboxUrl` | profile programistów |
| `sandbox-www` | `www.sandbox` | `sandboxUrl` | strony osobiste |
| `sandbox-targ` | `targ.sandbox` | `sandboxUrl` | ogłoszenia i oferty P2P |
| `sandbox-forum` | `forum.sandbox` | `sandboxUrl` | posty forum, lista dyskusyjna |
| `sandbox-spolecznosc` | `spolecznosc.sandbox` | `sandboxUrl` | profile, wpisy, komentarze |
| `sandbox-komunikator` | `komunikator.sandbox` | `sandboxUrl` | publiczne kanały grupowe |
| `sandbox-archiwum` | `archiwum.sandbox` | `sandboxUrl` | archiwalne kopie stron |
| `live-github` | `github.com` | `enableLive` | profil, README profilu, FUNDING.yml (REST API bez klucza) |
| `live-wayback` | `web.archive.org` | `enableLive` | archiwalne kopie `github.com/<login>` (CDX API) |
| `tor-onion` | `tor.onion` | `torProxyUrl` | jawne strony .onion z listy; domyślnie wyłączony |

## Jak łączniki opisują dokument

- `identityMatch`: `exact_identifier`, gdy identyfikator jest loginem, nickiem lub e-mailem autora; `name_only`, gdy zgadza się samo imię i nazwisko; `linked_profile` dla konta w tym samym serwisie, które potwierdzony profil sam wskazał odnośnikiem `rel="me"` (jeden krok).
- Wyszukiwanie po adresie kryptowalutowym (`crypto_address`) zwraca dokumenty **cudzego autorstwa** zawierające ten adres — służy do policzenia niepowiązanych publikujących. Takie dokumenty mają `identityMatch: 'name_only'` i `matchedIdentifier.type === 'crypto_address'`; nie należy ich traktować jak śladów podmiotu.
- `discoveredIdentifiers` (e-maile z treści, nick konta znalezionego po e-mailu, profile z `rel="me"` w innych serwisach) pochodzą tylko z dokumentów powiązanych pewnie — konto imiennika nie uruchamia dalszego wyszukiwania. Dokument znaleziony w kolejnej rundzie po odkrytym identyfikatorze łącznik oznacza jako `exact_identifier`, bo nie wie, skąd identyfikator pochodzi; obniżenie do `linked_profile` należy do przebiegu analizy.
- Kopie archiwalne mają `archivedAt` i `service` oryginału (np. `www.sandbox`, `github.com`), żeby ta sama strona na żywo i w archiwum nie liczyła się jako dwa niezależne źródła.

## Zasady wobec źródeł

Nagłówek `User-Agent: OLCyS-research/0.1`, limit czasu 10 s (Tor: 30 s), najwyżej 4 żądania na identyfikator w łącznikach live. Odpowiedzi 403 i 429 kończą pracę łącznika pustym wynikiem z wpisem w dzienniku analizy — bez ponawiania i obchodzenia. Łączniki nie logują się i nie wysyłają niczego poza zapytaniem do odpytywanego źródła.

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

`node --test test/*.test.ts` — `htmlToText` oraz łączniki piaskownicy na serwerze `apps/sandbox` uruchamianym w teście na losowym porcie. Testy nie łączą się z internetem; łączniki live i Tor nie mają testów sieciowych.
