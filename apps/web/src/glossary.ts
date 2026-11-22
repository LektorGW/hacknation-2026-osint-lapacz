// Słownik pojęć: krótkie, proste definicje dla urzędnika, który pierwszy raz siada do programu.
// Jedno źródło prawdy dla podpowiedzi <Term> i szuflady „Słownik pojęć”.

export type GlossaryGroup = 'wynik' | 'adresy' | 'pieniadze' | 'zrodla' | 'tryb' | 'praca';

export interface GlossaryEntry {
  /** Nazwa pojęcia tak, jak widzi ją użytkownik. */
  term: string;
  /** Definicja: 1–2 zdania prostym językiem. */
  short: string;
  /** Opcjonalnie: dlaczego to ważne dla sprawy. */
  why?: string;
  group: GlossaryGroup;
}

export const GLOSSARY_GROUPS: { id: GlossaryGroup; label: string }[] = [
  { id: 'wynik', label: 'Wyniki i pewność' },
  { id: 'adresy', label: 'Adresy i blockchain' },
  { id: 'pieniadze', label: 'Pieniądze i giełdy' },
  { id: 'zrodla', label: 'Źródła i dowody' },
  { id: 'tryb', label: 'Tryby pracy' },
  { id: 'praca', label: 'Praca w programie' },
];

const entries = {
  // ---------- Wyniki i pewność ----------
  'wskaznik-pewnosci': {
    term: 'Wskaźnik Pewności',
    short: 'Liczba od 0 do 100: jak mocno adres łączy się z autorem publikacji, w której go znaleziono. Każda przesłanka dodaje albo odejmuje punkty według jawnych reguł.',
    why: 'To wskaźnik porządkowy, a nie procent szans: 90 znaczy „bardzo mocne przesłanki”, a nie „90% pewności”.',
    group: 'wynik',
  },
  'osoba-adres': {
    term: 'Powiązanie osoba–adres',
    short: 'Na ile adres należy do osoby, której dotyczy sprawa. Łączy dwie rzeczy: czy profil to ta osoba i czy profil opublikował ten adres jako swój.',
    why: 'Najsłabsze ogniwo obniża całość — mocna publikacja na niepewnym profilu daje słabe powiązanie.',
    group: 'wynik',
  },
  'pewnosc-osoby': {
    term: 'Pewność ustalenia osoby',
    short: 'Na ile profile znalezione w sieci należą do jednej, tej samej osoby ze sprawy.',
    why: 'Zgodny sam nick to słaba przesłanka — wiele osób używa takich samych nicków.',
    group: 'wynik',
  },
  'laczna-pewnosc': {
    term: 'Łączna pewność ustalenia',
    short: 'Pewność całej drogi pieniędzy: powiązanie osoba–adres pomnożone przez pewność ścieżki do giełdy.',
    group: 'wynik',
  },
  'pewnosc-sciezki': {
    term: 'Pewność ścieżki',
    short: 'Na ile pewne jest, że środki z adresu dotarły do danej usługi. Bezpośredni przelew na publicznie oznaczony adres giełdy daje wysoką pewność.',
    group: 'wynik',
  },
  'priorytet-sprawy': {
    term: 'Priorytet sprawy',
    short: 'Ocena 0–100, którą sprawą zająć się najpierw. Łączy pewność ustaleń z szacowaną kwotą wypłat.',
    group: 'wynik',
  },
  beneficjent: {
    term: 'Beneficjent zbiórki',
    short: 'Organizacja, na rzecz której zbierane są wpłaty na adres — wskazana przez treść wokół adresu w publikacjach (np. „Donation to Tor”, pole autora obok pola zbiórki), a nie przez autora publikacji.',
    why: 'To hipoteza z jawnym wskaźnikiem 0–100; najmocniejsza przesłanka to oficjalna strona organizacji publikująca ten sam adres. Dla osoby adres zbiórki ma 0%.',
    group: 'wynik',
  },
  'osoba-w-roli': {
    term: 'Osoba w roli (rejestr)',
    short: 'Osoba pełniąca funkcję w organizacji według rejestru publicznego (zarząd, prokurent, założyciel, dyrektor).',
    why: 'To osoba odpowiedzialna za organizację — nie właściciel adresu i nie kandydat na osobę ze sprawy.',
    group: 'zrodla',
  },
  'siatka-adresu': {
    term: 'Siatka adresu',
    short: 'Zbiorcze zestawienie, kto wpłacał na adres i dokąd wypływały środki: liczby nadawców i odbiorców, najwięksi kontrahenci i usługi (punkty zapytania).',
    why: 'Wpłacający to darczyńcy lub klienci — nie są kontami właściciela, dlatego nie powstają dla nich osoby. Nadawców zna usługa, z której wysłano środki.',
    group: 'pieniadze',
  },
  hipoteza: {
    term: 'Hipoteza',
    short: 'Przypuszczenie programu oparte na przesłankach. Nie jest ustaleniem — wymaga sprawdzenia i decyzji analityka.',
    why: 'Hipotezy zawsze mają kolor bursztynowy, aby nie pomylić ich z faktami.',
    group: 'wynik',
  },
  'hipoteza-operatora': {
    term: 'Hipoteza wspólnego operatora',
    short: 'Przypuszczenie, że dwa różne konta lub nicki prowadzi ta sama osoba (albo ktoś jej bliski).',
    why: 'Kwoty z takich kont nie są doliczane do sprawy, dopóki analityk nie potwierdzi, że to ta sama osoba.',
    group: 'wynik',
  },
  'fakt-zrodlowy': {
    term: 'Fakt źródłowy',
    short: 'Informacja wprost ze źródła publicznego albo z blockchaina. Można ją sprawdzić pod podanym adresem.',
    group: 'wynik',
  },
  'wynik-obliczen': {
    term: 'Wynik obliczeń',
    short: 'Liczba wyliczona przez program z faktów (sumy, wyceny, ścieżki). Każdy krok obliczenia jest pokazany.',
    group: 'wynik',
  },
  'wniosek-do-weryfikacji': {
    term: 'Wniosek do weryfikacji',
    short: 'Interpretacja programu. Nie jest dowodem — wymaga potwierdzenia przez analityka.',
    group: 'wynik',
  },
  'wynik-czesciowy': {
    term: 'Wynik częściowy',
    short: 'Analiza nie zdążyła sprawdzić wszystkich źródeł lub adresów (limit czasu albo awaria źródła). To, co widać, jest poprawne, ale może być niepełne.',
    why: 'Warto ponowić analizę, najlepiej w trybie głębokim.',
    group: 'wynik',
  },
  trafienie: {
    term: 'Trafienie',
    short: 'Adres powiązany ze sprawą, nieodrzucony przez analityka, z Wskaźnikiem Pewności co najmniej 60 — czyli co najmniej „prawdopodobne”.',
    why: 'Próg jest jawny i stały, więc statystyki można porównywać między sprawami i w czasie.',
    group: 'wynik',
  },
  'srednia-pewnosc': {
    term: 'Średnia pewność',
    short: 'Średnia z najwyższego Wskaźnika Pewności adresu w każdej sprawie, która ma co najmniej jedną zakończoną analizę.',
    group: 'wynik',
  },
  'srednia-trafien': {
    term: 'Średnia liczba trafień na sprawę',
    short: 'Wszystkie trafienia podzielone przez liczbę spraw z zakończoną analizą.',
    group: 'wynik',
  },
  skutecznosc: {
    term: 'Skuteczność',
    short: 'Jaki odsetek przeanalizowanych spraw ma co najmniej jedno trafienie.',
    why: 'Sprawy jeszcze bez analizy nie obniżają skuteczności — liczy je osobno „odsetek spraw z trafieniami”.',
    group: 'wynik',
  },
  'odsetek-spraw-z-trafieniami': {
    term: 'Odsetek spraw z trafieniami',
    short: 'Sprawy z co najmniej jednym trafieniem wśród wszystkich spraw — także tych, których jeszcze nie przeanalizowano.',
    group: 'wynik',
  },
  'szczebel-drabiny': {
    term: 'Szczebel drabiny dowodowej',
    short: 'Etap, do którego udało się udokumentować drogę pieniędzy: przelew w blockchainie → wpływ do usługi → sygnał wypłaty → udokumentowana wypłata na rachunek.',
    why: 'Im wyższy szczebel, tym mocniejszy dowód spieniężenia. Najwyższy wymaga potwierdzenia spoza blockchaina, np. odpowiedzi giełdy.',
    group: 'wynik',
  },

  // ---------- Adresy i blockchain ----------
  'adres-krypto': {
    term: 'Adres kryptowalutowy',
    short: 'Ciąg znaków, na który można wysłać kryptowalutę — odpowiednik numeru konta. Sam adres nie zdradza, do kogo należy.',
    group: 'adresy',
  },
  blockchain: {
    term: 'Blockchain',
    short: 'Publiczny rejestr wszystkich transakcji danej kryptowaluty. Każdy może go przeglądać, ale nie widać w nim imion i nazwisk.',
    group: 'adresy',
  },
  eksplorator: {
    term: 'Eksplorator blockchaina',
    short: 'Publiczna strona, na której można sprawdzić transakcje dowolnego adresu.',
    group: 'adresy',
  },
  'suma-kontrolna': {
    term: 'Suma kontrolna adresu',
    short: 'Wbudowane w adres zabezpieczenie przed literówką. „Zweryfikowana” znaczy, że adres jest technicznie poprawny — nie że należy do tej osoby.',
    group: 'adresy',
  },
  'klaster-portfela': {
    term: 'Klaster portfela',
    short: 'Grupa adresów, które według blockchaina obsługuje ten sam portfel — np. bo zostały wydane razem w jednej transakcji.',
    why: 'Adres z klastra może prowadzić do tej samej osoby, choć nigdzie go nie opublikowała.',
    group: 'adresy',
  },
  'adres-powszechnie-cytowany': {
    term: 'Adres powszechnie cytowany',
    short: 'Adres, który publikuje wiele niezwiązanych osób (np. przykład w poradniku albo zbiórka). Nie przypisujemy go nikomu.',
    group: 'adresy',
  },
  'smart-kontrakt': {
    term: 'Smart kontrakt',
    short: 'Program zapisany w blockchainie (np. Ethereum), który sam przesyła środki według reguł. Przelew na kontrakt nie zawsze oznacza przelew do osoby lub firmy.',
    group: 'adresy',
  },
  mikser: {
    term: 'Mikser',
    short: 'Usługa, która miesza środki wielu osób, aby utrudnić śledzenie, skąd pochodzą i dokąd trafiły (np. Tornado Cash, Wasabi).',
    why: 'Po mikserze dalszej drogi środków nie da się ustalić z blockchainu. Samo użycie miksera bywa legalną ochroną prywatności — nie świadczy o niczym więcej.',
    group: 'adresy',
  },
  coinjoin: {
    term: 'CoinJoin',
    short: 'Wspólna transakcja Bitcoin wielu osób: każdy wpłaca środki i dostaje z powrotem wyjście o tej samej kwocie, więc nie widać, które wyjście należy do kogo.',
    why: 'Rozpoznajemy go heurystyką (wiele równych wyjść w jednej transakcji) — to hipoteza, bo wypłata zbiorcza usługi może wyglądać podobnie.',
    group: 'adresy',
  },
  scam: {
    term: 'Scam (oszustwo z użyciem adresu)',
    short: 'Adres, na który oszust zbiera wpłaty ofiar: fałszywe rozdanie, fałszywa giełda, phishing. Zgłoszenia pochodzą z publikacji poszkodowanych i świadków albo z publicznych zbiorów ostrzeżeń.',
    why: 'Zgłoszenie to informacja, nie wyrok — piszemy „adres mógł być wykorzystywany do oszustwa”. Autorzy ostrzeżeń nigdy nie są właścicielami adresu; właściciel pozostaje nieustalony.',
    group: 'adresy',
  },
  'falszywe-rozdanie': {
    term: 'Fałszywe rozdanie (fake giveaway)',
    short: 'Oszustwo „wyślij 1 BTC, odeślemy 2”: ogłoszenie często podszywa się pod znaną osobę lub markę. Nic nie wraca.',
    why: 'W blockchainie widać zwykle wiele wpłat od wielu różnych osób w krótkim czasie, a potem szybkie wyprowadzenie środków — to heurystyka, bo zbiórka lub sprzedaż może wyglądać podobnie.',
    group: 'adresy',
  },
  'zatruwanie-adresu': {
    term: 'Zatruwanie adresu (address poisoning)',
    short: 'Oszust wysyła drobny przelew z adresu o tym samym początku i końcu co prawdziwy kontrahent, licząc, że ofiara skopiuje podróbkę z historii przy następnym przelewie.',
    why: 'Sygnał dotyczy kontrahenta-podróbki, nie badanego adresu.',
    group: 'adresy',
  },

  // ---------- Pieniądze i giełdy ----------
  spieniezenie: {
    term: 'Spieniężenie',
    short: 'Zamiana kryptowalut na pieniądze tradycyjne (np. złotówki) — zwykle przez giełdę, kantor P2P, bramkę płatniczą albo kartę.',
    group: 'pieniadze',
  },
  'dowod-spienienia': {
    term: 'Dowód spieniężenia',
    short: 'Udokumentowana droga środków od adresu osoby do giełdy lub usługi, która może je zamienić na złotówki.',
    why: 'To podstawa zapytania do giełdy o dane właściciela konta.',
    group: 'pieniadze',
  },
  'off-ramp': {
    term: 'Off-ramp (wyjście do fiat)',
    short: 'Usługa, w której kryptowaluty zamienia się na waluty tradycyjne: giełda lub kantor z wypłatą na rachunek, bitomat, karta krypto, bramka płatnicza albo platforma P2P.',
    why: 'Wyjście do fiat potwierdza tylko ta usługa (dane KYC i historia wypłat) — sam blockchain pokazuje wyłącznie przekazanie środków.',
    group: 'pieniadze',
  },
  bitomat: {
    term: 'Bitomat',
    short: 'Automat (kryptomat) do kupna i sprzedaży kryptowalut za gotówkę. Przy sprzedaży wypłaca banknoty.',
    why: 'Wypłata gotówki z bitomatu nie zostawia śladu w banku; operator automatu może mieć nagrania i dane z weryfikacji klienta.',
    group: 'pieniadze',
  },
  'karta-krypto': {
    term: 'Karta krypto',
    short: 'Karta płatnicza zasilana kryptowalutami (np. wydawana przez giełdę): przy płatności lub wypłacie z bankomatu kryptowaluta jest zamieniana na złotówki.',
    why: 'Doładowanie karty to praktyczne wyjście do fiat — zestawienie płatności i wypłat ma wydawca karty.',
    group: 'pieniadze',
  },
  p2p: {
    term: 'P2P (wymiana bezpośrednia)',
    short: 'Sprzedaż kryptowalut innej osobie za przelew, BLIK albo gotówkę — przez ogłoszenie, komunikator albo platformę z depozytem (np. Binance P2P).',
    why: 'Pieniądze trafiają wprost na rachunek lub do ręki sprzedającego; potwierdzić je może bank albo platforma P2P.',
    group: 'pieniadze',
  },
  'adres-wplat': {
    term: 'Adres wpłat (depozytowy)',
    short: 'Adres, który giełda przydziela jednemu klientowi do wpłat. Przelew na taki adres wskazuje konkretne konto w giełdzie.',
    why: 'Giełda może na wniosek wskazać właściciela tego konta.',
    group: 'pieniadze',
  },
  'portfel-powierniczy': {
    term: 'Portfel powierniczy',
    short: 'Portfel, w którym klucze trzyma firma (np. giełda), a nie użytkownik. Firma zna swojego klienta.',
    group: 'pieniadze',
  },
  wycena: {
    term: 'Wycena w PLN',
    short: 'Kwota w złotych liczona po kursie z dnia transakcji (kurs giełdowy × kurs średni NBP).',
    why: 'To szacunek wartości przelewów, a nie ustalenie przychodu podatnika.',
    group: 'pieniadze',
  },
  gielda: {
    term: 'Giełda lub usługa wymiany',
    short: 'Firma, która zamienia kryptowaluty na pieniądze tradycyjne lub inne kryptowaluty: giełda, serwis P2P, bramka płatnicza, karta.',
    group: 'pieniadze',
  },
  'odpowiedz-uslugi': {
    term: 'Odpowiedź usługi (dokument spoza OSINT)',
    short: 'Pismo z giełdy lub innej usługi wprowadzone do sprawy przez analityka. Nie pochodzi ze źródeł publicznych.',
    why: 'Program nie sprawdza autentyczności takiego dokumentu — dlatego ma osobny, fioletowy znacznik.',
    group: 'pieniadze',
  },
  'dzialalnosc-sygnaly': {
    term: 'Działalność gospodarcza (sygnały)',
    short: 'Wskaźnik D: oznaki, że osoba zarabia w sposób zorganizowany i ciągły — powtarzalne oferty, wielu wpłacających, regularne wpływy, cennik, przyjmowanie płatności w krypto.',
    why: 'To hipoteza do sprawdzenia, nie ustalenie: czy działalność jest zgłoszona i czy przychód zadeklarowano, wiedzą tylko systemy KAS (CEIDG, zeznania, JPK). Wpis w rejestrze otwiera drugą ścieżkę — weryfikację zgodności obrotu firmy.',
    group: 'pieniadze',
  },
  'obrot-a-dochod': {
    term: 'Obrót a dochód',
    short: 'Obrót to suma wpływów na adresy osoby (po kursie z dnia). Dochód to przychód pomniejszony o koszty — z blockchaina go nie widać.',
    why: 'Wpływ może być zwrotem, pożyczką albo przelewem z własnego portfela. Kwota obrotu to skala do sprawdzenia, nie podstawa opodatkowania.',
    group: 'pieniadze',
  },
  kontrahent: {
    term: 'Kontrahent',
    short: 'Druga strona przelewu: adres, na który wysłano środki albo z którego przyszły.',
    group: 'pieniadze',
  },

  // ---------- Źródła i dowody ----------
  osint: {
    term: 'OSINT (biały wywiad)',
    short: 'Pozyskiwanie informacji wyłącznie ze źródeł publicznie dostępnych: profili, forów, ogłoszeń, rejestrów.',
    group: 'zrodla',
  },
  'slad-zrodlowy': {
    term: 'Ślad w źródle',
    short: 'Konkretna publikacja (profil, wpis, ogłoszenie), w której pojawił się adres, wraz z cytatem i datą.',
    group: 'zrodla',
  },
  'niezalezne-pochodzenie': {
    term: 'Niezależne pochodzenie',
    short: 'Dwa ślady liczą się osobno tylko wtedy, gdy pochodzą z różnych, niezależnych publikacji. Kopie, przedruki i archiwa tej samej strony liczą się raz.',
    group: 'zrodla',
  },
  sha256: {
    term: 'Skrót SHA-256',
    short: 'Cyfrowy „odcisk palca” zapisanej treści źródła. Zmiana choćby jednego znaku daje zupełnie inny skrót.',
    why: 'Pozwala wykazać, że materiał dowodowy nie zmienił się od chwili pozyskania.',
    group: 'zrodla',
  },
  'sugestia-modelu': {
    term: 'Sugestia modelu językowego',
    short: 'Model językowy czyta treść publikacji i podpowiada, np. czy autor podaje własny adres, czy cudzy. To tylko sugestia, którą można cofnąć.',
    group: 'zrodla',
  },
  'tozsamosc-powiazana': {
    term: 'Powiązana tożsamość',
    short: 'Inne konto lub nick, które może należeć do tej samej osoby — wykryte przez wspólny adres, przelew albo cechy profilu.',
    group: 'zrodla',
  },
  'dane-syntetyczne': {
    term: 'Dane syntetyczne',
    short: 'Dane wygenerowane do testów i pokazów. Wyglądają jak prawdziwe, ale nie dotyczą realnych osób.',
    group: 'zrodla',
  },

  // ---------- Tryby pracy ----------
  'tryb-live': {
    term: 'Tryb LIVE',
    short: 'Program pracuje na prawdziwych, publicznych źródłach i prawdziwym blockchainie.',
    group: 'tryb',
  },
  'tryb-sandbox': {
    term: 'Tryb SANDBOX (piaskownica)',
    short: 'Program pracuje na źródłach i blockchainie piaskownicy — dane są syntetyczne, przygotowane do testów.',
    group: 'tryb',
  },
  'tryb-demo': {
    term: 'Tryb DEMO',
    short: 'Pokaz na danych przykładowych wbudowanych w interfejs. Nic nie jest pobierane ze źródeł — wyników nie wolno używać w sprawach.',
    group: 'tryb',
  },
  'tryb-nieustalony': {
    term: 'Tryb nieustalony',
    short: 'Usługa analizy nie podała, skąd pochodzą dane. Traktuj wyniki jak niezweryfikowane.',
    group: 'tryb',
  },
  'tryb-gleboki': {
    term: 'Tryb głęboki',
    short: 'Dokładniejsza analiza: szeroki przegląd forów i serwisów oraz dalsze kroki w blockchainie. Trwa zwykle 1–4 minuty. To tryb domyślny.',
    group: 'tryb',
  },
  'tryb-szybki': {
    term: 'Tryb szybki',
    short: 'Krótsza analiza: podstawowe źródła i krótsze ścieżki w blockchainie. Wynik po kilku–kilkunastu sekundach, ale może być niepełny.',
    group: 'tryb',
  },

  // ---------- Praca w programie ----------
  teczka: {
    term: 'Teczka sprawy',
    short: 'Komplet ustaleń dla jednej sprawy: osoba, adresy, pieniądze i dowody — w jednym miejscu, gotowe do raportu.',
    group: 'praca',
  },
  identyfikator: {
    term: 'Identyfikator',
    short: 'Dowolna znana dana o osobie: nick, e-mail, imię i nazwisko, adres profilu albo adres krypto. Jeden wystarczy, by zacząć.',
    group: 'praca',
  },
  wejscie: {
    term: 'Wejście wyszukiwania',
    short: 'Dana, od której zaczęło się sprawdzanie — wpisana przez analityka. Wszystko inne program odkrył sam na jej podstawie.',
    group: 'praca',
  },
  'monitorowanie-sprawy': {
    term: 'Monitorowanie sprawy',
    short: 'Program sam ponawia analizę zaznaczonej sprawy w wybranym odstępie i pokazuje, co zmieniło się od poprzedniej analizy.',
    why: 'Nowy adres albo nowy przelew do giełdy widać bez ręcznego sprawdzania.',
    group: 'praca',
  },
  'korekta-analityka': {
    term: 'Korekta analityka',
    short: 'Twoje potwierdzenie albo odrzucenie (np. „to adres tej osoby”). Od razu przelicza teczkę; zostaje w rejestrze i można ją wycofać.',
    group: 'praca',
  },
  'rejestr-decyzji': {
    term: 'Rejestr decyzji',
    short: 'Historia wszystkich korekt analityka w sprawie: kto, kiedy i z jaką notatką. Wycofane decyzje też zostają widoczne.',
    group: 'praca',
  },
  'adres-do-potwierdzenia': {
    term: 'Adres do potwierdzenia',
    short: 'Adres znaleziony w źródłach, którego program nie przypisał osobie, bo przesłanki są za słabe. Jedno kliknięcie analityka rozstrzyga sprawę.',
    group: 'praca',
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof entries;

export const GLOSSARY: Record<GlossaryId, GlossaryEntry> = entries;

export const GLOSSARY_IDS = Object.keys(GLOSSARY) as GlossaryId[];

export const isGlossaryId = (value: string): value is GlossaryId => value in GLOSSARY;

/** Wyszukiwanie w słowniku: nazwa, definicja i uzasadnienie, bez względu na wielkość liter i polskie znaki. */
export function searchGlossary(query: string): GlossaryId[] {
  const fold = (text: string) =>
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ł/g, 'l');
  const needle = fold(query.trim());
  if (!needle) return GLOSSARY_IDS;
  return GLOSSARY_IDS.filter((id) => {
    const entry = GLOSSARY[id];
    return fold(`${entry.term} ${entry.short} ${entry.why ?? ''}`).includes(needle);
  });
}
