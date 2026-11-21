# Identity Lab

Gotowe lokalne środowisko testowania powiązań między kontami: **5 serwisów społecznościowych, 7 aukcyjnych/ogłoszeniowych i 15 forów**, syntetyczne treści, wyszukiwarka poszlak oraz blockchain UTXO. Wszystkie osoby, profile, skrzynki i transakcje są fikcyjne. Serwisy nie łączą się z rzeczywistymi platformami.

## Uruchomienie na Windows

Uruchom dwuklikiem **Start-Lab.cmd** albo w PowerShell:

```powershell
.\Start-Lab.ps1
```

Otwórz **http://127.0.0.1:8787**. Skrypt uruchamia panel oraz 27 portali na portach **8801–8827**. Zatrzymanie: Ctrl+C w oknie terminala. Wymagany Node.js 22 lub nowszy. Skrypt wykrywa również Node dostarczony z Codex. Brak pakietów do instalowania i zewnętrznych usług.

Jeżeli środowisko zostało uruchomione przez Codex w tle, jego PID znajduje się w `data/server.pid`, a logi w `artifacts/server.*.log`. Wtedy zatrzymasz je przez `.\Stop-Lab.ps1`. Skrypt weryfikuje, czy PID wskazuje serwer z tego katalogu.

Alternatywnie, jeżeli Node i npm są w PATH:

```powershell
npm start
# lub panel i 27 osobnych portów:
npm run portals
```

W obu wariantach wszystkie portale są również dostępne pod `http://127.0.0.1:8787/s/<slug>`. Domena `<slug>.lab.test` w interfejsie jest etykietą testową, bez konieczności zmiany DNS lub pliku hosts. To 27 osobnych przestrzeni profili i treści we wspólnym lokalnym procesie, nie pełne kopie oryginalnych usług. Nie zaimplementowano logowania, prawdziwych płatności ani integracji z API tych platform.

## Zawartość domyślnego scenariusza

Seed **67**, **180 osób**, **992 konta**: 706 zwykłych (`ordinary`), 217 dodatkowych (`multi`), 69 pod przybraną personą (`fake`). Są też 505 wpisów społecznościowych, 477 ofert, 863 wątki i 1974 odpowiedzi. Role opisują konstrukcję fixture, nie automatyczny werdykt modelu. Każdy portal jest zapełniony.

| Rodzaj | Serwisy | Porty |
|---|---|---|
| Społecznościowe | X, Facebook, Instagram, TikTok, LinkedIn — wersje LAB | 8801–8805 |
| Aukcje i ogłoszenia | Allegro, OLX, Vinted, eBay, Amazon, Etsy, Sprzedajemy — wersje LAB | 8806–8812 |
| Fora | Rowerowy Szlak, Kadr i Światło, Lutownia, Garaż Dyskusyjny, Zielony Zakątek, Wspólny Stół, Następna Tura, Kod Otwarty, Poza Mapą, Dom od Podstaw, Między Stronami, Drugi Refren, Równe Tempo, Nasza Dzielnica, Łańcuch Rozmów | 8813–8827 |

Katalogi i dane są odtwarzalne. Zmiana seedu zmienia scenariusz; data fixture pozostaje stała: 20 listopada 2026. Panel pozwala wygenerować 30–1000 osób. Sam generator obsługuje również mniejsze zbiory do testów jednostkowych.

## Pierwszy test powiązań

Dodatkowa kohorta **200 przykładów ujawniania adresów portfeli** obejmuje pięć serwisów społecznościowych i 15 forów. Po imporcie wpisz `#PortfelLAB` w wyszukiwarce portalu. Pełne teksty są w `artifacts/wallet-posts-200.txt`, a rekordy do dalszych testów w `artifacts/wallet-posts-200.jsonl`. Motywacje, zasady przypisywania adresów i ponowny import opisuje [WALLET-POSTS.md](WALLET-POSTS.md). Bazowe liczności powyżej nie obejmują tej kohorty; import dodaje 50 wpisów i 150 wątków.

W sekcji **Powiązania** wpisz **mira.kowal@poczta.test**. Zobaczysz profile tej samej syntetycznej osoby używające m.in. aliasów `szlak_ciszy`, `mira_k`, `mira.outdoors`, `m_kowal` i różnych e-maili. Kliknij „Przesłanki”, aby sprawdzić sygnały. Kliknięcie profilu otwiera jego dane, a „Analizuj powiązania” ustawia konkretny profil jako punkt startowy.

Przykładowe scenariusze:

- `mira.kowal@poczta.test`: kilka skrzynek, warianty aliasów i kontakt w bio; nie każde konto zostanie odnalezione.
- `rowerzysta`: ten sam popularny nick dwóch różnych osób. Oba trafienia zapytania pozostają odrębnymi hipotezami.
- `acct-00008`: fake konto Miry, którego nie można wiarygodnie połączyć na podstawie dostępnych atrybutów.
- Adres „Portfela pośrednika LAB” w sekcji Blockchain: dwie różne osoby publikują ten sam adres płatniczy. To celowa pułapka dla wnioskowania o właścicielu.

Silnik używa publicznych danych: e-maili, kontaktów w bio, podobieństwa aliasów, częstości ich występowania, lokalizacji, zainteresowań, godzin aktywności i wspólnych adresów portfeli. Wskaźnik 0–1 jest **heurystyczny i nieskalibrowany**. Nie należy interpretować go jako statystycznie potwierdzonego prawdopodobieństwa. Nie propaguje pewności łańcuchem A–B–C. Sam przelew między portfelami nie łączy ich właścicieli. Szczegóły: [IDENTITY.md](IDENTITY.md).

## Prawda wzorcowa i benchmark

Normalne profile oraz API wyszukiwania nie ujawniają `personId`, `role` ani `accountLinks`. Sekcja **Benchmark** jest świadomym trybem testowym: pobiera oddzielny wzorzec, oblicza precision, recall, F1 i pokazuje błędy przy wybranym progu. Nie ma uwierzytelniania ograniczającego benchmark; to laboratorium dla jednego lokalnego operatora.

Próba obejmuje do 12 000 par z osobnym doborem pozytywów i negatywów; metryki są ważone częstością doboru. Audyt tych samych aliasów lub portfeli różnych osób jest raportowany osobno. Domyślny kontrolowany audyt ujawnia fałszywe dopasowanie osób podających wspólny adres pośrednika, nawet jeśli próba losowa go nie zawiera. Wynik jednej próby nie gwarantuje braku rzadkich błędów. Wyszukiwanie nie odczytuje wzorca, również wtedy, gdy wcześniej otworzono benchmark.

## Blockchain

Początkowo: **30 portfeli, 7 bloków, 30 podpisanych przelewów**, genesis po 1000 LAB na portfel, nagroda 50 LAB na blok. Testowe adresy zaczynają się od `lab1`. Interfejs pozwala podpisać przelew, obejrzeć mempool, wykopać blok, zweryfikować cały rejestr i zasymulować reorganizację.

Implementacja obejmuje rzeczywiste podpisy **Ed25519**, UTXO, resztę, opłaty, odrzucanie podwójnych wydań, SHA-256 PoW, Merkle, walidację podaży i konkurencyjną gałąź o większej skumulowanej pracy. To symulator w jednym procesie, bez rozproszonej sieci P2P. Klucze są deterministyczne i wyłącznie testowe; publiczne API ich nie udostępnia. Szczegóły i ograniczenia: [BLOCKCHAIN.md](BLOCKCHAIN.md).

## Zapis, eksport i reset

Dane powstają automatycznie przy pierwszym uruchomieniu. Po przelewie, wydobyciu lub reorganizacji stan zapisuje się lokalnie. Nieudany zapis nie zmienia aktywnego stanu w pamięci.

| Plik w `data/` | Zastosowanie |
|---|---|
| `public.json` | Konta, serwisy, wpisy, oferty, dyskusje; bez wzorca |
| `ground-truth.json` | Osoby, przypisania i role kont oraz scenariusze |
| `blockchain-private.json` | Lokalny stan testowego blockchaina wraz z testowymi kluczami |
| `lab-state.json` | Atomowy snapshot całego środowiska, nadrzędny przy wczytywaniu |

Eksporty pobierane z panelu zawsze odzwierciedlają aktywny, zatwierdzony snapshot. Oddzielne pliki w katalogu data są wygodnymi eksportami; po przerwanym zapisie snapshot zapobiega wczytaniu różnych generacji. Nie edytuj tych plików ręcznie w działającym serwerze.

Aby zastąpić dane, użyj przycisku ustawień w panelu. Alternatywnie **zatrzymaj serwer** i uruchom:

```powershell
npm run generate -- --seed=67 --people=180
```

Zmienna `PORT` ustawia port panelu (domyślnie 8787); `LAB_DATA_DIR` wybiera katalog danych. Porty dodatkowych portali pozostają 8801–8827. Wszystkie nasłuchy Windows są ograniczone do `127.0.0.1`.

## API do własnych testów

| Metoda | Endpoint | Dane / wynik |
|---|---|---|
| GET | `/api/status`, `/api/services` | Parametry, liczności i katalog serwisów |
| GET | `/api/accounts?service=social-x&q=mira&limit=60&offset=0` | Filtrowane konta z paginacją |
| GET | `/api/accounts/acct-00001` | Profil i jego treści |
| GET | `/api/portal/x` | Pełny fixture jednego portalu |
| POST | `/api/resolve` | `{"query":"mira.kowal@poczta.test","limit":40}` |
| POST | `/api/evaluate` | `{"threshold":0.75}` |
| GET | `/api/ground-truth` | Jawny odczyt wzorca do benchmarku |
| GET | `/api/blockchain`, `/api/blockchain/validate` | Publiczny łańcuch / pełna walidacja |
| POST | `/api/blockchain/transfer` | `{"from":"wallet-1","to":"wallet-2","amount":25,"fee":1}` |
| POST | `/api/blockchain/mine` | `{}` lub `{"minerAddress":"lab1..."}` |
| POST | `/api/blockchain/reorg` | `{"depth":1}` (1–3) |
| POST | `/api/regenerate` | `{"seed":67,"people":180}` — zastępuje cały stan |
| GET | `/api/export/public`, `/api/export/truth`, `/api/export/blockchain` | Eksporty JSON do pobrania |

Żądania POST wymagają `Content-Type: application/json`. Kwoty i opłaty blockchaina są całkowitymi jednostkami LAB. Limit treści żądania wynosi 32 KiB. Serwer akceptuje lokalny Host i odrzuca obcy nagłówek Origin dla zapisów. Panel jest przeznaczony do pracy lokalnej.

Przykład PowerShell:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8787/api/resolve -Method Post -ContentType 'application/json' -Body '{"query":"mira.kowal@poczta.test"}'
```

## Testy i Docker

```powershell
node --test tests/*.test.mjs
node --check server.mjs
node --check public/app.js
```

Testy obejmują deterministyczny generator, pokrycie 27 portali, fałszywe podobieństwa, izolację wzorca, podpisy, manipulację łańcuchem, podwójne wydanie, reorganizację, API, odtworzenie stanu i nieudany zapis na dysk.

Opcjonalnie, jeśli masz Docker:

```powershell
docker compose up --build -d
```

Docker udostępnia panel i wszystkie ścieżki `/s/<slug>` na `127.0.0.1:8787`, ze stanem w wolumenie `lab-data`. Wariant kontenerowy nie otwiera 27 dodatkowych portów. Pliki Docker są dostarczone; ich uruchomienie wymaga lokalnie działającego silnika Docker.

Kod: `server.mjs` (HTTP/API), `lib/generator.mjs` (fixture), `lib/identity.mjs` (hipotezy), `lib/blockchain.mjs` (łańcuch), `lib/storage.mjs` (integracja i zapis), `public/` (interfejs bez frameworka).
