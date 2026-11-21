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
| `cashout_signal` | wzorzec typowy dla wypłaty: udokumentowana ścieżka do usługi, adres wpłat, zamiana na stablecoin i wpłata, powtarzalne wpłaty |
| `documented_fiat_exit` | wyjście udokumentowane **poza** blockchainem i przyjęte przez analityka |

Dane blockchain nigdy same nie osiągają ostatniego szczebla. Wypłatę na rachunek bankowy potwierdza
dopiero usługa (dane klienta, odpowiedź na zapytanie) — każda ocena niższego szczebla niesie to
ograniczenie. Wypłata **z** giełdy na adres podmiotu to źródło środków, a nie sygnał wypłaty.
Kwoty i wyceny pochodzą wyłącznie z danych sieci i kursów; gdy kursu brak, wyceny nie ma.

Adres kontrahenta, giełdy ani kontraktu nie jest przypisywany badanej osobie. Dwa portfele
korzystające z tej samej giełdy nie są przez to powiązane — powiązaniem (i to tylko hipotezą) jest
dopiero wspólny indywidualny adres wpłat.

## Decyzje analityka

Cele decyzji: `profile`, `address`, `evidence`, `link` (para kont, klucz `konto-a<->konto-b`).
Decyzja zmienia wynik w teczce, nie w zapisanej analizie. Wycofanie decyzji przywraca wynik
automatyczny; wpis i wycofanie pozostają w historii.
