# Zbiór syntetyczny

Generator nie pobiera danych z internetu. Wszystkie osoby, konta, ogłoszenia, wpisy i miejscowości stanowią fikcyjny benchmark. Znane nazwy serwisów oznaczają lokalne symulacje, a nie połączenie z ich właścicielami. Adresy używają zarezerwowanej domeny `.test`.

`generateDataset({ seed: 67, people: 180 })` daje powtarzalny zbiór dla 27 portali: pięciu społecznościowych, siedmiu handlowych oraz piętnastu forów. Obsługiwany zakres to 10–2000 osób oraz całkowity seed 0–2147483647. Stały moment migawki to 20 listopada 2026, godz. 12:00 UTC.

Każda osoba ma zwykłe konta na kilku serwisach. Część prowadzi dodatkowe konta (`multi`), a część również profile pod inną deklarowaną tożsamością (`fake`). Te etykiety i identyfikatory właścicieli występują wyłącznie w oddzielnym obiekcie `groundTruth`. Nie wolno ich wykorzystywać jako cech do dopasowania.

Imiona i nazwiska są składane z fikcyjnych kombinacji. Nazwiska przymiotnikowe mają dopasowane polskie formy, np. Zofia Zielińska i Bartosz Czarnecki; nazwiska rzeczownikowe, np. Kowal i Sikora, pozostają nieodmienne w mianowniku. Dotyczy to również deklarowanych tożsamości fake kont.

Publiczne wskazówki obejmują powtarzane adresy, warianty z `+`, podobne aliasy, adresy kontaktowe w bio, miejscowości, zainteresowania, godziny aktywności i okazjonalnie wspólny testowy portfel. Niektóre fake konta są celowo niezależne i nie dają się wiarygodnie powiązać na podstawie ujawnionych atrybutów.

Gotowy scenariusz rozpoczyna zapytanie `mira.kowal@poczta.test`. Ta sama syntetyczna osoba używa również aliasów `szlak_ciszy`, `mira_k`, `mira.outdoors` i `m_kowal` oraz kilku skrzynek. Scenariusz `rowerzysta` przedstawia dwie różne osoby z tym samym nickiem. Wspólne imię, miejscowość czy hobby nie powinny automatycznie łączyć kont.

Zbiór służy do testowania technicznego i demonstracji. Jego rozkład cech jest projektowany, więc wynik na tym benchmarku nie dowodzi jakości modelu w rzeczywistych populacjach. W szczególności informacje kontaktowe są tutaj celowo publiczne, aby umożliwić kontrolowane ćwiczenie.
