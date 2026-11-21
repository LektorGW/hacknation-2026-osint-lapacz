# Pomiar OŁCyŚ na laboratorium tożsamości (identity-lab)

Wygenerowano: 2026-11-21T17:21:57.827Z poleceniem `node scripts/benchmark-lab.ts`. Plik powstaje automatycznie — liczby i przykłady pochodzą z jednego przebiegu.

## Co i jak zmierzono

- **Zbiór:** `apps/identity-lab`, seed 67, 180 syntetycznych osób, 992 kont w 27 fikcyjnych portalach, 555 wpisów, 477 ofert, 1013 wątków (w tym kohorta 200 postów ujawniających adresy — dane zaimportowane dokumentowanym poleceniem `npm run wallet-posts -- --apply`), testowy łańcuch LAB z 30 publicznie podanymi adresami `lab1…`.
- **Narzędzie:** nasz kod bez zmian reguł — `buildApp` z `apps/api/src/app.ts` wywoływany przez `app.inject`, baza PGlite w pamięci, wyłącznie łączniki `lab-*` (`packages/sources/src/lab.ts`) i dostawca sieci laboratoryjnej (`packages/chain/src/providers/lab.ts`); tryb standardowy, bez internetu, bez modelu językowego.
- **Dostęp do danych:** łączniki czytają tylko publiczne API laboratorium (`/api/accounts`, `/api/accounts/:id`, `/api/portal/:slug`, `/api/blockchain`). Nie używają `/api/search` (zwraca hipotezy silnika laboratorium), `/api/resolve`, `/api/evaluate` ani eksportów.
- **Kolejność:** punkty startowe wybrano deterministycznie z danych publicznych (kolejność wg SHA-256 identyfikatora konta), wykonano wszystkie analizy, a dopiero potem pobrano `/api/ground-truth`. Strażnik na `fetch` przerwałby skrypt przy wcześniejszym odczycie; żądań do laboratorium w fazie analiz: 132976, do ścieżek zakazanych: 0, poza laboratorium: 0.
- **Próba główna:** 60 punktów startowych = pierwsze 60 RÓŻNYCH osób wśród 96 wylosowanych kont (po jednym koncie na osobę; role kont startowych: multi 11, ordinary 46, fake 3). Osoby z próby mają od 3 do 10 kont (średnio 6,0).
- **Identyfikatory startowe:** wariant „nick + e-mail” (nick i publiczny e-mail konta startowego) oraz wariant „sam nick”.
- **Łączenie kont:** konta przypisane osobie = profile osoby głównej w teczce + profile powiązanych tożsamości z relacją „prawdopodobnie ta sama osoba”; wzorzec = wszystkie konta tej osoby (także dodatkowe `multi` i pod przybraną tożsamością `fake`). Mikro: suma TP/FP/FN po punktach startowych; makro: średnia wartości z punktów startowych.
- **Adresy:** adres uznajemy za przypisany osobie, gdy Wskaźnik Pewności w teczce (względem osoby głównej, adres niewykluczony) osiąga próg. Wzorzec = adresy portfeli należących do osoby; adres pośrednika nie należy do nikogo z publikujących.

## (a) Łączenie kont tej samej osoby

| Wariant | Punkty | Precision mikro | Recall mikro | F1 mikro | Precision makro | Recall makro | F1 makro | TP / FP / FN |
|---|---|---|---|---|---|---|---|---|
| Próba główna, start: nick + e-mail — osoba główna + „prawdopodobnie ta sama osoba” | 60 | 99,5% | 54,8% | 70,7% | 99,4% | 54,5% | 66,5% | 198 / 1 / 163 |
| Próba główna, start: nick + e-mail — tylko profile osoby głównej | 60 | 100,0% | 53,2% | 69,4% | 100,0% | 52,1% | 65,0% | 192 / 0 / 169 |
| Próba główna, start: sam nick — osoba główna + „prawdopodobnie ta sama osoba” | 60 | 99,5% | 54,8% | 70,7% | 99,4% | 54,5% | 66,5% | 198 / 1 / 163 |
| Próba główna, start: sam nick — tylko profile osoby głównej | 60 | 100,0% | 53,2% | 69,4% | 100,0% | 52,1% | 65,0% | 192 / 0 / 169 |

Konto startowe jest zawsze znane, więc zawyża recall. Ta sama ocena **bez konta startowego** (ile POZOSTAŁYCH kont osoby narzędzie dołączyło):

| Wariant | Precision | Recall | Dołączone / błędnie dołączone / pominięte | Recall wg roli konta (ordinary / multi / fake) | Analizy bez osoby głównej | Konto startowe poza wynikiem |
|---|---|---|---|---|---|---|
| Próba główna, start: nick + e-mail — osoba główna + „prawdopodobnie ta sama osoba” | 99,3% | 45,8% | 138 / 1 / 163 | 94/196 · 44/77 · 0/28 | 0 | 0 |
| Próba główna, start: nick + e-mail — tylko profile osoby głównej | 100,0% | 43,9% | 132 / 0 / 169 | 88/196 · 44/77 · 0/28 | 0 | 0 |
| Próba główna, start: sam nick — osoba główna + „prawdopodobnie ta sama osoba” | 99,3% | 45,8% | 138 / 1 / 163 | 94/196 · 44/77 · 0/28 | 0 | 0 |
| Próba główna, start: sam nick — tylko profile osoby głównej | 100,0% | 43,9% | 132 / 0 / 169 | 88/196 · 44/77 · 0/28 | 0 | 0 |

### Dlaczego konta zostały pominięte albo błędnie dołączone (wariant nick + e-mail)

**Konta pominięte** (łącznie 163):

| Publiczna cecha łącząca konto z osobą | Liczba | Znaczenie |
|---|---|---|
| same_email (z kontem, którego narzędzie też nie znalazło) | 78 | ten sam e-mail (pole konta lub opis) co inne konto tej osoby |
| name_location | 38 | ta sama nazwa wyświetlana i miejscowość — w regułach to za mało (nazwa 15, brak wagi za miejscowość) |
| none | 21 | brak publicznej cechy wspólnej z innymi kontami osoby (np. konto pod przybraną tożsamością) |
| location_only | 12 | tylko ta sama miejscowość |
| name_location (z kontem, którego narzędzie też nie znalazło) | 11 | ta sama nazwa wyświetlana i miejscowość — w regułach to za mało (nazwa 15, brak wagi za miejscowość) |
| location_only (z kontem, którego narzędzie też nie znalazło) | 2 | tylko ta sama miejscowość |
| same_email | 1 | ten sam e-mail (pole konta lub opis) co inne konto tej osoby |

**Konta błędnie dołączone** (łącznie 1):

| Publiczna cecha łącząca konto z osobą | Liczba | Znaczenie |
|---|---|---|
| wspólny adres (pośrednika) | 1 | ten sam nick co inne konto tej osoby — sam nick nie wystarcza do połączenia (waga 20 < próg 50) |

### To samo dla wariantu „sam nick”

**Konta pominięte** (łącznie 163):

| Publiczna cecha łącząca konto z osobą | Liczba | Znaczenie |
|---|---|---|
| same_email (z kontem, którego narzędzie też nie znalazło) | 78 | ten sam e-mail (pole konta lub opis) co inne konto tej osoby |
| name_location | 38 | ta sama nazwa wyświetlana i miejscowość — w regułach to za mało (nazwa 15, brak wagi za miejscowość) |
| none | 21 | brak publicznej cechy wspólnej z innymi kontami osoby (np. konto pod przybraną tożsamością) |
| location_only | 12 | tylko ta sama miejscowość |
| name_location (z kontem, którego narzędzie też nie znalazło) | 11 | ta sama nazwa wyświetlana i miejscowość — w regułach to za mało (nazwa 15, brak wagi za miejscowość) |
| location_only (z kontem, którego narzędzie też nie znalazło) | 2 | tylko ta sama miejscowość |
| same_email | 1 | ten sam e-mail (pole konta lub opis) co inne konto tej osoby |

**Konta błędnie dołączone** (łącznie 1):

| Publiczna cecha łącząca konto z osobą | Liczba | Znaczenie |
|---|---|---|
| wspólny adres (pośrednika) | 1 | ten sam nick co inne konto tej osoby — sam nick nie wystarcza do połączenia (waga 20 < próg 50) |

## (b) Przypisanie adresów do osoby

Zbiory punktów startowych: **adresowy** — po jednym koncie na każdy publicznie podany adres (bez adresu szeroko publikowanego), 29 różnych osób, z czego 29 ma własny portfel; **próba główna** — 60 osób, z czego 9 ma własny portfel; **łącznie** — oba zbiory bez powtórzeń osób (80 osób, 29 z portfelem). Wariant startu: nick + e-mail.

| Zbiór | Próg Wskaźnika Pewności | Precision | Recall | F1 | TP / FP / FN | FP: adres pośrednika | FP: adres innej osoby |
|---|---|---|---|---|---|---|---|
| Zbiór adresowy | ≥ 40 | 100,0% | 100,0% | 100,0% | 29 / 0 / 0 | 0 | 0 |
| Zbiór adresowy | ≥ 60 | 100,0% | 93,1% | 96,4% | 27 / 0 / 2 | 0 | 0 |
| Zbiór adresowy | ≥ 80 | 100,0% | 93,1% | 96,4% | 27 / 0 / 2 | 0 | 0 |
| Próba główna | ≥ 40 | 100,0% | 66,7% | 80,0% | 6 / 0 / 3 | 0 | 0 |
| Próba główna | ≥ 60 | 100,0% | 66,7% | 80,0% | 6 / 0 / 3 | 0 | 0 |
| Próba główna | ≥ 80 | 100,0% | 66,7% | 80,0% | 6 / 0 / 3 | 0 | 0 |
| Łącznie | ≥ 40 | 100,0% | 100,0% | 100,0% | 29 / 0 / 0 | 0 | 0 |
| Łącznie | ≥ 60 | 100,0% | 93,1% | 96,4% | 27 / 0 / 2 | 0 | 0 |
| Łącznie | ≥ 80 | 100,0% | 93,1% | 96,4% | 27 / 0 / 2 | 0 | 0 |

Dla porównania — ten sam pomiar z progiem na **łącznym prawdopodobieństwie osoba–adres** (`subjectProbability` = prawdopodobieństwo osoby głównej × prawdopodobieństwo adresu u tej osoby):

| Zbiór | Próg | Precision | Recall | F1 | TP / FP / FN |
|---|---|---|---|---|---|
| Łącznie | ≥ 40 | 100,0% | 100,0% | 100,0% | 29 / 0 / 0 |
| Łącznie | ≥ 60 | 100,0% | 93,1% | 96,4% | 27 / 0 / 2 |
| Łącznie | ≥ 80 | 100,0% | 75,9% | 86,3% | 22 / 0 / 7 |

Aktywność w łańcuchu LAB: dla 40 z 40 adresów w teczkach dostawca zwrócił profil (saldo, przelewy); 21 ma co najmniej jeden przelew między adresami. Token LAB nie ma wartości — żadnej kwoty nie wyceniono w PLN.

### Pułapka: wspólny adres pośrednika (zbiórka)

Adres `lab146852904fbc14102d209c3f9f564f344a54deaf9` publikuje 22 kont (17 różnych osób); we wzorcu to adres pośrednika — nie należy do żadnej z publikujących osób. Analizę uruchomiono dla każdej publikującej osoby (17 punktów startowych, nick + e-mail).

| Próg Wskaźnika Pewności | Analizy, w których adres pośrednika przypisano osobie | Odsetek |
|---|---|---|
| ≥ 40 | 0 / 17 | 0,0% |
| ≥ 60 | 0 / 17 | 0,0% |
| ≥ 80 | 0 / 17 | 0,0% |

Jak narzędzie oceniło adres pośrednika:

- 15× wykluczony; niepowiązanych publikujących 20; reguły: base.own_profile → penalty.shared_address → exclusion.widely_cited
- 1× wykluczony; niepowiązanych publikujących 18; reguły: base.own_profile → synergy.second_source → synergy.extra_sources → penalty.shared_address → exclusion.widely_cited
- 1× wykluczony; niepowiązanych publikujących 19; reguły: base.own_profile → synergy.second_source → penalty.shared_address → exclusion.widely_cited

Czy wspólny adres skleił różne osoby: w 0 z 17 analiz do osoby głównej trafiło cudze konto, w 2 analizach cudze konto dostało relację „prawdopodobnie ta sama osoba”, w 1 — „możliwe: ta sama osoba albo bliska”. Precision łączenia kont w tym zbiorze (mikro): 97,0%, recall: 62,7%.

Własne adresy tych samych osób (prawdziwie należące do nich): 16 z 17 przypisano przy progu 60.

### Pułapka: ten sam nick u różnych osób

W danych publicznych 235 nicków występuje na co najmniej dwóch kontach; przeanalizowano 235 (start: sam nick). Według wzorca 1 z nich należy do RÓŻNYCH osób (pułapka), a 234 to konta jednej osoby (kontrola).

| Miara | Wynik |
|---|---|
| Nicki różnych osób: osoba główna zawiera konta więcej niż jednej osoby (błędne sklejenie) | 0 / 1 (0,0%) |
| Nicki różnych osób: cudze konto z relacją „prawdopodobnie ta sama osoba” | 0 / 1 (0,0%) |
| Nicki różnych osób: średnia czystość osoby głównej (udział kont osoby dominującej) | 100,0% |
| Nicki różnych osób: prawdopodobieństwo osoby głównej (średnio) | 40,0 |
| Nicki jednej osoby (kontrola): wszystkie konta z tym nickiem uznane za jedną osobę | 234 / 234 (100,0%) |
| Nicki jednej osoby (kontrola): prawdopodobieństwo osoby głównej (średnio) | 46,6 |

Adresy w analizach nicków różnych osób: 0 adresów z wynikiem ≥ 60 nie należy do żadnej osoby, której konta są w osobie głównej.

## (c) Czas analizy

| Zbiór | Analiz | Średnio | Mediana | P95 | Maks. |
|---|---|---|---|---|---|
| Wszystkie analizy | 478 | 0,28 s | 0,25 s | 0,55 s | 1,21 s |
| Próba główna, nick + e-mail | 60 | 0,20 s | 0,18 s | 0,47 s | 0,74 s |
| Próba główna, sam nick | 60 | 0,23 s | 0,22 s | 0,51 s | 0,55 s |
| Zbiór adresowy | 29 | 0,45 s | 0,46 s | 0,84 s | 1,13 s |
| Pułapka wspólnego adresu | 22 | 0,47 s | 0,41 s | 0,99 s | 1,21 s |
| Pułapka nicku | 235 | 0,28 s | 0,26 s | 0,46 s | 0,77 s |

Czas obejmuje założenie sprawy i całą analizę (wyszukiwanie w 27 portalach, wystąpienia adresów, łańcuch LAB, rozszerzanie, ocena, zapis); złożenie teczki to dodatkowo średnio 0,60 s. Średnio 287 zapytań do łączników na analizę. Laboratorium działa na tej samej maszynie, więc czas nie zawiera opóźnień sieci ani limitów prawdziwych serwisów. Analizy nieukończone lub częściowe: 0; analizy z błędem łącznika lub dostawcy w dzienniku: 0.

## Przykłady błędów (konkretne konta)

1. **Pominięte konto — same_email (z kontem, którego narzędzie też nie znalazło).** Start: acct-00084 (@p_brzezinski24, social-facebook, „Piotr Brzeziński”). Konto: acct-00081 (@kawa_i_kod24, forum-elektronika, „Piotr Brzeziński”), rola we wzorcu: `ordinary`. Cecha wspólna z kontem acct-00083 (@kawa.i.kod24, forum-rower, „Piotr Brzeziński”) (też nieznalezionym). Zawiodła przesłanka: ten sam e-mail (pole konta lub opis) co inne konto tej osoby. Szczegóły: e-maile konta: piotr.brzezinski24@poczta.test; e-maile konta wspólnego: piotr.brzezinski24+kontakt@poczta.test, piotr.brzezinski24@poczta.test; opis: „Najpierw kawa, później pomysły. Rozmawiam, testuję i dzielę się doświadczeniem. Zainteresowania: majsterkowanie, technologia, elektronika.”
2. **Pominięte konto — name_location.** Start: acct-00863 (@adam_sikora166, forum-lokalne, „Adam Sikora”). Konto: acct-00861 (@a_sikora166, social-tiktok, „Adam Sikora”), rola we wzorcu: `ordinary`. Cecha wspólna z kontem acct-00863 (@adam_sikora166, forum-lokalne, „Adam Sikora”). Zawiodła przesłanka: ta sama nazwa wyświetlana i miejscowość — w regułach to za mało (nazwa 15, brak wagi za miejscowość). Szczegóły: e-maile konta: iskrawgarazu166@inbox.test; e-maile konta wspólnego: a.sikora166@skrzynka.test, adam.sikora166@poczta.test; opis: „Dzielę się tym, co sprawdzone. Rozmawiam, testuję i dzielę się doświadczeniem. Zainteresowania: sport, majsterkowanie.”
3. **Pominięte konto — none.** Start: acct-00863 (@adam_sikora166, forum-lokalne, „Adam Sikora”). Konto: acct-00864 (@pstryk_i_juz_2815, social-linkedin, „Nina Maj”), rola we wzorcu: `fake`. Zawiodła przesłanka: brak publicznej cechy wspólnej z innymi kontami osoby (np. konto pod przybraną tożsamością). Szczegóły: e-maile konta: pstrykijuz2815@konto.test; opis: „Dzielę się tym, co sprawdzone. W wolnym czasie: książki, natura.”
4. **Pominięte konto — location_only.** Start: acct-00863 (@adam_sikora166, forum-lokalne, „Adam Sikora”). Konto: acct-00865 (@iskra_w_garazu_4724, forum-lokalne, „Iga Jabłońska”), rola we wzorcu: `fake`. Cecha wspólna z kontem acct-00859 (@adam_sikora166, social-x, „Adam S.”). Zawiodła przesłanka: tylko ta sama miejscowość. Szczegóły: e-maile konta: iskrawgarazu4724@konto.test; e-maile konta wspólnego: a.sikora166@skrzynka.test; opis: „Spokojnie, krok po kroku. W wolnym czasie: majsterkowanie, książki.”
5. **Pominięte konto — name_location (z kontem, którego narzędzie też nie znalazło).** Start: acct-00084 (@p_brzezinski24, social-facebook, „Piotr Brzeziński”). Konto: acct-00082 (@piotr_brzezinski24, market-vinted, „Piotr B.”), rola we wzorcu: `ordinary`. Cecha wspólna z kontem acct-00085 (@kawa_i_kod24, forum-lokalne, „Piotr B.”) (też nieznalezionym). Zawiodła przesłanka: ta sama nazwa wyświetlana i miejscowość — w regułach to za mało (nazwa 15, brak wagi za miejscowość). Szczegóły: e-maile konta: p.brzezinski24@skrzynka.test; e-maile konta wspólnego: piotr.brzezinski24@poczta.test; opis: „Najpierw kawa, później pomysły. Rzeczy, którym daję drugie życie. Zainteresowania: odzież, akcesoria, dom.”
6. **Pominięte konto — location_only (z kontem, którego narzędzie też nie znalazło).** Start: acct-00225 (@tomasz_krol50, market-allegro, „Tomasz Król”). Konto: acct-00226 (@iskra_w_garazu_7668, forum-kuchnia, „Paweł Kaczmarek”), rola we wzorcu: `fake`. Cecha wspólna z kontem acct-00227 (@wspolny_stol_3569, forum-gry, „Piotr Zieliński”) (też nieznalezionym). Zawiodła przesłanka: tylko ta sama miejscowość. Szczegóły: e-maile konta: iskrawgarazu7668@konto.test; e-maile konta wspólnego: wspolnystol3569@konto.test; opis: „Małe rzeczy robią różnicę. W wolnym czasie: gry, elektronika.”
7. **Pominięte konto — same_email.** Start: acct-00010 (@klara_kaczmarek11, forum-krypto, „Klara K.”). Konto: acct-00011 (@bursztynowy.brak11, market-ebay, „Klara Kaczmarek”), rola we wzorcu: `ordinary`. Cecha wspólna z kontem acct-00009 (@rowerzysta, social-x, „Klara Kaczmarek”). Zawiodła przesłanka: ten sam e-mail (pole konta lub opis) co inne konto tej osoby. Szczegóły: e-maile konta: klara.kaczmarek11+kontakt@poczta.test, klara.kaczmarek11@poczta.test; e-maile konta wspólnego: klara.kaczmarek11@poczta.test; opis: „Zbieram małe historie. Rzeczy, którym daję drugie życie. Zainteresowania: elektronika, fotografia, kolekcje. Kontakt: klara.kaczmarek11@poczta.test.”
8. **Błędnie dołączone konto — wspólny adres (pośrednika).** Start: acct-00010 (@klara_kaczmarek11, forum-krypto, „Klara K.”). Konto: acct-00013 (@rowerzysta, social-facebook, „Nina J.”), rola we wzorcu: `ordinary`. Cecha wspólna z kontem acct-00009 (@rowerzysta, social-x, „Klara Kaczmarek”). Zawiodła przesłanka: ten sam nick co inne konto tej osoby — sam nick nie wystarcza do połączenia (waga 20 < próg 50). Szczegóły: przesłanka narzędzia: Adres podmiotu lab11ce253…a57d68e7 publikuje jako własny także profil „rowerzysta” (x.lab.test).
9. **Błędnie dołączone konto (start: sam nick) — wspólny adres (pośrednika).** Start: acct-00010 (@klara_kaczmarek11, forum-krypto, „Klara K.”). Konto: acct-00013 (@rowerzysta, social-facebook, „Nina J.”), rola we wzorcu: `ordinary`. Cecha wspólna z kontem acct-00009 (@rowerzysta, social-x, „Klara Kaczmarek”). Zawiodła przesłanka: ten sam nick co inne konto tej osoby — sam nick nie wystarcza do połączenia (waga 20 < próg 50). Szczegóły: przesłanka narzędzia: Adres podmiotu lab11ce253…a57d68e7 publikuje jako własny także profil „rowerzysta” (x.lab.test).
10. **Ten sam nick, różne osoby — rozdzielone poprawnie.** Nick „rowerzysta”: konta acct-00009 (@rowerzysta, social-x, „Klara Kaczmarek”) oraz acct-00013 (@rowerzysta, social-facebook, „Nina J.”); osoba główna (prawdopodobieństwo 40) zawiera konta tylko jednej osoby: acct-00013, acct-00017, acct-00012, acct-00016, acct-00014, acct-00018; pozostali kandydaci: [acct-00009, acct-00011].
11. **Adres (próg 60).** start acct-00112 (@s_brzezinska29, forum-podroze, „Sara Brzezińska”): POMINIĘTY adres własny lab14233a6d8c9df9b24d57b325c860fa66eaa3277c0 — wynik 55, śladów 3, niepowiązanych publikujących 3, reguły: base.own_profile → penalty.shared_address
12. **Adres (próg 60).** start acct-00128 (@j_zajac32, forum-moto, „Julia Zając”): POMINIĘTY adres własny lab1abb1fc7bf34798e56e2a67851c814bd5fe4107f8 — wynik 55, śladów 3, niepowiązanych publikujących 3, reguły: base.own_profile → penalty.shared_address
13. **Adres pośrednika.** Start acct-00010 (@klara_kaczmarek11, forum-krypto, „Klara K.”): adres `lab146852904fbc14102d209c3f9f564f344a54deaf9` dostał wykluczenie (niepowiązanych publikujących 20; reguły: base.own_profile → penalty.shared_address → exclusion.widely_cited).

## Ograniczenia pomiaru

- **Zbiór jest syntetyczny.** Osoby, konta, treści i adresy wygenerował program; nie ma tu ani jednego prawdziwego konta. Nazwy portali nawiązują do znanych serwisów, ale to lokalne symulacje.
- **Rozkład cech jest zaprojektowany.** Generator sam decyduje, jak często konta jednej osoby dzielą e-mail, wariant nicku czy opis; w szczególności e-mail konta jest tu publiczny, czego w prawdziwych serwisach zwykle nie ma. Wynik zależy od tych decyzji bardziej niż od jakości narzędzia.
- **Wynik nie dowodzi jakości na rzeczywistych danych.** To test techniczny integracji i reguł w kontrolowanych warunkach, nie walidacja skuteczności w prawdziwym internecie.
- **Mała próba.** 60 osób w próbie głównej i 29 osób z portfelem — pojedyncze przypadki przesuwają wyniki o kilka punktów procentowych; nie liczono przedziałów ufności.
- **Jeden seed, jeden przebieg.** Inny seed laboratorium da inne liczby. Kolejność punktów startowych jest deterministyczna, więc powtórzenie na tym samym zbiorze daje ten sam wynik.
- **Punkt startowy to konto z danymi kontaktowymi.** Wariant „nick + e-mail” zakłada, że analityk zna e-mail osoby; wariant „sam nick” pokazuje wynik bez tej wiedzy.
- **Adresy `lab1…` nie mają sumy kontrolnej**, a łańcuch LAB ma 30 portfeli i kilkadziesiąt przelewów — z pomiaru nie wynika nic o śledzeniu środków, wypłatach ani wycenie (token LAB nie ma wartości; dostawca nie wycenia go w PLN).
- **Reguł nie strojono pod zbiór.** Poprawiano wyłącznie integrację (łączniki, dostawca sieci laboratoryjnej); błędy wynikające z reguł są opisane wyżej jako rekomendacje, bez zmian w kodzie oceny.
- **Łącznik nie czyta wszystkiego.** Odpowiedzi konta w cudzych wątkach są pobierane tylko przy wyszukiwaniu adresu; `/api/search` laboratorium jest celowo pominięte.

