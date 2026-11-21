# 200 postów ujawniających adresy portfeli

Zestaw obejmuje **50 wpisów społecznościowych i 150 wątków**, po 10 w każdym z 20 portali: X, Facebook, Instagram, TikTok, LinkedIn oraz wszystkie 15 forów. Każda z 10 motywacji występuje dokładnie 20 razy. Serwisy aukcyjne pozostają bez zmian, ponieważ przykłady są postami i dyskusjami, a nie ofertami sprzedaży.

Gotowe pliki:

- `artifacts/wallet-posts-200.txt` — wszystkie teksty, autorzy, motywacje i lokalne linki do profili.
- `artifacts/wallet-posts-200.jsonl` — 200 rekordów UTF-8, po jednym obiekcie JSON w wierszu.

Każdy tekst zawiera pełny testowy adres `lab1…` z aktualnego rejestru blockchaina LAB oraz znacznik `#PortfelLAB`. Po imporcie można wpisać ten znacznik w wyszukiwarce dowolnego z 20 portali. Autorzy to istniejące konta; nie powstają nowe profile ani prawdziwe publikacje w serwisach zewnętrznych. Zmiana nie wykonuje transakcji i zachowuje istniejące bloki oraz mempool.

Motywacje: napiwki, airdrop/konkurs, wynagrodzenie, zbiórka, wiarygodność transakcji, prezentacja kolekcji, tożsamość Web3, pomoc techniczna, przypadkowe ujawnienie oraz oznaczona symulacja wyłudzenia. Opisy kolekcji NFT stanowią fikcyjne wypowiedzi w makiecie, a nie implementację NFT w łańcuchu LAB.

20 zbiórek podaje ten sam adres pośrednika. Jest to kontrolowany przykład adresu opublikowanego przez wiele różnych osób. Pozostałe przykłady używają własnych portfeli autorów zgodnie z mapowaniem pierwszych 29 osób w `buildLab`. `account.walletAddresses` jest listą publicznie przywołanych adresów, nie dowodem własności. Motywacje i rzeczywisty właściciel są oddzielnymi etykietami w `groundTruth.walletPostExamples`; normalne API profili i portali nie udostępnia tych pól. Przykłady zwiększają liczbę publicznych powiązań adresowych i mogą zmienić wynik benchmarku.

## Przygotowanie i ponowny import

Wygenerowanie plików bez zmiany zbioru:

```powershell
npm run wallet-posts
```

Import do istniejącego snapshotu (serwer musi być zatrzymany):

```powershell
.\Stop-Lab.ps1
npm run wallet-posts -- --apply
.\Start-Lab.ps1
```

Skrypt odmawia importu, jeśli główny serwer odpowiada na lokalnym porcie. Standardowa instalacja używa portu 8787; przy niestandardowym uruchomieniu ustaw ten sam `PORT` i `LAB_DATA_DIR`, których używa serwer. Skrypt nie zastępuje pozostałych treści ani łańcucha. Powtórny import jest idempotentny: aktualizuje własną kohortę 200 wpisów, bez duplikowania. Pełny reset przyciskiem ustawień lub `npm run generate` celowo tworzy bazowy scenariusz; po takim resecie należy ponownie zaimportować przykłady. Wymagane są portfele i autorzy dla wszystkich 20 portali; domyślny seed 67 / 180 osób je zapewnia. Niektóre małe zbiory lub inne seedy mogą nie mieć odpowiedniego autora — skrypt zgłasza to przed zmianą danych.

Teksty źródłowe: `lib/wallet-post-texts.mjs`. Import: `lib/wallet-posts.mjs`. Eksporty: `scripts/wallet-posts.mjs`. Testy: `tests/wallet-posts.test.mjs`.
