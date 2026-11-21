// Łącznik `rejestry-publiczne` — dopasowanie i rozbiór danych na fikcyjnych wpisach, bez internetu;
// na końcu kontrola spójności migawek dołączonych do repozytorium.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { IdentifierType, SourceDocument } from '@olcys/core';
import { coreName, createRegistriesConnector, normalizeName, parseCsv, parseEsmaCasps, parseKnfWarnings, registryQuery } from '../src/search/registries.ts';
import type { CaspSnapshot, KnfSnapshot, RdwwSnapshot, RegistryData } from '../src/search/registries.ts';

const DATA: RegistryData = {
  rdww: {
    zrodlo: 'Rejestr działalności w zakresie walut wirtualnych — Dyrektor Izby Administracji Skarbowej w Katowicach',
    strona: 'https://www.gov.pl/web/ias-katowice/rejestr-dzialalnosci-w-zakresie-walut-wirtualnych',
    plik: 'https://www.gov.pl/attachment/test',
    stanNa: '2026-07-02',
    wpisy: [
      { numer: 'RDWW-1', dataWpisu: '2021-11-05', nazwa: 'KANTOR TESTOWY SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', nip: '1111111111', krs: '0000000001', uslugi: ['wymiana_na_srodki_platnicze'] },
      { numer: 'RDWW-2', dataWpisu: '2022-01-10', nazwa: 'ŻANETA ŹDŹBŁOWSKA', nip: '2222222222', uslugi: ['wymiana_miedzy_walutami'], wykreslony: true },
      { numer: 'RDWW-3', dataWpisu: '2023-03-03', nazwa: 'KANTOR TESTOWY BIS SPÓŁKA AKCYJNA', nip: '3333333333', krs: '0000000003' },
      { numer: 'RDWW-4', dataWpisu: '2023-04-04', nazwa: 'WYMIENNIK.PL SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', nip: '4444444444', krs: '0000000004' },
    ],
  },
  knf: {
    zrodlo: 'Lista ostrzeżeń publicznych Komisji Nadzoru Finansowego',
    strona: 'https://www.knf.gov.pl/dla_konsumenta/ostrzezenia_publiczne',
    pobrano: '2026-11-21T19:00:00.000Z',
    wpisy: [
      { sekcja: 'Zawiadomienia z art. 178 ustawy o obrocie instrumentami finansowymi', lp: '1', nazwa: 'Zysk Pewny Ltd (działalność przez platformę www.zyskpewny.example)', identyfikatory: 'podmiot nie jest zarejestrowany w Polsce', prokuratura: 'Prokuratura Okręgowa w Warszawie', orzeczenia: '-', informacje: 'Zawiadomienie złożone przez UKNF.' },
      { sekcja: 'Zawiadomienia z art. 150 ustawy o usługach płatniczych', lp: '7', nazwa: 'Kantor Testowy sp. z o.o. z siedzibą w Nysie', identyfikatory: 'KRS 0000000001\nNIP 1111111111', prokuratura: 'Prokuratura Okręgowa w Opolu', orzeczenia: '-', informacje: 'Zawiadomienie złożone przez UKNF.' },
    ],
  },
  casp: {
    zrodlo: 'Tymczasowy rejestr MiCA — dostawcy usług w zakresie kryptoaktywów (ESMA)',
    strona: 'https://www.esma.europa.eu/mica',
    plik: 'https://www.esma.europa.eu/CASPS.csv',
    pobrano: '2026-11-21T19:00:00.000Z',
    wpisy: [{ organ: 'Organ Testowy', kraj: 'AT', nazwa: 'Gielda Testowa GmbH', lei: 'LEI00000000000000001', nazwaHandlowa: 'GieldaT', strona: 'https://www.gieldat.example', dataZezwolenia: '01/02/2025', uslugi: 'c. exchange of crypto-assets for funds', kraje: 'AT|PL' }],
  },
};

function setup(data: RegistryData = DATA) {
  const connector = createRegistriesConnector({ data });
  const logs: string[] = [];
  const search = (type: IdentifierType, value: string): Promise<SourceDocument[]> => connector.search({ type, value }, { log: (message) => void logs.push(message) });
  return { connector, logs, search };
}

describe('rejestry publiczne: rozpoznanie zapytania i nazwy', () => {
  test('nazwa bez formy prawnej, wielkości liter i znaków diakrytycznych', () => {
    assert.equal(normalizeName('Żółć-Łódź  S.A.'), 'zolc lodz s a');
    assert.equal(coreName('Kantor Testowy sp. z o.o.'), 'kantor testowy');
    assert.equal(coreName('KANTOR TESTOWY SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ W LIKWIDACJI'), 'kantor testowy');
  });

  test('numer, domena, nazwa; zbyt ogólne wartości są odrzucane', () => {
    assert.deepEqual(registryQuery({ type: 'nick', value: 'NIP: 111-111-11-11' }), { kind: 'number', digits: '1111111111' });
    assert.deepEqual(registryQuery({ type: 'nick', value: 'KRS 0000000001' }), { kind: 'number', digits: '0000000001' });
    assert.deepEqual(registryQuery({ type: 'nick', value: 'www.Wymiennik.pl' }), { kind: 'domain', host: 'wymiennik.pl' });
    assert.deepEqual(registryQuery({ type: 'profile_url', value: 'https://www.gieldat.example/pl/start' }), { kind: 'domain', host: 'gieldat.example' });
    assert.deepEqual(registryQuery({ type: 'full_name', value: 'Żaneta Źdźbłowska' }), { kind: 'name', core: 'zaneta zdzblowska' });
    assert.equal(registryQuery({ type: 'full_name', value: 'Kowalski' }), null);
    assert.equal(registryQuery({ type: 'nick', value: 'btc' }), null);
    assert.equal(registryQuery({ type: 'nick', value: '12345' }), null);
  });
});

describe('rejestry publiczne: łącznik', () => {
  test('opis mówi, że sprawdzenie jest lokalne; łącznik nie przyjmuje adresów ani e-maili', () => {
    const { connector } = setup();
    assert.match(connector.description, /LOKALNE \(zapytanie nie opuszcza systemu\)/);
    assert.deepEqual(connector.accepts, ['full_name', 'nick', 'profile_url']);
  });

  test('NIP: dokładny identyfikator w rejestrze walut wirtualnych i na liście KNF', async () => {
    const { search, logs } = setup();
    const documents = await search('nick', '1111111111');
    assert.deepEqual(documents.map((document) => document.service), ['gov.pl', 'knf.gov.pl']);
    assert.ok(documents.every((document) => document.identityMatch === 'exact_identifier' && document.category === 'forum_post' && document.connectorId === 'rejestry-publiczne'));
    const [rdww, knf] = documents;
    assert.equal(rdww!.url, 'https://www.gov.pl/web/ias-katowice/rejestr-dzialalnosci-w-zakresie-walut-wirtualnych#RDWW-1');
    assert.match(rdww!.text, /^Wpis w rejestrze publicznym — Rejestr działalności w zakresie walut wirtualnych/);
    assert.match(rdww!.text, /stan na 2026-07-02/);
    assert.match(rdww!.text, /Podstawa dopasowania: NIP 1111111111\./);
    assert.match(rdww!.text, /Rodzaj usług: wymiana pomiędzy walutami wirtualnymi i środkami płatniczymi/);
    assert.match(rdww!.text, /nie jest zezwoleniem/);
    assert.equal(rdww!.publishedAt, '2021-11-05T00:00:00.000Z');
    assert.match(knf!.text, /Źródło: https:\/\/www\.knf\.gov\.pl\/dla_konsumenta\/ostrzezenia_publiczne/);
    assert.match(knf!.text, /nie ustalenie winy/);
    assert.match(logs.at(-1)!, /2 wpisów \(sprawdzenie lokalne\)/);
  });

  test('nazwa firmy: zgodność po pominięciu formy prawnej oraz początek nazwy — zawsze „tylko nazwa"', async () => {
    const { search } = setup();
    const documents = await search('nick', 'Kantor Testowy Sp. z o.o.');
    assert.deepEqual(documents.map((document) => document.title.replace(/^.*?: /, '')), [
      'KANTOR TESTOWY SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ (RDWW-1)',
      'KANTOR TESTOWY BIS SPÓŁKA AKCYJNA (RDWW-3)',
      'Kantor Testowy sp. z o.o. z siedzibą w Nysie',
    ]);
    assert.ok(documents.every((document) => document.identityMatch === 'name_only'));
    assert.match(documents[0]!.text, /Zgodna jest tylko nazwa — możliwa zbieżność nazw/);
    assert.match(documents[1]!.text, /nazwa wpisu zaczyna się od szukanej nazwy/);
  });

  test('osoba fizyczna: kolejność imienia i nazwiska bez znaczenia, status wykreślenia w treści', async () => {
    const { search } = setup();
    const [document] = await search('full_name', 'Zdzblowska Zaneta');
    assert.equal(document!.identityMatch, 'name_only');
    assert.match(document!.text, /Status: wykreślony z rejestru/);
    assert.deepEqual(await search('full_name', 'Żaneta Inna'), []);
  });

  test('domena: wpis KNF z tą domeną, strona podmiotu w rejestrze ESMA, nazwa równa domenie w rejestrze walut', async () => {
    const { search } = setup();
    const knf = await search('profile_url', 'https://zyskpewny.example/logowanie');
    assert.equal(knf.length, 1);
    assert.equal(knf[0]!.service, 'knf.gov.pl');
    assert.equal(knf[0]!.identityMatch, 'exact_identifier');
    // Inna domena kończąca się tak samo nie pasuje.
    assert.deepEqual(await search('nick', 'niezyskpewny.example'), []);
    assert.deepEqual(await search('nick', 'pewny.example'), []);

    const casp = await search('nick', 'gieldat.example');
    assert.equal(casp[0]!.service, 'esma.europa.eu');
    assert.match(casp[0]!.text, /Państwa świadczenia usług: AT\|PL \(w tym Polska\)/);
    assert.equal(casp[0]!.url, 'https://www.esma.europa.eu/mica#LEI00000000000000001');

    const rdww = await search('nick', 'wymiennik.pl');
    assert.equal(rdww[0]!.service, 'gov.pl');
    assert.equal(rdww[0]!.identityMatch, 'name_only');
  });

  test('nazwa handlowa w rejestrze ESMA', async () => {
    const { search } = setup();
    const [document] = await search('nick', 'gieldat');
    assert.match(document!.title, /Gielda Testowa GmbH/);
    assert.equal(document!.identityMatch, 'name_only');
  });

  test('brak migawki jest zgłaszany w dzienniku, bez wyjątku', async () => {
    const { search, logs } = setup({});
    assert.deepEqual(await search('nick', '1111111111'), []);
    assert.ok(logs.some((line) => /brak migawki — rejestr walut wirtualnych, lista KNF, rejestr ESMA/.test(line)));
  });
});

describe('rejestry publiczne: rozbiór opublikowanych danych', () => {
  test('lista KNF: tytuł tabeli z akapitu nad nią, sześć komórek w wierszu, encje i znaczniki usunięte', () => {
    const html =
      '<section><div><p class="t">Zawiadomienia o podejrzeniu popełnienia przestępstwa z art. 178 ustawy</p></div><div><table class="warning-list-table"><thead><tr><th>Lp.</th></tr></thead><tbody>' +
      '<tr><td>1<!-- -->.</td><td class="break-words"><span>Bulls&amp;Bears Trades (www.bb.example)</span></td><td><span>KRS 0000000009\n\n NIP 9999999999</span></td><td><span>Prokuratura Okręgowa w Warszawie</span></td><td><span>-</span></td><td><span>Zawiadomienie złożone przez UKNF.</span></td></tr>' +
      '<tr><td>2.</td><td></td><td></td><td></td><td></td><td></td></tr></tbody></table></div></section>';
    assert.deepEqual(parseKnfWarnings(html), [
      {
        sekcja: 'Zawiadomienia o podejrzeniu popełnienia przestępstwa z art. 178 ustawy',
        lp: '1',
        nazwa: 'Bulls&Bears Trades (www.bb.example)',
        identyfikatory: 'KRS 0000000009\nNIP 9999999999',
        prokuratura: 'Prokuratura Okręgowa w Warszawie',
        orzeczenia: '-',
        informacje: 'Zawiadomienie złożone przez UKNF.',
      },
    ]);
  });

  test('CSV z polami w cudzysłowach i rejestr ESMA', () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n"x, ""y""",z\n\n'), [['a', 'b'], ['x, "y"', 'z']]);
    const csv =
      'ae_competentAuthority,ae_homeMemberState,ae_lei_name,ae_lei,ae_commercial_name,ae_address,ae_website,ac_authorisationNotificationDate,ac_serviceCode,ac_serviceCode_cou\n' +
      'Organ,AT,Gielda Testowa GmbH,LEI1,GieldaT,"Ulica 1, 1020 Wien",https://www.gieldat.example,01/02/2025,c. exchange,AT|PL\n' +
      'Organ,DE,,LEI2,,,,,,\n';
    assert.deepEqual(parseEsmaCasps(csv), [
      { organ: 'Organ', kraj: 'AT', nazwa: 'Gielda Testowa GmbH', lei: 'LEI1', nazwaHandlowa: 'GieldaT', adres: 'Ulica 1, 1020 Wien', strona: 'https://www.gieldat.example', dataZezwolenia: '01/02/2025', uslugi: 'c. exchange', kraje: 'AT|PL' },
    ]);
    assert.deepEqual(parseEsmaCasps('inne,kolumny\n1,2\n'), []);
  });
});

describe('rejestry publiczne: migawki dołączone do repozytorium', () => {
  const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../src/search/data/${name}`, import.meta.url), 'utf8')) as T;

  test('rejestr walut wirtualnych: komplet numerów, poprawne NIP i daty', () => {
    const snapshot = read<RdwwSnapshot>('rdww.json');
    assert.ok(snapshot.wpisy.length >= 1800);
    assert.equal(new Set(snapshot.wpisy.map((entry) => entry.numer)).size, snapshot.wpisy.length);
    for (const entry of snapshot.wpisy) {
      assert.match(entry.numer, /^RDWW-\d+$/);
      assert.match(entry.nip, /^\d{10}$/);
      assert.match(entry.dataWpisu, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(entry.nazwa.length >= 3 && !entry.nazwa.includes('---'), entry.numer);
      if (entry.krs) assert.match(entry.krs, /^\d{10}$/);
    }
    assert.match(snapshot.stanNa, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('lista KNF i rejestr ESMA: wpisy mają nazwę i źródło', () => {
    const knf = read<KnfSnapshot>('knf-ostrzezenia.json');
    assert.ok(knf.wpisy.length >= 500);
    assert.ok(knf.wpisy.every((entry) => entry.nazwa && entry.sekcja && /^\d+$/.test(entry.lp)));
    assert.equal(knf.strona, 'https://www.knf.gov.pl/dla_konsumenta/ostrzezenia_publiczne');
    const casp = read<CaspSnapshot>('esma-casp.json');
    assert.ok(casp.wpisy.length >= 100);
    assert.ok(casp.wpisy.every((entry) => entry.nazwa && /^[A-Z]{2}$/.test(entry.kraj)));
  });

  test('łącznik czyta migawki z plików', async () => {
    const connector = createRegistriesConnector();
    const documents = await connector.search({ type: 'nick', value: '0000000000' }, { log: () => undefined });
    assert.deepEqual(documents, []);
  });
});
