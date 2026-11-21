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
| `SandboxChainProvider` | podano `sandboxUrl` | wszystkie | 1 + po jednym na nieopisanego kontrahenta (maks. 25) |
| `EsploraProvider` (blockstream.info, zapasowo mempool.space) | `enableLive` | Bitcoin, testnet | 2–3 + etykiety WalletExplorer + adresy pośrednie |
| `BlockscoutProvider` (eth.blockscout.com) | `enableLive` | Ethereum | 3 + do 5 na adresy pośrednie |
| `TronGridProvider` (api.trongrid.io) | `enableLive` | Tron | 3 + znaczniki TronScan + adresy pośrednie |

Do publicznego API trafia wyłącznie badany adres lub adres kontrahenta (do Binance — para i data, do NBP — zakres dat). Nagłówek `User-Agent: OLCyS-research/0.1`, limit czasu żądania 10 s. Pobieranych jest 50 najnowszych transakcji; przekroczenie limitu jest opisane w `limitations`.

**Budżet żądań:** analiza jednego adresu wykonuje łącznie najwyżej 15 żądań do eksploratorów i serwisów etykiet (`requestBudget`). Po wyczerpaniu budżetu dodatkowe kroki są przerywane, a `limitations` mówi, ilu kontrahentów nie sprawdzono. Błędy 429/5xx serwisów pomocniczych też trafiają do `limitations` i nie przerywają analizy. Kursy (Binance, NBP) nie wliczają się do budżetu — są pobierane raz i zapamiętywane.

Sandbox opisuje etykietą tylko pytany adres, dlatego dostawca dopytuje eksplorator o kontrahentów. Eksplorator może też opisać kontrahenta od razu w przelewie, polami opcjonalnymi `counterpartyLabel`, `counterpartyClass`, `counterpartyKind`, oraz podać `kind` dla pytanego adresu.

### Konfiguracja `createChainProviders`

| Pole | Domyślnie | Znaczenie |
|---|---|---|
| `sandboxUrl` | — | włącza dostawcę danych syntetycznych |
| `enableLive` | `false` | publiczne API, kursy rynkowe, etykiety zewnętrzne, adresy pośrednie |
| `rateSource` | zależnie od `enableLive` | własne źródło kursów |
| `rateCacheFile` | `data/cache/rates.json` | plik pamięci podręcznej kursów; `false` = tylko w procesie |
| `requestBudget` | `15` | łączny budżet żądań na adres |
| `externalLabels` | `true` | etykiety z WalletExplorer i TronScan |
| `walletExplorerIntervalMs` | `1000` | odstęp między żądaniami do WalletExplorer |
| `deposit` | `{ enabled: true, windowHours: 48, maxCandidates: 5, minForwardedShare: 0.9 }` | wnioskowanie o adresach wpłat |
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

## Prawdopodobny adres wpłat na giełdę (wnioskowanie)

Giełdy dają klientom indywidualne adresy wpłat bez publicznej etykiety i szybko zamiatają z nich środki na portfel zbiorczy. Przy `enableLive`, dla odbiorców największych przelewów wychodzących bez etykiety (maks. 5 na adres), pobieramy przelewy wychodzące kontrahenta (jedno żądanie). Jeśli w oknie 48 h od wpłaty co najmniej 90% kwoty trafiło na adres oznaczony jako giełda, powstaje wskaźnik `exchange_deposit`:

- `explanation` zaczyna się od „WNIOSKOWANIE (nie ustalony fakt)” i podaje giełdę, adres portfela, czas przekazania, udział kwoty, źródło etykiety giełdy i transakcję przekazania,
- kontrahent zachowuje klasę `unknown`, a jego etykieta brzmi „Prawdopodobny adres wpłat giełdy „X” (wnioskowanie)”,
- `limitations` zawiera opis kryteriów i zastrzeżenie.

Ograniczenia: adres pośredni może należeć do kogoś innego (pośrednik, kantor, znajomy); udział liczony jest z sumy przekazań w oknie, więc przy adresie zbierającym kilka wpłat może przekroczyć 100%; badane jest 50 najnowszych przelewów kontrahenta (25 transakcji w Bitcoinie), więc starszych przekazań nie widać; w Bitcoinie etykietę odbiorcy sprawdzamy w WalletExplorer tylko dla dwóch największych wyjść. Kolejność „największych przelewów” między walutami ustalają zgrubne wagi, nie kursy.

## Wycena w PLN — zawsze szacunek

Przy `enableLive` domyślnym źródłem jest **`MarketRateSource`**:

```
wartość = kwota × cena zamknięcia dnia w USDT (Binance) × kurs średni USD/PLN (NBP, tabela A)
```

- **Cena**: dzienna świeca Binance (`/api/v3/klines`, pary BTCUSDT, ETHUSDT, TRXUSDT) dla dnia transakcji w UTC. USDT, USDC i DAI są liczone jako 1 USD; WETH jak ETH. Inne waluty nie są wyceniane.
- **Reguła daty NBP**: kurs średni z **ostatniego dnia roboczego poprzedzającego dzień transakcji** (dzień wg czasu polskiego) — tak jak przy przeliczaniu przychodów w walutach obcych. Jedno zapytanie o zakres od 7 dni wstecz do dnia poprzedniego; brana jest najnowsza tabela. Transakcja z soboty, niedzieli i poniedziałku dostaje kurs piątkowy; z piątku — czwartkowy.
- **Opis** w `valuation` każdego wskaźnika, np.: „Szacunek: 0,3 BTC × 84 338,44 USD (Binance BTCUSDT, cena zamknięcia dnia 2025-03-15 UTC) × 3,8509 PLN/USD (NBP, kurs średni, tabela A nr 051/A/NBP/2025 z 2025-03-14 — ostatni dzień roboczy poprzedzający dzień transakcji) = 97 433,67 PLN. Data transakcji: 2025-03-15.”
- **Pamięć podręczna**: w procesie i w pliku `data/cache/rates.json` (poza repozytorium), więc powtórna analiza nie odpytuje API. Najwyżej 3 żądania równolegle; po przekroczeniu limitu czasu jedna ponowna próba. Ceny z niezakończonego dnia nie są zapisywane.
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
