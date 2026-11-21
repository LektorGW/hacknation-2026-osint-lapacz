// Druga część scenariusza: „rynek P2P" — kilkanaście fikcyjnych osób handlujących
// kryptowalutami na Targu, z różną skalą wypłat do walut tradycyjnych. Dane służą
// pokazowi typowania (kto wypłaca najwięcej) i powiązań między osobami.
//
// Wszystkie osoby, konta i adresy są zmyślone (adresy z scripts/generate-addresses.ts).
// Plik nie zmienia niczego w scenariuszach a–h z data/scenario.ts.

import type { Account, Entry, LabeledAddress, LedgerRow, Page, Thread } from './scenario.ts';

/** Adresy usług z części podstawowej — potrzebne tu jako kontrahenci wypłat. */
export interface ServiceAddresses {
  exchangeBtc: string;
  exchangeEth: string;
  exchangeTron: string;
  p2pBtc: string;
  p2pTron: string;
  gatewayEth: string;
  cardEth: string;
  swapEth: string;
}

export const MARKET_ADDR = {
  // Osoby — Bitcoin
  igorBtc: 'bc1qw87mrkzc4hzxn5mm47unt7x9ld4aemscys0jcj',
  darekBtc: 'bc1qq5xkqmzm397wferpkkz2e65lyrpx8x6enkq8v9',
  sylwiaBtc: '1HWuxAdSxEZ7KD6YuUEdQTKiz4vXyCAVPw',
  olekBtc: 'bc1q5wlezhqv0ex95g6qppvpg0gtuwylf9x6n8fv0m',
  pietrzakBtc: '1P3SDydL5bDPFGzpTJ6eKsdGYDQSmNig3o',
  marcelBtc: 'bc1q2a0hgm69zxrlhejysle00mvt45jp0uxtngmqdm',
  // Osoby — Ethereum
  gajdaEth: '0xbC823121bBC480eB677CC8e9B00f15fDBF7f9A94',
  dudekEth: '0x54c8d4AaAA5d5e6a70166D09f700EDd31249dbD6',
  ewelinaEth: '0xb94e2d0c36BBDbc7e61E54963aa7be20AbCB9938',
  nogaEth: '0x0c1C4cFcE3121d446C2d2EBE8842Cc4b7e97ec36',
  // Osoby — Tron
  wilkTron: 'TWQudVYcr9ymMBGe5eovB3b9yFhTkkJw5R',
  sowaTron: 'TYKQCFPkRyFg4A9fZrhLrspHRSMbdAkMDR',
  lisTron: 'TEJrwK9GS9kFUaZq79g9ntUBm3VnQfHMfD',
  rakTron: 'TNN6Uemk5Lqvybro36Lcmc6yNZEWMF58Zs',
  lenaTron: 'TYgA25gWvqTFmTNDWQr7sawdQ9nUhXDmwB',
  kolekcjeTron: 'TAvHgdm1ctMsPoAm9xxqrL4bRty2rfRUMb',
  // Wspólny pośrednik bez etykiety: środki Jana Pietrzaka trafiają przez niego do Sylwii Kot.
  midBtc: '3JWr9ULjEPQJXjqAykETkcFWJRSGEg5kTy',
  // Anonimowi kontrahenci
  anonBtc5: '1AVuHN1UXftEBgwV4Dc6yWrmoA9u3uRd2G',
  anonBtc6: '1AaNh8NeMihWKDMJMtcj4ivpteuctmHccW',
  anonEth4: '0x24F9036C2ae49E319947434868163172c57392d5',
  anonTron4: 'TYHNSXs9YJQ2GKHpAmosrYfpv136WxBUEs',
} as const;

const A = MARKET_ADDR;
const code = (address: string) => `<code>${address}</code>`;
const phoneHtml = (phone: string) => phone.replace(/ /g, '&nbsp;');

interface Trader {
  handle: string;
  /** Imię i nazwisko — ujawnione na koncie tylko wtedy, gdy `showName`. */
  name: string;
  showName: boolean;
  city: string;
  phone: string;
  email?: string;
  joined: string;
  address: string;
  /** Jak ogłoszenie nazywa walutę i sieć. */
  asset: string;
  offerId: number;
  publishedAt: string;
  title: string;
  price: string;
  body: string;
}

const traders: Trader[] = [
  {
    handle: 'igor_baran',
    name: 'Igor Baran',
    showName: true,
    city: 'Lublin',
    phone: '500 000 811',
    email: 'igor.baran@handel.example',
    joined: '2023-11-02T09:00:00Z',
    address: A.igorBtc,
    asset: 'BTC',
    offerId: 2001,
    publishedAt: '2026-06-12T08:20:00Z',
    title: 'Skup i sprzedaż BTC — większe kwoty, gotówka lub przelew, Lublin',
    price: 'kurs giełdowy +1,5%',
    body: 'Handluję bitcoinem od kilku lat, transakcje od 5 tys. zł wzwyż. Spotkanie w centrum albo przelew po wpłacie.',
  },
  {
    handle: 'darek_mroz',
    name: 'Dariusz Mróz',
    showName: true,
    city: 'Gdańsk',
    phone: '500 000 812',
    joined: '2024-06-18T09:00:00Z',
    address: A.darekBtc,
    asset: 'BTC',
    offerId: 2002,
    publishedAt: '2026-06-09T17:45:00Z',
    title: 'Sprzedam BTC za gotówkę — Trójmiasto',
    price: 'kurs dnia +2%',
    body: 'Mniejsze kwoty, do 20 tys. zł jednorazowo. Odbiór osobisty Gdańsk Wrzeszcz.',
  },
  {
    handle: 'sylwia_kot',
    name: 'Sylwia Kot',
    showName: false,
    city: 'Łódź',
    phone: '500 000 813',
    joined: '2025-08-30T09:00:00Z',
    address: A.sylwiaBtc,
    asset: 'BTC',
    offerId: 2003,
    publishedAt: '2026-05-28T11:05:00Z',
    title: 'Rękodzieło — ceramika, płatność także w BTC',
    price: 'od 60 zł',
    body: 'Kubki i misy z własnej pracowni. Kto woli, może zapłacić bitcoinem — odkładam na później, niczego nie wypłacam.',
  },
  {
    handle: 'olek_czyz',
    name: 'Aleksander Czyż',
    showName: true,
    city: 'Białystok',
    phone: '500 000 814',
    joined: '2026-04-02T09:00:00Z',
    address: A.olekBtc,
    asset: 'BTC',
    offerId: 2004,
    publishedAt: '2026-06-01T19:30:00Z',
    title: 'Kupię BTC za gotówkę — pierwszy raz, Białystok',
    price: 'do uzgodnienia',
    body: 'Dopiero zaczynam, portfel założony w tym tygodniu. Szukam kogoś zaufanego na niewielką kwotę.',
  },
  {
    handle: 'j_pietrzak',
    name: 'Jan Pietrzak',
    showName: true,
    city: 'Radom',
    phone: '500 000 815',
    joined: '2023-12-11T09:00:00Z',
    address: A.pietrzakBtc,
    asset: 'BTC',
    offerId: 2005,
    publishedAt: '2025-11-20T10:00:00Z',
    title: 'Wyprzedaż sprzętu po kopalni + resztka BTC',
    price: 'zasilacze od 150 zł',
    body: 'Zamknąłem kopanie w 2024 r. Zostały zasilacze, riser-y i trochę monet. Sprzęt można opłacić w BTC.',
  },
  {
    handle: 'marcel_zych',
    name: 'Marcel Zych',
    showName: true,
    city: 'Wałbrzych',
    phone: '500 000 816',
    email: 'marcel@zych-mineraly.example',
    joined: '2024-09-09T09:00:00Z',
    address: A.marcelBtc,
    asset: 'BTC',
    offerId: 2006,
    publishedAt: '2026-04-22T13:15:00Z',
    title: 'Minerały i skamieliny — okazy kolekcjonerskie, płatność BTC',
    price: 'od 40 zł',
    body: 'Agaty, ametysty, amonity. Wysyłka po zaksięgowaniu wpłaty. Zagraniczni klienci płacą bitcoinem.',
  },
  {
    handle: 'p_gajda',
    name: 'Paweł Gajda',
    showName: false,
    city: 'Rzeszów',
    phone: '500 000 817',
    joined: '2025-10-14T09:00:00Z',
    address: A.gajdaEth,
    asset: 'ETH',
    offerId: 2007,
    publishedAt: '2026-06-05T07:50:00Z',
    title: 'Sprzedam trochę ETH — Rzeszów, odbiór osobisty',
    price: 'kurs dnia',
    body: 'Niewielka kwota z wypłaty za zlecenie. Chętnie wymienię też na USDT.',
  },
  {
    handle: 'r_dudek',
    name: 'Robert Dudek',
    showName: true,
    city: 'Kielce',
    phone: '500 000 818',
    email: 'robert.dudek@grafika.example',
    joined: '2024-12-01T09:00:00Z',
    address: A.dudekEth,
    asset: 'ETH / USDT (ERC-20)',
    offerId: 2008,
    publishedAt: '2026-05-17T15:25:00Z',
    title: 'Grafika 3D na zlecenie — rozliczenie w ETH lub USDT',
    price: 'od 300 zł za model',
    body: 'Modele postaci i rekwizytów do gier. Zaliczka 30% przed rozpoczęciem pracy.',
  },
  {
    handle: 'ewelina_bak',
    name: 'Ewelina Bąk',
    showName: true,
    city: 'Szczecin',
    phone: '500 000 819',
    joined: '2025-01-20T09:00:00Z',
    address: A.ewelinaEth,
    asset: 'ETH',
    offerId: 2009,
    publishedAt: '2026-03-30T09:40:00Z',
    title: 'Tłumaczenia techniczne EN/DE — przyjmuję ETH',
    price: '45 zł za stronę',
    body: 'Instrukcje, dokumentacja, strony WWW. Klienci spoza Polski płacą w ETH.',
  },
  {
    handle: 'wiktor_noga',
    name: 'Wiktor Noga',
    showName: true,
    city: 'Płock',
    phone: '500 000 820',
    joined: '2024-02-27T09:00:00Z',
    address: A.nogaEth,
    asset: 'ETH / USDT (ERC-20)',
    offerId: 2010,
    publishedAt: '2026-06-14T21:10:00Z',
    title: 'Wymiana ETH/USDT — hurt, od 10 tys. zł, cała Polska',
    price: 'kurs dnia −0,5%',
    body: 'Stała współpraca mile widziana. Rozliczenie przelewem ekspresowym po zaksięgowaniu środków.',
  },
  {
    handle: 'nat_wilk',
    name: 'Natalia Wilk',
    showName: true,
    city: 'Kraków',
    phone: '500 000 821',
    email: 'natalia.wilk@kantor-online.example',
    joined: '2024-10-03T09:00:00Z',
    address: A.wilkTron,
    asset: 'USDT (TRC-20)',
    offerId: 2011,
    publishedAt: '2026-06-10T12:00:00Z',
    title: 'USDT (TRC-20) kupno/sprzedaż — Kraków, od ręki',
    price: 'kurs dnia ±1%',
    body: 'Wymiana w dni robocze 9–17, okolice Rynku Dębnickiego. Przy stałych klientach lepszy kurs.',
  },
  {
    handle: 'kinga_sowa',
    name: 'Kinga Sowa',
    showName: false,
    city: 'Opole',
    phone: '500 000 822',
    joined: '2025-03-12T09:00:00Z',
    address: A.sowaTron,
    asset: 'USDT (TRC-20)',
    offerId: 2012,
    publishedAt: '2026-05-06T18:35:00Z',
    title: 'Korepetycje z matematyki online — można płacić w USDT',
    price: '80 zł / 60 min',
    body: 'Liceum i studia, przygotowanie do matury rozszerzonej. Uczniowie z zagranicy płacą stablecoinami.',
  },
  {
    handle: 'tomasz_lis_p2p',
    name: 'Tomasz Lis',
    showName: true,
    city: 'Katowice',
    phone: '500 000 823',
    joined: '2023-09-15T09:00:00Z',
    address: A.lisTron,
    asset: 'USDT (TRC-20)',
    offerId: 2013,
    publishedAt: '2026-06-15T06:30:00Z',
    title: 'USDT hurtowo — Śląsk, gotówka, bez limitu',
    price: 'kurs dnia −1%',
    body: 'Duże kwoty od ręki, także w weekendy. Tylko poważne oferty, spotkanie w biurze.',
  },
  {
    handle: 'monika_rak',
    name: 'Monika Rak',
    showName: true,
    city: 'Zielona Góra',
    phone: '500 000 824',
    joined: '2026-01-05T09:00:00Z',
    address: A.rakTron,
    asset: 'USDT (TRC-20)',
    offerId: 2014,
    publishedAt: '2026-02-20T14:00:00Z',
    title: 'Sprzedam 250 USDT — jednorazowo',
    price: 'kurs dnia',
    body: 'Dostałam zapłatę za zlecenie w USDT i chcę zamienić na złotówki. Jedna transakcja.',
  },
  {
    handle: 'lena_kurek',
    name: 'Lena Kurek',
    showName: true,
    city: 'Elbląg',
    phone: '500 000 825',
    joined: '2025-06-22T09:00:00Z',
    address: A.lenaTron,
    asset: 'USDT (TRC-20)',
    offerId: 2015,
    publishedAt: '2026-04-11T10:25:00Z',
    title: 'Karty kolekcjonerskie — zestawy i single, płatność USDT',
    price: 'od 15 zł',
    body: 'Duży wybór kart z ostatnich dodatków. Wysyłka paczkomatem następnego dnia.',
  },
];

const traderOffer = (trader: Trader): Page => ({
  service: 'targ',
  path: `/oferta/${trader.offerId}`,
  kind: 'offer',
  title: trader.title,
  author: trader.handle,
  publishedAt: trader.publishedAt,
  html: `
<p><strong>Cena:</strong> ${trader.price} · <strong>Lokalizacja:</strong> ${trader.city}</p>
<p>${trader.body}</p>
<p>Adres do wpłaty (${trader.asset}): ${code(trader.address)}</p>
<p><strong>Kontakt:</strong> tel. ${phoneHtml(trader.phone)}, nick: ${trader.handle}${trader.email ? `, e-mail: <a href="mailto:${trader.email}">${trader.email}</a>` : ''}</p>`,
});

const profile = (handle: string, title: string, publishedAt: string, html: string, service: 'spolecznosc' | 'gitpub' = 'spolecznosc'): Page => ({
  service,
  path: service === 'gitpub' ? `/${handle}` : `/u/${handle}`,
  kind: 'profile',
  title,
  author: handle,
  publishedAt,
  html,
});

export const marketAccounts: Account[] = [
  ...traders.map(
    (trader): Account => ({
      service: 'targ',
      handle: trader.handle,
      ...(trader.showName ? { name: trader.name } : {}),
      ...(trader.email ? { email: trader.email } : {}),
      phone: trader.phone,
      location: trader.city,
      createdAt: trader.joined,
    }),
  ),
  // Drugie profile tych samych osób w innych serwisach.
  { service: 'spolecznosc', handle: 'igor_baran', name: 'Igor Baran', email: 'igor.baran@handel.example', location: 'Lublin', createdAt: '2022-05-14T09:00:00Z' },
  { service: 'spolecznosc', handle: 'darek_mroz', name: 'Dariusz Mróz', location: 'Gdańsk', createdAt: '2021-03-08T09:00:00Z' },
  { service: 'spolecznosc', handle: 'kinga.sowa', name: 'Kinga Sowa', location: 'Opole', createdAt: '2020-09-01T09:00:00Z' },
  { service: 'gitpub', handle: 'rdudek3d', name: 'Robert Dudek', email: 'robert.dudek@grafika.example', location: 'Kielce', createdAt: '2022-01-17T09:00:00Z' },
  // Wspólny telefon: konto Leny Kurek na Targu i konto „kurek_kolekcje" w Społeczności.
  { service: 'spolecznosc', handle: 'kurek_kolekcje', phone: '500 000 825', location: 'Elbląg', createdAt: '2025-07-01T09:00:00Z' },
  // Wspólny e-mail: Marcel Zych na Targu i konto „mz_mineraly" na Forum.
  { service: 'forum', handle: 'mz_mineraly', email: 'marcel@zych-mineraly.example', createdAt: '2024-10-02T09:00:00Z' },
  { service: 'komunikator', handle: 'tomasz_lis_p2p', location: 'Katowice' },
  { service: 'komunikator', handle: 'monika_rak' },
];

export const marketPages: Page[] = [
  ...traders.map(traderOffer),
  profile(
    'igor_baran',
    'Igor Baran (@igor_baran)',
    '2025-02-01T10:00:00Z',
    `
<p class="bio">Handel kryptowalutami i szkolenia dla początkujących. Lublin.</p>
<p>Kontakt: <a href="mailto:igor.baran@handel.example">igor.baran@handel.example</a>, tel. 500&nbsp;000&nbsp;811</p>
<p>Ogłoszenia wystawiam na Targu jako <a rel="me" href="/targ/oferta/2001">igor_baran</a>. Mój stały adres BTC: ${code(A.igorBtc)}</p>`,
  ),
  profile(
    'darek_mroz',
    'Dariusz Mróz (@darek_mroz)',
    '2025-04-19T10:00:00Z',
    `
<p class="bio">Żeglarz, Gdańsk. Od czasu do czasu wymieniam BTC ze znajomymi z branży.</p>
<p>Rozliczenia ze mną wyłącznie na ten adres: ${code(A.darekBtc)}</p>`,
  ),
  profile(
    'kinga.sowa',
    'Kinga Sowa (@kinga.sowa)',
    '2025-03-20T10:00:00Z',
    `
<p class="bio">Matematyczka, korepetytorka. Opole.</p>
<p>Uczniowie z zagranicy: USDT w sieci TRON na adres ${code(A.sowaTron)}</p>`,
  ),
  profile(
    'rdudek3d',
    'rdudek3d (Robert Dudek)',
    '2025-01-09T09:00:00Z',
    `
<p class="bio">Modele 3D do gier, narzędzia do eksportu. Kielce.</p>
<h2>README</h2>
<p>Skrypty do Blendera i paczki darmowych modeli. Zlecenia: <a href="mailto:robert.dudek@grafika.example">robert.dudek@grafika.example</a></p>
<h2>Wesprzyj mnie</h2>
<p>ETH / USDT (ERC-20): ${code(A.dudekEth)}</p>`,
    'gitpub',
  ),
  profile(
    'kurek_kolekcje',
    'Kurek Kolekcje (@kurek_kolekcje)',
    '2025-07-02T10:00:00Z',
    `
<p class="bio">Karty kolekcjonerskie, turnieje, wymiany. Elbląg.</p>
<p>Zamówienia telefonicznie: tel. 500&nbsp;000&nbsp;825. Przedpłaty w USDT (TRC-20): ${code(A.kolekcjeTron)}</p>`,
  ),
];

const entry = (author: string, publishedAt: string, html: string): Entry => ({ author, publishedAt, html: `<p>${html}</p>` });

export const marketThreads: Thread[] = [
  {
    service: 'forum',
    path: '/watek/3',
    title: 'Sprzedaż za krypto poza giełdą — wasze doświadczenia',
    itemKind: 'post',
    itemSegment: 'post',
    items: [
      entry('taryfa_nocna', '2026-05-30T18:00:00Z', 'Ktoś sprzedaje towar albo usługi bezpośrednio za krypto? Jak to potem rozliczacie?'),
      entry(
        'mz_mineraly',
        '2026-05-30T19:20:00Z',
        `Ja sprzedaję minerały kolekcjonerom z zagranicy. Wpłaty zbieram na jednym adresie: ${code(A.marcelBtc)} i raz na kwartał wymieniam w kantorze P2P. Kontakt: marcel@zych-mineraly.example`,
      ),
      entry('nocny_gornik', '2026-05-31T08:10:00Z', 'Dzięki, czyli da się normalnie. Pamiętajcie o PIT-38.'),
    ],
  },
  {
    service: 'spolecznosc',
    path: '/wpis/304',
    title: 'Nowe terminy szkoleń z bezpiecznego handlu P2P',
    opening: {
      kind: 'post',
      author: 'igor_baran',
      publishedAt: '2026-06-02T09:00:00Z',
      html: `<p>W czerwcu dwa szkolenia w Lublinie. Zapisy przez wiadomość prywatną, opłatę można wnieść w BTC na mój adres: ${code(A.igorBtc)}</p>`,
    },
    itemKind: 'comment',
    itemSegment: 'komentarz',
    items: [entry('darek_mroz', '2026-06-02T11:30:00Z', 'Polecam, z Igorem wymieniam od dawna — zawsze uczciwie.')],
  },
  {
    service: 'spolecznosc',
    path: '/wpis/305',
    title: 'Turniej kart w sobotę',
    opening: {
      kind: 'post',
      author: 'kurek_kolekcje',
      publishedAt: '2026-06-08T16:00:00Z',
      html: `<p>Wpisowe 20 zł albo 5 USDT (TRC-20) na ${code(A.kolekcjeTron)}. Zapisy do piątku.</p>`,
    },
    itemKind: 'comment',
    itemSegment: 'komentarz',
    items: [],
  },
  {
    service: 'komunikator',
    path: '/kanal/p2p-slask',
    title: 'P2P Śląsk — wymiana USDT',
    itemKind: 'message',
    itemSegment: 'wiadomosc',
    items: [
      entry('tomasz_lis_p2p', '2026-06-11T08:00:00Z', `Dziś kurs 3,62. Większe kwoty po wcześniejszym umówieniu. Wpłaty USDT jak zawsze: przelej na ${A.lisTron}`),
      entry('slazak_82', '2026-06-11T08:40:00Z', 'Biorę 2 tysiące, będę o 12.'),
      entry('monika_rak', '2026-06-11T09:15:00Z', `Czy ktoś odkupi 250 USDT? Mogę wysłać z ${A.rakTron}, rozliczenie BLIK-iem.`),
      entry('tomasz_lis_p2p', '2026-06-11T09:22:00Z', 'Monika, napisz prywatnie — wezmę.'),
    ],
  },
];

/** Adresy osób z tej części: prywatne; pośrednik i anonimowi kontrahenci celowo bez etykiety i klasy. */
export const marketLabeledAddresses: LabeledAddress[] = [
  ...([A.igorBtc, A.darekBtc, A.sylwiaBtc, A.olekBtc, A.pietrzakBtc, A.marcelBtc] as string[]).map(
    (address): LabeledAddress => ({ address, network: 'bitcoin', addressClass: 'private' }),
  ),
  ...([A.gajdaEth, A.dudekEth, A.ewelinaEth, A.nogaEth] as string[]).map(
    (address): LabeledAddress => ({ address, network: 'ethereum', addressClass: 'private' }),
  ),
  ...([A.wilkTron, A.sowaTron, A.lisTron, A.rakTron, A.lenaTron, A.kolekcjeTron] as string[]).map(
    (address): LabeledAddress => ({ address, network: 'tron', addressClass: 'private' }),
  ),
];

const row = (time: string, from: string, to: string, asset: string, amount: number): LedgerRow => ({ time, from, to, asset, amount });

export function marketLedger(S: ServiceAddresses): LedgerRow[] {
  return [
    // Igor Baran — duże wypłaty BTC w trzech latach; handluje z Dariuszem Mrozem.
    row('2024-01-09T10:00:00Z', A.anonBtc5, A.igorBtc, 'BTC', 2.4),
    row('2024-03-15T12:30:00Z', A.igorBtc, S.exchangeBtc, 'BTC', 1.2),
    row('2024-10-02T09:45:00Z', A.igorBtc, S.exchangeBtc, 'BTC', 0.9),
    row('2025-01-20T14:00:00Z', A.anonBtc6, A.igorBtc, 'BTC', 3.8),
    row('2025-02-11T08:15:00Z', A.igorBtc, S.exchangeBtc, 'BTC', 2.1),
    row('2025-03-18T16:20:00Z', A.igorBtc, A.darekBtc, 'BTC', 0.5),
    row('2025-06-24T11:05:00Z', A.darekBtc, A.igorBtc, 'BTC', 0.3),
    row('2025-07-30T13:40:00Z', A.igorBtc, S.p2pBtc, 'BTC', 0.8),
    row('2025-11-12T10:10:00Z', A.igorBtc, S.exchangeBtc, 'BTC', 1.4),
    row('2026-02-03T09:00:00Z', A.anonBtc5, A.igorBtc, 'BTC', 1.6),
    row('2026-04-16T15:30:00Z', A.igorBtc, S.exchangeBtc, 'BTC', 1.0),

    // Dariusz Mróz — średnia skala; kontrahentem jest adres Igora.
    row('2025-05-02T10:00:00Z', A.anonBtc5, A.darekBtc, 'BTC', 0.25),
    row('2025-09-09T12:00:00Z', A.darekBtc, S.exchangeBtc, 'BTC', 0.35),
    row('2026-03-21T17:10:00Z', A.darekBtc, S.p2pBtc, 'BTC', 0.15),

    // Jan Pietrzak — wypłaty tylko w 2024 r.; resztę oddaje przez pośrednika bez etykiety.
    row('2024-02-05T09:00:00Z', A.anonBtc5, A.pietrzakBtc, 'BTC', 0.6),
    row('2024-04-17T10:30:00Z', A.pietrzakBtc, S.exchangeBtc, 'BTC', 0.3),
    row('2024-09-26T14:45:00Z', A.pietrzakBtc, S.p2pBtc, 'BTC', 0.1),
    row('2025-11-02T19:00:00Z', A.pietrzakBtc, A.midBtc, 'BTC', 0.2),
    row('2025-11-03T07:30:00Z', A.midBtc, A.sylwiaBtc, 'BTC', 0.2),

    // Sylwia Kot — same wpływy, zero wypłat.
    row('2025-09-14T12:00:00Z', A.anonBtc6, A.sylwiaBtc, 'BTC', 0.05),
    row('2026-01-22T18:20:00Z', A.anonBtc6, A.sylwiaBtc, 'BTC', 0.03),

    // Marcel Zych — kantor P2P raz na jakiś czas.
    row('2025-02-14T11:00:00Z', A.anonBtc6, A.marcelBtc, 'BTC', 0.4),
    row('2025-05-19T09:30:00Z', A.marcelBtc, S.p2pBtc, 'BTC', 0.25),
    row('2026-02-10T10:00:00Z', A.marcelBtc, S.p2pBtc, 'BTC', 0.1),

    // Robert Dudek i Paweł Gajda — handlują ze sobą (ETH za USDT).
    row('2025-05-06T10:00:00Z', A.anonEth4, A.dudekEth, 'ETH', 1.5),
    row('2025-08-13T13:00:00Z', A.dudekEth, S.gatewayEth, 'ETH', 0.6),
    row('2025-12-04T16:00:00Z', A.dudekEth, A.gajdaEth, 'ETH', 0.3),
    row('2026-01-15T09:20:00Z', A.dudekEth, S.exchangeEth, 'ETH', 0.4),
    row('2026-01-08T12:00:00Z', A.anonEth4, A.gajdaEth, 'ETH', 0.5),
    row('2026-02-19T18:00:00Z', A.gajdaEth, A.dudekEth, 'USDT', 400),
    row('2026-03-27T10:40:00Z', A.gajdaEth, S.exchangeEth, 'ETH', 0.2),

    // Ewelina Bąk — średnia skala, 2025 i 2026.
    row('2025-03-03T09:00:00Z', A.anonEth4, A.ewelinaEth, 'ETH', 3.0),
    row('2025-04-10T11:00:00Z', A.ewelinaEth, S.swapEth, 'ETH', 2.0),
    row('2025-04-10T11:00:30Z', S.swapEth, A.ewelinaEth, 'USDT', 5200),
    row('2025-04-12T08:30:00Z', A.ewelinaEth, S.exchangeEth, 'USDT', 5000),
    row('2026-02-25T15:00:00Z', A.ewelinaEth, S.exchangeEth, 'ETH', 0.5),

    // Wiktor Noga — duże kwoty w 2025 r.: zamiana na stablecoiny, giełda, karta, bramka.
    row('2025-01-07T08:00:00Z', A.anonEth4, A.nogaEth, 'ETH', 12),
    row('2025-01-28T10:00:00Z', A.nogaEth, S.swapEth, 'ETH', 10),
    row('2025-01-28T10:00:30Z', S.swapEth, A.nogaEth, 'USDT', 31000),
    row('2025-02-04T09:15:00Z', A.nogaEth, S.exchangeEth, 'USDT', 20000),
    row('2025-06-16T12:00:00Z', A.nogaEth, S.cardEth, 'USDT', 6000),
    row('2025-09-23T14:30:00Z', A.nogaEth, S.gatewayEth, 'ETH', 1.5),

    // Natalia Wilk i Kinga Sowa — handlują ze sobą w USDT.
    row('2025-02-06T10:00:00Z', A.anonTron4, A.wilkTron, 'USDT', 4000),
    row('2025-03-12T12:00:00Z', A.wilkTron, S.p2pTron, 'USDT', 3000),
    row('2025-06-05T15:00:00Z', A.sowaTron, A.wilkTron, 'USDT', 1200),
    row('2025-07-21T09:00:00Z', A.anonTron4, A.wilkTron, 'USDT', 3500),
    row('2025-08-18T11:30:00Z', A.wilkTron, S.exchangeTron, 'USDT', 3800),
    row('2025-10-09T17:00:00Z', A.wilkTron, A.sowaTron, 'USDT', 600),
    row('2025-04-22T10:00:00Z', A.anonTron4, A.sowaTron, 'USDT', 2500),
    row('2025-12-15T13:00:00Z', A.sowaTron, S.p2pTron, 'USDT', 900),

    // Tomasz Lis — hurt w USDT, lata 2024 i 2025.
    row('2024-03-04T08:00:00Z', A.anonTron4, A.lisTron, 'USDT', 45000),
    row('2024-04-09T10:00:00Z', A.lisTron, S.exchangeTron, 'USDT', 20000),
    row('2024-10-17T12:00:00Z', A.lisTron, S.p2pTron, 'USDT', 15000),
    row('2025-01-13T09:00:00Z', A.anonTron4, A.lisTron, 'USDT', 38000),
    row('2025-02-20T11:00:00Z', A.lisTron, S.exchangeTron, 'USDT', 30000),
    row('2025-11-27T16:00:00Z', A.lisTron, S.p2pTron, 'USDT', 9000),

    // Monika Rak — jedna mała wypłata w 2026 r.
    row('2026-01-19T10:00:00Z', A.anonTron4, A.rakTron, 'USDT', 300),
    row('2026-02-23T12:00:00Z', A.rakTron, S.p2pTron, 'USDT', 250),

    // Lena Kurek i jej drugie konto „kurek_kolekcje" — dwa adresy, przelew między nimi.
    row('2025-09-08T10:00:00Z', A.anonTron4, A.lenaTron, 'USDT', 1800),
    row('2025-10-01T09:00:00Z', A.lenaTron, S.exchangeTron, 'USDT', 1500),
    row('2025-10-06T14:00:00Z', A.lenaTron, A.kolekcjeTron, 'USDT', 200),
    row('2026-01-28T11:00:00Z', A.anonTron4, A.kolekcjeTron, 'USDT', 700),
    row('2026-03-12T10:30:00Z', A.kolekcjeTron, S.p2pTron, 'USDT', 800),
  ];
}
