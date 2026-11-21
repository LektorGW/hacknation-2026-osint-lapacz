// Wskaźnik D — sygnały możliwej niezgłoszonej działalności gospodarczej (dwie ścieżki: działalność możliwie
// niezgłoszona oraz podmiot zarejestrowany). Osoby, firmy i serwisy są fikcyjne.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChainActivity, Transfer } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import {
  BUSINESS_RULES,
  assessBusinessActivity,
  businessSignalsFor,
  businessTextOf,
  groupOffers,
  registryDetailsOf,
} from '../src/business.ts';
import type { BusinessPublication, BusinessRegistryRecord } from '../src/business.ts';
import { renderBusinessSection } from '../src/report-business.ts';
import { cleanReplyPayload } from '../src/service-reply.ts';
import type { ServiceReply } from '../src/service-reply.ts';
import { BTC_A, BTC_EXCHANGE, cashOut, chainWith, dossierOf, fakeActivity, fakeConnector, transfer } from './helpers.ts';

const PAYERS = [
  'bc1ql5vwtlkruygfj599mev8ntffp59xkmxuz08l8d',
  'bc1q0g7lfxtuzndldalqdhgjhcvn37qa5mgw6d492z',
  'bc1qjd2cdzqeggq6zym3dtlwjcf0uu6dlmpwgm6nwd',
  'bc1q8ez7kxtca5g0fff4dt9njcad75th4nl8f7x0es',
  'bc1q03n7qhh3hcrk6jnamh4up3phczugel5glx8nf4',
  'bc1q9s8yt2u2v7tu5dluxsv8cqeq3nrehpq9m3fkd9',
  'bc1qymkzpt7lg4ap6fzjmvv2z7fgx7sdyjfn2vcayu',
  'bc1qcf3jmhnvffrmtzerj8ds8expxkgucs24nrscpx',
  'bc1qs6v82phvemsstkckpy4gsgzddknjz88l477l44',
  'bc1qrcluncvkkskagpy53pcmleeysjnn3tgk8hdvt2',
  'bc1qfugwsjh8yse5kpzs82502ypefwz3kzjkfvtggs',
  'bc1qfk6xkqneex5mwqddmh3ze2fnzskfhvpjg6jwvy',
];

/** Dwanaście wpłat od dwunastu nadawców w ośmiu miesiącach 2025 r. i comiesięczne wpłaty na giełdę (z wyceną). */
function sellerChain(): { transfers: Transfer[]; cashOuts: ReturnType<typeof cashOut>[] } {
  const months = ['01', '02', '03', '04', '05', '06', '07', '08'];
  const inflows = PAYERS.map((payer, index) =>
    transfer(100 + index, { direction: 'in', counterparty: payer, counterpartyClass: 'unknown', time: `2025-${months[index % months.length]}-1${index % 9}T12:00:00.000Z`, amount: 0.002 }),
  );
  const exits = months.map((month, index) => transfer(200 + index, { counterparty: BTC_EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Giełda Testowa', time: `2025-${month}-25T12:00:00.000Z`, amount: 0.003 }));
  // Wypłata z giełdy na adres podmiotu — przeniesienie własnych środków, nie zapłata klienta.
  const withdrawal = transfer(300, { direction: 'in', counterparty: BTC_EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Giełda Testowa', time: '2025-03-02T12:00:00.000Z', amount: 0.01 });
  return { transfers: [...inflows, ...exits, withdrawal], cashOuts: exits.map((item) => cashOut(item, 990)) };
}

const activity = (spec: { transfers: Transfer[]; cashOuts?: ReturnType<typeof cashOut>[]; addressClass?: ChainActivity['profile']['addressClass'] }): ChainActivity => ({
  ...fakeActivity('bitcoin', BTC_A, spec.addressClass ?? 'private'),
  transfers: spec.transfers,
  cashOuts: spec.cashOuts ?? [],
});

const pub = (url: string, text: string, extra: Partial<BusinessPublication> = {}): BusinessPublication => {
  const signals = businessTextOf({ text, url });
  return { url, service: new URL(url).hostname, category: 'sale_offer', ...(signals ? { signals } : {}), ...extra };
};

// ---------- Sygnały w treści ----------

test('sygnały w treści: przyjmowanie płatności w BTC, cennik, kontakt w sprawie zamówień, oferta P2P i związek z Polską', () => {
  const shop = businessTextOf({ text: 'Cennik: etui 40 zł/szt. Przyjmuję płatność w BTC lub USDT. Zamówienia: pisz na priv lub telegram. Wysyłka z Krakowa.' })!;
  assert.ok(shop.quotes.accepts_crypto && /BTC/.test(shop.quotes.accepts_crypto));
  assert.ok(shop.quotes.price_list);
  assert.ok(shop.quotes.contact_for_orders);
  assert.ok((shop.nexus?.score ?? 0) >= BUSINESS_RULES.polishNexusMin);
  const p2p = businessTextOf({ text: 'Sprzedam BTC za gotówkę, kurs dnia, Warszawa.' })!;
  assert.ok(p2p.quotes.p2p);
  // Sprzedaż sprzętu za kryptowalutę to nie wymiana kryptowalut.
  const rig = businessTextOf({ title: 'Sprzedam koparkę ASIC 110 TH/s — płatność w BTC mile widziana', text: 'Stan: używana, odbiór w Bydgoszczy.' })!;
  assert.equal(rig.quotes.p2p, undefined);
  assert.ok(rig.quotes.accepts_crypto);
  const donation = businessTextOf({ text: 'Wesprzyj projekt — darowizny w BTC mile widziane.' })!;
  assert.ok(donation.quotes.donation);
  assert.equal(donation.quotes.price_list, undefined);
});

test('dane rejestrów: odczyt wykazu VAT (status, daty, rachunki) i KRS (PKD, kapitał, organ)', () => {
  const vat = registryDetailsOf(
    'live-vat-whitelist',
    [
      'Wpis w urzędowym wykazie podatników VAT (stan na 2026-11-21)',
      'Nazwa: FIKCYJNA FIRMA SP. Z O.O.',
      'NIP: 5260250274',
      'KRS: 0000123456',
      'Status VAT: Zwolniony',
      'Data rejestracji jako podatnik VAT: 2025-02-01',
      'Reprezentanci: Jan Fikcyjny',
      'Numery rachunków w wykazie: 61109010140000071219812874',
    ].join('\n'),
  )!;
  assert.deepEqual([vat.nip, vat.krs, vat.vatStatus, vat.registrationDate, vat.accounts, vat.people], ['5260250274', '0000123456', 'Zwolniony', '2025-02-01', ['61109010140000071219812874'], ['Jan Fikcyjny']]);
  const krs = registryDetailsOf(
    'live-krs',
    ['Nazwa: FIKCYJNA FIRMA SP. Z O.O.', 'KRS: 0000123456', 'Data rejestracji w KRS: 2025-01-15', 'ZARZĄD (dane osobowe zamaskowane przez rejestr):', '- J*** F*** — PREZES ZARZĄDU', 'Kapitał zakładowy: 5000,00 PLN', 'PKD: 56.10.A — RESTAURACJE; 96.02.Z — FRYZJERSTWO'].join('\n'),
  )!;
  assert.deepEqual(krs.pkd.map((item) => item.code), ['56.10.A', '96.02.Z']);
  assert.equal(krs.capital, '5000,00 PLN');
  assert.ok(krs.people.some((item) => /PREZES/.test(item)));
  assert.equal(registryDetailsOf('sandbox-targ', 'Nazwa: X'), undefined);
});

// ---------- Kopie liczone raz ----------

test('kopie oferty liczą się raz: archiwum, ta sama treść w drugim serwisie tego samego dnia; ponowne wystawienie po tygodniach to nowa oferta', () => {
  const text = 'Sprzedam etui do telefonów, cennik 40 zł/szt, przyjmuję płatność w BTC. Wysyłka codziennie, zamówienia na priv.';
  const offers = [
    pub('https://targ.example/oferta/1', text, { publishedAt: '2025-03-01T10:00:00.000Z', contentHash: 'a' }),
    pub('https://web.archive.org/web/20250302000000/https://targ.example/oferta/1', text, { archivedAt: '2025-03-02T00:00:00.000Z', contentHash: 'b' }),
    pub('https://bazar.example/ogloszenie/7', text, { publishedAt: '2025-03-01T18:00:00.000Z', contentHash: 'c' }),
    pub('https://targ.example/oferta/2', text, { publishedAt: '2025-05-10T10:00:00.000Z', contentHash: 'd' }),
  ];
  const groups = groupOffers(offers);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.publications.length, 3);

  const result = assessBusinessActivity({ id: 't', subject: { kind: 'subject', label: 'Test' }, publications: offers, addresses: [] });
  const repeated = result.indicator.components.find((item) => item.rule === 'business.repeated_offers')!;
  assert.equal(repeated.weight, BUSINESS_RULES.weights.repeatedOffers.two + BUSINESS_RULES.weights.repeatedOffers.multiService);
  assert.match(repeated.independenceNote ?? '', /4 publikacje → 2 oferty/);
  // Składniki z tej samej publikacji nie są doliczane drugi raz.
  assert.ok(result.indicator.components.every((item) => item.direction === 'contradicts' || item.applied >= 0));
});

// ---------- Ścieżka 1: działalność możliwie niezgłoszona ----------

test('sprzedawca: wiele ofert, wielu wpłacających, regularne wpływy i kwoty detaliczne — istotne przesłanki, obrót roczny i lista sprawdzeń', () => {
  const chain = sellerChain();
  const text = (n: number) => `Sprzedam etui model ${n}, cennik od 40 zł/szt. Płatność w BTC. Zamówienia: pisz na priv. Wysyłka z Krakowa, tel. +48 600 100 200.`;
  const result = assessBusinessActivity({
    id: 't',
    subject: { kind: 'subject', label: 'Sprzedawca' },
    publications: [
      pub('https://targ.example/oferta/1', text(1), { publishedAt: '2025-01-10T00:00:00.000Z' }),
      pub('https://targ.example/oferta/2', text(2), { publishedAt: '2025-04-10T00:00:00.000Z' }),
      pub('https://bazar.example/ogl/3', text(3), { publishedAt: '2025-07-10T00:00:00.000Z' }),
    ],
    addresses: [{ address: BTC_A, network: 'bitcoin', chain: activity(chain) }],
    valuations: chain.cashOuts.map((item) => ({ asset: 'BTC', time: item.time, amount: item.amount, valuePln: item.valuePln! })),
    registry: { connectorsUsed: ['rejestry-publiczne'], identifiers: [{ type: 'nick', value: 'etui_kowalski' }], records: [] },
  });
  const rules = result.indicator.components.map((item) => item.rule);
  for (const rule of ['business.repeated_offers', 'business.many_payers', 'business.regular_inflows', 'business.retail_amounts', 'business.turnover', 'business.accepts_crypto_payments', 'business.price_list_or_service_ad', 'business.contact_for_orders', 'business.polish_nexus', 'business.registry_none_found']) {
    assert.ok(rules.includes(rule), `brak składnika ${rule}`);
  }
  assert.ok(result.indicator.score >= 60, `wynik ${result.indicator.score}`);
  assert.equal(result.status, 'hypothesis');
  assert.equal(result.track, 'unregistered');
  assert.equal(result.registered, undefined);
  // Wypłata z giełdy nie jest wpłacającym; obrót to suma wpływów wycenionych kursem z wypłat (330 zł / 0,001 BTC).
  assert.equal(result.turnover[0]!.payers, 12);
  assert.equal(result.turnoverPlnByYear['2025'], 7920);
  const many = result.indicator.components.find((item) => item.rule === 'business.many_payers')!;
  assert.match(many.explanation, /Wypłaty z giełd \(1\)/);
  // Wyszukiwanie wyłącznie po nazwie: słaba waga i jawne ograniczenie.
  const none = result.indicator.components.find((item) => item.rule === 'business.registry_none_found')!;
  assert.equal(none.weight, BUSINESS_RULES.weights.registryNoneFound.name);
  assert.ok(none.limitations.some((item) => /inną zarejestrowaną nazwą/.test(item)));
  assert.ok(result.indicator.limitations.some((item) => /CEIDG nie był sprawdzany/.test(item)));
  assert.ok(result.registryCheck.find((item) => item.connectorId === 'live-ceidg')!.status === 'not_checked');
  assert.ok(result.whatToVerify.some((item) => /PIT-38.*2025/.test(item)));
  assert.ok(result.whatToVerify.some((item) => /CEIDG/.test(item)));
  assert.ok(result.whatToVerify.every((item) => !/nie złożył|nie zapłacił|uchyla/.test(item)));
  assert.match(result.statement, /hipoteza/);
});

test('jednorazowa sprzedaż prywatna: słabe przesłanki i kontrdowód', () => {
  const result = assessBusinessActivity({
    id: 't',
    subject: { kind: 'subject', label: 'Prywatny' },
    publications: [pub('https://targ.example/oferta/9', 'Sprzedam rower, płatność w BTC, odbiór w Poznaniu.', { publishedAt: '2025-05-01T00:00:00.000Z' })],
    addresses: [{ address: BTC_A, network: 'bitcoin', chain: activity({ transfers: [transfer(1, { direction: 'in', counterparty: PAYERS[0]!, time: '2025-05-03T00:00:00.000Z', amount: 0.004 })] }) }],
  });
  assert.ok(result.indicator.components.some((item) => item.rule === 'business.one_off_sale' && item.direction === 'contradicts'));
  assert.ok(result.indicator.score < 40, `wynik ${result.indicator.score}`);
});

test('adres zbiórki organizacji: kontrdowód twardy, wpływy nieliczone', () => {
  const chain = sellerChain();
  const result = assessBusinessActivity({
    id: 't',
    subject: { kind: 'subject', label: 'Zbiórka' },
    publications: [],
    addresses: [{ address: BTC_A, network: 'bitcoin', chain: activity(chain), charity: 'Fundacja Fikcyjna' }],
  });
  const charity = result.indicator.components.find((item) => item.rule === 'business.charity_address')!;
  assert.equal(charity.blocking, true);
  assert.ok(!result.indicator.components.some((item) => item.rule === 'business.many_payers'));
  assert.equal(result.turnover.length, 0);
  assert.ok(result.indicator.score <= 45);
});

test('wpis w rejestrze działalności w zakresie walut wirtualnych: zarejestrowany dostawca przeczy działalności „ukrytej”', () => {
  const chain = sellerChain();
  const records: BusinessRegistryRecord[] = [{ connectorId: 'rejestry-publiczne', service: 'gov.pl', url: 'https://www.gov.pl/rdww#RDWW-1', title: 'Rejestr działalności w zakresie walut wirtualnych: KANTOR FIKCYJNY (RDWW-1)' }];
  const base = { id: 't', subject: { kind: 'subject', label: 'Kantor' }, publications: [pub('https://targ.example/k/1', 'Kantor BTC, wymiana BTC kurs dnia.')], addresses: [{ address: BTC_A, network: 'bitcoin', chain: activity(chain) }] };
  const without = assessBusinessActivity({ ...base, registry: { connectorsUsed: ['rejestry-publiczne'], identifiers: [{ type: 'full_name', value: 'Kantor Fikcyjny' }], records: [] } });
  const withEntry = assessBusinessActivity({ ...base, registry: { connectorsUsed: ['rejestry-publiczne'], identifiers: [{ type: 'full_name', value: 'Kantor Fikcyjny' }], records } });
  const vasp = withEntry.indicator.components.find((item) => item.rule === 'business.virtual_currency_register')!;
  assert.equal(vasp.direction, 'contradicts');
  assert.equal(vasp.weight, -BUSINESS_RULES.contradictions.virtualCurrencyRegister.exact);
  assert.ok(withEntry.indicator.score < without.indicator.score);
  assert.ok(withEntry.whatToVerify.some((item) => /rejestrze działalności w zakresie walut wirtualnych/.test(item)));
});

test('strona z prośbą o wsparcie bez oferty: kontrdowód „darowizny”', () => {
  const result = assessBusinessActivity({
    id: 't',
    subject: { kind: 'subject', label: 'Programista' },
    publications: [pub('https://gitpub.example/dev', 'Wesprzyj projekt — darowizny w BTC.', { category: 'own_profile' })],
    addresses: [{ address: BTC_A, network: 'bitcoin', chain: activity(sellerChain()) }],
  });
  assert.ok(result.indicator.components.some((item) => item.rule === 'business.donation_context'));
});

// ---------- Ścieżka 2: podmiot zarejestrowany ----------

const VAT_RECORD: BusinessRegistryRecord = {
  connectorId: 'live-vat-whitelist',
  service: 'wykazpodatnikowvat.mf.gov.pl',
  url: 'https://wykazpodatnikowvat.mf.gov.pl/api/search/nip/5260250274?date=2026-11-21',
  title: 'Wykaz podatników VAT: FIKCYJNA FIRMA SP. Z O.O. (NIP 5260250274)',
  organization: 'FIKCYJNA FIRMA SP. Z O.O.',
  registryEntries: ['NIP 5260250274 (wykaz podatników VAT: Zwolniony)'],
  details: {
    connectorId: 'live-vat-whitelist',
    name: 'FIKCYJNA FIRMA SP. Z O.O.',
    nip: '5260250274',
    krs: '0000123456',
    vatStatus: 'Zwolniony',
    registrationDate: '2024-12-20',
    pkd: [],
    people: ['Jan Fikcyjny'],
    accounts: ['61109010140000071219812874'],
  },
};
const KRS_RECORD: BusinessRegistryRecord = {
  connectorId: 'live-krs',
  service: 'api-krs.ms.gov.pl',
  url: 'https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/0000123456?rejestr=P&format=json',
  title: 'KRS 0000123456: FIKCYJNA FIRMA SP. Z O.O.',
  organization: 'FIKCYJNA FIRMA SP. Z O.O.',
  registryEntries: ['KRS 0000123456', 'NIP 5260250274'],
  details: { connectorId: 'live-krs', name: 'FIKCYJNA FIRMA SP. Z O.O.', nip: '5260250274', krs: '0000123456', registrationDate: '2025-01-15', pkd: [{ code: '56.10.A', description: 'RESTAURACJE' }], capital: '5000,00 PLN', people: ['J*** F*** — PREZES ZARZĄDU'], accounts: [] },
};

test('podmiot zarejestrowany: druga ścieżka z PKD niezwiązanym z obrotem, statusem VAT, świeżą rejestracją, mieszaniem środków, wspólnymi członkami organów i listą ostrzeżeń', () => {
  const chain = sellerChain();
  const companyOffer = pub('https://targ.example/firma/1', 'Sprzedam etui, cennik 40 zł/szt. Faktury: FIKCYJNA FIRMA, NIP 526-025-02-74. Płatność w BTC.', { publishedAt: '2025-02-01T00:00:00.000Z', addresses: [`bitcoin:${BTC_A}`] });
  const privatePost = pub('https://forum.example/p/1', 'Mój prywatny portfel na drobne: tu wpłacajcie.', { category: 'own_profile', publishedAt: '2025-03-01T00:00:00.000Z', addresses: [`bitcoin:${BTC_A}`] });
  const result = assessBusinessActivity({
    id: 't',
    subject: { kind: 'subject', label: 'Jan Fikcyjny' },
    publications: [companyOffer, privatePost],
    addresses: [{ address: BTC_A, network: 'bitcoin', chain: activity(chain) }],
    valuations: chain.cashOuts.map((item) => ({ asset: 'BTC', time: item.time, amount: item.amount, valuePln: item.valuePln! })),
    registry: { connectorsUsed: ['live-vat-whitelist', 'live-krs'], identifiers: [{ type: 'login', value: 'NIP 5260250274' }], records: [VAT_RECORD, KRS_RECORD] },
    registered: {
      organizations: [{ id: 'org:krs:0000123456', name: 'FIKCYJNA FIRMA SP. Z O.O.', krs: '0000123456', addressKeys: [] }],
      orgRelations: [{ from: 'org:krs:0000123456', to: 'org:krs:0000999999', kind: 'shared_officer', explanation: 'Ten sam członek zarządu w obu spółkach (rejestr).' }],
      riskFlags: [{ nodeId: 'nip:5260250274', badge: 'ostrzeżenie KNF', status: 'hypothesis', confidence: 'weak', summary: 'Nazwa podobna do wpisu listy ostrzeżeń.' }],
    },
  });
  // Ścieżka 1: wpis w rejestrze to składnik neutralny, a nie koniec oceny.
  assert.ok(result.indicator.components.some((item) => item.rule === 'business.registry_found' && item.direction === 'contradicts'));
  const track = result.registered!;
  assert.equal(track.track, 'registered_entity');
  assert.equal(track.entities.length, 1);
  assert.deepEqual([track.entities[0]!.vatStatus, track.entities[0]!.registrationDate, track.entities[0]!.pkd[0]!.code], ['Zwolniony', '2024-12-20', '56.10.A']);
  const rules = track.indicator.components.map((item) => item.rule);
  for (const rule of [
    'business.registered.crypto_flows_vs_pkd',
    'business.registered.recent_registration',
    'business.registered.vat_status_inactive_or_removed',
    'business.registered.personal_and_company_mixing',
    'business.registered.shared_officer_network',
    'business.registered.sanctions_or_knf_warning',
  ]) {
    assert.ok(rules.includes(rule), `brak składnika ${rule}`);
  }
  assert.ok(!rules.includes('business.registered.payout_to_whitelist_account'));
  assert.equal(track.indicator.components.find((item) => item.rule === 'business.registered.sanctions_or_knf_warning')!.weight, BUSINESS_RULES.registered.riskWeak);
  assert.match(track.statement, /sygnały do weryfikacji/);
  assert.match(track.statement, /nie ustalenie/);
  assert.ok(!/dopuścił się|pierze|wypranie/.test(JSON.stringify(track)));
  assert.ok(track.whatToVerify.some((item) => /JPK_V7/.test(item)));
  assert.ok(track.whatToVerify.some((item) => /CRBR/.test(item) && /podstawę prawną/.test(item)));
  assert.ok(track.whatToVerify.some((item) => /źródło pochodzenia środków/.test(item)));
});

test('podmiot zarejestrowany: wypłata z odpowiedzi usługi na rachunek z wykazu VAT (porównanie zamaskowanej końcówki)', () => {
  const chain = sellerChain();
  const base = {
    id: 't',
    subject: { kind: 'subject', label: 'Jan Fikcyjny' },
    publications: [],
    addresses: [{ address: BTC_A, network: 'bitcoin', chain: activity(chain) }],
    registry: { connectorsUsed: ['live-vat-whitelist'], identifiers: [{ type: 'login' as const, value: 'NIP 5260250274' }], records: [VAT_RECORD] },
  };
  const match = assessBusinessActivity({ ...base, registered: { payouts: [{ replyId: 'odp-1', serviceName: 'Giełda Testowa', reference: 'GT/1', bankAccountMasked: 'PL** **** 2874', amount: 5000, currency: 'PLN' }] } });
  const payout = match.registered!.indicator.components.find((item) => item.rule === 'business.registered.payout_to_whitelist_account')!;
  assert.equal(payout.weight, BUSINESS_RULES.registered.payoutToWhitelistAccount);
  assert.ok(payout.limitations.some((item) => /WYŁĄCZNIE 4 ostatnie cyfry/.test(item)));
  assert.deepEqual(payout.evidence[0], { kind: 'decision', value: 'reply:odp-1' });
  assert.ok(match.registered!.whatToVerify.some((item) => /pełny numer rachunku/.test(item)));
  const other = assessBusinessActivity({ ...base, registered: { payouts: [{ replyId: 'odp-2', serviceName: 'Giełda Testowa', reference: 'GT/2', bankAccountMasked: 'PL** **** 9999' }] } });
  assert.ok(!other.registered!.indicator.components.some((item) => item.rule === 'business.registered.payout_to_whitelist_account'));
});

// ---------- Byt siatki ----------

test('businessSignalsFor: byt siatki oceniany z dokumentów i adresów przekazanych przez wywołującego', () => {
  const chain = sellerChain();
  const finding = { address: BTC_A, network: 'bitcoin' as const, checksumVerified: true, evidence: [], confidence: { score: 80, tier: 't', excluded: false, ledger: [], nextSteps: [] }, unrelatedPublishers: 0, chain: activity(chain) };
  const result = businessSignalsFor(
    { key: 'profile:targ.example|kantor_b', kind: 'account', label: 'kantor_b', meta: { addresses: [`bitcoin:${BTC_A}`] } },
    {
      documents: [
        { url: 'https://targ.example/k/1', service: 'targ.example', text: 'Kantor: wymiana BTC kurs dnia, Łódź.', publishedAt: '2025-01-01T00:00:00.000Z', category: 'sale_offer' },
        { url: 'https://targ.example/k/2', service: 'targ.example', text: 'Skup BTC i USDT, gotówka od ręki, Łódź — nowa oferta na wiosnę.', publishedAt: '2025-04-01T00:00:00.000Z', category: 'sale_offer' },
      ],
      findings: [finding],
    },
  );
  assert.equal(result.subject.nodeId, 'profile:targ.example|kantor_b');
  assert.ok(result.indicator.components.some((item) => item.rule === 'business.p2p_trading'));
  assert.ok(result.indicator.components.some((item) => item.rule === 'business.many_payers'));
  assert.ok(result.indicator.score >= BUSINESS_RULES.networkMinScore);
});

// ---------- Integracja: analiza → teczka ----------

const nick = { type: 'nick' as const, value: 'etui_kowalski' };
const query = { identifiers: [nick] };

const sellerSources = () => [
  fakeConnector('targ', 'targ.example', ['nick'], (identifier) =>
    identifier.value === 'etui_kowalski'
      ? [
          { url: 'https://targ.example/oferta/1', author: 'etui_kowalski', category: 'sale_offer' as const, publishedAt: '2025-01-10T00:00:00.000Z', text: `Sprzedam etui, cennik 40 zł/szt. Płatność w BTC: ${BTC_A}. Zamówienia: pisz na priv. Kraków.`, profile: { handle: 'etui_kowalski', displayName: 'Paweł Etuiński' } },
          { url: 'https://targ.example/oferta/2', author: 'etui_kowalski', category: 'sale_offer' as const, publishedAt: '2025-05-10T00:00:00.000Z', text: `Nowa dostawa etui i szkieł, cennik od 30 zł/szt. Płatność w BTC: ${BTC_A}. Wysyłka z Krakowa.`, profile: { handle: 'etui_kowalski', displayName: 'Paweł Etuiński' } },
        ]
      : [],
  ),
  fakeConnector('bazar', 'bazar.example', ['nick'], (identifier) =>
    identifier.value === 'etui_kowalski'
      ? [{ url: 'https://bazar.example/u/etui_kowalski', author: 'etui_kowalski', category: 'sale_offer' as const, publishedAt: '2025-08-01T00:00:00.000Z', text: `Akcesoria GSM — przyjmuję płatności w kryptowalutach (BTC ${BTC_A}). Zamówienia przez telegram. Kraków, +48 600 100 200.`, profile: { handle: 'etui_kowalski', displayName: 'Paweł Etuiński' } }]
      : [],
  ),
];

test('integracja: analiza i teczka — wskaźnik D przy wskaźnikach A/B/C, zdanie w kluczowych ustaleniach i odznaka na grafie', async () => {
  const chain = sellerChain();
  const result = await runAnalysis({ query, connectors: sellerSources(), chainProviders: [chainWith({ [BTC_A]: chain })], now: () => new Date('2026-11-21T10:00:00.000Z') });
  // Sygnały liczone przy pobraniu dokumentu (pełna treść), zapisane w materiale analizy.
  assert.ok(result.intel.sightings.some((item) => item.businessText?.quotes.accepts_crypto));
  const dossier = dossierOf(result, query);
  const business = dossier.indicators.businessActivity!;
  assert.ok(business, 'brak wskaźnika D w teczce');
  assert.ok(business.indicator.score >= 60, `wynik ${business.indicator.score}`);
  assert.ok(business.indicator.components.some((item) => item.rule === 'business.repeated_offers'));
  assert.ok(business.indicator.components.some((item) => item.rule === 'business.cashout_to_exchange'));
  assert.ok(business.turnoverPlnByYear['2025']! > 0);
  assert.ok(dossier.keyFindings.some((item) => item.layer === 'inference' && /Sygnały możliwej działalności gospodarczej \(hipoteza\)/.test(item.text)));
  assert.match(dossier.graph.nodes.find((node) => node.id === 'subject')!.sublabel ?? '', /sygnały działalności/);
  assert.deepEqual(business.network, []);
});

test('integracja: odpowiedź usługi z wypłatą na rachunek z wykazu VAT otwiera ścieżkę „podmiot zarejestrowany”', async () => {
  const chain = sellerChain();
  const vat = fakeConnector('live-vat-whitelist', 'wykazpodatnikowvat.mf.gov.pl', ['login'], (identifier) =>
    /5260250274/.test(identifier.value)
      ? [
          {
            url: 'https://wykazpodatnikowvat.mf.gov.pl/api/search/nip/5260250274?date=2026-11-21',
            title: 'Wykaz podatników VAT: FIKCYJNA FIRMA SP. Z O.O. (NIP 5260250274)',
            category: 'forum_post' as const,
            text: [
              'Wpis w urzędowym wykazie podatników VAT (stan na 2026-11-21)',
              'Nazwa: FIKCYJNA FIRMA SP. Z O.O.',
              'NIP: 5260250274',
              'Status VAT: Czynny',
              'Data rejestracji jako podatnik VAT: 2025-01-02',
              'Numery rachunków w wykazie: 61109010140000071219812874',
            ].join('\n'),
            profile: { handle: 'NIP 5260250274', organization: 'FIKCYJNA FIRMA SP. Z O.O.', registryEntries: ['NIP 5260250274 (wykaz podatników VAT: Czynny)'] },
          },
        ]
      : [],
  );
  const firm = fakeConnector('targ', 'targ.example', ['nick'], (identifier) =>
    identifier.value === 'etui_kowalski'
      ? [
          {
            url: 'https://targ.example/oferta/1',
            author: 'etui_kowalski',
            category: 'sale_offer' as const,
            publishedAt: '2025-01-10T00:00:00.000Z',
            text: `Sprzedam etui, cennik 40 zł/szt. Płatność w BTC: ${BTC_A}. Faktura VAT: FIKCYJNA FIRMA, NIP 526-025-02-74.`,
            profile: { handle: 'etui_kowalski', displayName: 'Paweł Etuiński' },
            discoveredIdentifiers: [{ type: 'login' as const, value: 'NIP 5260250274' }],
          },
        ]
      : [],
  );
  const result = await runAnalysis({ query, connectors: [firm, vat], chainProviders: [chainWith({ [BTC_A]: chain })], now: () => new Date('2026-11-21T10:00:00.000Z') });
  const automatic = dossierOf(result, query);
  const exchange = automatic.serviceLinks.find((link) => /Giełda Testowa/.test(link.name))!;
  assert.ok(exchange, 'brak usługi w teczce');
  assert.ok(automatic.indicators.businessActivity!.registered, 'brak ścieżki „podmiot zarejestrowany”');
  assert.ok(!automatic.indicators.businessActivity!.registered!.indicator.components.some((item) => item.rule === 'business.registered.payout_to_whitelist_account'));

  const cleaned = cleanReplyPayload({
    matches: [{ network: 'bitcoin', txids: chain.cashOuts.map((item) => item.txid) }],
    fiatPayouts: [{ time: '2025-09-01', amount: 4000, currency: 'pln', bankAccount: 'PL61109010140000071219812874' }],
  });
  if ('error' in cleaned) throw new Error(cleaned.error);
  const reply: ServiceReply = {
    id: 'odp-gt',
    caseId: 'sprawa-1',
    serviceName: 'Giełda Testowa',
    serviceId: exchange.id,
    reference: 'GT/2026/7',
    receivedAt: '2026-11-20T12:00:00.000Z',
    recordedAt: '2026-11-21T10:00:00.000Z',
    recordedBy: 'analityk',
    payload: cleaned.payload,
  };
  const dossier = dossierOf(result, query, { serviceReplies: [reply] });
  const track = dossier.indicators.businessActivity!.registered!;
  assert.ok(track.indicator.components.some((item) => item.rule === 'business.registered.payout_to_whitelist_account'));
  assert.ok(track.indicator.score >= BUSINESS_RULES.registered.payoutToWhitelistAccount);
  assert.ok(dossier.indicators.businessActivity!.indicator.components.some((item) => item.rule === 'business.registry_found'));

  // Raport: sekcja wskaźnika D z obiema ścieżkami, tabelą obrotu i rejestrami; dane ze źródeł są escapowane.
  const html = renderBusinessSection(dossier.indicators.businessActivity);
  for (const phrase of ['Wskaźnik D — sygnały działalności gospodarczej', 'Ścieżka 1', 'Ścieżka 2: podmiot zarejestrowany', 'Obrót według roku podatkowego', 'nie dochód', 'Sprawdzenie rejestrów publicznych', 'Co sprawdzić po stronie KAS']) {
    assert.ok(html.includes(phrase), `brak w raporcie: ${phrase}`);
  }
  assert.ok(!html.includes('<script'));
  assert.match(renderBusinessSection(undefined), /nie zawiera wskaźnika D/);
});
