# Sprawdzenie środowiska — 21 listopada 2026

**46/46 testów automatycznych przechodzi** po dodaniu kohorty postów o portfelach. Sprawdzono składnię nowych modułów i skryptu; wcześniejsza weryfikacja objęła `server.mjs` i `public/app.js`. Testy są odtwarzalne poleceniem `node --test tests/*.test.mjs`.

- Generator: deterministyczne seedy, polskie nazwiska, referencje autorów, pokrycie wszystkich portali, oddzielony wzorzec, mylące aliasy i niepowiązywalne fake konto.
- Silnik: silne i słabe sygnały, korelacja przesłanek, niejednoznaczne zapytania, brak wpływu ukrytego wzorca, ważona ocena oraz audyt wspólnego portfela różnych osób.
- Blockchain: realna weryfikacja Ed25519, odrzucenie zmanipulowanych podpisów i treści, podwójne wydanie, bilans i opłaty, PoW, Merkle, emisja, podaż, mempool i reorganizacja według wykonanej pracy.
- Integracja HTTP: wszystkie 27 katalogów i portali, izolacja prawdy wzorcowej i kluczy prywatnych, profile, wyszukiwanie, przelew, wydobycie, reorganizacja i walidacja, reset oraz zapis/odczyt stanu. Awaria zapisu pozostawia aktywny stan bez zmian; atomowy snapshot zapobiega mieszaniu generacji.

**27/27 osobnych portów 8801–8827 odpowiada HTTP 200** po przejściu przekierowania do odpowiedniego portalu. Panel działa na porcie 8787.

Sprawdzono interfejs w przeglądarce: demo łączy siedem profili Miry i pomija odłączone konto; działają przesłanki, podgląd profilu, katalog i filtrowanie ofert, filtr kont, benchmark oraz pełny przebieg przelew → mempool → blok → reorganizacja → poprawna walidacja. W sprawdzonych widokach brak błędów i ostrzeżeń konsoli. Widok mobilny mieści się w szerokości 375 px dokumentu bez przewijania w poziomie. Po testach przywrócono bazowy seed 67 / 180 osób / 7 bloków.

Kontrolowany audyt celowo wskazuje fałszywe powiązanie dwóch różnych osób podających wspólny adres pośrednika płatności. Próba losowa może go nie zawierać. To pokazuje ograniczenia wnioskowania i powód oddzielnego raportowania trudnych przypadków.

Dockerfile i Compose są wariantem opcjonalnym; obrazu Docker nie budowano w ramach tego sprawdzenia. Lokalne uruchomienie Windows sprawdzono bez zależności zewnętrznych.

## Dodatkowa kohorta 200 postów o portfelach

Dodano 200 unikalnych tekstów od 83 istniejących kont: 50 wpisów w pięciu serwisach społecznościowych oraz 150 wątków na 15 forach. Każdy portal otrzymał 10 przykładów, każda z 10 motywacji występuje 20 razy. Wszystkie użyte adresy istnieją w rejestrze blockchaina LAB. Najdłuższy wpis X ma 190 znaków wraz z pełnym adresem i znacznikiem `#PortfelLAB`.

Nowe testy sprawdzają pokrycie, zgodność autorów i adresów, rozdzielenie własnych portfeli i wspólnej zbiórki, izolację etykiet benchmarku, idempotencję importu, daty oraz publikację w API portali i profili. Skrypt poprawnie odmawia importu przy działającym serwerze; po jego zatrzymaniu import wykonano i uruchomiono wszystkie portale ponownie.

Weryfikacja aktywnego środowiska: 200/200 tekstów jest zgodnych z eksportem JSONL i publicznym API, 20/20 portali ma po 10 nowych treści, 27/27 osobnych portów odpowiada HTTP 200. Aktywny zbiór ma 555 wpisów i 1013 wątków. Porównanie ze snapshotem sprzed importu potwierdziło identyczny stan łańcucha: **11 bloków i 5 oczekujących przelewów**; walidacja blockchaina zwraca `valid: true`. Pozostałe wpisy, wątki i oferty są zachowane. Kopia snapshotu sprzed importu znajduje się w `artifacts/lab-state-before-wallet-posts-20261121-154747.json`. Ten import wykonano na stanie zmienionym po bazowym sprawdzeniu opisanym wyżej; nie przywracano już bazowych siedmiu bloków.
