import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAME_MATCH_CAVEAT,
  buildRiskIndex,
  countryCode,
  cryptoAddressKey,
  findListedAddresses,
  foldText,
  matchRiskLists,
  nameTokens,
  skeleton,
  transliterateCyrillic,
} from '../src/sanctions/index.ts';
import type { RiskListSnapshot } from '../src/sanctions/index.ts';

// Lista syntetyczna — nazwy i numery fikcyjne, układ jak w migawkach list urzędowych.
const LISTA: RiskListSnapshot = {
  list: 'test-sankcje',
  label: 'Lista testowa',
  authority: 'organ testowy',
  source: 'https://przyklad.test/lista.xml',
  page: 'https://przyklad.test/lista',
  entryUrl: 'https://przyklad.test/wpis/{id}',
  retrievedAt: '2026-11-21T12:00:00.000Z',
  licence: 'test',
  kind: 'sanctions',
  entries: [
    { id: 'P1', type: 'person', names: ['Ivan Petrovich SIDOROV', 'Иван Петрович Сидоров'], birthDates: ['1970-05-12'], countries: ['RU'], programmes: ['RUS'] },
    { id: 'P2', type: 'person', names: ['Grzegorz BRZĘCZYSZCZYKIEWICZ'], countries: ['BY'], birthDates: ['1981'] },
    { id: 'P3', type: 'person', names: ['Mikhail KHODOROVSKY'], weakNames: ['Misha KHODOR'], countries: ['RU'] },
    { id: 'O1', type: 'organization', names: ['ZOLOTOY MOST TRADING LLC', 'ООО Золотой Мост'], ids: [{ kind: 'Tax ID No.', value: '7701234567' }], countries: ['RU'] },
    { id: 'O2', type: 'organization', names: ['BANK'], countries: ['IR'] },
    { id: 'O3', type: 'organization', names: ['AL NOOR'], countries: ['AE'] },
    {
      id: 'A1',
      type: 'organization',
      names: ['PRZYKŁADOWA GIEŁDA KRYPTO'],
      crypto: [
        { asset: 'ETH', address: '0x1CAb8177ACe78b1B6B1c393371F4f2dCAE40CbEB' },
        { asset: 'XBT', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' },
      ],
    },
    { id: 'H1', type: 'person', names: ['Jan NOWAK-HISTORYCZNY'], delistedOn: '2024-12-31' },
  ],
};

const PANSTWA: RiskListSnapshot = {
  list: 'test-panstwa',
  label: 'Państwa testowe',
  authority: 'organ testowy',
  source: 'https://przyklad.test/panstwa',
  page: 'https://przyklad.test/panstwa',
  retrievedAt: '2026-11-21T12:00:00.000Z',
  licence: 'test',
  kind: 'jurisdiction',
  entries: [],
  jurisdictions: [{ country: 'KP', name: 'KRLD', category: 'III. wezwanie do działań' }],
};

const index = buildRiskIndex([LISTA, PANSTWA]);

test('normalizacja: polskie znaki diakrytyczne, cyrylica i formy prawne', () => {
  assert.equal(foldText('Łukasz Żółć-Gęślą'), 'lukasz zolc gesla');
  assert.equal(transliterateCyrillic('Сидоров'), 'sidorov');
  assert.equal(foldText('Іван Їжак'), 'ivan yizhak');
  assert.deepEqual(nameTokens('Zolotoy Most Trading LLC'), ['zolotoy', 'most', 'trading']);
  assert.deepEqual(nameTokens('Przykład sp. z o.o.'), ['przyklad']);
  assert.equal(skeleton('bakalczuk'), skeleton('bakalchuk'));
  assert.equal(skeleton('michail'), skeleton('mikhail'));
});

test('kody państw z nazw polskich i angielskich', () => {
  assert.equal(countryCode('Polska'), 'PL');
  assert.equal(countryCode('pl'), 'PL');
  assert.equal(countryCode('Russian Federation'), 'RU');
  assert.equal(countryCode('Federacja Rosyjska'), 'RU');
  assert.equal(countryCode('IRAN (ISLAMIC REPUBLIC OF)'), 'IR');
  assert.equal(countryCode('Vanuatu'), 'VU');
  assert.equal(countryCode('Wietnam'), 'VN');
  assert.equal(countryCode('Atlantyda'), undefined);
});

test('imiennik bez drugiej cechy — dopasowanie słabe z zastrzeżeniem', () => {
  const { matches } = matchRiskLists({ name: 'Ivan Sidorov' }, index);
  assert.equal(matches.length, 1);
  const match = matches[0]!;
  assert.equal(match.entryId, 'P1');
  assert.equal(match.strength, 'exact_name');
  assert.equal(match.confidence, 'weak');
  assert.equal(match.caveat, NAME_MATCH_CAVEAT);
  assert.ok(match.reasons.some((reason) => /możliwy imiennik/.test(reason)));
  assert.equal(match.url, 'https://przyklad.test/wpis/P1');
});

test('ta sama nazwa ze zgodnym państwem — dopasowanie silne', () => {
  const { matches } = matchRiskLists({ name: 'Ivan Sidorov', country: 'Rosja' }, index);
  assert.equal(matches[0]?.confidence, 'strong');
  assert.deepEqual(matches[0]?.corroboration, ['państwo zgodne (RU)']);
});

test('sprzeczna data urodzenia albo państwo — zawsze słabe', () => {
  const birth = matchRiskLists({ name: 'Ivan Sidorov', country: 'RU', birthDate: '1990-01-01' }, index).matches[0]!;
  assert.equal(birth.confidence, 'weak');
  assert.match(birth.conflicts.join(), /data urodzenia sprzeczna/);
  const country = matchRiskLists({ name: 'Ivan Sidorov', country: 'PL' }, index).matches[0]!;
  assert.equal(country.confidence, 'weak');
  assert.match(country.conflicts.join(), /państwo niezgodne/);
});

test('zgodna data urodzenia (pełna i sam rok) jest drugą cechą', () => {
  assert.equal(matchRiskLists({ name: 'Ivan Sidorov', birthDate: '1970-05-12' }, index).matches[0]?.confidence, 'strong');
  const year = matchRiskLists({ name: 'Grzegorz Brzęczyszczykiewicz', birthDate: '1981-03-04' }, index).matches[0]!;
  assert.equal(year.confidence, 'strong');
  assert.match(year.corroboration.join(), /rok/);
});

test('polskie znaki: zapis bez ogonków i inna kolejność słów dają pełną zgodność', () => {
  const { matches } = matchRiskLists({ name: 'BRZECZYSZCZYKIEWICZ grzegorz' }, index);
  assert.equal(matches[0]?.entryId, 'P2');
  assert.equal(matches[0]?.strength, 'exact_name');
  assert.match(matches[0]!.reasons[0]!, /kolejności słów/);
});

test('cyrylica: zapytanie łacinką trafia w alias cyrylicą i odwrotnie', () => {
  const latin = matchRiskLists({ name: 'Sidorov Ivan Petrovich' }, index).matches[0]!;
  assert.equal(latin.entryId, 'P1');
  assert.equal(latin.strength, 'exact_name');
  const cyrillic = matchRiskLists({ name: 'Иван Сидоров', type: 'person' }, index).matches[0]!;
  assert.equal(cyrillic.entryId, 'P1');
  assert.equal(cyrillic.strength, 'exact_name');
  const company = matchRiskLists({ name: 'Золотой Мост', type: 'organization' }, index).matches[0]!;
  assert.equal(company.entryId, 'O1');
});

test('warianty transliteracji: polski zapis „Michaił Chodorowski” jako nazwa przybliżona', () => {
  const { matches } = matchRiskLists({ name: 'Michaił Chodorowskij' }, index);
  assert.equal(matches[0]?.entryId, 'P3');
  assert.equal(matches[0]?.strength, 'fuzzy_name');
  assert.equal(matches[0]?.confidence, 'weak');
  // Przybliżona nazwa potrzebuje dwóch zgodnych cech.
  assert.equal(matchRiskLists({ name: 'Michaił Chodorowskij', country: 'RU' }, index).matches[0]?.confidence, 'weak');
});

test('alias słabej jakości daje wyłącznie dopasowanie słabe', () => {
  const match = matchRiskLists({ name: 'Misha Khodor', country: 'RU' }, index).matches[0]!;
  assert.equal(match.entryId, 'P3');
  assert.equal(match.confidence, 'weak');
  assert.ok(match.reasons.some((reason) => /alias słabej jakości/.test(reason)));
});

test('ochrona krótkich nazw: brak porównania i brak dopasowania przybliżonego', () => {
  const short = matchRiskLists({ name: 'Li' }, index);
  assert.equal(short.matches.length, 0);
  assert.match(short.notes[0]!, /zbyt krótkie/);
  // „Ivan Sido” — za krótkie na dopasowanie przybliżone (mniej niż 10 znaków), pełnej zgodności brak.
  assert.equal(matchRiskLists({ name: 'Ivan Sido' }, index).matches.length, 0);
  // Jedno słowo nie dopasowuje się do wielowyrazowego wpisu.
  assert.equal(matchRiskLists({ name: 'Sidorov' }, index).matches.length, 0);
});

test('brak fałszywych trafień dla słów ogólnych', () => {
  for (const name of ['Bank', 'Trading Company', 'Global Services Group', 'Al Bank']) {
    assert.equal(matchRiskLists({ name }, index).matches.length, 0, name);
  }
  // „Most” jest zwykłym słowem — samo nie dopasowuje się do „Zolotoy Most Trading”.
  assert.equal(matchRiskLists({ name: 'Most Logistics' }, index).matches.length, 0);
});

test('rodzaj węzła: osoba nie jest porównywana z wpisem organizacji', () => {
  assert.equal(matchRiskLists({ name: 'Zolotoy Most', type: 'person' }, index).matches.length, 0);
  assert.equal(matchRiskLists({ name: 'Zolotoy Most', type: 'organization' }, index).matches[0]?.entryId, 'O1');
});

test('identyfikator: dokładna zgodność numeru niezależnie od zapisu', () => {
  const match = matchRiskLists({ identifiers: [{ kind: 'INN', value: '770-123-45-67' }] }, index).matches[0]!;
  assert.equal(match.entryId, 'O1');
  assert.equal(match.strength, 'exact_identifier');
  assert.equal(match.confidence, 'strong');
  // Identyfikator jest też drugą cechą dla nazwy.
  const named = matchRiskLists({ name: 'Zolotoy Most Trading', identifiers: [{ kind: 'NIP', value: 'RU7701234567' }] }, index).matches[0]!;
  assert.equal(named.strength, 'exact_identifier');
});

test('adres kryptowalutowy: EVM bez rozróżniania wielkości liter, Base58 dokładnie', () => {
  const evm = matchRiskLists({ cryptoAddresses: ['0x1cab8177ace78b1b6b1c393371f4f2dcae40cbeb'] }, index).matches[0]!;
  assert.equal(evm.entryId, 'A1');
  assert.equal(evm.strength, 'exact_identifier');
  assert.ok(evm.reasons.some((reason) => /sieciach zgodnych z Ethereum/.test(reason)));
  assert.equal(matchRiskLists({ cryptoAddresses: ['1BoatSLRHtKNngkdXEeobR76b53LETtpyT'] }, index).matches[0]?.entryId, 'A1');
  assert.equal(matchRiskLists({ cryptoAddresses: ['1boatslrhtknngkdxeeobr76b53lettpyt'] }, index).matches.length, 0);
  assert.equal(cryptoAddressKey('BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ'), 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  const hits = findListedAddresses(['0x1CAB8177ACE78B1B6B1C393371F4F2DCAE40CBEB', '0x0000000000000000000000000000000000000001'], index);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.asset, 'ETH');
});

test('wpis wykreślony: dopasowanie historyczne, nigdy silne; można go pominąć', () => {
  const match = matchRiskLists({ name: 'Jan Nowak-Historyczny', country: 'PL' }, index).matches[0]!;
  assert.equal(match.delistedOn, '2024-12-31');
  assert.equal(match.confidence, 'weak');
  assert.equal(matchRiskLists({ name: 'Jan Nowak-Historyczny' }, index, { skipDelisted: true }).matches.length, 0);
});

test('państwo z listy wysokiego ryzyka — informacja o jurysdykcji, nie o osobie', () => {
  const result = matchRiskLists({ name: 'Ktoś Zupełnie Inny', country: 'Korea Północna' }, index);
  assert.equal(result.matches.length, 0);
  assert.equal(result.jurisdictions[0]?.country, 'KP');
  assert.equal(result.checked.length, 2);
});

test('wynik jest deterministyczny', () => {
  const query = { name: 'Ivan Petrovich Sidorov', aliases: ['Иван Сидоров'], country: 'RU' };
  assert.deepEqual(matchRiskLists(query, index), matchRiskLists(query, buildRiskIndex([LISTA, PANSTWA])));
});
