# Piaskownica OŁCyŚ

Syntetyczne środowisko demonstracyjne: fikcyjny „internet" (sześć serwisów i archiwum) oraz fikcyjny eksplorator bloków. Wszystkie osoby, konta, firmy i adresy są zmyślone. Adresy mają poprawne sumy kontrolne, ale powstały z losowych danych i nie należą do nikogo.

```
node src/server.ts        # http://localhost:4100 (SANDBOX_PORT, SANDBOX_HOST)
```

Dane są w `data/scenario.ts` (scenariusze a–h) i `data/market.ts` („rynek P2P": kilkanaście osób handlujących na Targu); serwer (`src/app.ts`, funkcja `buildApp()`) tylko je renderuje. Łącznie w piaskownicy występuje 25 fikcyjnych osób, nie licząc kont tła.

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

Lista najnowszych publikacji: `GET /<serwis>/api/recent?limit=<1–100>` (domyślnie 20) zwraca w tym samym kształcie (bez `matchedBy`) ogłoszenia, posty, wiadomości z listy, komentarze i wiadomości kanałów, od najświeższych. Profile i strony osobiste nie są publikacjami, więc `/gitpub` i `/www` zwracają pustą listę.

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

### Podmiana adresu między analizami

Strona `/_demo` przełącza fazę scenariusza Dominika:

1. `GET /_demo/faza/before` — strona `/www/dsroka` pokazuje stary adres, archiwum nie ma jeszcze kopii z września 2025.
2. Wykonaj analizę dla `dsroka`.
3. `GET /_demo/faza/after` (stan domyślny) — strona pokazuje nowy adres.
4. Wykonaj analizę ponownie i porównaj obie: w tym samym miejscu publikacji stary adres został zastąpiony nowym.

Faza jest stanem procesu serwera; po restarcie wraca do `after`.

## Adresy

`node scripts/generate-addresses.ts [liczba]` generuje adresy każdego formatu (P2PKH, P2SH, bech32, EVM z EIP-55, Tron) i sprawdza je funkcją `validateAddress`. Wynik wkleja się do stałej `ADDR` w `data/scenario.ts` albo `MARKET_ADDR` w `data/market.ts`. Serwer przy starcie odrzuca scenariusz z niepoprawnym adresem.
