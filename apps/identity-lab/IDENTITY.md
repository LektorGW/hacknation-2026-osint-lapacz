# Dopasowywanie kont syntetycznych

Silnik korzysta wyłącznie z publicznych pól konta. Nie używa identyfikatora osoby, roli konta, wzorca identyfikatorów ani pliku wzorcowego. Wynik `probability` jest **heurystycznym wskaźnikiem podobieństwa**, nie skalibrowanym prawdopodobieństwem i nie dowodem tożsamości. Może wskazać konto współdzielone albo podszywające się.

## Sygnały i ograniczenia

- Najsilniejsze: identyczny e-mail, e-mail drugiego konta w opisie, wspólny publiczny adres portfela i jawne wskazanie rzadkiego aliasu w opisie.
- Średnie: rzadki alias, wariant aliasu, podobne nazwy skrzynek, zgodność aliasu z nazwą skrzynki.
- Słabe: nazwa wyświetlana, lokalizacja, zainteresowania, godziny aktywności. Same nie wystarczą do mocnego dopasowania.
- Popularne aliasy są osłabiane według częstości w analizowanym zbiorze. Nazwa `rowerzysta` jest dodatkowym przykładem aliasu generycznego.
- Skorelowane sygnały aliasu i e-maila mają wspólny limit. Skopiowany opis, współdzielony e-mail lub portfel wciąż mogą dać fałszywe dopasowanie.
- Adresowanie e-mail z plusem i usuwanie kropek stanowią podobieństwo zapisu, nie regułę dostawcy poczty.
- Przelew między dwoma różnymi portfelami nie jest sygnałem wspólnej osoby. Silnik nie wykorzystuje grafu transakcji.

Wynik zawiera listę `evidence` z jawnymi przesłankami i `effectiveEvidence` z wkładem grup po ograniczeniu korelacji. `score` to suma umownych wag z punktem startowym −4; funkcja logistyczna zamienia ją na wskaźnik 0–1, ograniczony do 0,985. Wagi nie zostały wyuczone na realnym zbiorze.

## Wyszukiwanie

`resolveIdentity(query, accounts, {limit})` obsługuje identyfikator profilu, e-mail, alias, nazwę wyświetlaną, portfel i fragmenty od trzech znaków. Zwraca punkty startowe `anchors`, bezpośrednie trafienia `queryMatch` oraz konta z powiązaniami wyjaśnionymi przez `via`. Zgodność zapytania z profilem ma inne znaczenie niż potwierdzenie wspólnej osoby. Gdy ten sam alias pasuje do kilku kont, punkty startowe pozostają osobnymi hipotezami. Wyszukanie konkretnego identyfikatora konta usuwa tę niejednoznaczność.

Nie propagujemy pewności przez łańcuchy A–B–C. Każde powiązanie jest bezpośrednim porównaniem z punktem startowym. Wyniki dla niejednoznacznego wyszukiwania po nazwie mają dodatkowo obniżoną pewność. `totalMatches` wskazuje liczbę wyników przed limitem, a lista `matches` ma najwyżej 200 pozycji.

## Benchmark

Wyłącznie `evaluateIdentity` dostaje plik wzorcowy. Osobno dobiera deterministyczną próbę par tej samej osoby oraz różnych osób (domyślnie łącznie do 20 000 par). Dobór negatywów jest losowaniem równomiernym bez powtórzeń, niezależnym od wyniku modelu. `precision`, `recall`, `f1` używają wag odwrotnych do częstości doboru warstw, żeby nadmiar pozytywów w próbie nie zawyżał oszacowania precyzji dla populacji wszystkich par. `confusion` zawiera surowe liczności próby, a `weightedConfusion` estymowane liczności populacyjne. Brak dodatnich predykcji daje `precision: null`; brak prawdziwych pozytywów daje `recall: null`.

Dodatkowy `hardNegativeAudit` sprawdza pary różnych osób o identycznym niepustym znormalizowanym aliasie lub wspólnym niepustym publicznym adresie portfela. Ten drugi przypadek ujawnia pułapkę adresu pośrednika płatności: dwie niezależne osoby mogą publikować ten sam adres i otrzymać wysokie dopasowanie. Wynik tej kontrolowanej próby jest raportowany osobno i nie zmienia głównych metryk. `pairs` i `falsePositives` liczą unikalne pary, nawet gdy para dzieli kilka portfeli lub spełnia oba kryteria. `bySignal.username` oraz `bySignal.sharedWallet` podają liczności według przyczyny; kategorie mogą się nakładać. Przykłady zawierają `reasons` i `signals`, a fałszywe trafienia są pokazywane w pierwszej kolejności. Wysoka precyzja głównej próby może współistnieć z fałszywymi trafieniami tego audytu, ponieważ losowa próba często pomija rzadkie kolizje.

Wyniki dotyczą wyłącznie generatora laboratorium. Mała próba może pominąć rzadkie fałszywe dopasowania. Testowanie na danych użytych do projektowania wag nie jest niezależną walidacją. Aby traktować wskaźnik jako prawdopodobieństwo, należałoby rozdzielić osoby między trening, kalibrację i test, dobrać reprezentatywną częstość trafień i sprawdzić kalibrację (np. Brier score i reliability diagram).
