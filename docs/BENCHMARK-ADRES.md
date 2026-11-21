# Od samego adresu do osoby — pomiar OŁCyŚ

Wygenerowano 2026-11-21T20:40:05.513Z poleceniem `node scripts/benchmark-address.ts`. Plik powstaje automatycznie — wszystkie liczby i przykłady pochodzą z jednego przebiegu skryptu (342 analiz, 170 s).

Pytanie: analityk ma **wyłącznie adres** kryptowalutowy. Czy narzędzie wskaże właściwą osobę, a przede wszystkim — czy nie wskaże **niewłaściwej**?

## Wynik w skrócie

| Miara (tryb standardowy) | Laboratorium tożsamości (sieć LAB) | Piaskownica (BTC / ETH / TRON) |
|---|---|---|
| Adresów przeanalizowanych | 30 | 65 |
| Trafienie / częściowe / błąd / wstrzymanie | 29 / 0 / 0 / 1 | 37 / 0 / 0 / 28 |
| **Błędne przypisanie osoby** (kandydat główny to ktoś inny) | **0 z 30** (0,0%) | **0 z 65** (0,0%) |
| Precision przypisania = trafienia / (trafienia + błędy) | 100,0% (29 / 29) | 100,0% (37 / 37) |
| Pokrycie = trafienia / adresy opublikowane przez prywatnego właściciela | 100,0% (29 / 29) | 94,7% (36 / 38) |
| Poprawne wstrzymanie dla adresów, które nie powinny wskazywać osoby | 100,0% (1 / 1) | 96,3% (26 / 27) |
| Czas analizy: mediana / P95 | 0,57 s / 1,54 s | 0,07 s / 0,24 s |

Najkrócej: na 95 adresach z obu zbiorów narzędzie **ani razu nie wskazało niewłaściwej osoby** (także częściowo). Dla 28 adresów, które nie powinny prowadzić do osoby (giełdy, kontrakty, zbiórka pośrednika, adresy cytowane i nieopublikowane), nie podało kandydata w 27 przypadkach, a w 1 wskazało konto, które samo podało adres jako swój (konto rozdania-oszustwa). Z 67 adresów prywatnych opublikowanych przez właściciela pominęło 2 (2× adres tylko we wpisach liczonych jako wzmianka (kategoria źródła spoza OWNERSHIP_CATEGORIES, bez modelu językowego) — autor nie jest kandydatem na właściciela). Ostrożność ma cenę: prawdopodobieństwo osoby wskazanej z samego adresu nie przekracza 75, więc przy progu 80 narzędzie nie wskazuje nikogo. Zbiory są syntetyczne — patrz „Czego ten pomiar nie mówi”.

## Jak mierzono

- **Zbiory.** (1) `apps/identity-lab`: seed 67, 180 syntetycznych osób, 992 kont w 27 portalach, łańcuch LAB z 30 portfelami — analizowano wszystkie adresy z `/api/blockchain` i z publicznych kont. (2) `apps/sandbox` (serwer na http://127.0.0.1:4100, tylko odczyt): 65 adresów — wszystkie adresy z plików `apps/sandbox/data` (publikacje, etykiety eksploratora, księga przelewów).
- **Start:** sprawa z jednym identyfikatorem `crypto_address`; tryb standardowy oraz — osobno — głęboki. Narzędzie: `buildApp` + `app.inject`, baza PGlite w pamięci odnawiana co 40 analiz, łączniki i dostawca danych blockchain wyłącznie danego zbioru (laboratorium: `lab-*`; piaskownica: `sandbox-*`), bez internetu i bez modelu językowego. Reguł nie zmieniano.
- **Kolejność.** Najpierw wszystkie analizy, potem prawda wzorcowa. Laboratorium: `/api/ground-truth` pobrane po analizach (strażnik na `fetch`); żądań w czasie pomiaru: laboratorium 36726, piaskownica 7160, zablokowanych (zakazane ścieżki, zapis, `/_demo`): 0, poza zbiorami: 0. Piaskownica: przed analizami skrypt wziął z plików danych tylko listę adresów i nicków autorów; właścicieli wyznaczył w fazie oceny.
- **Prawda wzorcowa — laboratorium:** właściciel = osoba, której portfel ma ten adres (`people[].walletAddresses`); adres zbiórki pośrednika (scenariusz `shared-payment-address`, posty z `walletOwnerPersonId = null`) nie należy do nikogo. „Opublikowany przez właściciela” = adres jest w publicznym polu portfeli któregoś konta tej osoby albo w jej poście z `addressUse = own`.
- **Prawda wzorcowa — piaskownica:** konta jednej osoby według plików danych i README (`SANDBOX_PERSONS` w skrypcie; skrypt sprawdza, że każde konto z `accounts` jest przypisane dokładnie raz — m.in. Rafał Kowalski i Julia Kowalska to jedna osoba, a dwa `marek88` i dwa `wilczek_x9` to różne osoby). Adres z etykietą klasy innej niż `private` = giełda / usługa / kontrakt; adres publikowany przez jedną osobę = jej adres; publikowany przez kilka osób = cytowany przez wielu (właściciel = autor wpisu otwierającego, np. konto rozdania); adres bez publikacji i bez etykiety = bez właściciela.
- **Klasyfikacja wyniku** (kandydat główny = `dossier.persons[0]` z prawdopodobieństwem > 0, konta = jego profile): **trafienie** — zawiera konto właściciela i żadnego konta innej osoby; **częściowe** — konto właściciela i konta innych osób; **błąd** — brak konta właściciela (dla adresów bez właściciela: każdy wskazany kandydat); **wstrzymanie** — teczka nie podaje kandydata.
- **Precision** = trafienia / (trafienia + błędy) — częściowe pokazane osobno. **Pokrycie** = trafienia / adresy prywatne opublikowane przez właściciela.

## Laboratorium tożsamości (sieć LAB)

### Wynik według rodzaju adresu (tryb standardowy)

| Rodzaj adresu (wzorzec) | Adresów | Trafienie | Częściowe | Błąd | Wstrzymanie |
|---|---|---|---|---|---|
| prywatny, właściciel sam go opublikował | 29 | 29 | 0 | 0 | 0 |
| wspólny adres pośrednika (zbiórka) | 1 | 0 | 0 | 0 | 1 |
| **Razem** | 30 | 29 | 0 | 0 | 1 |

- **Precision przypisania:** 100,0% (trafienia: 29, błędy: 0; częściowe: 0).
- **Pokrycie:** 100,0% — 29 z 29 adresów, które prywatny właściciel sam opublikował; licząc też częściowe: 100,0%.
- **Adresy, które nie powinny wskazywać osoby** (wspólny adres pośrednika (zbiórka)): poprawne wstrzymanie 1 z 1 (100,0%); wskazany właściciel konta, które podało adres jako swój (np. konto rozdania) 0; wskazana niewłaściwa osoba 0.

### Dlaczego narzędzie wstrzymało się ze wskazaniem osoby

| Powód (z teczki) | Adresów | W tym rodzaje adresu wg wzorca |
|---|---|---|
| adres powszechnie cytowany (≥ 10 niepowiązanych autorów) | 1 | wspólny adres pośrednika (zbiórka): 1 |

Rodzaje wyjaśnień w teczkach bez kandydata (`dossier.explanations[].kind`, jedna teczka może mieć kilka): `widely_cited` 1, `no_cash_out` 1.

### Czy prawdopodobieństwo kandydata oddziela trafienia od błędów

| Wynik | Prawdopodobieństwo kandydata głównego |
|---|---|
| Trafienia | 29 szt.; min 65, mediana 75, maks 75 |
| Częściowe | — |
| Błędy | — |

| Przedział prawdopodobieństwa | Trafienia | Częściowe | Błędy |
|---|---|---|---|
| 0–39 | 0 | 0 | 0 |
| 40–59 | 0 | 0 | 0 |
| 60–79 | 29 | 0 | 0 |
| 80–100 | 0 | 0 | 0 |

Liczymy tylko kandydatów z prawdopodobieństwem ≥ progu (pozostali = wstrzymanie):

| Próg | Trafienia | Częściowe | Błędy | Precision | Pokrycie |
|---|---|---|---|---|---|
| ≥ 40 | 29 | 0 | 0 | 100,0% | 100,0% |
| ≥ 60 | 29 | 0 | 0 | 100,0% | 100,0% |
| ≥ 80 | 0 | 0 | 0 | — | 0,0% |

Błędów nie było, więc ten zbiór **nie pozwala sprawdzić**, czy prawdopodobieństwo kandydata odsiewa błędne wskazania — tabela pokazuje tylko, ile trafień traci się przy wyższym progu. Najwyższe prawdopodobieństwo kandydata w analizie samego adresu: 75. Podstawa prawdopodobieństwa osoby (pierwsza przesłanka kandydata): 60 — 29×; resztę daje premia za mocne wiązania między profilami tej osoby (w uzasadnieniu: „Mocne wiązania między profilami (n): +x”). Próg 80 odcina więc każde wskazanie: sam adres na profilu nie daje osobie wysokiej pewności, dopóki analityk jej nie potwierdzi.

### Tryb głęboki

W pomiarze nie ma łączników internetowych, więc tryb głęboki różni się wyłącznie limitami rozszerzania (więcej kroków i zapytań; łącznik `deep-search` istnieje tylko przy źródłach publicznych).

| Tryb | Trafienie | Częściowe | Błąd | Wstrzymanie | Precision | Pokrycie | Mediana / P95 czasu |
|---|---|---|---|---|---|---|---|
| standardowy | 29 | 0 | 0 | 1 | 100,0% | 100,0% | 0,57 s / 1,54 s |
| głęboki | 29 | 0 | 0 | 1 | 100,0% | 100,0% | 0,62 s / 3,28 s |

Żaden adres nie zmienił klasyfikacji między trybami.

### Czas analizy

Tryb standardowy: mediana 0,57 s, P95 1,54 s, maks. 1,66 s (założenie sprawy + cała analiza; serwer zbioru działa na tej samej maszynie, więc bez opóźnień sieci). Analizy nieukończone lub częściowe: 0; z błędem łącznika lub dostawcy w dzienniku: 0.

### Przykłady

1. **TRAFIENIE** — `lab16a79cfb6229fd50bc9dd4b0be29d76579b19dcd4` (prywatny, właściciel sam go opublikował; właściciel we wzorcu: Mira Kowal (person-0001); Portfel LAB 01). Wynik: kandydat główny (prawdopodobieństwo 65): Mira Kowal (person-0001) — konta acct-00001, acct-00002, acct-00003, acct-00005, acct-00007. Adres w teczce: wynik 100, śladów 11, niepowiązanych publikujących 2, klasa unknown („Portfel LAB 01”); reguły: base.own_profile → synergy.second_source → synergy.extra_sources. Uzasadnienie w teczce: „Podstawa 60: profil x.lab.test („szlak_ciszy”) — autor sam publikuje adres wskazany w sprawie. Mocne wiązania między profilami (10): +15. Połączono profile x.lab.test i facebook.lab.test: ten sam e-mail mira.kowal@poczta.test (waga 100); ten sam adres kryptowalutowy publikowany przez oba profile jako własny, niepublikowany przez wiele innych osób (waga 80).”
2. **TRAFIENIE** — `lab13cb446f6cf73e4f425c66c0528fe8bde3a5fe2bb` (prywatny, właściciel sam go opublikował; właściciel we wzorcu: Artur Kowal (person-0024); Portfel LAB 24). Wynik: kandydat główny (prawdopodobieństwo 75): Artur Kowal (person-0024) — konta acct-00135, acct-00134, acct-00132, acct-00136. Adres w teczce: wynik 70, śladów 11, niepowiązanych publikujących 3, klasa unknown („Portfel LAB 24”); reguły: base.own_profile → independence.copies_merged → synergy.second_source → synergy.extra_sources → penalty.shared_address. Uzasadnienie w teczce: „Podstawa 60: profil forum-kulinarne.lab.test („a_kowal33”) — autor sam publikuje adres wskazany w sprawie. Mocne wiązania między profilami (4): +15. Połączono profile forum-kulinarne.lab.test i forum-muzyczne.lab.test: ten sam adres kryptowalutowy publikowany przez oba profile jako własny, niepublikowany przez wiele innych osób (waga 80); ta sama nazwa wyświetlana (możliwa zbieżność nazwisk) (waga 15).”
3. **WSTRZYMANIE** — `lab146852904fbc14102d209c3f9f564f344a54deaf9` (wspólny adres pośrednika (zbiórka); Portfel pośrednika LAB). Wynik: brak kandydata. Adres w teczce: wynik 0, powszechnie cytowany, śladów 0, niepowiązanych publikujących 20, klasa unknown („Portfel pośrednika LAB”); reguły: —. Uzasadnienie w teczce: „[widely_cited] Adres lab1468529…a54deaf9 wymienia 20 niepowiązanych autorów — na podstawie publikacji nie da się wskazać właściciela. [no_cash_out] 1 adres powiązany ma łącznie 0 pobranych przelewów, ale żaden wypływ nie trafił do adresu oznaczonego jako giełda, serwis wymiany, bramka płatnicza lub karta — dlatego nie ma dowodu spieniężenia.” Powód według pomiaru: adres powszechnie cytowany (≥ 10 niepowiązanych autorów).

## Piaskownica (BTC / ETH / TRON)

### Wynik według rodzaju adresu (tryb standardowy)

| Rodzaj adresu (wzorzec) | Adresów | Trafienie | Częściowe | Błąd | Wstrzymanie |
|---|---|---|---|---|---|
| giełda / usługa / kontrakt | 10 | 0 | 0 | 0 | 10 |
| prywatny, właściciel sam go opublikował | 38 | 36 | 0 | 0 | 2 |
| bez właściciela we wzorcu i bez publikacji (kontrahent anonimowy, adres pośredni) | 16 | 0 | 0 | 0 | 16 |
| cytowany przez wielu autorów | 1 | 1 | 0 | 0 | 0 |
| **Razem** | 65 | 37 | 0 | 0 | 28 |

- **Precision przypisania:** 100,0% (trafienia: 37, błędy: 0; częściowe: 0).
- **Pokrycie:** 94,7% — 36 z 38 adresów, które prywatny właściciel sam opublikował; licząc też częściowe: 94,7%.
- **Adresy, które nie powinny wskazywać osoby** (giełda / usługa / kontrakt; cytowany przez wielu autorów; bez właściciela we wzorcu i bez publikacji (kontrahent anonimowy, adres pośredni)): poprawne wstrzymanie 26 z 27 (96,3%); wskazany właściciel konta, które podało adres jako swój (np. konto rozdania) 1; wskazana niewłaściwa osoba 0.

### Dlaczego narzędzie wstrzymało się ze wskazaniem osoby

| Powód (z teczki) | Adresów | W tym rodzaje adresu wg wzorca |
|---|---|---|
| brak publikacji adresu w źródłach | 16 | bez właściciela we wzorcu i bez publikacji (kontrahent anonimowy, adres pośredni): 16 |
| adres wykluczony: exclusion.address_class, klasa institutional | 4 | giełda / usługa / kontrakt: 4 |
| adres wykluczony: exclusion.address_class, klasa exchange | 3 | giełda / usługa / kontrakt: 3 |
| adres wykluczony: exclusion.address_class, klasa smart_contract | 3 | giełda / usługa / kontrakt: 3 |
| adres tylko we wpisach liczonych jako wzmianka (kategoria źródła spoza OWNERSHIP_CATEGORIES, bez modelu językowego) — autor nie jest kandydatem na właściciela | 2 | prywatny, właściciel sam go opublikował: 2 |

Rodzaje wyjaśnień w teczkach bez kandydata (`dossier.explanations[].kind`, jedna teczka może mieć kilka): `no_cash_out` 15, `no_addresses` 10.

### Czy prawdopodobieństwo kandydata oddziela trafienia od błędów

| Wynik | Prawdopodobieństwo kandydata głównego |
|---|---|
| Trafienia | 37 szt.; min 60, mediana 60, maks 65 |
| Częściowe | — |
| Błędy | — |

| Przedział prawdopodobieństwa | Trafienia | Częściowe | Błędy |
|---|---|---|---|
| 0–39 | 0 | 0 | 0 |
| 40–59 | 0 | 0 | 0 |
| 60–79 | 37 | 0 | 0 |
| 80–100 | 0 | 0 | 0 |

Liczymy tylko kandydatów z prawdopodobieństwem ≥ progu (pozostali = wstrzymanie):

| Próg | Trafienia | Częściowe | Błędy | Precision | Pokrycie |
|---|---|---|---|---|---|
| ≥ 40 | 37 | 0 | 0 | 100,0% | 94,7% |
| ≥ 60 | 37 | 0 | 0 | 100,0% | 94,7% |
| ≥ 80 | 0 | 0 | 0 | — | 0,0% |

Błędów nie było, więc ten zbiór **nie pozwala sprawdzić**, czy prawdopodobieństwo kandydata odsiewa błędne wskazania — tabela pokazuje tylko, ile trafień traci się przy wyższym progu. Najwyższe prawdopodobieństwo kandydata w analizie samego adresu: 65. Podstawa prawdopodobieństwa osoby (pierwsza przesłanka kandydata): 60 — 37×; resztę daje premia za mocne wiązania między profilami tej osoby (w uzasadnieniu: „Mocne wiązania między profilami (n): +x”). Próg 80 odcina więc każde wskazanie: sam adres na profilu nie daje osobie wysokiej pewności, dopóki analityk jej nie potwierdzi.

### Pułapki piaskownicy — adres po adresie

| Adres (nazwa w danych) | Wzorzec | Wynik | Kandydat główny (prawdopodobieństwo) | Adres w teczce |
|---|---|---|---|---|
| `bc1qxhvk…6kl0ze` (kacperBtc) | prywatny, właściciel sam go opublikował — Kacper Wrzosek (programista, Bydgoszcz) | trafienie | gitpub:kwrzosek_dev, targ:kwrzosek_dev (65) | wynik 100; reguły: base.own_profile → synergy.second_source |
| `16YxN8Wj…r3hCfy` (namesakeBtc) | prywatny, właściciel sam go opublikował — Kacper Wrzosek (wędkarz, Olsztyn — imiennik) | trafienie | spolecznosc:wrzosek_ryby (60) | wynik 85; reguły: base.own_profile |
| `34PsxzNK…pB6z7A` (exchangeBtc) | giełda / usługa / kontrakt | wstrzymanie | — | wynik 0, wykluczony; reguły: exclusion.address_class |
| `0x1e6702…c76042` (stableEth) | giełda / usługa / kontrakt | wstrzymanie | — | wynik 0, wykluczony; reguły: exclusion.address_class |
| `TGVGqNUk…cVtUJj` (giveawayTron) | cytowany przez wielu autorów — konto „MEGA Rozdanie Krypto” (oszustwo) | trafienie | spolecznosc:mega_rozdanie_krypto (60) | wynik 55; reguły: base.own_profile → penalty.shared_address |
| `12BoumHb…ZQvxWo` (dominikOldBtc) | prywatny, właściciel sam go opublikował — Dominik Sroka | trafienie | www:dsroka (60) | wynik 85; reguły: base.own_profile |
| `TETb8rmo…2oTsv6` (martaLabsTron) | prywatny, właściciel sam go opublikował — Marta Zielonka | trafienie | gitpub:zielonka-labs (60) | wynik 85; reguły: base.own_profile |
| `TRASZbW4…Lq632v` (hubertTron) | prywatny, właściciel sam go opublikował — Hubert Jagła | trafienie | forum:hubi_serwis, komunikator:hubi_serwis (65) | wynik 80; reguły: base.settlement_message → synergy.second_source |
| `bc1q43zh…wk2g98` (kowalBtc) | prywatny, właściciel sam go opublikował — Rafał Kowalski / Julia Kowalska (jedna osoba) | trafienie | gitpub:rkowalski_btc, targ:rkowalski_btc (65) | wynik 100; reguły: base.own_profile → synergy.second_source |
| `0xDA63b3…3B08a4` (nowakEth) | prywatny, właściciel sam go opublikował — Tomasz Nowak | trafienie | targ:t_nowak_foto (60) | wynik 70; reguły: base.sale_offer |
| `0xEdE699…c8A8aD` (depositEth) | bez właściciela we wzorcu i bez publikacji (kontrahent anonimowy, adres pośredni) | wstrzymanie | — | wynik 0; reguły: — |
| `3JWr9ULj…Eg5kTy` (midBtc) | bez właściciela we wzorcu i bez publikacji (kontrahent anonimowy, adres pośredni) | wstrzymanie | — | wynik 0; reguły: — |
| `TYgA25gW…hXDmwB` (lenaTron) | prywatny, właściciel sam go opublikował — Lena Kurek | trafienie | targ:lena_kurek (60) | wynik 70; reguły: base.sale_offer |
| `TAvHgdm1…rfRUMb` (kolekcjeTron) | prywatny, właściciel sam go opublikował — Lena Kurek | trafienie | spolecznosc:kurek_kolekcje (60) | wynik 85; reguły: base.own_profile |
| `1AD4pc1b…L3fUca` (marekBtc) | prywatny, właściciel sam go opublikował — Marek Sikora (marek88 na Targu) | trafienie | targ:marek88 (60) | wynik 70; reguły: base.sale_offer |
| `TB9EFt6m…2BfwwB` (marekTron) | prywatny, właściciel sam go opublikował — Marek Wrona (marek88 na Forum) | wstrzymanie | — | wynik 0; reguły: — |
| `1HMMp2ZD…ve4d62` (wilczekBtc) | prywatny, właściciel sam go opublikował — Adam Wilczek (wilczek_x9 na Targu) | trafienie | targ:wilczek_x9 (60) | wynik 70; reguły: base.sale_offer |
| `TBnxxbu5…RMYjXu` (wilczynskaTron) | prywatny, właściciel sam go opublikował — Beata Wilczyńska (wilczek_x9 na Forum) | wstrzymanie | — | wynik 0; reguły: — |
| `bc1qyyrk…wzvfce` (szpakBtc) | prywatny, właściciel sam go opublikował — Norbert Szpak | trafienie | gitpub:szpak_nody (60) | wynik 95; reguły: base.cryptographic_proof |
| `bc1q78n2…kjtpac` (baronBtc) | prywatny, właściciel sam go opublikował — Borys Kania (fałszywy „dowód”) | trafienie | spolecznosc:krypto_baron (60) | wynik 85; reguły: base.own_profile |
| `TTfeafNd…UTeKtx` (jaskulaTron) | prywatny, właściciel sam go opublikował — Filip Jaskuła | trafienie | targ:fjaskula_usdt, forum:fjaskula_usdt, komunikator:fjaskula_usdt (60) | wynik 70; reguły: base.sale_offer → independence.copies_merged |

### Tryb głęboki

W pomiarze nie ma łączników internetowych, więc tryb głęboki różni się wyłącznie limitami rozszerzania (więcej kroków i zapytań; łącznik `deep-search` istnieje tylko przy źródłach publicznych).

| Tryb | Trafienie | Częściowe | Błąd | Wstrzymanie | Precision | Pokrycie | Mediana / P95 czasu |
|---|---|---|---|---|---|---|---|
| standardowy | 37 | 0 | 0 | 28 | 100,0% | 94,7% | 0,07 s / 0,24 s |
| głęboki | 37 | 0 | 0 | 28 | 100,0% | 94,7% | 0,06 s / 0,21 s |

Żaden adres nie zmienił klasyfikacji między trybami.

### Czas analizy

Tryb standardowy: mediana 0,07 s, P95 0,24 s, maks. 0,41 s (założenie sprawy + cała analiza; serwer zbioru działa na tej samej maszynie, więc bez opóźnień sieci). Analizy nieukończone lub częściowe: 0; z błędem łącznika lub dostawcy w dzienniku: 0.

### Przykłady

1. **TRAFIENIE** — `TTfeafNdtjeCTKcVo6SkGEaXwx3mUTeKtx` (`jaskulaTron`) (prywatny, właściciel sam go opublikował; właściciel we wzorcu: Filip Jaskuła). Wynik: kandydat główny (prawdopodobieństwo 60): Filip Jaskuła — konta targ:fjaskula_usdt, forum:fjaskula_usdt, komunikator:fjaskula_usdt. Adres w teczce: wynik 70, śladów 3, niepowiązanych publikujących 0, klasa private; reguły: base.sale_offer → independence.copies_merged. Uzasadnienie w teczce: „Podstawa 60: profil targ.sandbox („fjaskula_usdt”) — autor sam publikuje adres wskazany w sprawie. Połączono profile targ.sandbox i forum.sandbox: ten sam adres w skopiowanej publikacji / wzmiance — nie dowodzi wspólnego operatora (waga 30); ten sam nick (sam w sobie nie dowodzi tej samej osoby) (waga 20). Połączono profile targ.sandbox i komunikator.sandbox: ten sam adres w skopiowanej publikacji / wzmiance — nie dowodzi wspólnego operatora (waga 30); ten sam nick (sam w sobie nie dowodzi tej samej osoby) (waga 20).”
2. **TRAFIENIE** — `bc1qxhvk23usdd66dddy8lvafvv47v5aa9jz6kl0ze` (`kacperBtc`) (prywatny, właściciel sam go opublikował; właściciel we wzorcu: Kacper Wrzosek (programista, Bydgoszcz)). Wynik: kandydat główny (prawdopodobieństwo 65): Kacper Wrzosek (programista, Bydgoszcz) — konta gitpub:kwrzosek_dev, targ:kwrzosek_dev. Adres w teczce: wynik 100, śladów 2, niepowiązanych publikujących 0, klasa private; reguły: base.own_profile → synergy.second_source. Uzasadnienie w teczce: „Podstawa 60: profil gitpub.sandbox („kwrzosek_dev”) — autor sam publikuje adres wskazany w sprawie. Mocne wiązania między profilami (1): +5. Połączono profile gitpub.sandbox i targ.sandbox: ten sam adres kryptowalutowy publikowany przez oba profile jako własny, niepublikowany przez wiele innych osób (waga 80); ten sam rzadki nick i zgodna lokalizacja (waga 50).”
3. **TRAFIENIE** — `TGVGqNUk2kpU5kwNqaK3pdsh5ZDecVtUJj` (`giveawayTron`) (cytowany przez wielu autorów; właściciel we wzorcu: konto „MEGA Rozdanie Krypto” (oszustwo); 8 autorów). Wynik: kandydat główny (prawdopodobieństwo 60): konto „MEGA Rozdanie Krypto” (oszustwo) — konta spolecznosc:mega_rozdanie_krypto. Adres w teczce: wynik 55, śladów 1, niepowiązanych publikujących 7, klasa private; reguły: base.own_profile → penalty.shared_address. Uzasadnienie w teczce: „Podstawa 60: profil spolecznosc.sandbox („mega_rozdanie_krypto”) — autor sam publikuje adres wskazany w sprawie. Imię i nazwisko: nie ustalono — profile nie ujawniają nazwy wyświetlanej.”
4. **WSTRZYMANIE** — `0xeDCABEaF7845fb6f8d42D634acF7faea4449b5bf` (`exchangeEth`) (giełda / usługa / kontrakt; Giełda Bursztyn: Hot Wallet). Wynik: brak kandydata. Adres w teczce: wynik 0 (wykluczony), śladów 0, niepowiązanych publikujących 0, klasa exchange („Giełda Bursztyn: Hot Wallet”); reguły: exclusion.address_class. Uzasadnienie w teczce: „[no_addresses] Przeszukano 8 źródeł; 1 znaleziony adres należy do pośredników (giełdy, kontrakty) albo został odrzucony — żaden nie jest adresem podmiotu.” Powód według pomiaru: adres wykluczony: exclusion.address_class, klasa exchange.
5. **WSTRZYMANIE** — `TB9EFt6mvRQKihfPRiSQNCkBedqh2BfwwB` (`marekTron`) (prywatny, właściciel sam go opublikował; właściciel we wzorcu: Marek Wrona (marek88 na Forum)). Wynik: brak kandydata. Adres w teczce: wynik 0, śladów 0, niepowiązanych publikujących 1, klasa private; reguły: —. Teczka nie podaje żadnego wyjaśnienia (`explanations` puste). Powód według pomiaru: adres tylko we wpisach liczonych jako wzmianka (kategoria źródła spoza OWNERSHIP_CATEGORIES, bez modelu językowego) — autor nie jest kandydatem na właściciela.
6. **WSTRZYMANIE** — `TBnxxbu53MBoD2kFqEE42RtYCjsbRMYjXu` (`wilczynskaTron`) (prywatny, właściciel sam go opublikował; właściciel we wzorcu: Beata Wilczyńska (wilczek_x9 na Forum)). Wynik: brak kandydata. Adres w teczce: wynik 0, śladów 0, niepowiązanych publikujących 1, klasa private; reguły: —. Teczka nie podaje żadnego wyjaśnienia (`explanations` puste). Powód według pomiaru: adres tylko we wpisach liczonych jako wzmianka (kategoria źródła spoza OWNERSHIP_CATEGORIES, bez modelu językowego) — autor nie jest kandydatem na właściciela.

## Kierunek odwrotny: od nicku właściciela do adresu

Ten sam przebieg: przed analizami uruchomiono analizę „sam nick” dla każdego konta, które publicznie podaje jakikolwiek adres (wybór z danych publicznych). Po odsłonięciu wzorca wybrano pary (właściciel, jego opublikowany adres) i pierwsze konto właściciela publikujące ten adres jako punkt startowy. Adres uznajemy za znaleziony i przypisany, gdy jest w teczce z Wskaźnikiem Pewności ≥ progu (adres niewykluczony, co najmniej jeden ślad).

| Zbiór | Pary (właściciel, adres) ze startem | Adres w teczce | Przypisany ≥ 40 | Przypisany ≥ 60 | Przypisany ≥ 80 | Osoba główna = tylko właściciel | Cudze adresy przypisane ≥ 60 |
|---|---|---|---|---|---|---|---|
| Laboratorium tożsamości (sieć LAB) | 29 z 29 | 29 (100,0%) | 29 (100,0%) | 28 (96,6%) | 20 (69,0%) | 29 (100,0%) | 0 |
| Piaskownica (BTC / ETH / TRON) | 38 z 38 | 36 (94,7%) | 35 (92,1%) | 34 (89,5%) | 9 (23,7%) | 36 (94,7%) | 0 |

Dla porównania pełniejszy pomiar tego kierunku w laboratorium (start: nick + e-mail, także konta bez własnego adresu) jest w [BENCHMARK-LAB.md](BENCHMARK-LAB.md), sekcja „(b) Przypisanie adresów do osoby”.

## Czego ten pomiar nie mówi

- **Dane są syntetyczne i małe.** Oba zbiory wygenerowano tak, żeby zawierały przewidziane pułapki (imiennik, ten sam nick u dwóch osób, adres giełdy wklejony na forum, rozdanie, zbiórka pośrednika, fałszywy podpis). Wysoka precision znaczy tylko, że te pułapki nie zmyliły reguł; nie dowodzi skuteczności w prawdziwym internecie. Liczności są małe (kilkadziesiąt adresów na zbiór) — jeden przypadek przesuwa wynik o kilka punktów procentowych.
- **W prawdziwym świecie adres zwykle NIE jest nigdzie opublikowany.** W obu zbiorach większość adresów prywatnych ktoś podał publicznie — inaczej nie byłoby czego mierzyć. W rzeczywistości ogromna większość adresów nie ma żadnej publikacji i odpowiedzią narzędzia jest wtedy „brak kandydata”: pokrycie z tego pomiaru nie przenosi się na losowy adres z łańcucha.
- **Brak opóźnień i limitów.** Serwery zbiorów działają lokalnie; czasy nie zawierają opóźnień sieci ani limitów zapytań prawdziwych serwisów (w ustawieniach: do 20 s na zapytanie, 120 s na analizę).
- **Dwa kierunki błędu nie są symetryczne.** Dla zespołu dochodzeniowego błędne wskazanie osoby jest kosztowniejsze niż brak wskazania; dlatego najważniejsza liczba to „błąd”, a nie pokrycie.
- **Kontrole na prawdziwych danych (ręczne, poza tym pomiarem, 21.11.2026, tryb LIVE):**
  - adres z kradzieży Bitfinex 2016 `1CGA4srJbPWhtJb7ezgY6GQf4PKhFuzD9w` → teczka bez kandydata na osobę; wykryte przekazanie środków na adres rządu USA (zajęcie środków);
  - adres oszustwa z przejęcia kont Twittera 2020 `bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh` → adres powszechnie cytowany (60 niepowiązanych autorów), teczka bez kandydata;
  - nazwa ENS `vitalik.eth` (start od nazwy, nie od adresu) → osoba wskazana i adres potwierdzony zapisem ENS.
  To trzy pojedyncze próby, nie statystyka — pokazują tylko, że mechanizmy wstrzymania (zajęcie, powszechne cytowanie) i potwierdzenia (ENS) działają także na prawdziwych danych.
- **Jeden przebieg, jeden seed laboratorium, stan piaskownicy z chwili pomiaru** (m.in. faza scenariusza podmiany adresu na `/_demo`; skrypt jej nie zmienia).

