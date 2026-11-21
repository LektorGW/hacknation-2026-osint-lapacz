# Audyt silnika łączenia tożsamości i wskaźników — 21.11.2026

Zakres: `apps/api/src/persons.ts`, `aliases.ts`, `packages/core/src/score.ts`, pętla rozszerzania
(`analysis.ts`, `pivot.ts`), moduł danych blockchain (`packages/chain`), graf, raport, rozdzielenie
trybów w interfejsie. Każde ustalenie ma test odtwarzający problem. Algorytm wskaźników po zmianach
opisuje [WSKAZNIKI.md](WSKAZNIKI.md).

## 1. Trzy wskazane problemy

| # | Moduł | Werdykt | Na czym polegał błąd | Poprawka | Test |
|---|---|---|---|---|---|
| 1 | `persons.ts` | **błąd potwierdzony** | Profile łączył union-find po wiązaniach ≥ 50, a sprzeczność deklarowanych nazwisk sprawdzana była tylko w parze łączonej w danym kroku. Przy A–B (mocne), B–C (mocne) i sprzeczności A↔C wszystkie trzy trafiały do jednej osoby; sprzeczność odejmowała potem najwyżej 10 punktów. | Łączenie z ograniczeniami: wiązania od najmocniejszego, dwa skupienia łączą się tylko wtedy, gdy żadna para ich członków nie ma kontrdowodu twardego (sprzeczne nazwiska, decyzja „odrzucone”). Niewykonane połączenia trafiają do `blockedMerges` z powodem. | `persons.test.ts`: „A–B–C ze sprzecznością…” |
| 2 | `aliases.ts` | **błąd potwierdzony** | Tożsamości powiązane grupowane były po `normalize(handle ?? url)`, czyli po samym nicku. Dwa konta o tym samym nicku w różnych serwisach stawały się jedną tożsamością: przesłanki jednego przypisywano drugiemu, adresy się sumowały, a jedno potwierdzenie analityka scalało oba. | Grupowanie po koncie (`usługa|nazwa konta`). Konta łączą się w jedną personę tylko przy rzeczywistej przesłance między nimi (wiązanie ≥ 50, brak sprzeczności nazwisk). Identyfikator tożsamości: `tozsamosc:<usługa|konto>`. | `aliases.test.ts`: „ten sam nick w dwóch serwisach…”, `persons.test.ts`: „ten sam nick, różne osoby” |
| 3 | `score.ts` | **błąd potwierdzony** | Niezależność źródeł wyznaczała wyłącznie nazwa usługi. Jeden wpis wklejony do pięciu serwisów dostawał +15 i +10, jak pięć niezależnych potwierdzeń (70 → 95). | Grupy pochodzenia (`provenanceGroups`): ta sama treść, przedruk, kopia archiwalna, ten sam skrót, ta sama usługa = jedno potwierdzenie. Jawny wpis `independence.copies_merged`. | `core/test/independence.test.ts` (wynik 70 zamiast 95) |

## 2. Pozostałe ustalenia

### Łączenie tożsamości

- **Skopiowana publikacja jako dowód wspólnej osoby.** Wiązanie „ten sam adres” (80) liczyło każdą
  wzmiankę adresu. Teraz pełną wagę ma tylko adres publikowany przez oba konta jako własny; wzmianka
  albo kopia tej samej treści daje 30 i sama niczego nie łączy.
- **Pojęcia.** Rozdzielone: konto, persona, hipoteza wspólnego operatora, powiązanie potwierdzone.
  Kandydat na osobę i powiązana tożsamość mają pole `status` (`hypothesis` / `confirmed` /
  `rejected`).
- **Decyzje analityka.** Doszły cele `link` (para kont) i `cashout` (dokument wyjścia do fiat).
  Usunięcie decyzji kasowało wiersz, więc ginął ślad audytowy — teraz decyzja jest wycofywana
  (`withdrawnAt`, `withdrawnBy`), zostaje w rejestrze i przestaje wpływać na wynik.

### Rozszerzanie analizy

| Kontrola | Stan przed | Stan po |
|---|---|---|
| Maksymalna głębokość | była, tylko w dzienniku | wpis w `intel.expansion.stops` |
| Budżet żądań | brak | `maxRequests` — jeden budżet na zapytania do źródeł i do dostawców blockchain |
| Duplikaty | pętla rozszerzania mogła ponowić zapytanie zadane wcześniej | każde zapytanie (źródło, identyfikator) raz na analizę; adres analizowany w blockchainie raz |
| Wiarygodność źródeł | identyfikatory z masowych komentarzy i ze słabo przypisanych dokumentów były śledzone | jawna reguła `EXPANSION_RELIABILITY` |
| Powody zatrzymania | tylko dziennik | lista `stops` z etapem, powodem i liczbą pominiętych |
| Odtwarzalność | część wyników zależała od kolejności odpowiedzi | parametry przebiegu w `intel.expansion.run`, przetwarzanie w kolejności wejścia |
| Niedostępne źródło | błąd tylko w dzienniku; brak danych blockchain zastępowany zerami | `intel.sourceErrors`, `chain: undefined` z adnotacją, wyjaśnienie w teczce |

Świadomy wyjątek: dokument dopasowany tylko po nazwisku albo pospolitym nicku jest śledzony o jeden
krok (inaczej analiza z samego imienia i nazwiska nic by nie znalazła); dalej już nie.
Kontrahenci transakcyjni są sprawdzani do limitu `maxCounterparties` i nie są analizowani w głąb.

### Dane blockchain

| Obszar | Werdykt |
|---|---|
| Bitcoin — kwota przelewu | **błąd naprawiony**: największemu odbiorcy przypisywana była suma wszystkich obcych wyjść, co zawyżało wpłatę na giełdę |
| Bitcoin — reszta | **błąd naprawiony**: adres reszty mógł zostać kontrahentem |
| EVM / TRON — tokeny | **błąd naprawiony**: token bez liczby miejsc po przecinku liczony w jednostkach bazowych; teraz „niezweryfikowany”, bez wyceny |
| Klasyfikacja giełd i kontraktów | poprawna; adres z kodem to `smart_contract`, kontrahent bez etykiety zostaje `unknown` |
| Śledzenie przepływów | **błąd naprawiony**: ścieżka szła dalej przez adres z etykietą niebędącą usługą wymiany |
| Klaster portfela | **błąd naprawiony**: wspólne wejścia nie wykluczały adresów usług |
| Powiązania adresów | wspólna giełda ani wspólny kontrakt nie łączą portfeli (potwierdzone testami); zaostrzone progi dla adresów znanych tylko z etykiety |
| Etykiety usług | każda niesie źródło; etykieta z wnioskowania jest oznaczona |
| Wskaźniki wypłat | bez zmyślonych kwot; brak kursu = brak wyceny |

Wyjście do walut tradycyjnych ma teraz cztery szczeble; dane blockchain nie osiągają ostatniego.

### Graf i raport

Graf ma węzły operatora (hipoteza), persony, konta, identyfikatora, portfela, usługi i źródła.
Każda relacja ma status: fakt źródłowy, obliczenie, hipoteza, potwierdzona, odrzucona — odrzucone
zostają widoczne. Raport dostał sekcje trzech wskaźników ze składnikami, ścieżkę dowodową i rejestr
decyzji z wycofaniami. Sformułowania przedstawiające hipotezę jako fakt zostały zmienione.

## 3. Scenariusze regresyjne

| Scenariusz | Gdzie | Oczekiwany wynik |
|---|---|---|
| Jedna osoba, trzy pseudonimy, mocne dowody | `persons.test.ts` | uzasadniona hipoteza ze składnikami; nigdy „potwierdzona” bez analityka |
| Dwie osoby, identyczny nick | `persons.test.ts`, `aliases.test.ts` | brak scalenia |
| A–B–C, sprzeczność A↔C | `persons.test.ts` | A i C osobno, `blockedMerges` |
| Adres skopiowany do pięciu serwisów | `core/test/independence.test.ts` | jedno pochodzenie, brak premii |
| Dwa portfele, ta sama giełda | `chain/test/verification.test.ts`, `persons.test.ts`, `scenario.test.ts` | brak wspólnej osoby |
| Adres kontraktu w profilu | `persons.test.ts`, `scenario.test.ts` | wskaźnik 0, `notPrivateWallet` |
| Analityk odrzuca hipotezę | `dossier.test.ts`, `scenario.test.ts` | przeliczone osoby, tożsamości, wskaźniki, graf |
| Analityk potwierdza relację i wycofuje | `dossier.test.ts`, `scenario.test.ts` | powrót do wyniku automatycznego, wpis w rejestrze |
| Nieaktywne zewnętrzne API | `expansion.test.ts`, `scenario.test.ts` | wynik częściowy, brak zmyślonych danych |
| Pełny przebieg | `scenario.test.ts` | konta, adresy, hipotezy, blockchain, graf, raport |

## 4. Znane ograniczenia po zmianach

- Wskaźniki są porządkowe, nieskalibrowane — brak zbioru spraw z ustalonym stanem faktycznym.
- Kopię publikacji rozpoznaje się po treści fragmentu; krótkie wpisy (poniżej 24 znaków treści)
  i treść przeredagowana ręcznie liczą się jako osobne pochodzenia.
- Sprzeczność nazwisk jest kontrdowodem twardym tylko wtedy, gdy oba konta podają nazwę wyglądającą
  jak imię i nazwisko; pseudonimy niczego nie blokują.
- Dokument potwierdzający wyjście do fiat działa na poziomie adresu, nie pary adres–usługa.
- W Bitcoinie jedna transakcja to nadal jeden przelew na liście (odbiorca największej kwoty);
  pozostałe wyjścia są w ograniczeniach i w śledzeniu.
- Moment przerwania zbierania wzmianek o powszechnie cytowanym adresie zależy od kolejności
  odpowiedzi źródeł przy współbieżności większej niż 1.
