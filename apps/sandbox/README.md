# Piaskownica OŁCyŚ

Syntetyczne środowisko demonstracyjne: fikcyjny „internet" (sześć serwisów i archiwum) oraz fikcyjny eksplorator bloków. Wszystkie osoby, konta, firmy i adresy są zmyślone. Adresy mają poprawne sumy kontrolne, ale powstały z losowych danych i nie należą do nikogo.

```
node src/server.ts        # http://localhost:4100 (SANDBOX_PORT, SANDBOX_HOST)
```

Całość danych jest w `data/scenario.ts`; serwer (`src/app.ts`, funkcja `buildApp()`) tylko je renderuje.

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

### Podmiana adresu między analizami

Strona `/_demo` przełącza fazę scenariusza Dominika:

1. `GET /_demo/faza/before` — strona `/www/dsroka` pokazuje stary adres, archiwum nie ma jeszcze kopii z września 2025.
2. Wykonaj analizę dla `dsroka`.
3. `GET /_demo/faza/after` (stan domyślny) — strona pokazuje nowy adres.
4. Wykonaj analizę ponownie i porównaj obie: w tym samym miejscu publikacji stary adres został zastąpiony nowym.

Faza jest stanem procesu serwera; po restarcie wraca do `after`.

## Adresy

`node scripts/generate-addresses.ts [liczba]` generuje adresy każdego formatu (P2PKH, P2SH, bech32, EVM z EIP-55, Tron) i sprawdza je funkcją `validateAddress`. Wynik wkleja się do stałej `ADDR` w `data/scenario.ts`. Serwer przy starcie odrzuca scenariusz z niepoprawnym adresem.
