import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIGNAL_RULES, detectLanguage, polishNexus, suspicion } from '../src/signals.ts';
import type { SignalInput } from '../src/signals.ts';

const doc = (text: string, extra: Partial<SignalInput> = {}): SignalInput => ({ text, ...extra });
const weights = SIGNAL_RULES.polishWeights;
const suspicionWeights = SIGNAL_RULES.suspicionWeights;

/** Czy wśród przesłanek jest taka, która zaczyna się od etykiety i cytuje fragment. */
const cites = (reasons: string[], label: string, fragment: string) =>
  reasons.some((reason) => reason.startsWith(label) && reason.includes(fragment));

test('detektor języka: polski, angielski i tekst nierozstrzygnięty', () => {
  assert.equal(detectLanguage('Sprzedam koparkę, odbiór osobisty w Bydgoszczy, płatność też w BTC.').language, 'pl');
  // Polski bez ogonków też jest rozpoznawany po słowach funkcyjnych.
  assert.equal(detectLanguage('Sprzedam tanio, tylko odbior osobisty, kontakt przez telefon, nie wysylam').language, 'pl');
  assert.equal(detectLanguage('Selling my mining rig, only cash, you can contact me for the price.').language, 'en');
  assert.equal(detectLanguage('BTC 0.5').language, 'und');
  assert.equal(detectLanguage('Verkaufe Bitcoin gegen Bargeld').language, 'und');
});

test('związek z Polską: każdy rodzaj sygnału osobno, z cytatem', () => {
  const cases: [string, SignalInput, string, string, number][] = [
    ['język polski', doc('Sprzedam koparkę, płatność przelewem lub gotówką, nie wysyłam.'), 'Treść po polsku', 'słowa funkcyjne', weights.language!],
    ['waluta', doc('Price 4500 PLN, shipping included'), 'Polska waluta', '4500 PLN', weights.currency!],
    ['waluta zł', doc('cena 300 zł'), 'Polska waluta', '300 zł', weights.currency!],
    ['BLIK', doc('payment via BLIK accepted'), 'BLIK', 'via BLIK', weights.blik!],
    ['przelew na telefon', doc('please pay przelewem na telefon'), 'Przelew na telefon', 'przelewem na telefon', weights.phoneTransfer!],
    ['bank', doc('transfer from mBank or Revolut PL'), 'Polski bank lub fintech', 'mBank', weights.bank!],
    ['giełda', doc('I withdraw through Zonda'), 'Polska giełda lub kantor kryptowalut', 'Zonda', weights.cryptoExchange!],
    ['telefon +48', doc('call +48 601 234 567'), 'Numer telefonu z prefiksem +48', '+48 601 234 567', weights.phonePlus48!],
    ['telefon 9 cyfr', doc('tel. 601-234-567'), 'Dziewięciocyfrowy numer w polskim układzie', '601-234-567', weights.phoneNineDigits!],
    ['miasto z ogonkami', doc('meet in Łódź'), 'Polskie miasto lub region', 'Łódź', weights.place!],
    ['miasto bez ogonków', doc('meet in Wroclaw'), 'Polskie miasto lub region', 'Wroclaw', weights.place!],
    ['województwo', doc('region: małopolskie'), 'Polskie miasto lub region', 'małopolskie', weights.place!],
    ['kraj', doc('shipping only within Poland'), 'Wzmianka o Polsce', 'Poland', weights.country!],
    ['serwis', doc('pickup at paczkomaty InPost'), 'Polski serwis', 'paczkomaty', weights.polishService!],
    ['domena w treści', doc('more at sklep-kowalski.pl today'), 'Domena .pl w treści', 'sklep-kowalski.pl', weights.domainPl!],
    ['domena serwisu', doc('hello', { url: 'https://forum.bitcoin.pl/t/1' }), 'Publikacja w serwisie z domeny .pl', 'forum.bitcoin.pl', weights.domainPl!],
    ['imię w nazwie', doc('hello', { author: 'krypto_janek' }), 'Polskie imię w nazwie autora', 'krypto_janek', weights.firstName!],
    ['lokalizacja profilu', doc('hello', { profile: { location: 'Gdansk, PL' } }), 'Lokalizacja profilu', 'Gdansk, PL', weights.profileLocation!],
    ['flaga', doc('trader 🇵🇱 since 2017'), 'Flaga lub strefa czasowa Polski', '🇵🇱', weights.flagOrTimezone!],
    ['strefa czasowa', doc('my timezone is Europe/Warsaw'), 'Flaga lub strefa czasowa Polski', 'europe/warsaw', weights.flagOrTimezone!],
  ];
  for (const [name, input, label, fragment, weight] of cases) {
    const result = polishNexus(input);
    assert.ok(cites(result.reasons, label, fragment), `${name}: brak przesłanki „${label}” z „${fragment}” w ${JSON.stringify(result.reasons)}`);
    assert.equal(result.score, weight, `${name}: wynik`);
    assert.equal(result.reasons.length, 1, `${name}: dokładnie jeden sygnał`);
  }
});

test('związek z Polską: angielski tekst z polskimi sygnałami jest wysoko, bez nich — nisko', () => {
  const polishInEnglish = polishNexus(doc('Selling BTC for cash in Warsaw, BLIK ok'));
  assert.equal(polishInEnglish.language, 'en');
  assert.equal(polishInEnglish.score, weights.place! + weights.blik!);
  assert.ok(polishInEnglish.score >= SIGNAL_RULES.thresholds.hitPolishNexus);

  const generic = polishNexus(doc('Selling BTC for cash in Berlin, PayPal ok. Contact me for the price.', { author: 'crypto_mike' }));
  assert.equal(generic.score, 0);
  assert.deepEqual(generic.reasons, []);
  assert.equal(generic.language, 'en');

  // Wiele sygnałów sumuje się, ale ocena nie przekracza 100.
  const full = polishNexus(
    doc('Sprzedam BTC za gotówkę w Krakowie, możliwy BLIK lub przelew z mBank, tel. +48 600 100 200, cena 250 000 zł.', {
      author: 'marek88',
      profile: { location: 'Kraków, Polska' },
    }),
  );
  assert.equal(full.score, 100);
  assert.equal(full.language, 'pl');
  assert.ok(full.reasons.length >= 7);
});

test('sygnały obrotu: każdy rodzaj osobno, nazwany jako wskazówka z cytatem', () => {
  const cases: [string, string, string, string, number][] = [
    ['oferta sprzedaży', 'Sprzedam BTC', 'Oferta kupna, sprzedaży lub wymiany kryptowalut', 'Sprzedam BTC', suspicionWeights.tradeOffer!],
    ['oferta kupna', 'Kupię USDT od ręki'.replace(' od ręki', ''), 'Oferta kupna, sprzedaży lub wymiany kryptowalut', 'Kupię USDT', suspicionWeights.tradeOffer!],
    ['oferta po angielsku', 'WTS bitcoin', 'Oferta kupna, sprzedaży lub wymiany kryptowalut', 'WTS', suspicionWeights.tradeOffer!],
    ['gotówka', 'tylko gotówką', 'Gotówka lub transakcja osobista', 'gotówką', suspicionWeights.cashOrInPerson!],
    ['odbiór osobisty', 'odbiór osobisty w centrum', 'Gotówka lub transakcja osobista', 'odbiór osobisty', suspicionWeights.cashOrInPerson!],
    ['F2F', 'F2F only', 'Gotówka lub transakcja osobista', 'F2F', suspicionWeights.cashOrInPerson!],
    ['mała kwota', 'cena 300 zł', 'Podana kwota', '300 zł', suspicionWeights.amountMentioned!],
    ['znaczna kwota', 'mam 15 000 zł', 'Znaczna kwota', '15 000 zł', suspicionWeights.amountSignificant!],
    ['duża kwota', 'do wydania 0.5 BTC', 'Duża kwota', '0.5 BTC', suspicionWeights.amountLarge!],
    ['kwota ze skrótem', 'budget 30k USD', 'Duża kwota', '30k USD', suspicionWeights.amountLarge!],
    ['bez KYC', 'transakcja bez KYC', 'Oferta bez weryfikacji tożsamości', 'bez KYC', suspicionWeights.noKyc!],
    ['no KYC', 'fast, no KYC', 'Oferta bez weryfikacji tożsamości', 'no KYC', suspicionWeights.noKyc!],
    ['stała działalność', 'skupuję codziennie', 'Oznaki stałej działalności', 'skupuję', suspicionWeights.regularActivity!],
    ['płatność w krypto', 'serwis telefonów, przyjmuję krypto', 'Przyjmowanie płatności w kryptowalutach', 'przyjmuję krypto', suspicionWeights.cryptoPayments!],
    ['wypłata na konto', 'szybka wypłata na konto', 'Wypłata na konto lub kartę', 'wypłata na konto', suspicionWeights.payoutToAccount!],
    ['adres do wpłaty', 'podaj adres, wyślę od razu', 'Adres do wpłaty', 'podaj adres', suspicionWeights.depositAddressRequest!],
  ];
  for (const [name, text, label, fragment, weight] of cases) {
    // Sygnały liczą się tylko w kontekście kryptowalut — tutaj: publikacja z adresem.
    const result = suspicion(doc(text), { hasAddress: true });
    assert.ok(cites(result.reasons, label, fragment), `${name}: brak „${label}” z „${fragment}” w ${JSON.stringify(result.reasons)}`);
    // „skupuję codziennie” to także czasownik obrotu, ale bez nazwy kryptowaluty nie jest ofertą.
    assert.equal(result.score, weight, `${name}: wynik`);
  }
});

test('sygnały obrotu: zwykła treść daje zero, pełna oferta — wysoki wynik bez przekroczenia 100', () => {
  assert.deepEqual(suspicion(doc('Sprzedam rower górski, stan bardzo dobry, wysyłka kurierem.')), { score: 0, reasons: [] });
  // Sama nazwa kryptowaluty ani samo „sprzedam” nie są ofertą obrotu.
  assert.equal(suspicion(doc('Bitcoin znowu drożeje, ciekawe co dalej.')).score, 0);
  // Adres kryptowalutowy nie jest odczytywany jako kwota.
  assert.equal(suspicion(doc('adres 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).score, 0);

  const offer = suspicion(doc('Skupuję BTC i USDT hurtowo, każda ilość, gotówka od ręki, bez KYC. Do 200 000 zł dziennie, wypłata na konto też możliwa.'));
  assert.equal(offer.score, 100);
  assert.ok(offer.reasons.length >= 5);
  assert.ok(offer.reasons.every((reason) => /\(\+\d+\)$/.test(reason)));

  // Bez oferty obrotu kryptowalutą i bez adresu: zero, choć są gotówka, odbiór osobisty i kwota.
  assert.deepEqual(suspicion(doc('Sprzedam komputer, 3 500 zł, tylko gotówka i odbiór osobisty w Krakowie, codziennie po 17.')), { score: 0, reasons: [] });
  assert.equal(suspicion(doc('Pożyczę 15 000 zł, spłata gotówką. Bitcoin mnie nie interesuje.')).score, 0);
  // To samo ogłoszenie z adresem kryptowalutowym jest już kontekstem krypto.
  assert.ok(suspicion(doc('Sprzedam komputer, 3 500 zł, tylko gotówka i odbiór osobisty.'), { hasAddress: true }).score >= 30);

  const english = suspicion(doc('Selling BTC for cash in Warsaw, BLIK ok'));
  assert.equal(english.score, suspicionWeights.tradeOffer! + suspicionWeights.cashOrInPerson!);
});

test('oferta obrotu to forma ofertowa z nazwą kryptowaluty zaraz po niej — nie artykuł i nie ogłoszenie o sprzęcie', () => {
  const offers = ['Sprzedam BTC za gotówkę', 'Kupię / sprzedam USDT — gotówka', 'Skup bitcoin i ethereum, Lublin', 'WTS 2 BTC', 'Selling USDT, F2F only'];
  for (const text of offers) assert.ok(suspicion(doc(text)).score >= 30, text);

  const notOffers = [
    // Rzeczowniki z artykułów.
    'Od 1 lipca KYC przy każdej sprzedaży kryptowalut w bitomatach — nowe przepisy.',
    'Jak rozliczyć sprzedaż bitcoina i wymianę kryptowalut w zeznaniu rocznym?',
    // Ogłoszenie o sprzęcie: nazwa kryptowaluty pada daleko za „sprzedam”.
    'Sprzedam kartę graficzną Radeon RX 6600, stan idealny, na gwarancji, nigdy nie była używana do kopania kryptowalut.',
    'Sprzedam komputer PC Ryzen 7, 16 GB RAM, dysk SSD; odbiór osobisty Kraków; nie kopał bitcoin.',
    'Bitcoin spadł do 17000 USD! Z okazji mogli skorzystać nieliczni kupujący.',
  ];
  for (const text of notOffers) assert.deepEqual(suspicion(doc(text)), { score: 0, reasons: [] }, text);
});
