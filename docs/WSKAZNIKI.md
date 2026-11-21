# Wskaźniki pewności — algorytm

Narzędzie liczy **trzy osobne wskaźniki**, bo odpowiadają na trzy różne pytania. Zlanie ich w jedną
liczbę ukrywałoby, czego właściwie dotyczy pewność.

| | Wskaźnik | Pytanie | Gdzie w kodzie |
|---|---|---|---|
| A | **Konto → portfel** | Na ile konkretne konto publicznie deklaruje związek z adresem? | `packages/core/src/score.ts` (`computeConfidence`), `apps/api/src/operator.ts` |
| B | **Wspólny operator** | Na ile dwa konkretne konta może obsługiwać ten sam operator? | `apps/api/src/persons.ts`, `apps/api/src/operator.ts`, `packages/core/src/indicators.ts` |
| C | **Wyjście do walut tradycyjnych** | Na ile dane wskazują wymianę kryptowalut na fiat? | `packages/chain`, `apps/api/src/cashout-stage.ts` |

## Jak czytać liczby

Każdy wskaźnik to **liczba porządkowa 0–100 z jawnych reguł eksperckich**. Nie jest skalibrowanym
statystycznie prawdopodobieństwem: wynik 80 nie znaczy „w 80 przypadkach na 100 to prawda”, tylko
„powiązanie jest udokumentowane mocniej niż takie z wynikiem 60”. Kalibracja wymagałaby zbioru spraw
z ustalonym stanem faktycznym, którego w konkursie nie ma. Dlatego:

- wynik niesie pola `scale: 'ordinal_uncalibrated'` / `calibrated: false` i opis `interpretation`,
- nazwy progów Wskaźnika A („bardzo wysokie prawdopodobieństwo” itd.) pochodzą z załącznika
  metodycznego zadania i są zachowane dla zgodności z zadaniem,
- raport i interfejs pokazują tę uwagę przy każdym wskaźniku.

## Składnik punktacji

Każdy składnik każdego wskaźnika ma te same pola (`ScoreComponent`, a w Wskaźniku A wpis księgi
`LedgerEntry`):

| Pole | Znaczenie |
|---|---|
| `rule` | stały identyfikator reguły, np. `base.own_profile`, `operator.same_email`, `cashout.trail_documented` |
| `weight` | nominalna waga reguły (ujemna dla kontrdowodu) |
| `applied` / `delta` | punkty faktycznie doliczone po uwzględnieniu niezależności i ograniczeń |
| `source` / `sources` | skąd pochodzi przesłanka (usługa, adres publikacji, moduł danych blockchain, decyzja) |
| `evidence` / `evidenceIds` | dowód: adres URL, identyfikator transakcji, cecha, adres, identyfikator śladu |
| `explanation` | zdanie po polsku |
| `independence` | czy składnik jest niezależny od pozostałych, czy powtarza tę samą informację |
| `limitations` | czego składnik **nie** dowodzi |

Suma `delta` w księdze zawsze równa się wynikowi — sprawdza to test.

## A. Konto → portfel

Punkt wyjścia: najmocniejszy ślad według rodzaju miejsca publikacji (wartości z załącznika zadania):

| Rodzaj śladu | Punkty |
|---|---|
| dowód kryptograficzny (rekord ENS, podpis) | 95 |
| własny profil | 85 |
| ogłoszenie sprzedaży / oferta P2P | 70 |
| wiadomość w kontekście rozliczenia | 65 |
| wypowiedź na forum | 50 |
| masowy komentarz | 25 |

Korekty:

1. **Sposób odnalezienia profilu** (`identity.*`): profil pośredni −5, sam nick −10, pospolity nick −20,
   samo imię i nazwisko −20.
2. **Niezależne potwierdzenia** (`synergy.second_source` +15, `synergy.extra_sources` +5 za każde
   kolejne, najwyżej +10) — liczone po **pochodzeniu**, nie po liczbie serwisów (niżej).
3. **Adres współdzielony** (`penalty.shared_address` −30), gdy publikują go co najmniej trzy
   niepowiązane tożsamości.
4. **Wykluczenie** (`exclusion.address_class`, wynik 0): adres giełdy, smart kontraktu, zbiórki,
   miksera lub instytucji. Fakt publikacji zostaje odnotowany, ale adres nie jest portfelem
   prywatnym konta.

### Niezależność pochodzenia

Wcześniej niezależność wyznaczała sama nazwa usługi, więc jeden wpis wklejony do pięciu serwisów
dawał premię jak pięć potwierdzeń. Teraz ślady dzielone są na **grupy pochodzenia**
(`provenanceGroups`). Dwa ślady trafiają do jednej grupy, gdy:

- pochodzą z tej samej usługi,
- mają identyczny skrót SHA-256 pobranej treści,
- mają tę samą treść fragmentu po normalizacji (bez adresów, odnośników, wielkości liter,
  interpunkcji i znaków diakrytycznych),
- są przedrukiem — podobieństwo zbiorów wyrazów (Jaccard) co najmniej 0,8 przy co najmniej 8 wyrazach,
- jeden jest kopią archiwalną adresu strony drugiego (Wayback Machine, archive.today),
- źródło nadało im ten sam klucz pochodzenia (`originKey`).

Premia zależy od liczby grup. Scalenie kopii jest jawne: księga dostaje wpis
`independence.copies_merged` z wagą 0 i listą usług, a wynik podaje `independentSources`
i `provenance`.

Ograniczenie: fragment krótszy niż 24 znaki treści (np. samo „BTC: adres”) nie wystarcza do
rozpoznania kopii — dwa takie wpisy w różnych usługach liczą się osobno. Treść przeredagowana
ręcznie też może nie zostać rozpoznana.

## B. Wspólny operator

Rozdzielone pojęcia:

- **konto** — jeden profil w jednej usłudze (`usługa|nazwa konta`),
- **persona** — deklarowana tożsamość, pod którą występują konta,
- **hipoteza wspólnego operatora** — przypuszczenie narzędzia dla pary kont,
- **powiązanie potwierdzone** — hipoteza przyjęta decyzją analityka albo dowód kryptograficzny.

Zgodność nicku nie jest dowodem wspólnej tożsamości: ten sam nick w dwóch usługach daje słabą
przesłankę (waga 20), która sama niczego nie łączy.

Wagi przesłanek (`PERSON_RULES.ties`): ten sam e-mail 100, ten sam telefon 100, wzajemne odnośniki 90,
ten sam adres publikowany przez oba konta jako własny 80, jednostronny odnośnik 50 (−10 za każdy
kolejny niepotwierdzony krok), ta sama strona WWW 50, ten sam awatar 50, rzadki nick ze zgodną nazwą
lub miejscowością 50, sam nick 20, sama nazwa wyświetlana 15.

Składanie (`combineComponents`):

```
wynik = najmocniejsza przesłanka
      + 20% wagi każdej kolejnej NIEZALEŻNEJ przesłanki (łącznie najwyżej +15)
      − kontrdowody
wynik ≤ 95 bez decyzji analityka; wynik ≤ 45 przy kontrdowodzie twardym; 100 tylko po potwierdzeniu
```

Przesłanki o tym samym kluczu pochodzenia (np. ten sam e-mail widoczny w dwóch miejscach) są
pokazane, ale doliczane raz.

Kontrdowody:

- **twarde** (blokują automatyczne łączenie bez względu na sumę): sprzeczne deklarowane imię
  i nazwisko, decyzja analityka „odrzucone”,
- **miękkie**: różne miejscowości (−10),
- **informacyjne**: wspólny adres jest współdzielony albo należy do giełdy lub kontraktu — nie został
  policzony.

### Łączenie kont w kandydatów na operatora

Konta łączone są od najmocniejszego wiązania do najsłabszego (próg 50). Dwa skupienia łączą się
tylko wtedy, gdy **żadna** para ich członków nie ma kontrdowodu twardego. Dzięki temu ścieżka
A–B–C nie scala A i C, jeśli A i C deklarują różne osoby. Każde niewykonane połączenie trafia do
`blockedMerges` kandydata z powodem.

Statusy hipotezy: `hypothesis` (konta osobno), `auto_grouped` (konta w jednym kandydacie — nadal
wnioskowanie narzędzia), `blocked` (mocne przesłanki, ale kontrdowód twardy), `confirmed`,
`rejected`. Dwa ostatnie pochodzą wyłącznie z decyzji analityka; decyzję można wycofać, a wpis
i jego wycofanie zostają w rejestrze.

## C. Wyjście do walut tradycyjnych

Drabina dowodowa — każdy szczebel wymaga więcej niż poprzedni:

| Szczebel | Co wiadomo |
|---|---|
| `onchain_transfer` | sam przelew w blockchainie na adres bez etykiety usługi |
| `service_interaction` | przelew na adres publicznie oznaczony jako usługa wymiany |
| `cashout_signal` | wzorzec typowy dla wypłaty: udokumentowana ścieżka do usługi, adres wpłat, zamiana na stablecoin i wpłata, powtarzalne wpłaty, doładowanie karty, adres zamilkł po wpłacie — albo deklaracja wymiany na fiat w publikacjach podmiotu |
| `documented_fiat_exit` | wyjście udokumentowane **poza** blockchainem i przyjęte przez analityka |

Dane blockchain nigdy same nie osiągają ostatniego szczebla. Wypłatę na rachunek bankowy potwierdza
dopiero usługa (dane klienta, odpowiedź na zapytanie) — każda ocena niższego szczebla niesie to
ograniczenie. Wypłata **z** giełdy na adres podmiotu to źródło środków, a nie sygnał wypłaty.
Kwoty i wyceny pochodzą wyłącznie z danych sieci i kursów; gdy kursu brak, wyceny nie ma.

Adres kontrahenta, giełdy ani kontraktu nie jest przypisywany badanej osobie. Dwa portfele
korzystające z tej samej giełdy nie są przez to powiązane — powiązaniem (i to tylko hipotezą) jest
dopiero wspólny indywidualny adres wpłat.

### Wzorce w blockchainie (`apps/api/src/cashout-stage.ts`, `CASH_OUT_RULES`)

| Reguła | Waga | Kiedy |
|---|---|---|
| `cashout.onchain_transfer` | 5 | przelewy na adresy bez etykiety usługi (szczebel 1) |
| `cashout.stablecoin_swap_only` | 15 | zamiana na stablecoin bez wpłaty do usługi (szczebel 1) |
| `cashout.direct_service_transfer` | 40 / 45 / 45 / 30 | przelew na oznaczony adres: giełda / P2P / karta / bramka (szczebel 2) |
| `cashout.deposit_address_inferred` | 55 | przez prawdopodobny indywidualny adres wpłat (wnioskowanie) |
| `cashout.trail_documented` | 50 | ścieżka przez adresy pośrednie |
| `cashout.stablecoin_swap` | 60 | zamiana na stablecoin, potem wpłata stablecoina do usługi w ciągu 7 dni |
| `cashout.stablecoin_conversion_large` | 65 | jak wyżej, ale wartość zamiany ≥ 50 000 zł (kurs z dnia; próg ekspercki `largeStablecoinPln`); bez kursu reguły nie ocenia się — ograniczenie to mówi |
| `cashout.repeated_deposits` | 60 | ≥ 3 osobne wpłaty do tej samej usługi |
| `cashout.repeated_offramp` | 65 | ≥ 3 wpłaty w ≥ 3 różnych miesiącach (regularne spieniężanie; nie dotyczy bramki) |
| `cashout.deposit_then_quiet` | 50 | ostatnia aktywność adresu to wpłata do usługi, potem ≥ 30 dni bez żadnej transakcji (do daty oceny), saldo w walucie sieci ≤ 1% wpływów; bez daty oceny reguła nie działa |
| `cashout.crypto_card_topup` | 55 | przelew na adres oznaczony jako wydawca karty zasilanej kryptowalutami |
| `cashout.round_amounts_pln` | 10 | ≥ 2 wpłaty (i ≥ połowa wycenionych) o wartości w PLN bliskiej wielokrotności 1 000 zł (odchylenie ≤ 50 zł i ≤ 0,5%) — przesłanka słaba; bez kursu nie ocenia się |
| `cashout.valuation_available` | 5 | jest kurs z dnia transakcji |

Te same fakty opisane dwiema regułami liczą się raz (wspólny klucz pochodzenia): zamiana dużej wartości
i zamiana ogólna, wpłaty powtarzalne i regularne spieniężanie, przelew na kartę i doładowanie karty.
Kontrskładniki (`inferred_hop`, `cluster_origin`, `label_heuristic`, `low_trail_confidence`,
`service_also_non_custodial`, `payment_gateway_spend`, `withdrawals_back`, `incoming_only`,
`unverified_asset`) — bez zmian.

### Oznaki w publikacjach podmiotu — Web2 (`apps/api/src/fiat-signals.ts`, `FIAT_WEB_RULES`)

Zadanie KAS wymienia: interakcje z usługami P2P, bramkami płatniczymi, kartami krypto-fiat i wymianę
znacznych wartości na stablecoiny. W publikacjach szukamy:

| Reguła | Waga | Przykład |
|---|---|---|
| `cashout.web.p2p_offer_pln` | 45 | „sprzedam USDT za gotówkę”, „wymiana BTC na PLN” (kupno kryptowaluty się nie liczy) |
| `cashout.web.cash_meeting` | 40 | „odbiór osobisty”, „gotówka do ręki”, „spotkanie” — w zdaniu o kryptowalutach albo w publikacji z ofertą |
| `cashout.web.bank_or_blik` | 35 | „BLIK”, „przelew na konto”, „wypłata na konto” — w tym samym kontekście |
| `cashout.web.crypto_card` | 35 | karta zasilana kryptowalutami (Binance Card, Crypto.com, karta Zonda, Revolut krypto, Wirex…) |
| `cashout.web.named_offramp` | 25 | nazwana usługa wyjścia do fiat: giełda/kantor z wypłatą (Zonda, Kanga, Egera, FlyingAtom, Revolut, Bitpanda…), bitomat, platforma P2P (Binance P2P, LocalCoinSwap, Bisq, HodlHodl…) |
| `cashout.web.payment_gateway` | 25 | bramka (BitPay, CoinGate, NOWPayments…; Przelewy24 i Tpay tylko w zdaniu o kryptowalutach) |

Zasady:

- **tylko konta podmiotu** — analiza zapisuje oznaki wyłącznie dla dokumentów z rolą `subject`, a teczka
  bierze publikacje kont kandydata głównego; wzmianki i cytaty innych autorów się nie liczą;
- **kopie liczą się raz** — publikacje grupuje `provenanceGroups` (ta sama treść, przedruk, kopia
  archiwalna); kilka oznak z jednej oferty ma ten sam klucz pochodzenia i nie sumuje się;
- zdania z ostrzeżeniem lub zaprzeczeniem („uwaga na oszustów”, „nie sprzedaję”) są pomijane;
- ocena z publikacji jest osobną pozycją (`origin: 'web'`, status `hypothesis`): `cashout_signal`, gdy jest
  deklaracja wymiany (oferta, gotówka, BLIK/przelew, karta), w przeciwnym razie `service_interaction`;
  **nigdy** `documented_fiat_exit`;
- gdy podmiot w publikacji nazywa usługę, do której są przelewy w blockchainie, ocena tej usługi dostaje
  składnik `cashout.web.named_offramp`; publikacja mówiąca o wymianie na fiat podnosi ją do `cashout_signal`.

### Rodzaje usług wyjścia do fiat i rejestry

Lista nazw `packages/chain/data/fiat-offramps.json` (bez adresów) klasyfikuje usługę: `exchange_with_pln`,
`crypto_atm_operator`, `crypto_card_issuer`, `payment_gateway`, `p2p_escrow`. Dla nazw z polem `registry`
narzędzie szuka dokładnej nazwy podmiotu w migawkach Rejestru działalności w zakresie walut wirtualnych
(IAS Katowice) i rejestru MiCA (ESMA) i podaje numer wpisu lub organ z migawki — to zgodność nazwy, nie
tożsamości. Adresu usługi nie oznacza się bez publicznego źródła wymieniającego dokładny adres (pole
`offrampKind` w zbiorze etykiet wymaga `source`); dla polskich usług takiego źródła nie znaleziono, więc
nie oznaczono żadnego adresu.

### „Dlaczego to oznaka wypłaty” i „Co potwierdzi wypłatę”

Każda ocena ma pole `why` (zdanie z reguł, które zadziałały) i `confirm` (do kogo skierować zapytanie,
z gotowymi wskazówkami z powiązań z usługami: transakcje, adresy wpłat, nazwy kont). Przy ofertach
rozliczanych przelewem lub BLIK-iem wskazany jest też bank albo operator płatności — w trybie właściwych
przepisów. Ostatni szczebel daje wyłącznie odpowiedź usługi przyjęta przez analityka.

## D. Sygnały możliwej niezgłoszonej działalności gospodarczej

Pytanie KAS: czy osoba zarabia na obrocie (kryptowalutami albo towarami i usługami za kryptowaluty)
w sposób zorganizowany i ciągły, a może tego nie zgłaszać. Narzędzie **nie zna statusu podatkowego**:
pokazuje sygnały w źródłach publicznych i w blockchainie oraz listę sprawdzeń, które może wykonać tylko
KAS (`whatToVerify`). Ocena jest zawsze hipotezą (`status: 'hypothesis'`). Kod:
`apps/api/src/business.ts` (reguły w `BUSINESS_RULES`), teczka: `indicators.businessActivity`.

Wskaźnik ma **dwie ścieżki**, liczone osobno (każda przez `combineComponents`):

### Ścieżka 1 — działalność możliwie niezgłoszona (`track: 'unregistered'`)

| Reguła | Waga | Źródło | Kiedy |
|---|---|---|---|
| `business.repeated_offers` | 40 / 50 (+5) | publikacje | ≥ 2 / ≥ 3 odrębne oferty; +5 przy co najmniej dwóch serwisach |
| `business.price_list_or_service_ad` | 35 | publikacje | cennik („40 zł/szt.”, „cennik”) albo ogłoszenie usług |
| `business.accepts_crypto_payments` | 35 | publikacje | „przyjmuję płatność w BTC” (frazy z `data/signals.json`) |
| `business.p2p_trading` | 45 | publikacje | „sprzedam BTC”, kantor, skup, kurs dnia — nazwa waluty tuż po formie ofertowej |
| `business.website_shop` | 40 | publikacje | własna strona ze sklepem / koszykiem i instrukcją płatności |
| `business.contact_for_orders` | 20 | publikacje | „zamówienia: pisz na priv / telegram” |
| `business.polish_nexus` | 10 | `signals.ts` | związek z Polską ≥ 40 (PLN, BLIK, miasta, +48) przy ofercie |
| `business.many_payers` | 30 / 40 / 50 | blockchain | ≥ 5 / 10 / 25 różnych nadawców (wypłaty z giełd liczone osobno) |
| `business.regular_inflows` | 30 / 40 | blockchain | wpływy w ≥ 3 / ≥ 6 miesiącach przy pokryciu okresu ≥ 50% |
| `business.retail_amounts` | 20 | blockchain | ≥ 60% wycenionych wpływów w przedziale 20–5000 zł |
| `business.turnover` | 10 / 20 / 30 | blockchain | obrót w roku ≥ 5 / 20 / 100 tys. zł — **obrót (wpływy), nie dochód** |
| `business.cashout_to_exchange` | 15 | wskaźnik C | środki z adresów podmiotu trafiały do usług wymiany |
| `business.registry_none_found` | 10 / 5 | rejestry | szukano po numerze lub domenie / wyłącznie po nazwie — brak wpisu (słaby sygnał) |

Kontrdowody: `business.charity_address` (40, **twardy** — adres zbiórki organizacji: wpłaty to darowizny,
wpływów nie liczy się), `business.donation_context` (20 — prośba o wsparcie bez oferty),
`business.one_off_sale` (15 — jedna oferta, bez wielu wpłacających i regularności),
`business.virtual_currency_register` (30 przy dopasowaniu po numerze/domenie, 10 po nazwie — wpis w
rejestrze działalności w zakresie walut wirtualnych / MiCA), `business.registry_found` (10 — działalność
jest zarejestrowana; pytanie brzmi wtedy, czy obrót jest zadeklarowany — i otwiera się ścieżka 2).

- **Kopie liczą się raz.** Oferty dzieli się na odrębne: kopia to ta sama strona (także w archiwum), ta
  sama treść (SHA-256) albo ta sama / niemal ta sama treść (Jaccard ≥ 0,8) w odstępie < 14 dni. Ta sama
  treść wystawiona ponownie po tygodniach jest kolejną ofertą. Składniki oparte na jednej publikacji
  dzielą klucz pochodzenia — drugi nie jest doliczany.
- **Wyłącznie adresy podmiotu** (przypisane osobie głównej, jak we wskaźniku C). Adresy giełd,
  kontraktów, mikserów i zbiórek są wyłączone; przelewy między własnymi adresami nie są wpływami.
- **Wycena** — kurs z istniejących wycen tego samego aktywa (wypłaty, ścieżki) najwyżej 45 dni od
  wpływu; bez kursu wpływ nie jest wyceniony (nie jest zerem). Kurs przykładowy jest oznaczony.
  Rok podatkowy według czasu polskiego.
- **Rejestry** — tylko łączniki użyte w analizie: `live-ceidg` (wymaga tokenu `CEIDG_API_TOKEN`),
  `live-krs`, `live-vat-whitelist`, `rejestry-publiczne` (migawki lokalne). Każdy dostaje wynik
  `found` / `not_found` / `not_checked` / `unavailable` z podstawą wyszukiwania. Wyszukiwanie po nazwie
  jest zawodne — osoba może działać pod inną zarejestrowaną nazwą.

### Ścieżka 2 — podmiot zarejestrowany: zgodność obrotu i ryzyko prania pieniędzy (`registered`)

Gdy wykaz VAT, KRS albo CEIDG zwrócił wpis (bez dopasowań po samej nazwie), wpis nie jest wyłącznie
kontrdowodem — otwiera osobną ocenę **sygnałów do weryfikacji** na danych zwróconych przez rejestr
(status VAT z datami, rachunki z wykazu, PKD, data rejestracji, kapitał, organy):

| Reguła | Waga | Kiedy |
|---|---|---|
| `business.registered.crypto_flows_vs_pkd` | 40 | obrót kryptowalutowy, a PKD nie dotyczą handlu (46, 47), IT (62, 63) ani finansów (64, 66) |
| `business.registered.recent_registration` | 20 | rejestracja ≤ 365 dni przed pierwszą aktywnością (albo po niej) |
| `business.registered.vat_status_inactive_or_removed` | 35 | wpływy przy statusie VAT innym niż „Czynny” albo po wykreśleniu |
| `business.registered.payout_to_whitelist_account` | 60 | wypłata z odpowiedzi usługi (`fiatPayouts[].bankAccountMasked`) na rachunek o tej samej końcówce co rachunek z wykazu VAT — **porównanie wyłącznie 4 ostatnich cyfr** |
| `business.registered.personal_and_company_mixing` | 30 | ten sam adres w publikacji z numerem firmy (lub jako adres organizacji z rejestru) i w publikacji prywatnej |
| `business.registered.shared_officer_network` | 15 | wspólni członkowie organów z innymi podmiotami sieci organizacji |
| `business.registered.sanctions_or_knf_warning` | 40 / 15 | `checkNetworkNodes` (listy sankcyjne, ostrzeżenia KNF) albo wpis KNF z łącznika rejestrów — mocne / sama nazwa |

Język: „sygnał do weryfikacji”, np. „możliwe wprowadzanie środków z kryptowalut do obrotu firmy —
sprawdź JPK_V7, księgi, źródło środków”. Narzędzie nigdy nie stwierdza prania pieniędzy. Lista
sprawdzeń: JPK_V7, CIT-8 / PIT-36(L) podmiotu, źródło pochodzenia środków, beneficjent rzeczywisty —
CRBR jest rejestrem jawnym, ale narzędzie z niego nie korzysta: przed użyciem sprawdź podstawę prawną.

### Siatka

Dla powiązanych tożsamości i organizacji z sieci organizacji teczka liczy wskaźnik D osobno; węzły od
40 pkt dostają w grafie odznakę „sygnały działalności”, a ocena podmiotu — listę `network` ze ścieżką do
podmiotu (`strongestPath`: siła z zanikiem na hipotezach, najsłabsze ogniwo). Powiązanie w siatce nie
przenosi sygnałów na podmiot. Rozwijanie sieci na żądanie może liczyć wskaźnik dla dowolnego bytu
funkcją `businessSignalsFor(entity, data)` (czysta, bez zapytań do źródeł).

Zdanie w kluczowych ustaleniach (warstwa wniosków) pojawia się od 40 pkt; linia w podsumowaniu sprawy
— od 60 pkt („istotne przesłanki”).

## Odpowiedź usługi

Kto jest klientem giełdy i czy wypłacono pieniądze na rachunek, wie tylko usługa (dane KYC). Analityk
wprowadza jej odpowiedź na zapytanie uprawnionego organu w karcie usługi („Giełdy i portfele” →
„Wczytaj odpowiedź usługi”). To **dokument spoza OSINT** — osobna warstwa, nigdy „znalezisko w
źródłach publicznych”; narzędzie nie weryfikuje jego autentyczności. Kod: `apps/api/src/service-reply.ts`.

- **Dopasowanie.** Odpowiedź dotyczy adresu sprawy tylko wtedy, gdy wskazany w niej adres wpłat /
  adres usługi albo identyfikator transakcji występuje w przelewach lub ścieżkach tego adresu (z
  uwzględnieniem sieci). Niedopasowana jest zapisana i pokazana jako „nie dopasowano do danych
  sprawy”, ale niczego nie zmienia. Adres wykluczony albo odrzucony przez analityka — tak samo.
- **Wskaźnik C.** Szczebel `documented_fiat_exit` (składnik `cashout.documented_service_reply`,
  dowód `reply:<id>` z sygnaturą) — **wyłącznie** gdy odpowiedź zawiera co najmniej jedną wypłatę na
  rachunek (`fiatPayouts`). Samo potwierdzenie właściciela konta nie dokumentuje wypłaty.
- **Tożsamość.** Imię i nazwisko (bez względu na kolejność i znaki diakrytyczne), e-mail i telefon
  klienta porównywane z kandydatem głównym:
  - zgodne → kandydat `confirmed` z przesłanką „potwierdzone odpowiedzią usługi X, sygn. Y”, a
    własność dopasowanych adresów liczona jak potwierdzona przez analityka;
  - **inna osoba** → kandydat NIE jest potwierdzony; jawna sprzeczność „konto w usłudze należy do
    innej osoby” (w teczce, kluczowych ustaleniach i raporcie), z informacją, czy to imię nosi
    powiązana tożsamość ze sprawy (np. ta sama rodzina nazwisk: Kowalski / Kowalska). Wypłata jest
    wtedy udokumentowana z zastrzeżeniem, że otrzymał ją właściciel konta;
  - brak danych klienta → ustalenie osoby bez zmian.
- **Dane wrażliwe.** Identyfikator klienta (PESEL, NIP, numer dokumentu) i numer rachunku serwer
  maskuje (ostatnie 4 znaki) przed zapisem — pełna wartość nigdy nie trafia do bazy. Z treści
  dokumentu zapisywany jest tylko skrót SHA-256.
- **Wycofanie** (`DELETE`) przywraca dokładnie wynik sprzed odpowiedzi; wpis zostaje w rejestrze z
  czasem i autorem wycofania, a raport wymienia go w części „Odpowiedzi wycofane”.

Trasy: `GET|POST /api/cases/:id/service-replies`, `DELETE /api/cases/:id/service-replies/:replyId`,
`GET /api/cases/:id/service-replies/sandbox-sample?service=…&variant=inna-osoba` (tylko przy
skonfigurowanej piaskownicy; przyjmowana wyłącznie odpowiedź z `"syntetyczne": true`).

## Decyzje analityka

Cele decyzji: `profile`, `address`, `evidence`, `link` (para kont, klucz `konto-a<->konto-b`).
Decyzja zmienia wynik w teczce, nie w zapisanej analizie. Wycofanie decyzji przywraca wynik
automatyczny; wpis i wycofanie pozostają w historii.
