# Demonstracja dla jury — około 5 minut

Wszystkie osoby, konta i adresy w piaskownicy są zmyślone. Uruchomienie trzech procesów opisuje
[README](../README.md#uruchomienie-krok-po-kroku). Pasek u góry ekranu pokazuje tryb: **SANDBOX**
(dane syntetyczne), **LIVE** (publiczne źródła) albo **DEMO** (dane wbudowane w interfejs).

Liczby poniżej pochodzą z przebiegu na piaskownicy z 21.11.2026 przy domyślnych regułach.

## 1. Od jednego identyfikatora do raportu (2 min)

Wpisz login `rkowalski_btc`.

| Co pokazać | Gdzie | Co widać |
|---|---|---|
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
