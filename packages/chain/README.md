# @olcys/chain

Dane blockchain dla OŁCyŚ: klasyfikacja adresów, przepływy, wskaźniki wyjścia do walut tradycyjnych i ich szacunkowa wycena w PLN.

```ts
import { createChainProviders, getActivityFromProviders } from '@olcys/chain';

const providers = createChainProviders({ sandboxUrl: 'http://localhost:4100', enableLive: false });
const activity = await getActivityFromProviders(providers, 'bitcoin', address, { log: console.log });
```

`getActivityFromProviders` pyta dostawców po kolei i zwraca pierwszą udaną odpowiedź. Błąd dostawcy (np. „nieznany adres” z sandboxa, limit zapytań) trafia do dziennika analizy i próbę podejmuje następny. Gdy nikt nie ma danych, wynik ma klasę `unknown`, zera i powód w `limitations`.

## Dostawcy

| Dostawca | Kiedy | Sieci | Żądania na adres |
|---|---|---|---|
| `LabChainProvider` | podano `labUrl` | wyłącznie sieć laboratoryjna `lab` (adresy `lab1…`) | 1 (`/api/blockchain`, wynik pamiętany 5 s) |
| `SandboxChainProvider` | podano `sandboxUrl` | wszystkie | 1 + po jednym na nieopisanego kontrahenta (maks. 25) |
| `EsploraProvider` (blockstream.info, zapasowo mempool.space) | `enableLive` | Bitcoin, testnet | 2–3 + etykiety WalletExplorer + adresy pośrednie |
| `BlockscoutProvider` (eth.blockscout.com) | `enableLive` | Ethereum | 3 + 1 (hurtowe znaczniki) + śledzenie środków |
| `TronGridProvider` (api.trongrid.io + TronScan) | `enableLive` | Tron | 3 + znaczniki TronScan + śledzenie środków |

Do publicznego API trafia wyłącznie badany adres lub adres kontrahenta (do Binance — para i data, do NBP — zakres dat). Nagłówek `User-Agent: OLCyS-research/0.1`, limit czasu żądania 10 s. Pobieranych jest 50 najnowszych transakcji; przekroczenie limitu jest opisane w `limitations`.

**Budżet żądań:** analiza jednego adresu wykonuje łącznie najwyżej 15 żądań do eksploratorów i serwisów etykiet (`requestBudget`), w trybie głębokim 40. Po wyczerpaniu budżetu dodatkowe kroki są przerywane, a `limitations` mówi, ilu kontrahentów nie sprawdzono. Błędy 429/5xx serwisów pomocniczych też trafiają do `limitations` i nie przerywają analizy. Kursy (Binance, NBP) nie wliczają się do budżetu — są pobierane raz i zapamiętywane.

Sandbox opisuje etykietą tylko pytany adres, dlatego dostawca dopytuje eksplorator o kontrahentów. Eksplorator może też opisać kontrahenta od razu w przelewie, polami opcjonalnymi `counterpartyLabel`, `counterpartyClass`, `counterpartyKind`, oraz podać `kind` dla pytanego adresu.

### Sieć laboratoryjna (`labUrl`)

`createChainProviders({ labUrl: 'http://127.0.0.1:8787' })` (w API: zmienna `LAB_URL`; domyślnie wyłączone) dodaje `LabChainProvider` — dostawcę dla testowego łańcucha UTXO z `apps/identity-lab`. To **sieć laboratoryjna, nie prawdziwa**: w core ma osobną wartość `Network` `'lab'`, a adresy `lab1` + 40 znaków hex nie mają sumy kontrolnej. Kod: `src/providers/lab.ts`, testy na atrapie: `test/lab.test.ts`.

Zakres jest minimalny — tyle, żeby teczka pokazała aktywność adresu: saldo z rejestru portfeli, sumy wpływów i wypływów oraz przelewy między adresami z potwierdzonych bloków (nadawca = właściciel wydawanych wyjść, reszta wracająca do nadawcy jest pomijana). Nazwa portfela z rejestru trafia do profilu jako etykieta bez klasy.

Ograniczenia (każde jest też w `limitations` wyniku):

- **token LAB nie ma wartości pieniężnej** — dostawca nie wycenia niczego w PLN, nie tworzy wskaźników wypłat, ścieżek ani sum podatkowych;
- bez transakcji oczekujących (mempool), śledzenia środków, klastra portfela i szukania powiązanych adresów;
- emisja początkowa (genesis) i nagrody za bloki są wliczone do wpływów i salda, ale nie mają nadawcy, więc nie ma ich na liście przelewów;
- kontrahenci nie dostają etykiet (nazwy portfeli w rejestrze to nazwy porządkowe, nie etykiety usług).

### Konfiguracja `createChainProviders`

| Pole | Domyślnie | Znaczenie |
|---|---|---|
| `sandboxUrl` | — | włącza dostawcę danych syntetycznych |
| `labUrl` | — | włącza dostawcę sieci laboratoryjnej (`apps/identity-lab`, token LAB bez wyceny) |
| `enableLive` | `false` | publiczne API, kursy rynkowe, etykiety zewnętrzne, adresy pośrednie |
| `rateSource` | zależnie od `enableLive` | własne źródło kursów |
| `rateCacheFile` | `data/cache/rates.json` | plik pamięci podręcznej kursów; `false` = tylko w procesie |
| `requestBudget` | `15` | łączny budżet żądań na adres |
| `externalLabels` | `true` | etykiety z WalletExplorer i TronScan |
| `walletExplorerIntervalMs` | `1000` | odstęp między żądaniami do WalletExplorer |
| `depth` | `'standard'` | `'deep'`: budżet 40, więcej kandydatów, dodatkowe strony przelewów wychodzących |
| `deposit` | `{ enabled: true, windowHours: 48, maxCandidates: 5, minForwardedShare: 0.9 }` | okno i progi śledzenia (wspólne z `trace`) |
| `trace` | `{ maxHops: 4, maxNodeTxCount: 200, swapForwardHours: 72, clusterLimit: 25, utxoHoldHours: 720 }` | śledzenie w głąb i klaster |
| `politeFetch` | włączone dla prawdziwego `fetch` | kolejka i ponawianie po 429 dla TronScan i TronGrid |
| `sanctions` | lokalna kopia OFAC SDN | lista sankcyjna |
| `labels`, `cashOut`, `fetch` | — | zbiór etykiet, progi wypłat, podmiana `fetch` w testach |

## Klasyfikacja adresu

`classify(network, address, hints)` rozstrzyga w kolejności:

1. etykieta ze zbioru (`data/labels.json`),
2. klasa podana przez źródło danych,
3. kod pod adresem ⇒ `smart_contract`,
4. sama nazwa ze źródła: giełda z listy `data/service-keywords.json` lub mikser, w pozostałych przypadkach `unknown` (do ręcznej weryfikacji),
5. historia transakcji bez etykiety ⇒ `private`,
6. brak danych ⇒ `unknown`.

Kontrahenci bez etykiety dostają `unknown`. Przy `enableLive` dla odbiorców największych przelewów sprawdzamy jeszcze dalszą drogę środków (niżej).

### Własne etykiety analityka

Utwórz `data/labels.local.json` w formacie zbioru wbudowanego; wpis analityka zastępuje wbudowany dla tego samego adresu. Plik z błędnym wpisem jest odrzucany z komunikatem wskazującym numer wpisu.

```json
{
  "labels": [
    {
      "network": "bitcoin",
      "address": "bc1q…",
      "label": "Kantor X: adres wpłat",
      "addressClass": "exchange",
      "kind": "exchange_deposit"
    }
  ]
}
```

- `addressClass`: `private`, `unknown`, `exchange`, `smart_contract`, `charity`, `mixer`, `institutional`.
- `kind` (opcjonalne, do wykrywania wypłat): `exchange_deposit`, `p2p_service`, `payment_gateway`, `crypto_card`, `stablecoin_swap`. Bez `kind` rodzaj wynika z klasy (`exchange`) lub słów kluczowych etykiety (np. „P2P”, „bramka”, „karta”).
- `asset` (opcjonalne): symbol tokena emitowanego przez kontrakt. Tylko tokeny z kontraktów wpisanych do zbioru są traktowane jako USDT/USDC; pozostałe dostają dopisek „niezweryfikowany token” i nie są wyceniane.

## Wskaźniki wypłat

`detectCashOuts(transfers, options)` zgłasza przelewy wychodzące:

- na adres giełdy, serwisu P2P, bramki płatniczej lub karty krypto-fiat — bez progu kwoty,
- zamianę znacznej wartości na stablecoiny: wyjście waluty o zmiennym kursie do kontraktu i przyjście USDT/USDC w tej samej transakcji lub w oknie czasu (domyślnie 30 min; stablecoiny: USDT, USDC, DAI), albo przelew na adres z `kind: stablecoin_swap`.

Próg znacznej wartości: `options.significantAmounts` (domyślnie `{ BTC: 0.03, ETH: 1, TRX: 10000 }`); waluty spoza tabeli nie są oceniane. Okno czasu: `options.swapWindowMinutes`.

## Skąd pochodzą etykiety

Kolejność rozstrzygania się nie zmienia: wpis w `data/labels.json` (lub `labels.local.json`) ma pierwszeństwo przed etykietą ze źródła.

| Źródło | Sieć | Co bierzemy | `classificationSource` |
|---|---|---|---|
| Blockscout (`/api/v2/addresses/…`, opis stron w transakcjach) | Ethereum | `metadata.tags` (znacznik typu `name` o najwyższym `ordinal`, znaczniki ogólne np. „Exchange”, `protocol`), `public_tags`, `private_tags`, `name`, `is_contract`, `ens_domain_name` | `Blockscout (…)` |
| WalletExplorer (`/api/1/address-lookup`) | Bitcoin | nazwa portfela, np. `Binance.com`, `Kraken.com`; badany adres i do 10 kontrahentów, 1 żądanie/s | `WalletExplorer (…)` |
| TronScan (`/api/account/tag`) | Tron | `publicTag` (np. `Binance-Hot 2`), dalej `blueTag`/`greyTag`/`redTag`; badany adres i do 10 kontrahentów | `TronScan (…)` |
| OFAC SDN (kopia lokalna) | wszystkie | adresy „Digital Currency Address” | dopisek z nazwą listy |

- **Giełda wg Blockscout**: znacznik ogólny „Exchange” albo nazwa z listy `data/service-keywords.json`. Dla kontraktów sama nazwa nie wystarcza (kontrakt tokena wydanego przez giełdę to nie portfel giełdy) — wymagany jest też znacznik „Exchange”.
- **EIP-7702**: konto z delegacją kodu Blockscout zgłasza jako `is_contract: true` z `proxy_type: "eip7702"`. Traktujemy je jak zwykłe konto, nie kontrakt (tak jest m.in. dla adresu `vitalik.eth`).
- **ENS** jest pokazywany jako etykieta („ENS: nazwa.eth”), ale nie wpływa na klasę adresu — nazwę może zarejestrować każdy.
- **Dane adresu niedostępne**: dla bardzo aktywnych adresów (np. portfele giełd) punkt `/addresses/{adres}` bywa przerywany limitem czasu. Analiza wtedy trwa dalej: znaczniki bierzemy z opisu stron transakcji, saldo liczymy z przelewów, a `limitations` to odnotowuje.
- **`data/service-keywords.json`** to jawna lista słów-kluczy (Binance, Coinbase, Kraken, OKX, Bybit, KuCoin, Bitfinex, Gate, HTX/Huobi, Zonda/BitBay, Kanga, Revolut… oraz kategorie `p2p`, `payment_gateway`, `crypto_card`). Dopasowywane są całe słowa: „Gate” nie pasuje do „gateway” ani „Stargate”. Rozpoznanie po nazwie jest poszlaką.
- **WalletExplorer** przypisuje adres do portfela heurystyką wspólnego wydawania środków, więc nazwa obejmuje też indywidualne adresy wpłat klientów giełdy — ale jest oszacowaniem serwisu, nie potwierdzeniem właściciela. Portfel bez nazwy (samo `wallet_id`) niczego nie wnosi.
- **TronScan**: punkt `accountv2` wymaga klucza (HTTP 401) i nie jest używany; `account/tag` działa bez klucza, ale dla adresów kontraktów zwraca „Contracts are not supported yet”.

### Lista sankcyjna OFAC

`node scripts/update-ofac.ts` pobiera publiczny plik `SDN.XML` (ok. 28 MB, serwowany powoli — kilka minut) z `sanctionslistservice.ofac.treas.gov` (przekierowanie 302 do pliku; stary adres `treasury.gov/ofac/downloads/sdn_advanced.xml` zwraca 404) i zapisuje adresy kryptowalutowe do `data/ofac-addresses.json` z datą pobrania. Sprawdzenie jest lokalne — badany adres nie jest wysyłany.

Adres z listy dostaje etykietę „Lista sankcyjna OFAC (SDN): <podmiot>” (badany adres i kontrahenci) oraz wpis „OSTRZEŻENIE — …” na początku `limitations`. Klasa adresu się nie zmienia. Kopia starzeje się — trafienie i brak trafienia trzeba potwierdzić w aktualnej liście.

## Ścieżki środków do usług wymiany (`trails`)

`ChainActivity.trails` to udokumentowane ścieżki od adresu podmiotu do adresu z etykietą usługi wymiany (giełda, P2P, bramka, karta). Ścieżka jednokrokowa to bezpośredni przelew na oznaczony portfel; każda dłuższa jest **wnioskowaniem** z jawnych reguł, a każdy krok (`FlowHop`) ma `inferred` i `reason`. Kod: `src/trace.ts` (`traceAccountFlows` dla Ethereum/Tron, `traceUtxoFlows` dla Bitcoina, `trailConfidence`).

### Reguły przejścia przez adres pośredni

| Reguła | Kiedy krok jest dopuszczony |
|---|---|
| (a) adres przelotowy | adres otrzymał kwotę i w oknie 48 h (`windowHours`) przekazał ≥ 90% (`minForwardedShare`) jednemu odbiorcy, jednym lub kilkoma przelewami. W Bitcoinie powiązanie jest ścisłe (wydano dokładnie otrzymane wyjście), więc dopuszczamy do 30 dni (`utxoHoldHours`) — dłuższy czas obniża pewność |
| (b) łańcuch reszty (Bitcoin) | transakcja o dwóch wyjściach, której wejścia należą do portfela: resztę wskazuje typ skryptu zgodny z wejściem albo „nieokrągła” kwota (gdy druga jest wielokrotnością 0,0001 BTC); adres dotąd nieużywany wzmacnia przesłankę. Sprzeczne przesłanki = brak wskazania. Płatność sprawdzamy pod kątem usług, resztę śledzimy dalej |
| (c) adres wpłat giełdy | adres bez etykiety, z którego niemal cała kwota trafiła w oknie na oznaczony portfel giełdy (jeden krok) |
| (d) zamiana na stablecoin | przelew do kontraktu i wpływ USDT/USDC/DAI w tej samej transakcji (lub w 30 min), a potem — do 72 h — wyjście 90–102% tej kwoty stablecoina; dalej jak (a)/(c) |

Jedno zamiecenie może obsłużyć kilka wpłat tylko do wysokości swojej kwoty (wcześniejsza wpłata ma pierwszeństwo).

### Gdzie ścieżka się kończy bez wyniku

- adres pośredni o dużej aktywności (ponad 200 transakcji, `maxNodeTxCount`) — to zwykle usługa bez publicznej etykiety, a jej wypłaty nie mają związku z wpłatą podmiotu. Wyjątek: gdy ≥ 95% ostatnich przelewów wychodzących takiego adresu trafia do jednej giełdy, uznajemy wzorzec adresu wpłat intensywnie używanego konta i dopuszczamy krok do tej giełdy;
- kontrakt (wymiana, most, DeFi), adres z etykietą niebędącą usługą wymiany, rozdzielenie środków, brak przekazania w oknie;
- mikser lub transakcja wyglądająca na CoinJoin — z wpisem „OSTRZEŻENIE — mikser” w `limitations`;
- limit kroków (`maxHops`, domyślnie 4) i budżet żądań — z liczbą sprawdzonych kontrahentów.

Każda przyczyna trafia do `limitations` z liczbą przerwanych ścieżek.

### Pewność ścieżki (0–100) — jawny wzór

`trailConfidence` (stałe w `CONFIDENCE_RULES`):

- **95** — bezpośredni przelew na adres z publiczną etykietą usługi; **−5**, gdy etykieta pochodzi z heurystycznego grupowania portfeli (WalletExplorer);
- każde ogniwo pośrednie obniża: adres wpłat **−8**, adres przelotowy **−10**, zamiana na stablecoin **−12**, start z innego adresu klastra **−12**, adres reszty **−22 / −18 / −15** przy 1 / 2 / 3 zgodnych heurystykach;
- gdy środki przeszły przez obcy adres — zgodność kwot (**+4** przy ≥ 98%, **+2** przy ≥ 90%, **0** przy ≥ 50%, **−8** poniżej) i czas od opuszczenia portfela (**+4** do 1 h, **+2** do 24 h, **0** do 72 h, **−5** dłużej);
- ścieżka z jakimkolwiek ogniwem pośrednim dostaje najwyżej **90**; wynik nie spada poniżej 5.

Składniki są wypisane w `reasons`. `openQuestions` mówi, co trzeba potwierdzić poza łańcuchem (np. „Giełda X może potwierdzić właściciela konta, na które wpłynęło 0,40 BTC 2025-03-14 (tx …)”). Wycena jak dla wskaźników: Binance × NBP, na chwilę wpływu do usługi.

### Ścieżki a wskaźniki `cashOuts`

`cashOuts` pozostają podstawą sum PLN. Jednokrokowy „adres wpłat giełdy” tworzy wskaźnik na przelewie z adresu podmiotu (jak dotąd, z „WNIOSKOWANIE” w `explanation`). Dłuższa ścieżka dostaje własny wskaźnik tylko wtedy, gdy żaden jej krok nie ma już wskaźnika (np. wpłata na giełdę z adresu reszty) — nic nie jest liczone dwa razy. Tokeny o niezweryfikowanym kontrakcie nie tworzą ścieżek.

## Klaster adresów portfela (`cluster`)

`ChainActivity.cluster` (`src/cluster.ts`):

- **Bitcoin** — heurystyka wspólnych wejść (adresy wydawane w jednej transakcji z adresem podmiotu), z pominięciem transakcji wyglądających na CoinJoin (≥ 3 adresy wejściowe i ≥ 3 równe wyjścia), oraz adresy reszty z reguły (b). Limit 25 adresów (`clusterLimit`). Wspólne wejścia liczymy z już pobranych transakcji — bez dodatkowych żądań. Dla adresów klastra pobieramy historię (w budżecie) i liczymy ścieżki także z nich; taka ścieżka ma dopisek o heurystyce i niższą pewność. Adres klastra o bardzo dużej aktywności dostaje dopisek, że przynależność jest wątpliwa.
- **Ethereum, Tron** — model kont: klastra nie budujemy, `method` to wyjaśnia.

`method` zawsze nazywa heurystyki i ich słabe strony. Klaster jest przypuszczeniem analitycznym.

## Tron / USDT

- Transfery TRC-20 pochodzą z TronScan (`/api/token_trc20/transfers?relatedAddress=`), który w tej samej odpowiedzi podaje publiczne znaczniki stron (`to_address_tag`, `from_address_tag`) i to, czy kontrahent jest kontraktem — etykiety giełd dla kontrahentów nie kosztują dodatkowych żądań. Przy błędzie TronScan dostawca wraca do TronGrid (`/v1/accounts/{a}/transactions/trc20`, bez znaczników) i odnotowuje to.
- Zapytania o adres pośredni są zawężone do okna czasu (`start_timestamp`/`end_timestamp`, w TronGrid `min_timestamp`/`max_timestamp`), więc da się prześledzić także dawne wpłaty.
- Pole `total` z TronScan jest obcinane do 10000 i nie mówi o aktywności adresu; liczbę transakcji bierzemy z `/api/account` tylko wtedy, gdy strona historii jest pełna.
- Oba serwisy bez klucza odrzucają serie żądań (HTTP 429), a TronGrid blokuje potem nadawcę na kilkanaście sekund. `createPoliteFetch` ustawia żądania w kolejce (TronScan co 450 ms, TronGrid co 350 ms) i ponawia raz po 429. Analiza adresu Tron w trybie głębokim trwa przez to 10–40 s.
- `data/labels.json` zawiera 17 portfeli giełd na Tronie (Binance, OKX, Bybit, KuCoin, Bitfinex, Gate, MEXC) — wyłącznie takie, których znacznik TronScan potwierdzono na żywo 2026-11-21 (znacznik jest w treści etykiety).

## Powiązane adresy (`linkedAddresses`)

Kandydaci na **inne adresy tej samej osoby** — `src/links.ts`, pole dodatkowe wyniku `activity.linkedAddresses` (typ `LinkedAddress`, poza kontraktem core). Każde powiązanie ma `kind`, `strength` 0–100 z jawnych stałych (`LINK_STRENGTH`), `reason` z nazwaną heurystyką i zastrzeżeniami, `txids`, daty, kwotę. To heurystyki, nie ustalenie tożsamości.

| `kind` | Reguła | Siła |
|---|---|---|
| `co_depositor` | inny nadawca wpłat na TEN SAM indywidualny adres wpłat giełdy (adres ustalony regułą zamiecenia; w Bitcoinie także adres zaliczony przez WalletExplorer do portfela giełdy). Adres wpłat należy do jednego konta klienta, więc wpłacający to najpewniej ta sama osoba albo ktoś wpłacający na jej konto (kupujący, kontrahent, rodzina) | 80; 70 gdy adres wpłat znany tylko z etykiety; 65 gdy ma ponad 5 innych nadawców |
| `same_wallet` | adres z klastra portfela: wspólne wejścia albo reszta | 75 wspólne wejścia; 55 / 65 reszta przy 1 / 2+ przesłankach; 25 gdy adres ma bardzo dużą aktywność |
| `funded_by` | adres prywatny, z którego przyszła PIERWSZA wpłata na adres podmiotu (tylko przy pełnej historii) | 45; 50 przy kilku przelewach; 60 przy przelewach w obie strony |
| `funds` | adres prywatny, dla którego przelew z adresu podmiotu był pierwszą wpłatą | jak wyżej |
| `repeated_counterparty` | prywatny kontrahent: co najmniej 3 przelewy, w obie strony, w ciągu co najmniej 30 dni — drugi portfel, osoba bliska albo wspólnik | 30 + 4 za każdy kolejny przelew, najwyżej 50 |

- **Wyjątek pośrednika**: adres wpłat z ponad 10 różnymi nadawcami albo ponad 2000 transakcji to kantor, bramka, serwis przyjmujący wpłaty wielu osób albo portfel zbiorczy — powiązań nie tworzymy, powstaje wpis w `limitations`.
- Usługi, kontrakty i adresy o dużej aktywności (ponad 200 transakcji) nie są traktowane jak adresy prywatne.
- **Adresy-podróbki** („address poisoning”: ten sam początek i koniec adresu, mniejszy obrót), przelewy zerowe i tokeny o niezweryfikowanym kontrakcie nie tworzą powiązań; liczba pominiętych jest w `limitations`.
- **Nie tworzymy powiązania „to samo źródło finansowania”** (dwa adresy zasilone z tego samego adresu wypłat giełdy w krótkim odstępie): giełda wypłaca z kilku gorących portfeli tysiącom klientów na godzinę, więc wspólny adres wypłat występuje między zupełnie obcymi osobami i nie ma wartości dowodowej.
- Osobny budżet żądań: 12, w trybie głębokim 40 (`linkBudget` w konfiguracji albo w kontekście wywołania); `findLinks: false` wyłącza moduł.

## Sieci EVM (`networks`) i stan posiadania (`balances`)

Ten sam adres EVM działa na wielu sieciach, a wypłata na giełdę przez tańszą sieć jest niewidoczna, gdy analizujemy tylko Ethereum mainnet.

- **Rejestr** `data/evm-networks.json` (`src/networks.ts`): 11 sieci z publicznym API Blockscout v2 potwierdzonych na żywo 2026-11-21 — Ethereum, OP Mainnet, ZKsync Era, Scroll, Celo, Unichain, Soneium, Mode, Ink, Lisk, World Chain. Stablecoiny (USDT/USDC) są wpisane tylko dla sieci, gdzie kontrakt potwierdzono w API (Ethereum, Optimism, ZKsync, Scroll, Celo). Sekcja `unavailable` opisuje sieci sprawdzone i niedostępne: Base, Arbitrum, Polygon (HTTP 403 dla naszego nagłówka `User-Agent`; odpowiadają dopiero na postać „Mozilla/5.0 (compatible; …)” — nagłówka nie zmieniamy, żeby obejść blokadę), Gnosis (przekierowanie na serwis z blokadą), **BNB Smart Chain (brak publicznego eksploratora z API bez klucza)**, Linea, Zora, Mantle, Avalanche.
- **Dlaczego nie zmieniamy nagłówka dla Base, Arbitrum i Polygon** (warunki sprawdzone 2026-11-21):
  - `robots.txt` każdego z trzech eksploratorów (`https://base.blockscout.com/robots.txt` i odpowiedniki) zawiera `Allow: /` i nie zabrania ścieżek `/api/`;
  - dokumentacja limitów (`https://docs.blockscout.com/devs/apis/requests-and-limits`) opisuje dostęp bez klucza: „No API key (by IP) 300 req/min (default)”, ale ta sama strona zapowiada: „per-instance API access will be deprecated soon”;
  - strona API (`https://docs.blockscout.com/devs/apis`) mówi wprost: „per-instance API support has been deprecated. Please go to https://dev.blockscout.com/ to get an API key”;
  - regulamin (`https://eaas.blockscout.com/terms-and-conditions`, wersja 1.1) nie mówi nic o automatycznym odczycie, ale zakazuje „circumventing or attempting to circumvent any access or functionality restrictions”.
  Blokada 403 dla nieznanych nagłówków wygląda więc na egzekwowanie wycofania dostępu bez klucza, a zmiana nagłówka po to, żeby ją przejść, byłaby obejściem ograniczenia. Warunki są co najmniej niejednoznaczne — zostawiamy te sieci jako niedostępne. Dopuszczona przez operatora droga to API z kluczem (plan darmowy: „Free 100K credits/day · 5 RPS · All chains”), które wymaga rejestracji i decyzji zespołu. Uwaga: to samo ogłoszenie o wycofaniu dotyczy instancji, z których korzystamy dziś bez klucza (Ethereum i pozostałe sieci z rejestru) — mogą przestać odpowiadać.
- **`discoverNetworks(address, context, options?)`** → `{ networks: NetworkPresence[], limitations }`: jedno żądanie o liczniki na sieć, współbieżnie, w budżecie ~8 s; dla sieci z aktywnością drugie żądanie o saldo. `NetworkPresence = { networkId, name, txCount, tokenTransfers, balance?, nativeAsset, firstSeen?, lastSeen?, explorerUrl }` (`firstSeen`/`lastSeen` tylko dla sieci, które przeszły pełną analizę). Wynik trafia do pola `activity.networks`.
- **Inne sieci w wyniku**: typ `Network` w core ma dla EVM jedną wartość, więc przelewy, wskaźniki i ścieżki z innych sieci mają `network: 'ethereum'` i pole dodatkowe **`chain: '<id z rejestru>'`** (brak pola = Ethereum mainnet), a `explorerUrl` wskazuje eksplorator właściwej sieci. Wpisy `limitations` z innej sieci zaczynają się od `[Nazwa sieci]`. Profil (`profile`) opisuje Ethereum mainnet.
- **Tryb głęboki**: do 3 innych sieci o największej aktywności (`maxExtraNetworks`) przechodzi tę samą analizę wypływów, etykiet, ścieżek i powiązań; ich wskaźniki wchodzą do `cashOuts`, `trails` i sum PLN. W trybie standardowym jest samo wykrycie sieci i wpis, których sieci nie przeanalizowano.
- **Etykiety w innych sieciach**: zbiór etykiet z Ethereum nie jest przenoszony (kontrakt pod tym samym adresem może być czymś innym); giełdy rozpoznajemy po znacznikach eksploratora danej sieci i usługi metadanych Blockscout (parametr `chainId`), tokeny — po kontraktach z rejestru.
- **Wycena walut natywnych**: ETH na sieciach warstwy 2 jak ETH; POL, BNB i CELO przez Binance (pary potwierdzone); xDAI nie ma pary, więc nie jest wyceniany.
- **Stan posiadania** (`src/balances.ts`, pole `activity.balances`): `BalanceEntry = { asset, amount, network, chain?, kind: 'current' | 'year_end', asOf, valuePln?, valuation?, basis }`. Saldo bieżące (waluta natywna i zweryfikowane stablecoiny) podaje źródło; **saldo na 31 grudnia** każdego roku z aktywnością jest wynikiem obliczeń — saldo bieżące pomniejszone o przelewy późniejsze (rok wg czasu polskiego). Liczymy je tylko wtedy, gdy historia aktywa jest pełna I jej suma zgadza się z saldem bieżącym (±0,5%); inaczej jest pomijane z wpisem w `limitations`. W praktyce: Bitcoin przy pełnej historii zawsze (zmiany salda liczymy z opłatami), stablecoiny przy pełnej historii zwykle, waluta natywna EVM i TRX zwykle nie (opłat i transakcji wewnętrznych nie ma w przelewach).

## Litecoin i Solana

- **Litecoin** (`network: 'litecoin'`): `EsploraProvider` z `network: 'litecoin'` i `siteUrl: 'https://litecoinspace.org'` (fork mempool.space z zapleczem Esplora, prowadzony przez Fundację Litecoin; API sprawdzone na żywo 2026-11-22: `/api/address/<adres>`, `/txs`, `/txs/chain/<txid>`). Te same reguły co dla Bitcoina: przelew jako zmiana salda adresu, wykrywanie reszty, klaster portfela, powiązane adresy, saldo na koniec roku; bez WalletExplorera (tylko Bitcoin) i bez śledzenia dalszej drogi środków (zbiór etykiet nie zna adresów giełd w sieci Litecoin — dodatkowe zapytania nie mogłyby niczego rozpoznać). Wycena: para `LTCUSDT` (Binance) × NBP. Tempo dla hosta: najwyżej 2 żądania naraz, co 400 ms (serwis nie publikuje limitów). Adresy: `L…` (0x30), `M…` (0x32), `ltc1…` (bech32/bech32m); stary zapis P2SH `3…` jest nie do odróżnienia od Bitcoina i zostaje przy Bitcoinie. `createChainProviders({ litecoin: false })` wyłącza dostawcę.
- **Solana** (`network: 'solana'`): `SolanaRpcProvider` działa wyłącznie z węzłem wskazanym w `solanaRpcUrl` (`SOLANA_RPC_URL`): `getBalance`, `getSignaturesForAddress` (strona 1000 podpisów — liczba transakcji, w trybie `full` kolejne strony), `getTransaction` (`jsonParsed`) dla najwyżej 20 najnowszych udanych transakcji (tryb głęboki 60). Przelew = zmiana salda adresu w transakcji: SOL (opłata sieciowa odliczona), USDC i USDT (kontrakty w `SOLANA_STABLECOINS`); inne tokeny SPL tylko liczone w `limitations`. Publicznego węzła `api.mainnet-beta.solana.com` nie używamy — dokumentacja: „not intended for production applications”, regulaminu nie udało się przeczytać (docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. „Sieci blockchain: Litecoin, Solana”). Bez węzła wynik ma jeden wpis w `limitations` (`SOLANA_NO_PROVIDER`) i zero zapytań.
- **Rozpoznawanie adresu Solana** (`@olcys/core`): 32–44 znaki Base58 dekodujące się dokładnie do 32 bajtów (`isSolanaAddress`). Format nie ma sumy kontrolnej (`checksumVerified: false`), więc `extractAddresses` przyjmuje taki ciąg **tylko** obok słowa SOL / Solana / Phantom / Solflare / Backpack / SPL (w promieniu 60 znaków); normalizacja tekstu w `packages/sources` nie skleja rozbitych ciągów w adres Solana, a adres z odnośnika `solana:` / eksploratora Solany dostaje w tekście słowo „Solana”.
- **Base i Polygon** — ponownie sprawdzone 2026-11-22: bez zmian (403 bez klucza, 402 z kluczem planu darmowego), dalej w sekcji `unavailable` rejestru.

## Organy państwa, znane incydenty i pochodzenie środków

- **Etykiety** (`data/labels.json`): wpis może mieć `category` — `law_enforcement` (adres organu państwa lub zajętych środków; klasa z core `institutional`, bo zestaw klas jest zamknięty) albo `incident` (adres wymieniony w publicznym źródle jako związany z włamaniem lub oszustwem) — oraz wymagane wtedy pola `source` (adres źródła wymieniającego DOKŁADNY adres) i `checkedAt`. Wpis z kategorią bez źródła jest odrzucany przy wczytaniu. W zbiorze jest 5 adresów `law_enforcement` (m.in. portfel rządu USA ze środkami z Bitfinex i z Silk Road) i 49 adresów `incident` (44 z oświadczenia prokuratury w sprawie US v. Zhong, 22 Cr. 606, SDNY; pozostałe z artykułów redakcyjnych i analizy Merkle Science). Nic nie zostało wpisane z pamięci.
- **Zajęcie** (`activity.seizures`, typ `SeizureIndicator`): przelew na adres `law_enforcement` to przekazanie środków organowi państwa, a NIE spieniężenie. Nie trafia do `cashOuts`, `trails` ani sum PLN; ma kwotę, datę, wycenę (Binance × NBP) i `labelSource`. `limitations` mówi, że to ustalenie z etykiety publicznej, nie z dokumentu dotyczącego tej transakcji.
- **Pochodzenie środków** (`activity.fundingSources`, `src/funding.ts`, typ `FundingSource`): dla adresu o historii do 200 transakcji grupujemy wpływy według nadawcy i badamy pięciu największych. Jeśli nadawca ma etykietę (giełda, usługa, lista sankcyjna OFAC, incydent, organ państwa) — koniec, `hops: 1`. Jeśli nie — jeden krok wstecz: największy nadawca środków na ten adres przed przelewem do podmiotu (`hops: 2`, pole `via`), co jest HEURYSTYKĄ i nie dowodzi, że to te same środki. Nadawca o dużej aktywności kończy ścieżkę. Osobny budżet żądań: 8, w trybie głębokim 16 (`fundingBudget`).
- **Zbiory adresów incydentów**: nie podłączyliśmy żadnego gotowego zbioru. Kandydaci do sprawdzenia licencji przed użyciem: BitcoinHeist (UCI, adresy okupów ransomware, licencja CC BY 4.0 wg strony zbioru), `forta-network/labelled-datasets` i CryptoScamDB (licencji nie potwierdzono).

## Klucz API Blockscout

`createChainProviders({ …, blockscoutApiKey })` — klucz podaje się z otoczenia (`process.env.BLOCKSCOUT_API_KEY`); wartość nie trafia do adresów żądań, komunikatów błędów, `limitations` ani dzienników.

- Klucz idzie w nagłówku `authorization: Bearer …` (dokumentacja: „Pass an API key using either: apikey query parameter, authorization header” — `https://docs.blockscout.com/devs/blockscout-api-responses-and-routes`), wyłącznie do hosta `api.blockscout.com`.
- Z kluczem sieci obsługiwane przez wspólne API idą przez `https://api.blockscout.com/<chainId>/api/v2/…`, a rejestr obejmuje sekcję `keyed` — sieci dostępne tylko z kluczem. Bez klucza zachowanie jest takie jak wcześniej.
- **Co działa na planie darmowym (sprawdzone 2026-11-21):** Ethereum, Arbitrum One, OP Mainnet, Gnosis, Scroll, Celo, Unichain, Soneium, Mode, Ink, Lisk, World Chain. **Wymagają płatnego planu (HTTP 402):** Base, Polygon, ZKsync Era (ZKsync zostaje przy publicznej instancji). **Nieobsługiwane (HTTP 404):** BNB Smart Chain, Linea, Avalanche, Mantle, Zora, Blast, Fantom, opBNB.
- **Limity:** plan darmowy to 5 żądań/s i 100 000 kredytów dziennie; każde wywołanie kosztuje 20 kredytów (odmowy 402/404 nie są liczone). Pomiar: brama zrywa połączenia przy kilkunastu równoczesnych żądaniach, więc ogranicznik tempa puszcza najwyżej 2 naraz, co 220 ms; limit czasu żądania liczony jest od jego startu, nie od wejścia do kolejki.
- **Odporność:** limit czasu żądania do eksploratorów EVM to 25 s (`evmTimeoutMs`). Z kluczem Ethereum ma dwie drogi w jednym dostawcy (`FailoverProvider`): gdy pierwsza przekroczy czas, zwróci błąd albo niepoprawny JSON, przez 10 minut pytamy od razu drugą, a potem próbujemy pierwszej ponownie; „nieznany adres” (404) nie przełącza drogi. Pierwszy wpis `limitations` zaczyna się od „Droga danych: …” i mówi, którą drogą przyszły dane i dlaczego.
- **Zakres klucza** (`blockscoutKeyScope`): domyślnie `required` — klucz obsługuje sieci niedostępne bez niego (Arbitrum, Gnosis), pozostałe idą przez publiczne instancje, a dla Ethereum wspólne API jest zapasem na wypadek awarii publicznej instancji. `all` kieruje przez wspólne API każdą obsługiwaną sieć (publiczna instancja Ethereum zostaje zapasem). Domyślny jest `required`, bo w pomiarach z 2026-11-21 wspólne API odpowiadało w 0,1–6 s i w trybie `all` analiza bywała przerywana limitem czasu 10 s; publiczne instancje operator zapowiedział jednak do wycofania, więc `all` może stać się konieczne.

## Zakres historii adresu (`history`)

Domyślnie analizowane jest ~50 najnowszych transakcji. Dla adresu będącego przedmiotem sprawy to za mało: stare, duże wypływy bywają przykryte tysiącem późniejszych drobnych wpłat. Zakres ustawia się **osobno dla każdego adresu w kontekście wywołania** (albo domyślnie w `createChainProviders`):

```ts
import { getActivityFromProviders } from '@olcys/chain';
import type { ChainRequestContext } from '@olcys/chain';

const context: ChainRequestContext = {
  signal, log,
  history: 'full',            // 'recent' (domyślnie) | 'full'
  since: '2020-07-01',        // opcjonalnie, ISO 8601
  until: '2020-12-31',        // opcjonalnie, ISO 8601
  maxHistoryRequests: 60,     // opcjonalnie; domyślnie 24, w trybie głębokim 60
  requestBudget: 160,         // opcjonalnie; budżet etykiet i śledzenia dla TEGO adresu
};
const activity = await getActivityFromProviders(providers, network, address, context);
```

- `full` stronicuje historię do końca, do limitu żądań (osobnego od budżetu śledzenia) albo do wyjścia poza `since`: Bitcoin — strony po 25 (`/txs/chain/{last_txid}`), przy błędzie strony kontynuacja z zapasowego eksploratora (mempool.space ↔ blockstream.info); Ethereum — obie listy Blockscout po 50; Tron — TRC-20 z TronScan po 50 i przelewy TRX z TronGrid; górny limit 2000 pozycji na listę.
- `since`/`until` zawężają analizę (przelewy, wskaźniki, ścieżki) do okresu; sumy profilu Bitcoin pochodzą z pól zbiorczych API (`chain_stats`), więc dotyczą całej historii.
- `firstSeen` jest podawane tylko wtedy, gdy pobrano całą historię bez zawężenia okresu.
- Do śledzenia wybierane są **największe wartościowo wypływy** w analizowanym zakresie (5, w trybie głębokim 10), a `limitations` podaje, ile było wypływów, ile wybrano i jaką część wartości obejmują.
- W Bitcoinie każde istotne wyjście transakcji wypływu (≥ 5% wartości, do 4 gałęzi — `maxBranches`, `minBranchShare`) jest śledzone osobno. Gałąź kończąca się na adresie o dużej aktywności zostawia pytanie „N% wartości wypływu … trafiło na adres X o M transakcjach — prawdopodobnie usługa bez publicznej etykiety”: w `openQuestions` ścieżek z tej samej transakcji, w dodatkowym polu wyniku `activity.openQuestions` (poza kontraktem core, typ `ChainActivityWithQuestions`) i w `limitations` z przedrostkiem „Do wyjaśnienia:”.
- Drobna płatność do usługi z adresu pośredniego tworzy ścieżkę na tę kwotę (z dopiskiem, że to tylko część środków), a śledzenie idzie dalej za resztą.

## Tryb głęboki

`createChainProviders({ enableLive: true, depth: 'deep' })`: budżet 40 żądań na adres zamiast 15, do 12 badanych kontrahentów zamiast 5, a dla Ethereum i Tron dodatkowe zapytania o najnowsze przelewy **wychodzące** (przy aktywnych adresach wpłaty i spam wypychają wypłaty z pierwszej strony). Liczba kroków ścieżki (4) jest ta sama. `requestBudget` i `trace` pozwalają ustawić wartości ręcznie.

Hurtowe znaczniki Ethereum: usługa metadanych Blockscout (`metadata.services.blockscout.com/api/v1/metadata?addresses=…&chainId=1`) zwraca bez klucza znaczniki wielu adresów jednym żądaniem (do 40) i zna etykiety, których nie ma w opisie stron transakcji (np. „Kraken: Hot Wallet”). Używamy jej dla kontrahentów badanego adresu i dla odbiorców na adresach pośrednich.

Sprawdzone i nieużywane: Blockchair (`api.blockchair.com`, bez klucza odpowiada 430 „IP temporarily blacklisted” już przy pierwszych zapytaniach), `mempool.space/api/v1/…` (brak danych do atrybucji adresów — tylko pule wydobywcze), TronScan `accountv2` i filtr `fromAddress` (401).

## Próba śledzenia na prawdziwych danych

```
node scripts/trace-check.ts [--depth=deep|standard] [--verbose] sieć:adres[:oczekiwana_usługa] …
```

Adresy podaje się w wierszu poleceń; skrypt ich nie zapisuje i pokazuje skróty. Trzeci człon to fragment nazwy usługi, do której — jak wiadomo z samego łańcucha — trafiły środki; na tej podstawie skrypt liczy trafność. Wypisuje ścieżki, pewność, kroki, klaster, czas, liczbę żądań i przyczyny przerwania.

## Wycena w PLN — zawsze szacunek

Przy `enableLive` domyślnym źródłem jest **`MarketRateSource`**:

```
wartość = kwota × cena zamknięcia dnia w USDT (Binance) × kurs średni USD/PLN (NBP, tabela A)
```

- **Cena**: dzienna świeca Binance (`/api/v3/klines`, pary BTCUSDT, ETHUSDT, TRXUSDT) dla dnia transakcji w UTC. USDT, USDC i DAI są liczone jako 1 USD; WETH jak ETH. Inne waluty nie są wyceniane.
- **Reguła daty NBP**: kurs średni z **ostatniego dnia roboczego poprzedzającego dzień transakcji** (dzień wg czasu polskiego) — tak jak przy przeliczaniu przychodów w walutach obcych. Jedno zapytanie o zakres od 7 dni wstecz do dnia poprzedniego; brana jest najnowsza tabela. Transakcja z soboty, niedzieli i poniedziałku dostaje kurs piątkowy; z piątku — czwartkowy.
- **Opis** w `valuation` każdego wskaźnika, np.: „Szacunek: 0,3 BTC × 84 338,44 USD (Binance BTCUSDT, cena zamknięcia dnia 2025-03-15 UTC) × 3,8509 PLN/USD (NBP, kurs średni, tabela A nr 051/A/NBP/2025 z 2025-03-14 — ostatni dzień roboczy poprzedzający dzień transakcji) = 97 433,67 PLN. Data transakcji: 2025-03-15.”
- **Pamięć podręczna**: w procesie i w pliku `data/cache/rates.json` (poza repozytorium), więc powtórna analiza nie odpytuje API. Najwyżej 3 żądania równolegle; po przekroczeniu limitu czasu jedna ponowna próba. Ceny z niezakończonego dnia nie są zapisywane.
- **NBP bywa zawodny**: API sporadycznie odpowiada HTTP 500 na poprawne zapytanie. Zapytanie o zakres jest ponawiane do 3 razy z rosnącą przerwą, a potem zastępowane cofaniem dzień po dniu (pojedyncze zapytania, 404 = brak tabeli tego dnia).
- **Błąd sieci** → zapas na `StaticRateSource`, z dopiskiem w `valuation`: „UWAGA: KURS PRZYKŁADOWY (dane demonstracyjne — nie jest to kurs rynkowy ani urzędowy). Nie udało się pobrać kursu rynkowego (powód)…” oraz wpisem w `limitations`, ile wskaźników to dotyczy.

`StaticRateSource` (`data/rates-pln.json`) to przybliżone średnie miesięczne — **dane przykładowe do demonstracji, nie kursy rynkowe ani urzędowe**. Bez `enableLive` (tryb bez sieci, sandbox) jest jedynym źródłem i każda wycena niesie ten sam dopisek „UWAGA: KURS PRZYKŁADOWY”.

`valueCashOuts` uzupełnia `valuePln` i `valuation`, `valueAmount` wycenia pojedynczą kwotę, `summarizeByTaxYear` sumuje według roku kalendarzowego w czasie polskim. Kwoty nie są ustaleniem przychodu.

Uproszczenia wyceny: cena zamknięcia dnia, nie cena z chwili transakcji (różnica w ciągu dnia bywa kilkuprocentowa); notowanie jednej giełdy w USDT traktowane jak USD; stablecoiny przyjęte jako dokładnie 1 USD; faktyczny przychód zależy od kursu sprzedaży na giełdzie i prowizji, których z blockchaina nie widać.

## Znane uproszczenia

- Bitcoin: transakcja jest sprowadzana do jednego przelewu; kontrahentem wypłaty jest odbiorca największej kwoty, wpłaty — pierwszy adres nadawcy. Transakcje niepotwierdzone są pomijane.
- Bitcoin: etykiety WalletExplorer sprawdzamy dla ograniczonej liczby kontrahentów (budżet żądań); w sieci testowej wcale.
- Ethereum: bez transakcji wewnętrznych; liczba transakcji i sumy ETH pochodzą z pobranych przelewów.
- Tron: TronGrid nie podaje, czy kontrahent jest kontraktem; znaczniki TronScan nie obejmują kontraktów.
- Indywidualne adresy wpłat na giełdach są rozpoznawane tylko przez etykietę portfela (WalletExplorer) albo wnioskowanie z dalszej drogi środków — obie metody mogą zarówno pominąć wypłatę, jak i wskazać ją błędnie.
- Śledzenie widzi tylko to, co mieści się na jednej stronie historii adresu pośredniego (50 przelewów; w Bitcoinie 25 transakcji) — poza Tronem, gdzie zapytanie jest zawężone do okna czasu.
- Ścieżka kończy się na usługach bez publicznej etykiety (kantory, mniejsze giełdy, pośrednicy OTC): brak ścieżki nie oznacza braku spieniężenia.
- Ethereum: zamiana jest rozpoznawana tylko wtedy, gdy stablecoin wpływa jako transfer ERC-20; ETH otrzymane z wymiany (transakcja wewnętrzna) nie jest widoczne.
- Bitcoin: resztę wskazujemy tylko w transakcjach o dwóch wyjściach; przy trzech i więcej sprawdzane są dwa największe wyjścia.
- Etykieta `bc1qm34l…7s3h` (gorący portfel Binance) w `data/labels.json` pochodzi z wiedzy powszechnej — żadne źródło odpytywane na żywo jej nie potwierdza i mówi o tym treść etykiety.
- Lista OFAC jest kopią z dnia pobrania.

## Próba na żywo

```
node scripts/live-check.ts [sieć:adres …]
```

Wycenia przykładowe kwoty BTC i ETH (2024, 2025) i analizuje jeden adres Ethereum oraz jeden Bitcoin przez publiczne API; wypisuje klasę, etykietę, przelewy, wypłaty, ograniczenia i liczbę żądań. To nie jest test — wymaga internetu.

## Testy

```
node --test test/*.test.ts
```

Testy nie łączą się z internetem — dostawcy i źródła kursów dostają atrapę `fetch` z zapisanymi przykładowymi odpowiedziami.
