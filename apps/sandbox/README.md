# Piaskownica OŁCyŚ

Syntetyczne środowisko demonstracyjne: fikcyjny „internet" (sześć serwisów i archiwum) oraz fikcyjny eksplorator bloków. Wszystkie osoby, konta, firmy i adresy są zmyślone. Adresy mają poprawne sumy kontrolne, ale powstały z losowych danych i nie należą do nikogo.

```
node src/server.ts        # http://localhost:4100 (SANDBOX_PORT, SANDBOX_HOST)
```

Dane są w `data/scenario.ts` (scenariusze a–h) i `data/market.ts` („rynek P2P": kilkanaście osób handlujących na Targu); serwer (`src/app.ts`, funkcja `buildApp()`) tylko je renderuje. Trzecia część, `data/related.ts`, zawiera przypadki „powiązanych tożsamości". Łącznie w piaskownicy występują 32 fikcyjne osoby, nie licząc kont tła.

## Serwisy

| Ścieżka | Co udaje | Kategoria śladu |
|---|---|---|
| `/gitpub` | profile programistów (bio, README, „Wesprzyj mnie") | `own_profile` |
| `/www/<osoba>` | osobiste strony WWW | `own_profile` |
| `/targ` | ogłoszenia i oferty P2P | `sale_offer` |
| `/forum` | forum branżowe (`/watek/…`) i lista dyskusyjna ze stopkami (`/lista/…`) | `forum_post`, `settlement_message` |
| `/spolecznosc` | profile, wpisy, komentarze pod rozdaniami | `own_profile`, `mass_comment` |
| `/komunikator` | publiczne kanały grupowe | `settlement_message` |
| `/archiwum` | archiwalne kopie stron z datami | jak oryginał |
| `/explorer` | eksplorator bloków „BlokSkan" (Bitcoin, Ethereum, Tron) | — |

Każdy serwis ma wyszukiwarkę `GET /<serwis>/api/search?q=<fraza>` zwracającą `[{ url, title, author, publishedAt, snippet, kind, matchedBy }]` (archiwum dodatkowo `archivedAt`, `originalService`, `originalUrl`). Wyszukiwarka dopasowuje wyłącznie publiczne dane autora — login/nick, e-mail, imię i nazwisko — albo adres kryptowalutowy w treści; pole `matchedBy` (`handle`, `email`, `name`, `address`) mówi, po czym trafiła. Posty, komentarze i wiadomości mają własne adresy URL, więc dokument zawiera treść jednego autora.

Każde trafienie ma też pole `profile` z publicznymi danymi konta autora: `{ handle, displayName?, emails?, phones?, location?, createdAt? }`.

Lista najnowszych publikacji: `GET /<serwis>/api/recent?limit=<1–100>` (domyślnie 20) zwraca w tym samym kształcie (bez `matchedBy`) ogłoszenia, posty, wiadomości z listy, komentarze, wiadomości kanałów, profile i strony, od najświeższych. Lista obejmuje także profile i strony osobiste (z danymi kontaktowymi autora), więc jeden przebieg monitoringu po wszystkich serwisach zasila indeks publikacji telefonami, e-mailami i adresami.

Eksplorator: `GET /explorer/api/address/:address` zgodnie z kontraktem z `docs/ARCHITEKTURA.md` (nieznany adres → 404), strona `GET /explorer/address/:address`. Ponad kontrakt: adres usługi ma pole `kind` (`p2p_service`, `payment_gateway`, `crypto_card`, `stablecoin_swap`), a przelew do lub od opisanego kontrahenta — pola `counterpartyLabel`, `counterpartyClass`, `counterpartyKind`. Każdy adres występujący w przelewach odpowiada kodem 200.

Archiwum: kopia ma adres wzorem Wayback Machine, `/archiwum/web/<RRRRMMDDGGMMSS>/<pełny URL oryginału>`.

## Scenariusze testowe

Wyniki podano dla domyślnych reguł Wskaźnika Pewności.

| Osoba | Identyfikatory do wpisania | Oczekiwany wynik |
|---|---|---|
| **Kacper Wrzosek** — programista, sprzedaje koparkę | login `kwrzosek_dev` (opcjonalnie e-mail `kacper.wrzosek@poczta.example`) | `bc1qxhvk…kl0ze`: własny profil GitPub (85) + ogłoszenie na Targu → synergia +15 = **100%**. `0x5214…e86a`: tylko profil = **85%**. W eksploratorze: wpłaty na „Giełda Bursztyn: Hot Wallet" w latach 2024, 2025 i 2026, „KantorKrypto P2P", zamiana ETH→USDT przez „WymianaSwap: Router (zamiana na stablecoiny)", „PlatnosciPay Gateway", „KartaCoin". |
| **Bartłomiej Kruk** — wkleja na forum cudze adresy | nick `bkruk_trader` | `34Psxz…6z7A` (gorący portfel giełdy) i `0x1e67…6042` (kontrakt stablecoina): **wykluczone, 0%** — odnotowany tylko fakt publikacji. |
| **Kacper Wrzosek (imiennik)** — wędkarz z Olsztyna | imię i nazwisko `Kacper Wrzosek` | Trafienia `name_only` z dwóch różnych osób: adresy programisty i adres wędkarza `16YxN8…hCfy` po **65%** (85 − 20) ze wskazówką, by potwierdzić tożsamość. Po wpisaniu samego loginu `kwrzosek_dev` adres wędkarza nie pojawia się wcale. |
| **Oliwia Stępniak** — komentuje „rozdanie" | nick `oli_stepniak` | `TGVGqN…tUJj`: masowy komentarz (25), a ten sam adres publikuje 7 innych kont (`/spolecznosc/api/search?q=<adres>`) → kara za adres współdzielony = **0%**. |
| **Dominik Sroka** — podmienił adres na stronie | nick `dsroka` (lub e-mail `dominik@sroka-foto.example`) | Na żywo nowy adres `bc1qartt…t4hp` (**85%**; kopia z 2025-09-20 to ten sam serwis, bez synergii). Stary adres `12Boum…vxWo` tylko w kopiach archiwalnych z 2024-05-12 i 2025-03-02. Porównanie analiz: patrz niżej. |
| **Marta Zielonka** — łańcuch tożsamości | e-mail `m.zielonka@skrzynka.example` | Runda 1: profil w Społeczności bez adresu, odkryte identyfikatory: nick `marta.zielonka`, nick `zielonka_codes`. Runda 2: GitPub `zielonka_codes` z adresem `0x3fb2…9D84` (własny profil odnaleziony pośrednio, 85 − 5 = **80%**) oraz wskazane przez niego konto `zielonka-labs` z adresem `TETb8r…Tsv6` (`linked_profile`, **80%**). |
| **Hubert Jagła** — serwis GSM | identyfikator komunikatora `@hubi_serwis` | `TRASZb…632v` w dwóch wiadomościach kanału Komunikatora (65) i w stopce e-maila na liście dyskusyjnej Forum → synergia = **80%**. Żadnego profilu z adresem. |
| **Zofia Mielcarz** — brak kryptowalut | nick `zosia_mielcarz`, e-mail `zofia.mielcarz@listy.example` lub imię i nazwisko | Znalezione dokumenty (profil, wpis, post, ogłoszenie), **zero adresów** — wynik pusty. |

### Rynek P2P — typowanie i powiązania

Część `data/market.ts` nie zmienia wyników scenariuszy a–h. Każda osoba ma na Targu ogłoszenie z adresem do wpłaty i telefonem; skala wypłat do walut tradycyjnych (giełda, kantor P2P, bramka, karta, zamiana na stablecoiny) jest celowo różna.

| Nick na Targu | Osoba | Sieć | Wypłaty do walut tradycyjnych |
|---|---|---|---|
| `tomasz_lis_p2p` | Tomasz Lis, Katowice | Tron (USDT) | bardzo duże: 35 000 USDT w 2024 i 39 000 USDT w 2025 |
| `igor_baran` | Igor Baran, Lublin | Bitcoin | duże: 2,1 BTC w 2024, 4,3 BTC w 2025, 1,0 BTC w 2026 |
| `wiktor_noga` | Wiktor Noga, Płock | Ethereum | duże, tylko 2025: zamiana 10 ETH na USDT, 20 000 USDT na giełdę, 6 000 USDT na kartę, 1,5 ETH przez bramkę |
| `nat_wilk` | Natalia Wilk, Kraków | Tron (USDT) | średnie, 2025: 6 800 USDT |
| `ewelina_bak` | Ewelina Bąk, Szczecin | Ethereum | średnie: 2025 (zamiana 2 ETH, 5 000 USDT na giełdę) i 2026 (0,5 ETH) |
| `r_dudek` | Robert Dudek, Kielce | Ethereum | średnie: 0,6 ETH w 2025, 0,4 ETH w 2026 |
| `darek_mroz` | Dariusz Mróz, Gdańsk | Bitcoin | średnie: 0,35 BTC w 2025, 0,15 BTC w 2026 |
| `j_pietrzak` | Jan Pietrzak, Radom | Bitcoin | tylko 2024: 0,4 BTC |
| `marcel_zych` | Marcel Zych, Wałbrzych | Bitcoin | małe: 0,25 BTC w 2025, 0,1 BTC w 2026 |
| `lena_kurek` | Lena Kurek, Elbląg | Tron (USDT) | małe: 1 500 USDT w 2025 (drugi adres: 800 USDT w 2026) |
| `kinga_sowa` | Kinga Sowa, Opole | Tron (USDT) | małe: 900 USDT w 2025 |
| `p_gajda` | Paweł Gajda, Rzeszów | Ethereum | małe: 0,2 ETH w 2026 |
| `monika_rak` | Monika Rak, Zielona Góra | Tron (USDT) | jednorazowo 250 USDT w 2026 |
| `marek88` | Marek Sikora, Poznań | Bitcoin | małe: 0,2 BTC w 2026 |
| `sylwia_kot` | Sylwia Kot, Łódź | Bitcoin | zero — same wpływy |
| `olek_czyz` | Aleksander Czyż, Białystok | Bitcoin | zero — adres bez żadnej transakcji |

Powiązania do pokazania:

- **Pary handlujące ze sobą** (adres jednej osoby jest kontrahentem w przelewach drugiej i jest opublikowany na profilu tej pierwszej): Igor Baran ↔ Dariusz Mróz (profil `/spolecznosc/u/darek_mroz`), Natalia Wilk ↔ Kinga Sowa (profil `/spolecznosc/u/kinga.sowa`), Paweł Gajda ↔ Robert Dudek (profil `/gitpub/rdudek3d`).
- **Wspólny telefon na dwóch profilach**: `lena_kurek` na Targu i `kurek_kolekcje` w Społeczności (tel. 500 000 825) — dwa różne adresy Tron, między którymi jest przelew.
- **Wspólny e-mail na dwóch profilach**: `marcel_zych` na Targu i `mz_mineraly` na Forum (`marcel@zych-mineraly.example`) — ten sam adres BTC w dwóch niezależnych źródłach.
- **Wspólny pośrednik bez etykiety**: Jan Pietrzak wysyła 0,2 BTC na adres `3JWr9U…5kTy`, z którego następnego dnia ta sama kwota trafia do Sylwii Kot. Adres pośrednika nie ma etykiety ani klasy.
- **Dwa niezależne źródła**: Igor Baran publikuje ten sam adres na Targu i na profilu w Społeczności (ze wskazaniem `rel="me"` na ogłoszenie).
- Publikacje z adresami poza Targiem: wątek `/forum/watek/3`, wpisy `/spolecznosc/wpis/304` i `/305`, kanał `/komunikator/kanal/p2p-slask`.

### Rozdzielanie i łączenie osób po atrybutach profilu

- **Spójne dane jednej osoby**: Kacper Wrzosek — GitPub i Targ podają tę samą miejscowość (Bydgoszcz), a telefon z ogłoszenia jest na koncie Targu; Igor Baran — Targ i Społeczność mają ten sam e-mail, telefon i miejscowość (Lublin).
- **Imiennik**: drugi Kacper Wrzosek (`wrzosek_ryby`) ma to samo imię i nazwisko, ale miejscowość Olsztyn i e-mail `wrzosek.ryby@jeziora.example`.
- **Pospolity nick**: `marek88` na Targu to Marek Sikora z Poznania (BTC, `marek.sikora@skup.example`), a `marek88` na Forum — Marek Wrona z Suwałk (USDT, `m.wrona@suwalki-net.example`). Inne nazwisko, e-mail, miejscowość i adres; w eksploratorze nic ich nie łączy.

### Powiązane tożsamości

Dane w `data/related.ts`. Wyniki scenariuszy a–h i części rynkowej pozostają bez zmian (parze Igor ↔ Dariusz doszły tylko przelewy między ich adresami).

| Przypadek | Identyfikator do wpisania | Oczekiwana powiązana tożsamość | Ścieżka dojścia |
|---|---|---|---|
| Ta sama osoba pod innym nazwiskiem | login `rkowalski_btc` (Rafał Kowalski) | Julia Kowalska, `julka_k` | Adres `bc1q43zh…2g98` jest na profilu GitPub i w ogłoszeniu `/targ/oferta/2101` Rafała; ten sam adres jako własny publikują profil `/spolecznosc/u/julka_k` i ogłoszenie `/targ/oferta/2102`. Ta sama miejscowość (Toruń). Z adresu: wypłaty na „Giełda Bursztyn" w 2024 i 2025 r. |
| To samo w drugą stronę | nick `julka_k` | Rafał Kowalski, `rkowalski_btc` | jak wyżej — wyszukiwanie adresu zwraca dwóch autorów, obaj z kategorią własnego profilu / ogłoszenia |
| Wspólny indywidualny adres wpłat giełdy | nick `t_nowak_foto` (Tomasz Nowak) | Ewa Wiśniewska, `ewa_wisniewska` | Adres Tomasza `0xDA63…08a4` (ogłoszenie `/targ/oferta/2103`) i adres Ewy `0x5E03…90Db` (profil w Społeczności, ogłoszenie `2104`) wysyłają środki na ten sam adres pośredni `0xEdE6…A8aD` — bez etykiety, 6 transakcji — który po 22–36 minutach przekazuje całość na „Giełda Bursztyn: Hot Wallet". Widać to w historii wszystkich trzech adresów w eksploratorze. |
| Wspólny telefon, różne nazwiska | nick `auto_czesci_wwa` (Piotr Zając) | Anna Maj, `ania_handmade` | oba ogłoszenia (`/targ/oferta/2105`, `2106`) podają tel. 500 000 840; różne adresy Tron (`TRCwAH…A4Q5`, `TNS8s3…fx8k`) |
| Wspólny e-mail, różne nazwiska | nick `ania_handmade` (Anna Maj) | Karolina Lis, `maj_studio` | ogłoszenia `2106` i `2107` podają e-mail `pracownia@maj-studio.example`; inny telefon i inny adres (`14rGHX…SEP8`) |
| Łańcuch telefon → e-mail | nick `auto_czesci_wwa` | Anna Maj (telefon), dalej Karolina Lis (e-mail) | dwa kroki: wspólny telefon, potem wspólny e-mail |
| Przelewy w obie strony | nick `igor_baran` | Dariusz Mróz, `darek_mroz` | między adresami `bc1qw87m…0jcj` i `bc1qq5xk…q8v9`: 4 przelewy od Igora i 3 od Dariusza w latach 2024–2026; adres Dariusza jest na jego profilu w Społeczności. Pojedyncze przelewy w obie strony mają też pary Natalia Wilk ↔ Kinga Sowa i Paweł Gajda ↔ Robert Dudek. |

Wyszukiwanie po telefonie i e-mailu opiera się na indeksie publikacji: `GET /<serwis>/api/recent` (metoda `discover` łączników piaskownicy) zwraca wszystkie powyższe ogłoszenia i profile z polami `profile.phones` / `profile.emails`.

### Dowody i ich podróbki

Dane w `data/proofs.ts`; wyniki wcześniejszych części pozostają bez zmian (na Targu doszły dwa ogłoszenia). Podpisy sprawdza lokalnie `verifySignedMessage` z `@olcys/core` (Bitcoin: BIP-137, Ethereum: EIP-191) — bez żadnej usługi zewnętrznej. Adresy Norberta Szpaka pochodzą z klucza wylosowanego przez `scripts/generate-signed-proofs.ts`; klucz istniał tylko w pamięci skryptu, w repozytorium są wyłącznie adres, wiadomość i podpis.

| Przypadek | Identyfikator do wpisania | Oczekiwany wynik |
|---|---|---|
| i) **Norbert Szpak** — ważna podpisana wiadomość | e-mail `norbert@szpak-nody.example` (albo login `szpak_nody`) | Profil `/gitpub/szpak_nody` zawiera blok `BEGIN BITCOIN SIGNED MESSAGE` dla `bc1qyyrk…zvfce` i JSON w stylu Etherscan dla `0x812B…38c7`; obie wiadomości wymieniają konto `szpak_nody`. Narzędzie dodaje dokument `…/gitpub/szpak_nody?podpis=<adres>` kategorii `cryptographic_proof` → oba adresy **95%** (reguła `base.cryptographic_proof`). Po samym loginie: 95 − 10 za zgodny tylko nick = **85%**, przy osobie 95%. |
| ii) **Borys Kania** — sfałszowany „dowód" | nick `krypto_baron` | Na profilu `/spolecznosc/u/krypto_baron` wiadomość przerobiona na jego nick i adres `bc1q78n2…tpac`, ale podpis skopiowany od Norberta → podpis nie weryfikuje się. Kategoria bez zmian (`own_profile`, **85%**; po samym nicku 75%), w treści śladu uwaga „UWAGA: podpis nie weryfikuje się dla tego adresu … możliwa podróbka". |
| iii) **Filip Jaskuła** — ta sama oferta w trzech serwisach | nick `fjaskula_usdt` | Identyczny akapit z adresem `TTfeaf…eKtx` w ogłoszeniu `/targ/oferta/3101`, w poście `/forum/watek/31` i w wiadomości kanału `/komunikator/kanal/p2p-podkarpacie` → jedna grupa pochodzenia (`independence.copies_merged`), jedno niezależne źródło: **70%** (po samym nicku 60%) zamiast 90% za trzy serwisy. |
| iv) **Adam Wilczek** i **Beata Wilczyńska** — ten sam nick, dwie osoby | nick `wilczek_x9` | Targ (`/targ/oferta/3102`): Adam Wilczek, Gdynia, `adam@wilczek-rowery.example`, BTC `1HMMp2…4d62`. Forum (`/forum/watek/32`): Beata Wilczyńska, Przemyśl, `beata.w@przemysl-net.example`, USDT `TBnxxb…YjXu`. Inne nazwisko, e-mail, miejscowość, sieć i adres → **dwie osobne osoby** w teczce, bez łączenia; adres drugiej osoby nie zasila wyniku pierwszej (adnotacja „zaliczonego do innego kandydata"). |

Nowe dane wymagają restartu piaskownicy. Podpisy i oczekiwane wyniki sprawdzają testy `packages/sources/test/sandbox.test.ts` (część „dowody i ich podróbki").

### Działalność gospodarcza — wskaźnik D

Dane w `data/business.ts` (osoby i sklepy zmyślone; wcześniejsze części bez zmian). Wskaźnik D pokazuje zakładka „Więcej → Wskaźniki” (karta D), a od 60 pkt także linia w podsumowaniu sprawy. Rejestry na żywo (CEIDG, KRS, wykaz VAT) są w piaskownicy wyłączone — sprawdzany jest tylko lokalny rejestr walut wirtualnych po nicku, więc „brak wpisu” jest tu słabym sygnałem (5 pkt).

| Przypadek | Identyfikator do wpisania | Oczekiwany wynik |
|---|---|---|
| **Bartosz Lipa** — sprzedawca akcesoriów GSM, Kraków | nick `lipa_gsm` | Trzy oferty na Targu (`/targ/oferta/7001`, `7044`, `7102`), cennik na forum, strona sklepu `/www/lipa-gsm` z instrukcją płatności, wpis w Społeczności skopiowany z oferty 7001 tego samego dnia (kopia liczona raz: 6 publikacji → 5 ofert w 4 serwisach). Adres `bc1q8g50…5nyf`: 25 wpłat od 25 adresów w 10 miesiącach 2025, kwoty detaliczne, co miesiąc wpłata na giełdę. **D ≈ 70 — istotne przesłanki**: `business.repeated_offers` 55 + premie za wpłacających i sklep; obrót 2025 ok. 28 tys. zł (kurs przykładowy — wpływy, nie dochód); zdanie w kluczowych ustaleniach, odznaka „sygnały działalności” na węźle podmiotu. |
| **Ewa Sosna** — jednorazowa sprzedaż roweru, Poznań | nick `ewa_sosna` | Jedno ogłoszenie „Sprzedam rower… płatność w BTC” (`/targ/oferta/7210`) i jedna wpłata na `1Esyc…EV1Tr`. **D ≈ 23 — słabe przesłanki**: `business.accepts_crypto_payments` 35 i kontrdowód `business.one_off_sale` −15; brak zdania w kluczowych ustaleniach. |

Ścieżkę „podmiot zarejestrowany” (wykaz VAT, KRS, odpowiedź usługi z wypłatą na rachunek z wykazu) pokazują testy `apps/api/test/business.test.ts` — w piaskownicy rejestry na żywo są wyłączone.

### Wyjście do walut tradycyjnych — wskaźnik C

Dane w `data/fiat.ts` (osoba i „Giełda Wisła” zmyślone; wcześniejsze części bez zmian). Wynik w zakładce „Więcej → Wskaźniki” (karta C: oznaki pogrupowane „W publikacjach” / „W blockchainie”) i w podsumowaniu sprawy (kafelek „Dokąd trafiły pieniądze”: „oznaki wypłaty na PLN”).

| Przypadek | Identyfikator do wpisania | Oczekiwany wynik |
|---|---|---|
| **Teodor Kaliszuk** — sprzedaje USDT za gotówkę, Warszawa | nick `teo_usdt_waw` | Web2: ogłoszenie `/targ/oferta/4101` „Sprzedam USDT za gotówkę, Warszawa, BLIK…” i jego kopia `/forum/watek/41/post/1` (kopia liczona raz), profil `/spolecznosc/u/teo_usdt_waw` („płacę kartą krypto, gotówkę wypłacam w bitomacie”); odpowiedź `obserwator_waw` pod postem się nie liczy. **Ocena z publikacji ≈ 60, `cashout_signal`, hipoteza**: `cashout.web.p2p_offer_pln` 45 + `cash_meeting`, `crypto_card` (BLIK i bitomat jako zależne). Blockchain (`0x3563…a584`): 12 ETH → 27 700 USDT przez „WymianaSwap” (ok. 99,6 tys. zł), cztery wpłaty USDT na „Giełda Wisła” w 02, 04, 06 i 08.2026 (każda ok. 20 lub 30 tys. zł), potem cisza. **Ocena giełdy ≈ 80, `cashout_signal`**: `stablecoin_conversion_large` 65, `repeated_offramp`, `deposit_then_quiet`, `round_amounts_pln`. Żadna ocena nie osiąga „udokumentowanego wyjścia” — to daje dopiero odpowiedź usługi. „Oznaki wypłaty na PLN”: 11 (5 w publikacjach, 6 w blockchainie). |

Nowe dane wymagają restartu piaskownicy.

### Miksery i CoinJoin

Dane w `data/mixers.ts` (osoba i mikser „WirMix” zmyślone; wcześniejsze części bez zmian). Wynik: baner pod kafelkami podsumowania sprawy, odznaka „mikser” na moście „Śledzenie w blockchainie”, blok „Miksery i CoinJoin” w sekcji Pieniądze, węzeł ze spiralą w grafie i sekcja raportu „Miksery i CoinJoin”.

| Przypadek | Identyfikator do wpisania | Oczekiwany wynik |
|---|---|---|
| **Edward Wirski** — środki przez fikcyjny mikser | nick `e_wirski` (albo adres `bc1qwvesxke7vc3zacv89tss38pu0tu58v0zxaxvdj`) | Profil `/gitpub/e_wirski` z adresem BTC. Blockchain: dwa przelewy **do** „WirMix: pula miksera (fikcyjny mikser)” (0,3 i 0,2 BTC, 03.2026), przelew **z** miksera 0,45 BTC (04.2026) i transakcja z czterema wyjściami po 0,05 BTC do różnych adresów (wzorzec CoinJoin / nominał Whirlpool — **hipoteza**). Poziom „potwierdzony” (czerwony baner): „Środki przeszły przez mikser (WirMix, 3 transakcje, ok. 140 tys. zł do miksera) — dalsza droga nieustalona”. Wskaźnik C: składniki `cashout.mixer_obfuscation` i `cashout.mixer_inflow` (waga 0, nie zmieniają wyniku). Kwoty PLN po kursie przykładowym z wpłat na „Giełda Bursztyn”. |

Nowe dane wymagają restartu piaskownicy.

### Obieg środków (ping-pong)

Dane w `data/roundtrip.ts` (osoba i adresy zmyślone; wcześniejsze części bez zmian, bez ogłoszeń). Wynik: w grafie śledczym kliknij adres podmiotu i w panelu bocznym „Obieg środków (ping-pong)” → „Szukaj dalej” (domyślnie do 10 przelewów, budżet 60 adresów, okno 180 dni; do wyboru do 50 przelewów i 200 adresów).

| Przypadek | Identyfikator do wpisania | Oczekiwany wynik |
|---|---|---|
| **Leon Krąg** — środki wracają na adres | nick `l_krag` (albo adres `bc1qqk6pav9ap2q6wmex7yc40cy9hkjv4uqpcg7s2w`) | Profil `/gitpub/l_krag` z adresem BTC. „Szukaj dalej” znajduje **3 obiegi**: (1) „obieg przez adresy pośrednie” — 3 przelewy w 3 dni (02.2026): podmiot → `bc1qvd3p…k0cj` (0,8 BTC) → `1PMujJ…dCrj` (0,79) → podmiot (0,78), stosunek 97,5%; (2) i (3) „bezpośredni ping-pong (powtarzany: 2 razy)” z adresem `17nS1U…bik`: 0,3 → 0,3 BTC (03.2026) i 0,25 → 0,24 BTC (04.2026). Gałąź `12V4Kx…HVSv` → inny adres nie wraca. Pobrane adresy pośrednie: 5. Oba adresy pośrednie dostają odznakę „ping-pong”; „Pokaż na grafie” podświetla ścieżkę obiegu. Każdy krok to fakt (przelew), a to, że krążą te same środki — **hipoteza**. Obieg przez mikser pokazuje też sprawa `e_wirski` (WirMix → podmiot). |

Nowe dane wymagają restartu piaskownicy.

### Ostrzeżenia o możliwym oszustwie (fałszywe rozdanie)

Dane w `data/scam.ts` (konta i adresy zmyślone; wcześniejsze części bez zmian, bez ogłoszeń). Wynik: baner pod kafelkami podsumowania sprawy, odznaka „zgłoszenia oszustwa” przy adresie (karta adresu i węzeł grafu), blok „Ostrzeżenia o możliwym oszustwie” w sekcji Adresy (publikacje z odnośnikami), kluczowe ustalenie i sekcja raportu o tej samej nazwie.

| Przypadek | Identyfikator do wpisania | Oczekiwany wynik |
|---|---|---|
| **Fałszywe rozdanie BTC** — ostrzeżenia poszkodowanych | adres `bc1qqaqykqddpsm50g6thsqju895cjntaedqynh3dw` | Wpis poszkodowanej `gosia_z_lodzi` na własnym profilu (`/spolecznosc/wpis/777`, cytuje reklamę „odeślemy x2”) i komentarz `pan_tadeusz_btc`; wątek `/forum/watek/88` z ostrzeżeniami `ostrozny_inwestor`, `kasia_poszkodowana`, `moderator_bezpieczenstwo` i **kopią** ostrzeżenia (`przeklejacz_ostrzezen` — ta sama treść, liczy się raz). Blockchain: 10 wpłat od 10 różnych nadawców w ok. 30 godzin od pierwszej aktywności (10–11.05.2026), potem wyprowadzenie 95% na `bc1qay5k…ma5w` (wzorzec rozdania — **hipoteza**). Czerwony baner: „Ostrzeżenie: adres mógł być wykorzystywany do oszustwa (zgłoszenia w 5 niezależnych źródłach)”; składniki `scam.warning_publications` 65, `scam.giveaway_text` 25, `scam.giveaway_chain_pattern` 20. **Nikt nie jest kandydatem na osobę** (także autorka wpisu na własnym profilu) — autorzy ostrzeżeń to poszkodowani lub świadkowie; właściciel nieustalony; linia „co można zrobić” (CERT Polska / Policja). |

Nowe dane wymagają restartu piaskownicy.

### Podmiana adresu między analizami

Strona `/_demo` przełącza fazę scenariusza Dominika:

1. `GET /_demo/faza/before` — strona `/www/dsroka` pokazuje stary adres, archiwum nie ma jeszcze kopii z września 2025.
2. Wykonaj analizę dla `dsroka`.
3. `GET /_demo/faza/after` (stan domyślny) — strona pokazuje nowy adres.
4. Wykonaj analizę ponownie i porównaj obie: w tym samym miejscu publikacji stary adres został zastąpiony nowym.

Faza jest stanem procesu serwera; po restarcie wraca do `after`.

## Adresy

`node scripts/generate-addresses.ts [liczba]` generuje adresy każdego formatu (P2PKH, P2SH, bech32, EVM z EIP-55, Tron) i sprawdza je funkcją `validateAddress`. Wynik wkleja się do stałej `ADDR` w `data/scenario.ts` albo `MARKET_ADDR` w `data/market.ts`. Serwer przy starcie odrzuca scenariusz z niepoprawnym adresem.
