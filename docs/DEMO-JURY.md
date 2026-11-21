# Demonstracja dla jury — około 5 minut

Wszystkie osoby, konta i adresy w piaskownicy są zmyślone. Uruchomienie trzech procesów opisuje
[README](../README.md#uruchomienie-krok-po-kroku). Pasek u góry ekranu pokazuje tryb: **SANDBOX**
(dane syntetyczne), **LIVE** (publiczne źródła) albo **DEMO** (dane wbudowane w interfejs).

Liczby poniżej pochodzą z przebiegu na piaskownicy z 21.11.2026 przy domyślnych regułach.

## 1. Od jednego identyfikatora do raportu (2 min)

Wpisz login `rkowalski_btc`. Pod polem widać **„Tryb: Szybki / Głęboki”** — domyślnie zaznaczony
jest **Głęboki** (1–4 minuty, szeroki przegląd forów i serwisów). Gdy na pokazie liczy się czas,
kliknij **„Szybki”** (kilka–kilkanaście sekund). Okres analizy (od – do) jest zawsze widoczny i
nieobowiązkowy. Ekran postępu ma tytuł „Szukam powiązań: „rkowalski_btc”…”.

| Co pokazać | Gdzie | Co widać |
|---|---|---|
| Wejście wyszukiwania | pod tytułem teczki | znaczek „Szukano: login rkowalski_btc”; kafel „Kto to prawdopodobnie jest” ma znacznik „wejście”, w grafie węzeł wejścia ma obwódkę i podpis „wejście” |
| Wyszukiwanie i odkrywanie | góra teczki, lista identyfikatorów | e-mail odkryty w profilu w kroku 1, użyty do dalszego wyszukiwania |
| Adres i jego weryfikacja | zakładka „Adresy” | `bc1q43zh…2g98`, suma kontrolna poprawna, Wskaźnik Pewności 90 z księgą kroków |
| Niezależność dowodów | księga wyniku | „niezależnych pochodzeń: 2” — profil i ogłoszenie o różnej treści |
| Analiza blockchain | „Dowód spieniężenia”, „Giełdy i portfele” | 3 przelewy do „Giełda Bursztyn”, ok. 345 tys. zł, z identyfikatorami transakcji |
| Raport | przycisk raportu | sekcje wskaźników A, B, C i „Ścieżka dowodowa” |

## 2. Hipoteza wspólnego operatora, a nie odgadnięta tożsamość (1,5 min)

Ta sama sprawa, zakładka **„Wskaźniki”**, karta B.

- Dwa konta `rkowalski_btc` (gitpub i targ): wskaźnik 90, status „konta zgrupowane automatycznie”
  — nadal wnioskowanie narzędzia.
- `rkowalski_btc` ↔ `julka_k` (Julia Kowalska): ten sam adres publikowany jako własny, ale
  **sprzeczne deklarowane nazwiska** blokują scalenie — wskaźnik ograniczony do 45, status
  „zablokowana sprzecznością”. Rozwiń składniki: przesłanka, kontrdowód, ograniczenia.
- Zakładka **„Graf powiązań”**: hipotezy linią przerywaną, fakty ciągłą. Kliknij relację — panel
  pokazuje dowody. Przełącz warstwę na „Przepływy blockchain”.
- Kliknij **„Potwierdź wspólnego operatora”**: konto Julii przechodzi do operatora, teczka się
  przelicza. Potem **„Wycofaj”** w historii zmian: wynik wraca, a wpis zostaje w rejestrze.

## 3. Odrzucanie błędnych przypisań (1 min)

| Identyfikator | Co pokazuje | Wynik |
|---|---|---|
| nick `bkruk_trader` | adres gorącego portfela giełdy i kontrakt stablecoina w profilu | oba wykluczone, wskaźnik 0, „to nie jest portfel prywatny” |
| nick `oli_stepniak` | adres wklejany przez wiele kont | adres współdzielony, nieprzypisany |
| imię i nazwisko `Kacper Wrzosek` | imiennicy | osobni kandydaci, bez scalenia |
| nick `t_nowak_foto` | wspólny indywidualny adres wpłat giełdy | powiązanie jako hipoteza; sama wspólna giełda niczego nie łączy |

## 4. Wyjście do walut tradycyjnych (0,5 min)

Zakładka „Wskaźniki”, karta C: drabina czterech szczebli. Dla `rkowalski_btc` szczebel
„potencjalny sygnał wypłaty” (wskaźnik 69). Ostatni szczebel — „udokumentowane wyjście” — wymaga
dokumentu spoza blockchaina; narzędzie samo go nie nadaje.

## 5. Odpowiedź giełdy zamyka łańcuch (1 min)

Ta sama sprawa `rkowalski_btc`, tryb **SANDBOX** (piaskownica i API uruchomione po ostatnich zmianach).

1. Zakładka **„Giełdy i portfele”** → karta „Giełda Bursztyn” → rozwiń **„Wczytaj odpowiedź usługi”**.
2. Kliknij **„Pobierz przykładową odpowiedź z piaskownicy”** — formularz wypełnia się danymi
   syntetycznymi (klient „Rafał Kowalski”, PESEL zamaskowany, 3 transakcje, 3 wypłaty w PLN).
3. Kliknij **„Zapisz odpowiedź usługi”**. Teczka się przelicza: na karcie usługi odpowiedź z
   oznaczeniem „Dokument spoza OSINT”; w „Ustaleniu” osoba **potwierdzona odpowiedzią usługi**
   (100, z sygnaturą); karta C na szczeblu **„udokumentowane wyjście”** z odpowiedzią jako dowodem;
   w grafie węzeł „Odpowiedź usługi Giełda Bursztyn”; w raporcie sekcja „Odpowiedzi usług”.
4. Kliknij **„Wycofaj”** przy odpowiedzi — wynik wraca dokładnie do stanu sprzed niej (wskaźnik C
   znów „potencjalny sygnał wypłaty”), wpis zostaje w rejestrze jako wycofany.
5. Kliknij **„Wariant: konto należy do innej osoby”**, potem „Zapisz”. Właścicielką konta jest
   „Julia Kowalska” — osoba **nie** zostaje potwierdzona; czerwona sprzeczność „konto w usłudze należy
   do innej osoby”, ze wskazaniem, że to powiązana tożsamość z tej sprawy. Na koniec „Wycofaj”.

Puenta: OSINT wskazuje adres i giełdę; tożsamość klienta i wypłatę potwierdza dopiero dokument od
usługi — wprowadzony jawnie, oznaczony, odwracalny i nigdy nie mylony ze źródłami publicznymi.

## 6. Statystyki i monitorowanie spraw (0,5 min)

1. **Pulpit → „Historia spraw”**: najnowsze na górze, nagłówki „Priorytet”, „Najmocniejsze powiązanie”,
   „Szacowane wypłaty”, „Utworzono” sortują listę. Zaznacz **„Monitoruj”** przy sprawie
   `rkowalski_btc` — analiza będzie ponawiana automatycznie (domyślnie co 6 godzin, tryb głęboki).
2. Menu **„Monitoring”**: karta sprawy z ostatnią i następną analizą, wyborem odstępu (co godzinę /
   co 6 godzin / codziennie) i przyciskiem **„Odśwież teraz”**. Po drugiej analizie rozwiń „Co się
   zmieniło” — nowe i usunięte adresy, zmiany wyniku, podmiany adresów i nowe przelewy do usług.
   Dawny przegląd źródeł jest niżej, w sekcji „Przegląd źródeł”.
3. Menu **„Statystyki”**: średnia pewność, średnia liczba trafień na sprawę, skuteczność i odsetek
   spraw z trafieniami. **Trafienie** = adres nieodrzucony z Wskaźnikiem Pewności ≥ 60 (poziom
   „prawdopodobne”) — definicje pod podkreślonymi słowami. Niżej dawne kafle z liczbami i wykres
   wypłat na lata podatkowe.
4. Menu **„Typowanie”**: źródła podzielone na „publicznie dostępne” i „wymagające klucza API”, przy
   drugich znaczek „klucz aktywny” albo „brak klucza” (wartości kluczy nie są nigdzie pokazywane).

„Zasady punktacji” są teraz w dolnej części paska bocznego, obok „Słownika pojęć” i „Pomocy”.

## Pytania, na które warto mieć odpowiedź

- **Czy 90 to 90% pewności?** Nie. To wskaźnik porządkowy z jawnych reguł, nieskalibrowany —
  narzędzie mówi to przy każdej liczbie. Szczegóły: [WSKAZNIKI.md](WSKAZNIKI.md).
- **Co chroni przed fałszywymi powiązaniami?** Kontrdowody twarde sprawdzane w całym skupieniu
  kont, wykluczenie adresów usług, liczenie kopii jako jednego dowodu, brak łączenia po samym
  nicku. Lista błędów znalezionych w audycie: [AUDYT.md](AUDYT.md).
- **Co, gdy źródło nie odpowiada?** Wynik jest częściowy, źródło wymienione z nazwy, brakujących
  danych narzędzie nie uzupełnia.
- **Czy analiza jest odtwarzalna?** Limity, kolejność źródeł, skrót reguł i powody zatrzymania są
  zapisane przy każdej analizie.
- **Prawdziwe dane?** Tryb LIVE korzysta wyłącznie z publicznych źródeł; próba z 21.11.2026 dla
  publicznej nazwy ENS `vitalik.eth` zakończyła się w 46 s (10 profili, adres potwierdzony zapisem
  ENS, przelewy na giełdę z identyfikatorami transakcji).
