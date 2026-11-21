# OŁCyŚ — OSINTowy Łapacz Cyfrowych Śladów (HackNation 2026, MF / KAS)

Narzędzie, które na podstawie identyfikatora podmiotu (imię i nazwisko, nick, login, e-mail, adres krypto) przeszukuje publiczne źródła, znajduje powiązane adresy kryptowalutowe i ocenia wiarygodność powiązania Wskaźnikiem Pewności (0–100%).

Status: szkielet monorepo (21.11.2026).

## Struktura
- `packages/core/` — logika niezależna od źródeł: wykrywanie i walidacja adresów, Wskaźnik Pewności (gotowe, z testami)
- `apps/` — API, interfejs analityka i syntetyczne źródła do demo (w przygotowaniu)
- `docs/` — architektura, scenariusze testowe, licencje komponentów

## Laboratorium 27 portali i blockchaina

`apps/identity-lab/` zawiera niezależne środowisko testowe: 5 portali społecznościowych, 7 aukcyjnych/ogłoszeniowych i 15 forów, 180 syntetycznych osób i 992 konta, silnik dopasowań z osobnym wzorcem oraz podpisany blockchain UTXO. Nie wymaga zewnętrznych zależności. Uruchomienie z katalogu repozytorium:

```powershell
pnpm --filter synthetic-identity-lab start
# panel oraz 27 osobnych portów:
pnpm --filter synthetic-identity-lab portals
```

Panel: http://127.0.0.1:8787. Na Windows można również uruchomić `apps/identity-lab/Start-Lab.cmd`. Generator odtwarza dane przy pierwszym starcie; stan lokalny, logi i testowe klucze pozostają poza Gitem. Dodatkowy generator przygotowuje 200 postów ujawniających testowe portfele. Instrukcje importu, API, benchmarku i symulatora: [README laboratorium](apps/identity-lab/README.md) oraz [scenariusze postów o portfelach](apps/identity-lab/WALLET-POSTS.md).

## Uruchomienie testów
Wymagany Node 24+ i pnpm.

```
pnpm install
pnpm test
```

## Zasady zadania, których pilnujemy
- wyłącznie publiczne źródła; bez skanowania, logowania na cudze konta i obchodzenia zabezpieczeń
- każdy wynik ze źródłem, URL, datą i czasem pozyskania
- raport rozróżnia fakty źródłowe, wyniki obliczeń i wnioski do weryfikacji
- dane testowe i wyniki nie są wysyłane do niezatwierdzonych usług zewnętrznych
- model AI wymienialny przez konfigurację; komponenty open source ze wskazaną licencją
