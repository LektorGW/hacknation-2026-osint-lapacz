// Część scenariusza „działalność” — demonstracja wskaźnika D (sygnały możliwej niezgłoszonej działalności gospodarczej).
// Wszystkie osoby, konta, sklepy i adresy są ZMYŚLONE. Adresy wygenerowano skryptem scripts/generate-addresses.ts
// z losowych danych — mają poprawne sumy kontrolne, ale nikt nie zna do nich kluczy.
//
// Sprawa A (nick „lipa_gsm”, Bartosz Lipa, Kraków) — sprzedawca akcesoriów GSM:
//   trzy oferty na Targu (luty, maj, wrzesień 2025), cennik na forum, własna strona sklepu z instrukcją płatności
//   w BTC, wpis w Społeczności skopiowany z pierwszej oferty tego samego dnia (kopia — liczona raz);
//   25 wpłat od 25 różnych adresów przez 10 miesięcy (kwoty detaliczne), comiesięczne wpłaty na giełdę.
//   W rejestrach (migawka rejestru walut wirtualnych) brak wpisu. Oczekiwany wskaźnik D: ok. 70 — istotne przesłanki.
// Sprawa B (nick „ewa_sosna”, Ewa Sosna, Poznań) — jednorazowa sprzedaż prywatna:
//   jedno ogłoszenie „sprzedam rower, płatność w BTC” i jedna wpłata. Oczekiwany wskaźnik D: ok. 20 — słabe przesłanki.

import type { Account, LabeledAddress, LedgerRow, Page } from './scenario.ts';

export const BUSINESS_ADDR = {
  /** Adres sklepu Bartosza Lipy (podawany w ofertach i na stronie). */
  lipaBtc: 'bc1q8g50zn88a7j4jrqk3jhh75k3zkslezdzf85nyf',
  /** Adres Ewy Sosny z jednego ogłoszenia. */
  sosnaBtc: '1EsyCoWgeTmgnYkrBPbeAwbeCW8BJEV1Tr',
  /** Kupujący rower — anonimowy adres. */
  rowerBuyerBtc: '1LrwdP1UvPXiEw8FJtR5EaJWzvJ6K2d63r',
} as const;

/** Klienci sklepu — 25 anonimowych adresów (w grafie wyłącznie adresy, nigdy osoby). */
export const BUSINESS_PAYERS = [
  'bc1q2x2m56emt5gfpv844phcca3n4r3fcx257hm0cv',
  'bc1q39d45un43mn4cvnr70qee7grrrk0galw5pjd03',
  'bc1qq2mfxxl06efhs758e5al4fzk6jwnm67np362ax',
  'bc1qz274z7yuwd2tkxtpd97rf067sjrh2num5kw678',
  'bc1qyg4xjhggdtyqu6m2e80sh75kaz72fqyyuj3c2z',
  'bc1qlvx7cwvn6rx6sz9hfwy9ugsc28xwud00rz48zf',
  'bc1qujzfkp8vvy24jx6ssxjl2qgpd673rvv6r6ygd0',
  'bc1qp4dmgrjkwd06au69vtfe4f7s36empka2dlmgxj',
  'bc1qes4e8j8trpc3d7309ge4444fju3fzmpq8ynpp9',
  'bc1q7xnlj49z79cz3wshwhler5ue5rzvsrj5xwgtjn',
  'bc1qrwhhl8tqs4686r2tmxdhfr94hl69r3mtjv57vt',
  'bc1q78cs80ckcrdkzyskeaxnevxvne2saudvw32f5j',
  'bc1qf8a9rc2ztn66xp27ccy370gjy7nlm665gv3u7v',
  'bc1qkjzjuvm880y38lt4mls9f3suvjhchmj87ddu84',
  'bc1qtk2cxaprdu8fq0dev9zgjh6g2gdwj04leae4kt',
  'bc1qzym59mex6j4f9zu2wchg70xa6e9lve9fjj8hdj',
  'bc1q6zf4n7y4kl736ry473xz4a0n58gnfm8fv5cd7s',
  'bc1q3u4r7sdxvhkp76qqzyndgj9tf0dsnhhgs3h7mf',
  'bc1qvwl3pzfm9jf8f40raz5l76fcmysvn0evrc6p03',
  'bc1qcqs2jhz78aem2j9y0ny4n8aada0tt8rwd37400',
  'bc1q9g2fgyxjn8e5kt0fz4a3aes4gwmmcfel3h43lj',
  '19GSA1aYTc6RU8nHC7NiwcLqvL8vNkWK2s',
  '1N3ckWgUV4ibXFcr39ceGCNqfzNeckLC3R',
  '12YUJKqoda2BgESGc4smZXtaEEH2TtPy56',
  '1MFiMrbKQHi1AjJhuZgdRedA9vFfVuTb8',
] as const;

const A = BUSINESS_ADDR;
const code = (address: string) => `<code>${address}</code>`;

export const businessAccounts: Account[] = [
  { service: 'targ', handle: 'lipa_gsm', name: 'Bartosz Lipa', email: 'sklep@lipagsm.example', phone: '+48 600 410 217', location: 'Kraków', createdAt: '2024-11-02T09:00:00Z' },
  { service: 'forum', handle: 'lipa_gsm', name: 'Bartosz Lipa', email: 'sklep@lipagsm.example', location: 'Kraków', createdAt: '2024-10-15T09:00:00Z' },
  { service: 'www', handle: 'lipa_gsm', name: 'Bartosz Lipa', email: 'sklep@lipagsm.example', location: 'Kraków', createdAt: '2024-12-01T09:00:00Z' },
  { service: 'spolecznosc', handle: 'lipa_gsm', name: 'Bartosz Lipa', location: 'Kraków', createdAt: '2025-01-20T09:00:00Z' },
  { service: 'targ', handle: 'ewa_sosna', name: 'Ewa Sosna', location: 'Poznań', createdAt: '2025-05-01T09:00:00Z' },
];

const firstOffer = `
<p><strong>Cena:</strong> etui od 39 zł/szt., szkła hartowane 25 zł/szt. · <strong>Lokalizacja:</strong> Kraków</p>
<p>Sprzedam etui i szkła do telefonów — nowe, na stanie. Przyjmuję płatność w BTC: ${code(A.lipaBtc)} albo BLIK.</p>
<p>Zamówienia: pisz na priv albo telegram @lipa_gsm. Wysyłka codziennie, tel. +48 600 410 217.</p>`;

export const businessPages: Page[] = [
  { service: 'targ', path: '/oferta/7001', kind: 'offer', title: 'Etui i szkła do telefonów — Kraków, płatność BTC', author: 'lipa_gsm', publishedAt: '2025-02-03T09:00:00Z', html: firstOffer },
  // Ten sam tekst tego samego dnia w drugim serwisie — kopia, liczona jako jedna oferta.
  { service: 'spolecznosc', path: '/lipa_gsm/wpis/1', kind: 'post', title: 'Etui i szkła do telefonów — Kraków, płatność BTC', author: 'lipa_gsm', publishedAt: '2025-02-03T15:00:00Z', html: firstOffer },
  {
    service: 'targ',
    path: '/oferta/7044',
    kind: 'offer',
    title: 'Ładowarki i kable USB-C — hurt i detal, Kraków',
    author: 'lipa_gsm',
    publishedAt: '2025-05-12T09:00:00Z',
    html: `
<p><strong>Cena:</strong> ładowarka 59 zł/szt., kabel 19 zł/szt. · <strong>Lokalizacja:</strong> Kraków</p>
<p>Sprzedam ładowarki i kable, duże ilości od ręki. Płatność w BTC na adres ${code(A.lipaBtc)}.</p>
<p>Zamówienia przez telegram @lipa_gsm albo e-mail sklep@lipagsm.example.</p>`,
  },
  {
    service: 'targ',
    path: '/oferta/7102',
    kind: 'offer',
    title: 'Powerbanki — nowa dostawa, wysyłka z Krakowa',
    author: 'lipa_gsm',
    publishedAt: '2025-09-08T09:00:00Z',
    html: `
<p><strong>Cena:</strong> powerbank 10 000 mAh — 89 zł/szt. · <strong>Lokalizacja:</strong> Kraków</p>
<p>Nowa dostawa powerbanków. Przyjmuję płatności w kryptowalutach (BTC): ${code(A.lipaBtc)}.</p>
<p>Zamówienia: pisz na priv. Wysyłka w 24 h.</p>`,
  },
  {
    service: 'forum',
    path: '/watek/akcesoria-gsm/lipa_gsm',
    kind: 'post',
    title: 'Cennik akcesoriów GSM — lipa_gsm',
    author: 'lipa_gsm',
    publishedAt: '2025-04-01T09:00:00Z',
    html: `<p>Aktualny cennik: etui 39 zł/szt., szkła 25 zł/szt., kable 19 zł/szt. Realizuję zamówienia na terenie całej Polski, płatność w BTC (${code(A.lipaBtc)}).</p>`,
  },
  {
    service: 'www',
    path: '/lipa-gsm',
    kind: 'page',
    title: 'LipaGSM — sklep z akcesoriami (Kraków)',
    author: 'lipa_gsm',
    publishedAt: '2025-03-01T09:00:00Z',
    html: `
<p class="bio">Sklep z akcesoriami GSM. Kraków.</p>
<h2>Jak zamówić</h2>
<p>Dodaj produkty do koszyka i złóż zamówienie e-mailem: sklep@lipagsm.example. Płatność w BTC — wpłata na adres ${code(A.lipaBtc)}.</p>
<p>Po wpłacie prześlij numer zamówienia; dostawa kurierem w 1–2 dni. Regulamin sklepu i cennik — w zakładce „Oferta”.</p>`,
  },
  {
    service: 'targ',
    path: '/oferta/7210',
    kind: 'offer',
    title: 'Rower miejski — Poznań',
    author: 'ewa_sosna',
    publishedAt: '2025-06-14T09:00:00Z',
    html: `
<p><strong>Cena:</strong> 900 zł · <strong>Lokalizacja:</strong> Poznań</p>
<p>Sprzedam rower miejski po przeprowadzce, stan dobry. Płatność w BTC: ${code(A.sosnaBtc)} albo gotówka przy odbiorze.</p>`,
  },
];

export const businessLabeledAddresses: LabeledAddress[] = [
  { address: A.lipaBtc, network: 'bitcoin', addressClass: 'private' },
  { address: A.sosnaBtc, network: 'bitcoin', addressClass: 'private' },
];

/** Przelewy części „działalność” — adres giełdy z części podstawowej. */
export const businessLedger = (base: { exchangeBtc: string }): LedgerRow[] => {
  const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
  const rows: LedgerRow[] = BUSINESS_PAYERS.map((payer, index) => ({
    time: `2025-${months[index % months.length]}-${String(3 + ((index * 7) % 24)).padStart(2, '0')}T1${index % 10}:15:00Z`,
    from: payer,
    to: A.lipaBtc,
    asset: 'BTC',
    amount: Math.round((0.0012 + (index % 5) * 0.0009) * 1e6) / 1e6,
  }));
  // Co miesiąc część utargu trafia na giełdę.
  for (const month of months) rows.push({ time: `2025-${month}-28T18:00:00Z`, from: A.lipaBtc, to: base.exchangeBtc, asset: 'BTC', amount: 0.004 });
  rows.push({ time: '2025-06-16T12:00:00Z', from: A.rowerBuyerBtc, to: A.sosnaBtc, asset: 'BTC', amount: 0.0026 });
  return rows;
};
