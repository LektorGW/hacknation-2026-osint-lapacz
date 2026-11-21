import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  attachOfacAddresses,
  checkNetworkNodes,
  createRiskListsConnector,
  getDefaultRiskLists,
  knfNames,
  knfRiskList,
  loadRiskLists,
  matchRiskLists,
  riskListAddressFlags,
  riskListGraph,
  screenSanctions,
} from '../src/sanctions/index.ts';
import type { RiskListSnapshot } from '../src/sanctions/index.ts';
import {
  cryptoFromText,
  parseEuFsf,
  parseEuHighRiskCountries,
  parseMswiaList,
  parseOfacDate,
  parseOfacSdn,
  parseUkBirthDate,
  parseUkSanctions,
  splitPolishNames,
} from '../src/sanctions/parse.ts';

const logs: string[] = [];
const context = { log: (message: string) => logs.push(message) };

// ---------- Rozbiór plików list (fragmenty o układzie plików urzędowych, dane fikcyjne) ----------

const SDN = `<?xml version="1.0" standalone="yes"?>
<sdnList><publshInformation><Publish_Date>11/20/2026</Publish_Date></publshInformation>
<sdnEntry><uid>101</uid><firstName>Jan</firstName><lastName>PRZYKŁADOWY</lastName><sdnType>Individual</sdnType>
<programList><program>SDGT</program><program>CYBER2</program></programList>
<idList><id><uid>1</uid><idType>Passport</idType><idNumber>AB123456</idNumber><idCountry>Poland</idCountry></id>
<id><uid>2</uid><idType>Gender</idType><idNumber>Male</idNumber></id>
<id><uid>3</uid><idType>Digital Currency Address - ETH</idType><idNumber>0x00000000000000000000000000000000000000aa</idNumber></id></idList>
<akaList><aka><uid>5</uid><type>a.k.a.</type><category>strong</category><lastName>KOWALSKY, Johann</lastName></aka>
<aka><uid>6</uid><type>a.k.a.</type><category>weak</category><lastName>JANEK</lastName></aka></akaList>
<addressList><address><uid>7</uid><city>Warszawa</city><country>Poland</country></address></addressList>
<dateOfBirthList><dateOfBirthItem><uid>8</uid><dateOfBirth>05 Mar 1980</dateOfBirth></dateOfBirthItem>
<dateOfBirthItem><uid>9</uid><dateOfBirth>1981 to 1982</dateOfBirth></dateOfBirthItem></dateOfBirthList></sdnEntry>
<sdnEntry><uid>102</uid><lastName>STATEK TESTOWY</lastName><sdnType>Vessel</sdnType><programList><program>IRAN</program></programList></sdnEntry>
</sdnList>`;

test('OFAC SDN: nazwy, aliasy silne i słabe, program, daty, państwa, identyfikatory; statki pominięte', () => {
  const { publishedAt, entries } = parseOfacSdn(SDN);
  assert.equal(publishedAt, '2026-11-20');
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.id, '101');
  assert.equal(entry.type, 'person');
  assert.deepEqual(entry.names, ['Jan PRZYKŁADOWY', 'Johann KOWALSKY']);
  assert.deepEqual(entry.weakNames, ['JANEK']);
  assert.deepEqual(entry.programmes, ['SDGT', 'CYBER2']);
  assert.deepEqual(entry.birthDates, ['1980-03-05', '1981', '1982']);
  assert.deepEqual(entry.countries, ['PL']);
  // „Gender” nie jest identyfikatorem; adres kryptowalutowy pochodzi z kopii w packages/chain (bez powielania).
  assert.deepEqual(entry.ids, [{ kind: 'Passport', value: 'AB123456' }]);
  assert.equal(entry.crypto, undefined);
  assert.deepEqual(parseOfacDate('circa 1961'), ['1961']);
  assert.deepEqual(parseOfacDate('Feb 1970'), ['1970-02']);
});

test('OFAC: adresy z istniejącej kopii packages/chain dołączane do wpisów po nazwie podmiotu', () => {
  const snapshot = { list: 'ofac-sdn', label: 'OFAC', authority: '', source: '', page: '', retrievedAt: '2026-11-21T00:00:00Z', licence: '', kind: 'sanctions', entries: parseOfacSdn(SDN).entries } satisfies RiskListSnapshot;
  const merged = attachOfacAddresses(snapshot, {
    addresses: [
      { address: '0x00000000000000000000000000000000000000AA', asset: 'ETH', entity: 'Jan PRZYKŁADOWY' },
      { address: 'TXyz', asset: 'TRX', entity: 'Podmiot Spoza Listy' },
    ],
  });
  assert.deepEqual(merged.entries[0]?.crypto, [{ asset: 'ETH', address: '0x00000000000000000000000000000000000000AA' }]);
  assert.equal(merged.entries.length, 2);
  assert.equal(merged.entries[1]?.id, 'adres:Podmiot Spoza Listy');
});

const EU = `<?xml version="1.0" encoding="UTF-8"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-11-20T16:51:00.798+01:00">
<sanctionEntity designationDate="2022-04-08" unitedNationId="" euReferenceNumber="EU.1.1" logicalId="1">
<regulation programme="UKR" logicalId="2"><publicationUrl>https://eur-lex.europa.eu/akt</publicationUrl></regulation>
<subjectType code="person" classificationCode="P"/>
<nameAlias firstName="Иван" lastName="ТЕСТОВ" wholeName="Иван ТЕСТОВ" nameLanguage="RU" strong="true" logicalId="3"></nameAlias>
<nameAlias firstName="Ivan" lastName="TESTOV" wholeName="Ivan TESTOV" nameLanguage="EN" strong="true" logicalId="4"></nameAlias>
<nameAlias wholeName="Vanya" strong="false" logicalId="5"></nameAlias>
<citizenship countryIso2Code="RU" countryDescription="RUSSIAN FEDERATION" logicalId="6"></citizenship>
<birthdate circa="false" birthdate="" dayOfMonth="" monthOfYear="" year="1975" countryIso2Code="00" logicalId="7"></birthdate>
<identification number="4500 123456" identificationTypeCode="passport" identificationTypeDescription="National passport" countryIso2Code="RU" logicalId="8"></identification>
</sanctionEntity>
<sanctionEntity designationDate="" unitedNationId="QDe.001" euReferenceNumber="EU.2.2" logicalId="9">
<regulation programme="TAQA" logicalId="10"><publicationUrl>https://eur-lex.europa.eu/akt2</publicationUrl></regulation>
<subjectType code="enterprise" classificationCode="E"/>
<nameAlias wholeName="Test Front &amp; Co" strong="true" logicalId="11"></nameAlias>
<remark>Wallet: ETH 0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB</remark>
</sanctionEntity>
</export>`;

test('lista UE (FSF): nazwy w cyrylicy i łacince, aliasy słabe, obywatelstwo, rok urodzenia, numer ONZ', () => {
  const { publishedAt, entries } = parseEuFsf(EU);
  assert.equal(publishedAt, '2026-11-20');
  assert.equal(entries.length, 2);
  const person = entries[0]!;
  // Zapis łacinką jako nazwa główna; cyrylica identyczna po transliteracji nie jest powielana.
  assert.deepEqual(person.names, ['Ivan TESTOV']);
  assert.deepEqual(person.weakNames, ['Vanya']);
  assert.deepEqual(person.countries, ['RU']);
  assert.deepEqual(person.birthDates, ['1975']);
  assert.deepEqual(person.ids, [{ kind: 'National passport', value: '4500 123456' }]);
  assert.equal(person.listedOn, '2022-04-08');
  const company = entries[1]!;
  assert.equal(company.type, 'organization');
  assert.equal(company.names[0], 'Test Front & Co');
  assert.equal(company.unRef, 'QDe.001');
  assert.deepEqual(company.crypto, [{ asset: 'ETH', address: '0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB' }]);
});

const UK = `<?xml version="1.0" encoding="utf-8"?>
<Designations><DateGenerated>20/11/2026</DateGenerated>
<Designation><LastUpdated>09/04/2025</LastUpdated><DateDesignated>11/03/2022</DateDesignated><UniqueID>RUS9999</UniqueID>
<Names><Name><Name1>Piotr</Name1><Name6>TESTOWY</Name6><NameType>Primary name</NameType></Name>
<Name><Name6>Petya TEST</Name6><NameType>Alias</NameType><AliasStrength>Low quality a.k.a</AliasStrength></Name></Names>
<NonLatinNames><NonLatinName><NameNonLatinScript>Пётр Тестовый</NameNonLatinScript></NonLatinName></NonLatinNames>
<RegimeName>The Russia (Sanctions) (EU Exit) Regulations 2019</RegimeName><IndividualEntityShip>Individual</IndividualEntityShip>
<OtherInformation>Crypto wallets: (1) USDT: TGJVc32ig2u8tQsYMLE7KXHT5NDQroaVNU</OtherInformation>
<Addresses><Address><AddressCountry>Russia</AddressCountry></Address></Addresses>
<IndividualDetails><Individual><DOBs><DOB>dd/05/1972</DOB></DOBs><Nationalities><Nationality>Belarus</Nationality></Nationalities>
<PassportDetails><Passport><PassportNumber>512340377</PassportNumber></Passport></PassportDetails></Individual></IndividualDetails></Designation>
<Designation><UniqueID>SHIP001</UniqueID><Names><Name><Name6>STATEK</Name6><NameType>Primary name</NameType></Name></Names><IndividualEntityShip>Ship</IndividualEntityShip></Designation>
</Designations>`;

test('UK Sanctions List: nazwa główna, cyrylica, alias słaby, reżim, państwa, paszport, adres z treści wpisu', () => {
  const { publishedAt, entries } = parseUkSanctions(UK);
  assert.equal(publishedAt, '2026-11-20');
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.deepEqual(entry.names, ['Piotr TESTOWY', 'Пётр Тестовый']);
  assert.deepEqual(entry.weakNames, ['Petya TEST']);
  assert.deepEqual(entry.birthDates, ['1972-05']);
  assert.deepEqual(entry.countries, ['BY', 'RU']);
  assert.deepEqual(entry.ids, [{ kind: 'Passport', value: '512340377' }]);
  assert.deepEqual(entry.crypto, [{ asset: 'USDT', address: 'TGJVc32ig2u8tQsYMLE7KXHT5NDQroaVNU' }]);
  assert.equal(entry.listedOn, '2022-03-11');
  assert.equal(parseUkBirthDate('dd/mm/1945'), '1945');
  assert.equal(parseUkBirthDate('22/05/1972'), '1972-05-22');
  assert.deepEqual(cryptoFromText('brak adresów'), []);
});

const MSWIA = `<html><body><h2>Lista osób i podmiotów objętych sankcjami</h2>
<h3>Osoby</h3><div><table><tbody>
<tr><td><strong>Nazwisko i imię</strong></td><td>Dane</td><td>Uzasadnienie</td><td>Środki</td><td>Data</td><td>Wykreślenie</td></tr>
<tr><td><u>TESTOW Iwan (TESTOV Ivan)</u></td><td>urodzony 5 października 1973 r.<br />obywatel rosyjski<br />nr PESEL: 73100512345</td><td>uzasadnienie</td>
<td>a. zamrożenie wszystkich środk&oacute;w finansowych,<br />d. wpis do wykazu cudzoziemc&oacute;w, kt&oacute;rych pobyt na terytorium Rzeczypospolitej Polskiej jest niepożądany</td><td>27.10.2022</td><td>31.12.2024</td></tr>
</tbody></table></div>
<h3>Podmioty</h3><div><table><tbody><tr><td><strong>Podmioty</strong><table><tbody>
<tr><td><strong>Nazwa podmiotu</strong></td><td>Dane</td><td>Uzasadnienie</td><td>Środki</td><td>Data</td><td></td></tr>
<tr><td><u>Przykład Dystrybucja Sp. z o.o.</u></td><td>siedziba: ul. Testowa 1<br />00-001 Warszawa<br />Nr KRS 0000999999<br />NIP 123-456-32-18</td><td>u</td><td>wykluczenie z postępowania o udzielenie zam&oacute;wienia publicznego</td><td>26.04.2022</td><td>&nbsp;</td></tr>
</tbody></table></td></tr></tbody></table></div>
<h3>Materiały</h3><p>Lista osób i podmiotów objętych sankcjami 169.0 03.11.2026 10:13</p></body></html>`;

test('MSWiA: osoby i podmioty z tabel gov.pl — nazwy z nawiasu, data urodzenia, PESEL, NIP, KRS, wykreślenie', () => {
  const page = 'https://www.gov.pl/web/mswia/lista-osob-i-podmiotow-objetych-sankcjami';
  const { publishedAt, entries } = parseMswiaList(MSWIA, page);
  assert.equal(publishedAt, '2026-11-03');
  assert.equal(entries.length, 2);
  const person = entries[0]!;
  assert.deepEqual(person.names, ['TESTOW Iwan', 'TESTOV Ivan']);
  assert.deepEqual(person.birthDates, ['1973-10-05']);
  assert.deepEqual(person.countries, ['RU', 'PL']);
  assert.deepEqual(person.ids, [{ kind: 'PESEL', value: '73100512345' }]);
  assert.equal(person.delistedOn, '2024-12-31');
  assert.ok(person.programmes?.some((item) => /niepożądany/.test(item)));
  const company = entries[1]!;
  assert.equal(company.type, 'organization');
  assert.deepEqual(company.ids, [
    { kind: 'NIP', value: '1234563218' },
    { kind: 'KRS', value: '0000999999' },
  ]);
  assert.ok(company.programmes?.some((item) => /zamówienia publicznego/.test(item)));
  assert.deepEqual(splitPolishNames('Igor Iwanowicz Sieczin (Igor Ivanovich Sechin)'), ['Igor Iwanowicz Sieczin', 'Igor Ivanovich Sechin']);
});

test('UE — państwa trzecie wysokiego ryzyka: sekcje załącznika i kody ISO', () => {
  const html = `<p>ZAŁĄCZNIK</p><p>Państwa trzecie wysokiego ryzyka</p><p>I. Państwa trzecie wysokiego ryzyka, które przedstawiły zobowiązanie.</p>
<table><tr><td>Nr</td><td>Państwo trzecie wysokiego ryzyka</td></tr><tr><td>1</td><td>Vanuatu</td></tr><tr><td>2</td><td>Wietnam</td></tr><tr><td>3</td><td>Mjanma/Birma</td></tr></table>
<p>III. Państwa trzecie wysokiego ryzyka, które są źródłem ciągłego ryzyka.</p><table><tr><td>Nr</td><td>Państwo trzecie wysokiego ryzyka</td></tr><tr><td>1</td><td>Koreańska Republika Ludowo-Demokratyczna (KRLD)</td></tr></table>`;
  const { jurisdictions, unknown } = parseEuHighRiskCountries(html);
  assert.deepEqual(unknown, []);
  assert.deepEqual(
    jurisdictions.map((item) => `${item.category.split('.')[0]}:${item.country}`),
    ['I:VU', 'I:VN', 'I:MM', 'III:KP'],
  );
});

// ---------- Migawki z repozytorium (data/) ----------

test('migawki: wszystkie listy wczytane, z adresem źródła, datą pobrania i licencją', () => {
  const lists = getDefaultRiskLists();
  assert.deepEqual(lists.missing, []);
  const ids = lists.snapshots.map((snapshot) => snapshot.list);
  assert.deepEqual(ids, ['ofac-sdn', 'ue-fsf', 'uk-sanctions', 'mswia', 'ue-wysokie-ryzyko', 'knf']);
  for (const snapshot of lists.snapshots) {
    assert.match(snapshot.source, /^https:\/\//, snapshot.list);
    assert.match(snapshot.retrievedAt, /^\d{4}-\d{2}-\d{2}T/, snapshot.list);
    assert.ok(snapshot.licence.length > 5, snapshot.list);
    assert.ok(snapshot.entries.length + (snapshot.jurisdictions?.length ?? 0) > 10, snapshot.list);
  }
});

test('prawdziwy adres z listy OFAC (kopia w packages/chain) — trafienie dokładne, flaga source_fact', () => {
  const chain = JSON.parse(readFileSync(new URL('../../chain/data/ofac-addresses.json', import.meta.url), 'utf8')) as { addresses: { address: string; entity: string }[] };
  const tron = chain.addresses.find((item) => item.address === 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81');
  assert.ok(tron, 'adres w kopii OFAC');
  const flags = riskListAddressFlags(['TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81']);
  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.list, 'ofac-sdn');
  assert.equal(flags[0]?.status, 'source_fact');
  assert.equal(flags[0]?.entryName, tron.entity);
  assert.match(flags[0]!.label, /^adres na liście sankcyjnej OFAC SDN/);
  assert.match(flags[0]!.url ?? '', /^https:\/\/sanctionssearch\.ofac\.treas\.gov\/Details\.aspx\?id=\d+$/);
  // Adres EVM z kopii OFAC zapisany wielkimi literami — ta sama postać adresu.
  const evm = chain.addresses.find((item) => /^0x[0-9a-fA-F]{40}$/.test(item.address))!;
  const match = matchRiskLists({ cryptoAddresses: [evm.address.toUpperCase().replace(/^0X/, '0x')] }).matches[0]!;
  assert.equal(match.strength, 'exact_identifier');
  assert.equal(match.entryName, evm.entity);
  // Każdy adres z kopii OFAC jest rozpoznawany (dołączenie po nazwie podmiotu bez strat).
  const all = riskListAddressFlags(chain.addresses.map((item) => item.address)).filter((flag) => flag.list === 'ofac-sdn');
  assert.equal(new Set(all.map((flag) => flag.address)).size, new Set(chain.addresses.map((item) => item.address)).size);
});

test('prawdziwe wpisy: imiennik bez drugiej cechy słaby, ze zgodnym państwem silny (OFAC, UK)', () => {
  const weak = matchRiskLists({ name: 'Mikhail Fridman', type: 'person' });
  assert.ok(weak.matches.length > 0);
  assert.ok(weak.matches.every((match) => match.confidence === 'weak'));
  const strong = matchRiskLists({ name: 'Mikhail Fridman', type: 'person', country: 'Rosja' });
  const lists = strong.matches.filter((match) => match.confidence === 'strong').map((match) => match.list);
  assert.ok(lists.includes('ofac-sdn') && lists.includes('uk-sanctions'), lists.join());
});

test('prawdziwe wpisy: polski zapis z MSWiA i cyrylica z listy UE', () => {
  const polish = matchRiskLists({ name: 'Michaił Fridman', type: 'person' }).matches;
  assert.equal(polish[0]?.list, 'mswia');
  assert.equal(polish[0]?.strength, 'exact_name');
  const cyrillic = matchRiskLists({ name: 'Евгений Ревенко', type: 'person' }).matches;
  assert.ok(cyrillic.some((match) => match.list === 'ue-fsf' && match.strength === 'exact_name'));
  assert.ok(cyrillic.some((match) => match.list === 'uk-sanctions'));
});

test('prawdziwe wpisy MSWiA: NIP i PESEL jako identyfikator (dopasowanie silne)', () => {
  const nip = matchRiskLists({ identifiers: [{ kind: 'NIP', value: '949-225-44-31' }] }).matches[0]!;
  assert.equal(nip.list, 'mswia');
  assert.equal(nip.strength, 'exact_identifier');
  assert.equal(nip.confidence, 'strong');
  assert.match(nip.entryName, /K Dystrybucja/);
});

test('słowa ogólne i krótkie nazwy nie dają trafień w prawdziwych listach', () => {
  for (const name of ['Bank', 'Global Trading Company', 'International Services Group', 'Li', 'Ali']) {
    assert.equal(matchRiskLists({ name }).matches.length, 0, name);
  }
});

test('KNF: ponowne użycie migawki łącznika rejestry-publiczne, oznaczenie „nie jest listą sankcyjną”', () => {
  assert.deepEqual(knfNames('„Bank Gospodarczy” prowadzący działalność poprzez platformy home.example.com'), ['Bank Gospodarczy']);
  assert.deepEqual(knfNames('1. Grand Example Ltd. z siedzibą w Republice Wysp Marshalla, administrator platformy'), ['Grand Example Ltd.']);
  const list = knfRiskList({
    zrodlo: 'KNF',
    strona: 'https://www.knf.gov.pl/dla_konsumenta/ostrzezenia_publiczne',
    pobrano: '2026-11-21T19:01:45.789Z',
    wpisy: [{ sekcja: 'Zawiadomienia z art. 178', lp: '1', nazwa: 'Przykład Inwest sp. z o.o. z siedzibą w Warszawie', identyfikatory: 'KRS 869136', prokuratura: 'PO', orzeczenia: '', informacje: '' }],
  });
  assert.equal(list.kind, 'warning');
  assert.deepEqual(list.entries[0]?.ids, [{ kind: 'KRS', value: '0000869136' }]);
  const loaded = loadRiskLists({ snapshots: [list] });
  const match = matchRiskLists({ identifiers: [{ kind: 'KRS', value: '0000869136' }] }, loaded).matches[0]!;
  assert.equal(match.listKind, 'warning');
  assert.match(match.caveat, /nie jest listą sankcyjną/);
});

test('sieć powiązań: odznaka „lista sankcyjna”, identyfikator = source_fact, sama nazwa = hipoteza', () => {
  const flags = checkNetworkNodes([
    { id: 'org-1', kind: 'organization', name: 'Inna Nazwa', identifiers: [{ kind: 'NIP', value: '9492254431' }] },
    { id: 'osoba-1', kind: 'person', name: 'Tatiana Bakalczuk' },
    { id: 'osoba-2', kind: 'person', name: 'Tatiana Bakalczuk', birthDate: '1975-10-16' },
    { id: 'osoba-3', kind: 'person', name: 'Zupełnie Nieznana Osoba' },
  ]);
  assert.deepEqual(flags.map((flag) => flag.nodeId), ['org-1', 'osoba-1', 'osoba-2']);
  assert.equal(flags[0]?.badge, 'lista sankcyjna');
  assert.equal(flags[0]?.status, 'source_fact');
  assert.equal(flags[1]?.status, 'hypothesis');
  assert.equal(flags[1]?.confidence, 'weak');
  assert.match(flags[1]!.summary, /możliwy imiennik/);
  assert.equal(flags[2]?.confidence, 'strong');
  assert.equal(checkNetworkNodes([{ id: 'osoba-1', kind: 'person', name: 'Tatiana Bakalczuk' }], { includeWeak: false }).length, 0);
});

test('graf teczki: wpis listy jako osobny węzeł, krawędź sanctions_hit dla adresu, odznaka na węźle sprawy', () => {
  const result = riskListGraph({
    nodes: [
      { id: 'addr:tron:TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81', kind: 'address', label: 'TNiq…H81' },
      { id: 'org:k-dystrybucja', kind: 'organization', label: 'K Dystrybucja sp. z o.o.' },
      { id: 'person:tb', kind: 'person', label: 'Tatiana Bakalczuk' },
      { id: 'profile:github|ktos', kind: 'profile', label: 'ktos' },
    ],
  }, { attributes: { 'org:k-dystrybucja': { identifiers: [{ kind: 'NIP', value: '9492254431' }] } } });
  const address = result.edges.find((edge) => edge.from.startsWith('addr:'))!;
  assert.equal(address.relation, 'sanctions_hit');
  assert.equal(address.status, 'source_fact');
  assert.match(address.to, /^sankcje:ofac-sdn:\d+$/);
  const entry = result.nodes.find((node) => node.id === address.to)!;
  assert.equal(entry.status, 'source_fact');
  assert.equal(entry.meta.sanctioned.entryId, address.to.split(':')[2]);
  assert.equal(result.badges['addr:tron:TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81']?.badge, 'lista sankcyjna');
  assert.equal(result.badges['org:k-dystrybucja']?.status, 'source_fact');
  // Sama nazwa bez drugiej cechy (słabe) nie trafia do grafu domyślnie.
  assert.equal(result.badges['person:tb'], undefined);
  assert.equal(result.edges.filter((edge) => edge.from === 'person:tb').length, 0);
  const weak = riskListGraph({ nodes: [{ id: 'person:tb', kind: 'person', label: 'Tatiana Bakalczuk' }] }, { includeWeak: true });
  assert.equal(weak.edges[0]?.relation, 'sanctions_name_match');
  assert.equal(weak.edges[0]?.status, 'hypothesis');
});

test('screenSanctions: kształt wyniku zgodny z adapterem ekspandera „listy-sankcyjne”', () => {
  const rows = screenSanctions({
    names: ['Inna Nazwa'],
    addresses: [{ network: 'tron', address: 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81' }],
    identifiers: ['NIP 949-225-44-31'],
  });
  // Ta sama reguła, którą adapter (apps/api/src/network/sanctions.ts) rozróżnia identyfikator i nazwę.
  const kind = (match: string) => (/address|identifier|exact|id/i.test(match) && !/name|fuzzy/i.test(match) ? 'identifier' : 'name');
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.equal(typeof row.list, 'string');
    assert.equal(typeof row.entryId, 'string');
    assert.equal(typeof row.entryName, 'string');
    assert.equal('entry' in row || 'name' in row, false);
    assert.equal(kind(row.match), 'identifier');
  }
  assert.ok(rows.some((row) => row.listId === 'ofac-sdn'));
  assert.ok(rows.some((row) => row.listId === 'mswia'));
  const byName = screenSanctions({ names: ['Tatiana Bakalczuk'] });
  assert.equal(kind(byName[0]!.match), 'name');
  assert.equal(byName[0]?.confidence, 'weak');
});

test('łącznik listy-sankcyjne: lokalny, wpis jako dokument „tylko nazwa” z zastrzeżeniem, bez adresów', async () => {
  const connector = createRiskListsConnector();
  assert.equal(connector.enabledByDefault, true);
  assert.deepEqual(connector.accepts, ['full_name', 'nick']);
  const documents = await connector.search({ type: 'full_name', value: 'Tatiana Bakalczuk' }, context);
  assert.ok(documents.length >= 1);
  const document = documents[0]!;
  assert.equal(document.identityMatch, 'name_only');
  assert.equal(document.service, 'gov.pl');
  assert.match(document.text, /NIE oznacza tożsamości/);
  const byNumber = await connector.search({ type: 'full_name', value: 'NIP 9492254431' }, context);
  assert.equal(byNumber[0]?.identityMatch, 'exact_identifier');
  // Nick — wyłącznie zgodność pełna; słowo ogólne — nic.
  assert.equal((await connector.search({ type: 'nick', value: 'bank' }, context)).length, 0);
  assert.ok(logs.some((line) => /sprawdzenie lokalne/.test(line)));
});
