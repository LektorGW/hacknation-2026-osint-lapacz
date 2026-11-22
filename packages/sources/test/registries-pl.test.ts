import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCrbrConnector,
  crbrQueryOf,
  crbrRequestXml,
  parseCrbrResponse,
  parseSaosSearch,
  queryCrbr,
  saosPhraseFor,
  saosSearchUrl,
  searchCourtDecisions,
  CRBR_ENDPOINT,
} from '../src/registries-pl/index.ts';
import type { CrbrFetch } from '../src/registries-pl/index.ts';

const NS = 'http://www.mf.gov.pl/schematy/AP/ApiPrzegladoweCRBR/2022/12/01';

/** Odpowiedź w kształcie z rozdz. 4.1.3 specyfikacji v3.0.4 (dane fikcyjne; PESEL i data urodzenia są w odpowiedzi). */
const CRBR_OK = `<?xml version="1.0" encoding="UTF-8"?>
<NS1:Envelope xmlns:NS1="http://www.w3.org/2003/05/soap-envelope"><NS1:Body>
<NS2:PobierzInformacjeOSpolkachIBeneficjentachOdpowiedz xmlns:NS2="http://www.mf.gov.pl/uslugiBiznesowe/uslugiESB/AP/ApiPrzegladoweCRBR/2022/12/01">
<PobierzInformacjeOSpolkachIBeneficjentachOdpowiedzDane>
<in10:IdentyfikatorWniosku xmlns:in10="${NS}">5DB49FB6CBA7438FB643468CA8F58FBC</in10:IdentyfikatorWniosku>
<in10:DataICzasUdostepnieniaWniosku xmlns:in10="${NS}">2026-11-22T10:00:00</in10:DataICzasUdostepnieniaWniosku>
<in10:ListaInformacjiOSpolkachIBeneficjentach xmlns:in10="${NS}">
 <in10:SpolkaIBeneficjenci>
  <in10:Nazwa>FIKCYJNA FIRMA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ</in10:Nazwa>
  <in10:NIP>5260250274</in10:NIP>
  <in10:KRS>0000123456</in10:KRS>
  <in10:KodFormyOrganizacyjnej>117</in10:KodFormyOrganizacyjnej>
  <in10:OpisFormyOrganizacyjnej>Spółka z ograniczoną odpowiedzialnością</in10:OpisFormyOrganizacyjnej>
  <in10:KodPocztowy>00-001</in10:KodPocztowy>
  <in10:Miejscowosc>WARSZAWA</in10:Miejscowosc>
  <in10:Ulica>ul. Tajna</in10:Ulica>
  <in10:NrDomu>7</in10:NrDomu>
  <in10:ListaBeneficjentowRzeczywistych>
   <in10:BeneficjentRzeczywisty>
    <in10:PierwszeImie>JAN</in10:PierwszeImie>
    <in10:KolejneImiona>PIOTR</in10:KolejneImiona>
    <in10:Nazwisko>FIKCYJNY</in10:Nazwisko>
    <in10:PESEL>82072702620</in10:PESEL>
    <in10:Obywatelstwo>PL</in10:Obywatelstwo>
    <in10:KrajZamieszkania>PL</in10:KrajZamieszkania>
    <in10:ListaInformacjiOUdzialach><in10:InformacjaOUdzialach>
     <in10:UprawnieniaWlascicielskieBezposrednie>
      <in10:KodUprawnienWlascicielskich>001</in10:KodUprawnienWlascicielskich>
      <in10:RodzajUprawnienWlascicielskich>udziały w spółce</in10:RodzajUprawnienWlascicielskich>
      <in10:JednostkaMiary>sztuki</in10:JednostkaMiary>
      <in10:Ilosc>6E+1</in10:Ilosc>
      <in10:InformacjaOUprzywilejowaniu><in10:KodUprzywilejowania>99</in10:KodUprzywilejowania><in10:RodzajUprzywilejowania>brak</in10:RodzajUprzywilejowania></in10:InformacjaOUprzywilejowaniu>
     </in10:UprawnieniaWlascicielskieBezposrednie>
    </in10:InformacjaOUdzialach></in10:ListaInformacjiOUdzialach>
   </in10:BeneficjentRzeczywisty>
   <in10:BeneficjentRzeczywisty>
    <in10:PierwszeImie>ANNA</in10:PierwszeImie>
    <in10:Nazwisko>PRZYKŁADOWA &amp; S-KA</in10:Nazwisko>
    <in10:DataUrodzenia>1990-01-01</in10:DataUrodzenia>
    <in10:Obywatelstwo>DE</in10:Obywatelstwo>
    <in10:KrajZamieszkania>DE</in10:KrajZamieszkania>
   </in10:BeneficjentRzeczywisty>
  </in10:ListaBeneficjentowRzeczywistych>
  <in10:ListaReprezentantow><in10:Reprezentant><in10:PierwszeImie>ZENON</in10:PierwszeImie><in10:Nazwisko>ZGŁASZAJĄCY</in10:Nazwisko><in10:PESEL>11111111111</in10:PESEL><in10:RodzajReprezentacji>PREZES ZARZĄDU</in10:RodzajReprezentacji></in10:Reprezentant></in10:ListaReprezentantow>
  <in10:DataPoczatkuPrezentacjiZgloszenia>2025-01-20</in10:DataPoczatkuPrezentacjiZgloszenia>
  <in10:NumerReferencyjny>65d858da2f45f8c601afa7c0e3e3ee71</in10:NumerReferencyjny>
  <in10:ListaInformacjiORozbieznosciach><in10:InformacjaORozbieznosciach><in10:IdentyfikatorUwagi>1</in10:IdentyfikatorUwagi><in10:InformacjaDlaZainteresowanego>rozbieżność</in10:InformacjaDlaZainteresowanego></in10:InformacjaORozbieznosciach></in10:ListaInformacjiORozbieznosciach>
 </in10:SpolkaIBeneficjenci>
</in10:ListaInformacjiOSpolkachIBeneficjentach>
<in10:SzczegolyWniosku xmlns:in10="${NS}"><in10:NIP>5260250274</in10:NIP></in10:SzczegolyWniosku>
<in10:Status xmlns:in10="${NS}">IstniejaInformacje</in10:Status>
<in10:CelZapytania xmlns:in10="${NS}">BeneficjenciISpolki</in10:CelZapytania>
</PobierzInformacjeOSpolkachIBeneficjentachOdpowiedzDane>
</NS2:PobierzInformacjeOSpolkachIBeneficjentachOdpowiedz></NS1:Body></NS1:Envelope>`;

const CRBR_EMPTY = `<NS1:Envelope xmlns:NS1="http://www.w3.org/2003/05/soap-envelope"><NS1:Body><NS2:X xmlns:NS2="x"><D><io5:IdentyfikatorWniosku xmlns:io5="${NS}">AB</io5:IdentyfikatorWniosku><io5:ListaInformacjiOSpolkachIBeneficjentach xmlns:io5="${NS}"/><io5:Status xmlns:io5="${NS}">BrakInformacji</io5:Status></D></NS2:X></NS1:Body></NS1:Envelope>`;

function crbrFake(body: string, calls: { url: string; body: string; method: string }[] = [], status = 200): CrbrFetch {
  return async (url, init) => {
    calls.push({ url, body: init.body, method: init.method });
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  };
}

const context = (logs: string[] = []) => ({ log: (message: string) => logs.push(message) });

test('CRBR: odczyt odpowiedzi — spółka, beneficjenci z udziałami, rozbieżności; bez PESEL, daty urodzenia, adresu i reprezentantów', () => {
  const result = parseCrbrResponse(CRBR_OK);
  assert.equal(result.status, 'IstniejaInformacje');
  assert.equal(result.requestId, '5DB49FB6CBA7438FB643468CA8F58FBC');
  assert.equal(result.companies.length, 1);
  const company = result.companies[0]!;
  assert.deepEqual([company.name, company.nip, company.krs, company.legalForm], ['FIKCYJNA FIRMA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', '5260250274', '0000123456', 'Spółka z ograniczoną odpowiedzialnością']);
  assert.deepEqual(company.beneficialOwners.map((owner) => owner.name), ['JAN PIOTR FIKCYJNY', 'ANNA PRZYKŁADOWA & S-KA']);
  assert.deepEqual(company.beneficialOwners[0]!.interests, ['bezpośrednio: udziały w spółce — 60 (sztuki)']);
  assert.equal(company.beneficialOwners[1]!.citizenship, 'DE');
  assert.equal(company.discrepancies, 1);
  assert.equal(company.presentedFrom, '2025-01-20');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /82072702620|11111111111|1990-01-01/, 'PESEL ani data urodzenia nie są odczytywane');
  assert.doesNotMatch(serialized, /Tajna|00-001|WARSZAWA/, 'adres siedziby nie trafia do wyniku');
  assert.doesNotMatch(serialized, /ZENON|ZGŁASZAJĄCY/, 'reprezentanci (zgłaszający) nie są odczytywani');
});

test('CRBR: brak informacji, SOAP Fault i błąd formalny', () => {
  assert.deepEqual(parseCrbrResponse(CRBR_EMPTY).companies, []);
  assert.equal(parseCrbrResponse(CRBR_EMPTY).status, 'BrakInformacji');
  const fault = parseCrbrResponse('<env:Envelope xmlns:env="e"><env:Body><env:Fault><env:Reason><env:Text>Błąd techniczny</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>', 500);
  assert.equal(fault.status, 'blad');
  assert.match(fault.error!, /Błąd techniczny/);
  assert.equal(parseCrbrResponse(`<a><x:Status xmlns:x="${NS}">BladFormalny</x:Status></a>`).status, 'BladFormalny');
});

test('CRBR: zapytanie SOAP 1.2 wyłącznie po NIP albo KRS spółki; numer bez poprawnej cyfry kontrolnej nie wychodzi', async () => {
  assert.deepEqual(crbrQueryOf({ nip: '526-025-02-74' }), { nip: '5260250274' });
  assert.deepEqual(crbrQueryOf({ krs: '123456' }), { krs: '0000123456' });
  assert.equal(crbrQueryOf({ nip: '5260250275' }), null);
  assert.match(crbrRequestXml({ nip: '5260250274' }), /<ns1:SzczegolyWniosku><ns1:NIP>5260250274<\/ns1:NIP><\/ns1:SzczegolyWniosku>/);
  assert.doesNotMatch(crbrRequestXml({ krs: '0000123456' }), /PESEL|Nazwisko|PierwszeImie/);
  const calls: { url: string; body: string; method: string }[] = [];
  const lookup = await queryCrbr({ krs: '0000123456' }, { fetch: crbrFake(CRBR_OK, calls), minIntervalMs: 0 });
  assert.equal(lookup.companies.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, CRBR_ENDPOINT);
  assert.equal(calls[0]!.method, 'POST');
  assert.match(calls[0]!.body, /<ns1:KRS>0000123456<\/ns1:KRS>/);
  const failed = await queryCrbr({ nip: '5260250274' }, { fetch: async () => { throw new Error('ECONNRESET'); }, minIntervalMs: 0 });
  assert.equal(failed.status, 'blad');
  assert.match(failed.error!, /ECONNRESET/);
});

test('łącznik live-crbr: dokument z beneficjentami w roli z rejestru, numery spółki jako identyfikatory odkryte, bez danych wrażliwych', async () => {
  const calls: { url: string; body: string; method: string }[] = [];
  const connector = createCrbrConnector({ fetch: crbrFake(CRBR_OK, calls), minIntervalMs: 0 });
  assert.equal(connector.id, 'live-crbr');
  assert.deepEqual(await connector.search({ type: 'login', value: 'jan_fikcyjny' }, context()), [], 'login bez numeru nie uruchamia zapytania');
  assert.deepEqual(await connector.search({ type: 'login', value: 'rachunek 61109010140000071219812874' }, context()), []);
  assert.equal(calls.length, 0);
  const docs = await connector.search({ type: 'login', value: 'NIP 5260250274' }, context());
  assert.equal(docs.length, 1);
  const doc = docs[0]!;
  assert.equal(doc.connectorId, 'live-crbr');
  assert.equal(doc.identityMatch, 'exact_identifier');
  assert.equal(doc.profile?.organization, 'FIKCYJNA FIRMA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ');
  assert.match(doc.text, /^Nazwa: FIKCYJNA FIRMA/m);
  assert.match(doc.text, /^NIP: 5260250274$/m);
  assert.match(doc.text, /^Beneficjent rzeczywisty: JAN PIOTR FIKCYJNY \(obywatelstwo: PL; państwo zamieszkania: PL; bezpośrednio: udziały w spółce — 60 \(sztuki\)\)$/m);
  assert.match(doc.text, /Zgłoszone rozbieżności do wpisu: 1/);
  assert.doesNotMatch(doc.text, /^- /m, 'brak wierszy „- …” (czytanych jako członkowie organów)');
  assert.doesNotMatch(JSON.stringify(doc), /82072702620|1990-01-01|Tajna|ZENON/);
  assert.deepEqual(doc.discoveredIdentifiers, [{ type: 'login', value: 'KRS 0000123456' }]);
  const empty = createCrbrConnector({ fetch: crbrFake(CRBR_EMPTY), minIntervalMs: 0 });
  const logs: string[] = [];
  assert.deepEqual(await empty.search({ type: 'login', value: 'KRS 0000123456' }, context(logs)), []);
  assert.ok(logs.some((line) => /brak informacji w rejestrze/.test(line)));
});

// ---------- SAOS ----------

const SAOS_RESPONSE = {
  items: [
    {
      id: 554858,
      href: 'https://www.saos.org.pl/api/judgments/554858',
      courtType: 'COMMON',
      courtCases: [{ caseNumber: 'X GU 12/26' }],
      judgmentType: 'DECISION',
      judges: [{ name: 'Sędzia Przykładowy', function: null, specialRoles: ['PRESIDING_JUDGE'] }],
      textContent: ' ogłasza upadłość dłużnika <em>Fikcyjna Firma</em> spółki z ograniczoną odpowiedzialnością w W. ',
      keywords: ['upadłość'],
      division: { id: 1, name: 'X Wydział Gospodarczy', court: { id: 276, name: 'Sąd Rejonowy dla m.st. Warszawy' } },
      judgmentDate: '2026-10-09',
    },
    { id: 'zły', courtType: 'COMMON' },
    { id: 555541, courtType: 'COMMON', courtCases: [{ caseNumber: 'III SA/Wa 1/26' }], judgmentType: 'SENTENCE', textContent: 'decyzja w przedmiocie podatku od towarów i usług <em>Fikcyjna Firma</em>', keywords: [], judgmentDate: '2026-01-02' },
  ],
};

test('SAOS: fraza bez formy prawnej, zapytanie o dokładną frazę, odczyt orzeczeń bez nazwisk sędziów', async () => {
  assert.equal(saosPhraseFor('FIKCYJNA FIRMA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ W LIKWIDACJI'), 'FIKCYJNA FIRMA');
  assert.equal(saosPhraseFor('KRYPTO S.A.'), undefined, 'jeden wyraz — za dużo zbieżności');
  const url = saosSearchUrl('FIKCYJNA FIRMA');
  assert.match(url, /^https:\/\/www\.saos\.org\.pl\/api\/search\/judgments\?/);
  assert.equal(new URL(url).searchParams.get('all'), '"FIKCYJNA FIRMA"');
  assert.equal(new URL(url).searchParams.get('pageSize'), '10');
  const decisions = parseSaosSearch(SAOS_RESPONSE);
  assert.equal(decisions.length, 2);
  assert.deepEqual([decisions[0]!.url, decisions[0]!.court, decisions[0]!.caseNumbers[0], decisions[0]!.insolvency, decisions[0]!.tax], ['https://www.saos.org.pl/judgments/554858', 'Sąd Rejonowy dla m.st. Warszawy', 'X GU 12/26', true, false]);
  assert.equal(decisions[0]!.excerpt, 'ogłasza upadłość dłużnika Fikcyjna Firma spółki z ograniczoną odpowiedzialnością w W.');
  assert.equal(decisions[1]!.tax, true);
  assert.doesNotMatch(JSON.stringify(decisions), /Sędzia Przykładowy/);
  const seen: string[] = [];
  const result = await searchCourtDecisions('FIKCYJNA FIRMA', {
    fetch: (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify(SAOS_RESPONSE), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });
  assert.equal(result.decisions.length, 2);
  assert.equal(seen.length, 1);
  const failed = await searchCourtDecisions('FIKCYJNA FIRMA', { fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch });
  assert.deepEqual([failed.decisions.length, failed.error], [0, 'kod 503']);
});
