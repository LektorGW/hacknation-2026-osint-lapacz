import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crbrDocument, parseCrbrResponse } from '@olcys/sources';
import { assessBusinessActivity, registryDetailsOf, sameBeneficialOwnerName, BUSINESS_RULES } from '../src/business.ts';
import type { BusinessRegistryRecord } from '../src/business.ts';
import { buildOrganizationNetwork } from '../src/org-network.ts';

const NS = 'http://www.mf.gov.pl/schematy/AP/ApiPrzegladoweCRBR/2022/12/01';
const CRBR_XML = `<NS1:Envelope xmlns:NS1="http://www.w3.org/2003/05/soap-envelope"><NS1:Body><NS2:Odp xmlns:NS2="x"><Dane>
<in10:IdentyfikatorWniosku xmlns:in10="${NS}">ABC</in10:IdentyfikatorWniosku>
<in10:ListaInformacjiOSpolkachIBeneficjentach xmlns:in10="${NS}"><in10:SpolkaIBeneficjenci>
<in10:Nazwa>KRYPTO KANTOR SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ W LIKWIDACJI</in10:Nazwa><in10:NIP>5260250274</in10:NIP><in10:KRS>0000123456</in10:KRS>
<in10:Ulica>ul. Tajna</in10:Ulica><in10:NrDomu>7</in10:NrDomu>
<in10:ListaBeneficjentowRzeczywistych><in10:BeneficjentRzeczywisty><in10:PierwszeImie>JAN</in10:PierwszeImie><in10:KolejneImiona>PIOTR</in10:KolejneImiona><in10:Nazwisko>FIKCYJNY</in10:Nazwisko><in10:PESEL>82072702620</in10:PESEL><in10:Obywatelstwo>PL</in10:Obywatelstwo><in10:KrajZamieszkania>PL</in10:KrajZamieszkania>
<in10:ListaInformacjiOUdzialach><in10:InformacjaOUdzialach><in10:UprawnieniaWlascicielskieBezposrednie><in10:RodzajUprawnienWlascicielskich>udziały w spółce</in10:RodzajUprawnienWlascicielskich><in10:JednostkaMiary>sztuki</in10:JednostkaMiary><in10:Ilosc>1E+2</in10:Ilosc></in10:UprawnieniaWlascicielskieBezposrednie></in10:InformacjaOUdzialach></in10:ListaInformacjiOUdzialach>
</in10:BeneficjentRzeczywisty></in10:ListaBeneficjentowRzeczywistych>
</in10:SpolkaIBeneficjenci></in10:ListaInformacjiOSpolkachIBeneficjentach>
<in10:Status xmlns:in10="${NS}">IstniejaInformacje</in10:Status></Dane></NS2:Odp></NS1:Body></NS1:Envelope>`;

const KRS_ODPIS = {
  odpis: {
    dane: {
      dzial1: { danePodmiotu: { nazwa: 'KRYPTO KANTOR SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ W LIKWIDACJI', identyfikatory: { nip: '5260250274', regon: '123456785' } } },
      dzial2: { reprezentacja: { nazwaOrganu: 'LIKWIDATORZY', sklad: [{ imiona: { imie: 'J***' }, nazwisko: { nazwiskoICzlon: 'F*******' }, funkcjaWOrganie: 'LIKWIDATOR' }] } },
    },
  },
};

const SAOS = {
  items: [
    { id: 777, courtType: 'COMMON', courtCases: [{ caseNumber: 'X GU 12/26' }], judgmentType: 'DECISION', textContent: 'oddala wniosek o ogłoszenie upadłości <em>Krypto Kantor</em> sp. z o.o.', keywords: ['upadłość'], division: { name: 'X Wydział', court: { name: 'Sąd Rejonowy dla m.st. Warszawy' } }, judgmentDate: '2026-09-01', judges: [{ name: 'Sędzia Przykładowy' }] },
  ],
};

/** Atrapa `fetch`: CRBR (POST, XML), KRS i SAOS (JSON); reszta 404. */
function fakeFetch(calls: { url: string; method: string }[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('bramka-crbr.mf.gov.pl')) return new Response(CRBR_XML, { status: 200, headers: { 'Content-Type': 'application/soap+xml' } });
    if (url.includes('OdpisAktualny/0000123456?rejestr=P')) return new Response(JSON.stringify(KRS_ODPIS), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('saos.org.pl/api/search/judgments')) return new Response(JSON.stringify(SAOS), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

test('sieć organizacji: CRBR — beneficjenci w roli „beneficjent rzeczywisty (CRBR)” (fakt z rejestru), SAOS — orzeczenia jako kontekst organizacji', async () => {
  const calls: { url: string; method: string }[] = [];
  const network = await buildOrganizationNetwork({
    seeds: [{ name: 'KRS 0000123456', krs: '0000123456', addresses: ['bitcoin:bc1qtt04zfgjxg7lpqhk9vk8hnmnwf88ucwww5arsd'], origin: 'wpis KRS' }],
    fetch: fakeFetch(calls),
    now: () => new Date('2026-11-22T10:00:00.000Z'),
  });
  const org = network.organizations[0]!;
  assert.equal(org.identifiers.nip, '5260250274');
  assert.deepEqual(org.beneficialOwners, ['JAN PIOTR FIKCYJNY']);
  const owner = network.persons.find((person) => person.source.registry === 'CRBR')!;
  assert.ok(owner, 'beneficjent rzeczywisty w sieci organizacji');
  assert.equal(owner.role, 'beneficjent rzeczywisty (CRBR)');
  assert.equal(owner.relation, 'beneficjent rzeczywisty organizacji (rola w CRBR)');
  assert.equal(owner.masked, false);
  assert.equal(owner.organizationId, org.id);
  assert.match(owner.beneficialInterest!, /udziały w spółce — 100/);
  assert.equal(owner.source.retrievedAt, '2026-11-22T10:00:00.000Z');
  assert.ok(calls.some((call) => call.url.includes('bramka-crbr') && call.method === 'POST'));
  // Dane wrażliwe: bez PESEL i bez adresu przy beneficjencie.
  assert.doesNotMatch(JSON.stringify(network), /82072702620|Tajna/);
  assert.ok(network.notes.some((note) => /CRBR/.test(note) && /NIE jest właścicielem adresów/.test(note)));
  // Orzeczenia: kontekst organizacji, dopasowanie po nazwie, bez nazwisk sędziów.
  assert.equal(org.courtDecisions?.length, 1);
  assert.deepEqual([org.courtDecisions![0]!.match, org.courtDecisions![0]!.insolvency, org.courtDecisions![0]!.source.registry], ['name_only', true, 'SAOS']);
  assert.match(org.courtDecisions![0]!.label, /postanowienie, Sąd Rejonowy dla m\.st\. Warszawy, X GU 12\/26, 2026-09-01/);
  const saosCall = calls.find((call) => call.url.includes('saos.org.pl'))!;
  assert.equal(new URL(saosCall.url).searchParams.get('all'), '"KRYPTO KANTOR"');
  assert.doesNotMatch(JSON.stringify(network), /Sędzia Przykładowy/);
  assert.ok(network.notes.some((note) => /SAOS/.test(note) && /osób nie ustalamy/.test(note)));
  assert.ok(!network.persons.some((person) => person.source.registry === 'SAOS'), 'orzeczenie nigdy nie tworzy osoby');
});

test('sieć organizacji: CRBR_DISABLE=1 wyłącza zapytania do CRBR', async () => {
  const previous = process.env.CRBR_DISABLE;
  process.env.CRBR_DISABLE = '1';
  try {
    const calls: { url: string; method: string }[] = [];
    const network = await buildOrganizationNetwork({ seeds: [{ name: 'KRS 0000123456', krs: '0000123456', addresses: [], origin: 'test' }], fetch: fakeFetch(calls) });
    assert.ok(!calls.some((call) => call.url.includes('bramka-crbr')));
    assert.ok(!network.persons.some((person) => person.source.registry === 'CRBR'));
  } finally {
    if (previous === undefined) delete process.env.CRBR_DISABLE;
    else process.env.CRBR_DISABLE = previous;
  }
});

// ---------- Wskaźnik D: ścieżka „podmiot zarejestrowany” ----------

const lookup = parseCrbrResponse(CRBR_XML);
const crbrDoc = crbrDocument(lookup.companies[0]!, lookup, { type: 'login', value: 'NIP 5260250274' }, '2026-11-22T10:00:00.000Z');
const CRBR_RECORD: BusinessRegistryRecord = {
  connectorId: 'live-crbr',
  service: crbrDoc.service,
  url: crbrDoc.url,
  title: crbrDoc.title,
  organization: crbrDoc.profile!.organization!,
  registryEntries: crbrDoc.profile!.registryEntries!,
  details: registryDetailsOf('live-crbr', crbrDoc.text)!,
};

test('odczyt dokumentu CRBR w business.ts: beneficjenci osobno od członków organów, numery podmiotu', () => {
  const details = CRBR_RECORD.details!;
  assert.deepEqual([details.name, details.nip, details.krs], ['KRYPTO KANTOR SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ W LIKWIDACJI', '5260250274', '0000123456']);
  assert.deepEqual(details.beneficialOwners, ['JAN PIOTR FIKCYJNY']);
  assert.deepEqual(details.people, [], 'beneficjent nie jest członkiem organu');
  assert.equal(sameBeneficialOwnerName('JAN PIOTR FIKCYJNY', 'Jan Fikcyjny'), true);
  assert.equal(sameBeneficialOwnerName('JAN PIOTR FIKCYJNY', 'Piotr Fikcyjny'), false, 'wymagane pierwsze imię z rejestru');
  assert.equal(sameBeneficialOwnerName('JAN PIOTR FIKCYJNY', 'fikcyjny'), false, 'samo nazwisko nie wystarcza');
  assert.equal(sameBeneficialOwnerName('JAN FIKCYJNY', 'Jan Fikcyjny-Nowak'), false);
});

test('wskaźnik D: osoba sprawy jako beneficjent rzeczywisty (mocny) i podmiot w likwidacji', () => {
  const result = assessBusinessActivity({
    id: 't',
    subject: { kind: 'subject', label: 'Jan Fikcyjny' },
    publications: [],
    addresses: [],
    registry: { connectorsUsed: ['live-crbr'], identifiers: [{ type: 'login', value: 'NIP 5260250274' }], records: [CRBR_RECORD] },
  });
  const track = result.registered!;
  assert.equal(track.entities.length, 1);
  const owner = track.indicator.components.find((item) => item.rule === 'business.registered.subject_is_beneficial_owner')!;
  assert.ok(owner, 'składnik beneficjenta rzeczywistego');
  assert.equal(owner.weight, BUSINESS_RULES.registered.subjectIsBeneficialOwner);
  assert.ok(owner.limitations.some((item) => /PESEL/.test(item)));
  const insolvency = track.indicator.components.find((item) => item.rule === 'business.registered.insolvency_or_liquidation')!;
  assert.equal(insolvency.weight, BUSINESS_RULES.registered.insolvencyOrLiquidation);
  assert.match(insolvency.explanation, /w likwidacji/);
  assert.ok(track.whatToVerify.some((item) => /CRBR/.test(item) && /JAN PIOTR FIKCYJNY/.test(item)));
  assert.ok(!/pierze|wypranie|dopuścił się/.test(JSON.stringify(track)));

  const other = assessBusinessActivity({
    id: 't2',
    subject: { kind: 'subject', label: 'Anna Inna' },
    publications: [],
    addresses: [],
    registry: { connectorsUsed: ['live-crbr'], identifiers: [], records: [CRBR_RECORD] },
  });
  assert.ok(!other.registered!.indicator.components.some((item) => item.rule === 'business.registered.subject_is_beneficial_owner'), 'inna osoba — brak składnika');
});

test('wskaźnik D: beneficjent z sieci organizacji i orzeczenie o upadłości tylko po nazwie (słaby składnik)', () => {
  const krsRecord: BusinessRegistryRecord = {
    connectorId: 'live-krs',
    service: 'api-krs.ms.gov.pl',
    url: 'https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/0000999999?rejestr=P&format=json',
    title: 'KRS 0000999999: ZWYKŁA FIRMA SP. Z O.O.',
    details: { connectorId: 'live-krs', name: 'ZWYKŁA FIRMA SP. Z O.O.', krs: '0000999999', pkd: [], people: [], accounts: [] },
  };
  const result = assessBusinessActivity({
    id: 't3',
    subject: { kind: 'subject', label: 'Ewa Przykład' },
    publications: [],
    addresses: [],
    registry: { connectorsUsed: ['live-krs'], identifiers: [], records: [krsRecord] },
    registered: {
      organizations: [
        {
          id: 'org:krs:0000999999',
          name: 'ZWYKŁA FIRMA SP. Z O.O.',
          krs: '0000999999',
          addressKeys: [],
          beneficialOwners: ['EWA MARIA PRZYKŁAD'],
          courtDecisions: [{ label: 'postanowienie, Sąd Rejonowy, X GU 1/26, 2026-01-01', url: 'https://www.saos.org.pl/judgments/1', insolvency: true }],
        },
      ],
    },
  });
  const components = result.registered!.indicator.components;
  assert.ok(components.some((item) => item.rule === 'business.registered.subject_is_beneficial_owner'));
  const insolvency = components.find((item) => item.rule === 'business.registered.insolvency_or_liquidation')!;
  assert.equal(insolvency.weight, BUSINESS_RULES.registered.insolvencyCourtOnly);
  assert.ok(insolvency.limitations.some((item) => /zbieżność nazw/.test(item)));
});
