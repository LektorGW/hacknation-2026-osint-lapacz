# Symulacja sieci LAB

Moduł `lib/blockchain.mjs` implementuje izolowany blockchain UTXO, a nie atrapę listy przelewów. Domyślnie tworzy 24 portfele, blok genesis oraz sześć bloków z podpisanymi transakcjami. Token LAB nie ma wartości pieniężnej. Moduł nie wykonuje żadnych połączeń sieciowych.

## Mechanika

- Każde wejście przelewu wskazuje istniejące UTXO i zawiera weryfikowany podpis Ed25519 nad kanoniczną treścią całej transakcji. Identyfikator transakcji obejmuje również podpisy.
- Kwoty i opłaty są całkowitymi jednostkami LAB. Weryfikacja wymaga zachowania wartości: wejścia = wyjścia + opłata. Ponowne wydanie tego samego UTXO, nieznany adres, błędny podpis oraz ujemna lub ułamkowa kwota są odrzucane.
- Mempool jest odtwarzany kolejno wraz z zależnościami transakcji; środki w oczekujących transakcjach są rezerwowane. API pokazuje saldo potwierdzone oraz saldo po uwzględnieniu mempoolu.
- Każdy blok zawiera hash poprzednika, korzeń Merkle, nonce i SHA-256 proof of work. Domyślna trudność to dwa początkowe zera szesnastkowe, celowo niewielka, aby testy trwały krótko.
- Genesis emituje po 1000 LAB na portfel. Każdy następny blok tworzy dokładnie 50 nowych LAB oraz przekazuje opłaty górnikowi. `validateBlockchain` ponownie odtwarza cały rejestr, weryfikuje podpisy, PoW, ciągłość bloków, rejestr kluczy, emisję oraz podaż.
- `simulateReorg({depth:1..3})` rzeczywiście kopie konkurencyjną gałąź od punktu rozwidlenia. Zastępuje poprzednią tylko wtedy, gdy ma większą skumulowaną pracę. Usunięte bloki trafiają do archiwum orphanów, a nadal poprawne przelewy wracają do mempoolu. Przelewy zależne od osieroconych nagród zostają odrzucone z przyczyną.

## Determinizm i powiązania kont

Adres portfela o indeksie `i` (od zera) to `lab1` + pierwsze 40 znaków hex SHA-256 tekstu `${seed}:wallet:${i}`. Rejestr wiąże adresy LAB z kluczami publicznymi i jego hash jest zawarty w nagłówkach bloków. Nie jest to format adresu żadnej rzeczywistej sieci. Przykładowe przepływy obejmują wspólnych odbiorców i powtarzalne przelewy, które można analizować jako poszlaki. Wspólny adres czy płatność nie stanowią dowodu jednej osoby: portfel może należeć do pośrednika lub kilku użytkowników.

Prywatne klucze Ed25519 są odtwarzalne z SHA-256 `${seed}:ed25519:${i}` i zapisane w lokalnym stanie testowym, aby aplikacja mogła podpisywać demonstracyjne przelewy. **Nigdy nie używaj tych kluczy ani adresów poza laboratorium.** `publicBlockchain` usuwa wszystkie klucze prywatne z odpowiedzi HTTP. Klucze publiczne pozostają widoczne do weryfikacji podpisów.

## Granice modelu

Jest to pojedynczy proces z deterministycznym zegarem i kontrolowanym rejestrem portfeli. Nie symuluje propagacji pakietów P2P, trudności zależnej od hashrate, rzeczywistej ekonomii opłat, kontraktów, ataków na globalną sieć ani niezależnego konsensusu wielu maszyn. Reorganizacja modeluje wybór gałęzi według wykonanej pracy, ale nie rozproszoną sieć węzłów. UTXO coinbase można wydać od kolejnego bloku; nie ma dodatkowego okresu dojrzewania.

Uruchomienie testów: `node --test tests/blockchain.test.mjs`.
