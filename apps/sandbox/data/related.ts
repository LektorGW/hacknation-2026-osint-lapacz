// Trzecia część scenariusza: „powiązane tożsamości" — ta sama osoba pod innym nazwiskiem,
// wspólny indywidualny adres wpłat giełdy, wspólny telefon i e-mail u osób o różnych
// nazwiskach. Wszystkie osoby, konta i adresy są zmyślone (adresy z scripts/generate-addresses.ts).
// Plik nie zmienia niczego w scenariuszach a–h ani w części rynkowej poza dodatkowymi
// przelewami między Igorem Baranem i Dariuszem Mrozem (przelewy w obie strony).

import type { Account, LabeledAddress, LedgerRow, Page } from './scenario.ts';

export const RELATED_ADDR = {
  // Jeden adres, dwa nazwiska: Rafał Kowalski i Julia Kowalska publikują go jako własny.
  kowalBtc: 'bc1q43zhzvxx00twnd5jlg7n4f9x42ped8u6wk2g98',
  // Dwie osoby o różnych nazwiskach wpłacają na ten sam adres wpłat giełdy.
  nowakEth: '0xDA63b310B7B6c5e4A74A1F5AED0A7021B43B08a4',
  wisniewskaEth: '0x5E0361698A0176E20F4Cb1a30484E43291EC90Db',
  /** Adres pośredni bez etykiety: mało transakcji, w ciągu godziny przekazuje całość na portfel giełdy. */
  depositEth: '0xEdE699742C11336693768f40Ee09Cc3809c8A8aD',
  // Wspólny telefon i wspólny e-mail u różnych nazw kont.
  zajacTron: 'TRCwAH4zkVeaZADymohAmaebc786TpA4Q5',
  majTron: 'TNS8s3VrbyMhvkVgvEVekaHvELzcvMfx8k',
  studioBtc: '14rGHX134FcK7HiLQtKm83XwCwvB2xSEP8',
} as const;

const R = RELATED_ADDR;
const code = (address: string) => `<code>${address}</code>`;
const nbsp = (phone: string) => phone.replace(/ /g, '&nbsp;');

interface Offer {
  id: number;
  handle: string;
  title: string;
  publishedAt: string;
  price: string;
  city: string;
  body: string;
  asset: string;
  address: string;
  phone: string;
  email?: string;
}

const offer = (item: Offer): Page => ({
  service: 'targ',
  path: `/oferta/${item.id}`,
  kind: 'offer',
  title: item.title,
  author: item.handle,
  publishedAt: item.publishedAt,
  html: `
<p><strong>Cena:</strong> ${item.price} · <strong>Lokalizacja:</strong> ${item.city}</p>
<p>${item.body}</p>
<p>Adres do wpłaty (${item.asset}): ${code(item.address)}</p>
<p><strong>Kontakt:</strong> tel. ${nbsp(item.phone)}, nick: ${item.handle}${item.email ? `, e-mail: <a href="mailto:${item.email}">${item.email}</a>` : ''}</p>`,
});

export const relatedAccounts: Account[] = [
  // 1) Ta sama osoba pod innym nazwiskiem.
  { service: 'gitpub', handle: 'rkowalski_btc', name: 'Rafał Kowalski', email: 'rafal.kowalski@kodowanie.example', location: 'Toruń', createdAt: '2021-04-12T09:00:00Z' },
  { service: 'targ', handle: 'rkowalski_btc', name: 'Rafał Kowalski', phone: '500 000 831', location: 'Toruń', createdAt: '2023-02-01T09:00:00Z' },
  { service: 'spolecznosc', handle: 'julka_k', name: 'Julia Kowalska', location: 'Toruń', createdAt: '2022-07-19T09:00:00Z' },
  { service: 'targ', handle: 'julka_k', name: 'Julia Kowalska', phone: '500 000 832', location: 'Toruń', createdAt: '2024-03-03T09:00:00Z' },
  // 2) Różne nazwiska, wspólny adres wpłat giełdy.
  { service: 'targ', handle: 't_nowak_foto', name: 'Tomasz Nowak', phone: '500 000 833', location: 'Olsztyn', createdAt: '2023-08-08T09:00:00Z' },
  { service: 'spolecznosc', handle: 'ewa_wisniewska', name: 'Ewa Wiśniewska', location: 'Olsztyn', createdAt: '2021-11-30T09:00:00Z' },
  { service: 'targ', handle: 'ewa_wisniewska', name: 'Ewa Wiśniewska', phone: '500 000 834', location: 'Olsztyn', createdAt: '2024-05-20T09:00:00Z' },
  // 3) Wspólny telefon (dwa konta) i wspólny e-mail (drugie i trzecie konto).
  { service: 'targ', handle: 'auto_czesci_wwa', name: 'Piotr Zając', phone: '500 000 840', location: 'Warszawa', createdAt: '2022-09-14T09:00:00Z' },
  { service: 'targ', handle: 'ania_handmade', name: 'Anna Maj', email: 'pracownia@maj-studio.example', phone: '500 000 840', location: 'Warszawa', createdAt: '2023-10-10T09:00:00Z' },
  { service: 'targ', handle: 'maj_studio', name: 'Karolina Lis', email: 'pracownia@maj-studio.example', phone: '500 000 841', location: 'Piaseczno', createdAt: '2025-01-15T09:00:00Z' },
];

export const relatedPages: Page[] = [
  {
    service: 'gitpub',
    path: '/rkowalski_btc',
    kind: 'profile',
    title: 'rkowalski_btc (Rafał Kowalski)',
    author: 'rkowalski_btc',
    publishedAt: '2024-02-10T09:00:00Z',
    html: `
<p class="bio">Skrypty do księgowania transakcji i boty cenowe. Toruń.</p>
<h2>README</h2>
<p>Narzędzia do eksportu historii z giełd. Zlecenia: <a href="mailto:rafal.kowalski@kodowanie.example">rafal.kowalski@kodowanie.example</a></p>
<h2>Wesprzyj mnie</h2>
<p>BTC: ${code(R.kowalBtc)}</p>`,
  },
  offer({
    id: 2101,
    handle: 'rkowalski_btc',
    title: 'Konfiguracja botów giełdowych — rozliczenie w BTC',
    publishedAt: '2026-05-10T10:00:00Z',
    price: 'od 400 zł',
    city: 'Toruń',
    body: 'Ustawiam boty cenowe i alerty na wybranej giełdzie. Zaliczka 50% przed startem.',
    asset: 'BTC',
    address: R.kowalBtc,
    phone: '500 000 831',
  }),
  {
    service: 'spolecznosc',
    path: '/u/julka_k',
    kind: 'profile',
    title: 'Julia Kowalska (@julka_k)',
    author: 'julka_k',
    publishedAt: '2025-03-15T10:00:00Z',
    html: `
<p class="bio">Ilustratorka, Toruń. Portrety zwierzaków na zamówienie.</p>
<p>Zamówienia opłacone w krypto przyjmuję na swój adres BTC: ${code(R.kowalBtc)}</p>`,
  },
  offer({
    id: 2102,
    handle: 'julka_k',
    title: 'Portret zwierzaka na zamówienie — akwarela',
    publishedAt: '2026-05-11T12:00:00Z',
    price: '250 zł',
    city: 'Toruń',
    body: 'Maluję ze zdjęcia, format A4. Termin realizacji około dwóch tygodni.',
    asset: 'BTC',
    address: R.kowalBtc,
    phone: '500 000 832',
  }),
  offer({
    id: 2103,
    handle: 't_nowak_foto',
    title: 'Obiektyw 85 mm f/1.8 — sprzedam, możliwa zapłata w ETH',
    publishedAt: '2026-05-12T09:30:00Z',
    price: '1 400 zł',
    city: 'Olsztyn',
    body: 'Stan bardzo dobry, komplet z osłoną i filtrem UV. Odbiór osobisty albo wysyłka.',
    asset: 'ETH',
    address: R.nowakEth,
    phone: '500 000 833',
  }),
  {
    service: 'spolecznosc',
    path: '/u/ewa_wisniewska',
    kind: 'profile',
    title: 'Ewa Wiśniewska (@ewa_wisniewska)',
    author: 'ewa_wisniewska',
    publishedAt: '2025-06-01T10:00:00Z',
    html: `
<p class="bio">Lektorka języka hiszpańskiego. Olsztyn.</p>
<p>Uczniowie spoza Polski mogą płacić w ETH: ${code(R.wisniewskaEth)}</p>`,
  },
  offer({
    id: 2104,
    handle: 'ewa_wisniewska',
    title: 'Hiszpański online — konwersacje i przygotowanie do DELE',
    publishedAt: '2026-05-13T16:00:00Z',
    price: '90 zł / 60 min',
    city: 'Olsztyn',
    body: 'Zajęcia indywidualne, wszystkie poziomy. Pierwsza lekcja próbna za pół ceny.',
    asset: 'ETH',
    address: R.wisniewskaEth,
    phone: '500 000 834',
  }),
  offer({
    id: 2105,
    handle: 'auto_czesci_wwa',
    title: 'Części do aut japońskich — sprowadzam na zamówienie',
    publishedAt: '2026-05-14T08:00:00Z',
    price: 'wycena indywidualna',
    city: 'Warszawa',
    body: 'Sprowadzam używane części z aukcji. Przedpłata w USDT przyspiesza zamówienie.',
    asset: 'USDT (TRC-20)',
    address: R.zajacTron,
    phone: '500 000 840',
  }),
  offer({
    id: 2106,
    handle: 'ania_handmade',
    title: 'Biżuteria z żywicy — kolczyki i wisiorki',
    publishedAt: '2026-05-15T18:20:00Z',
    price: 'od 45 zł',
    city: 'Warszawa',
    body: 'Ręcznie robione, każdy egzemplarz inny. Wysyłka paczkomatem.',
    asset: 'USDT (TRC-20)',
    address: R.majTron,
    phone: '500 000 840',
    email: 'pracownia@maj-studio.example',
  }),
  offer({
    id: 2107,
    handle: 'maj_studio',
    title: 'Warsztaty z żywicy epoksydowej — weekendowe',
    publishedAt: '2026-05-16T11:45:00Z',
    price: '320 zł od osoby',
    city: 'Piaseczno',
    body: 'Grupy do sześciu osób, materiały w cenie. Rezerwacja po wpłacie zadatku.',
    asset: 'BTC',
    address: R.studioBtc,
    phone: '500 000 841',
    email: 'pracownia@maj-studio.example',
  }),
];

/** Adresy osób: prywatne. Adres pośredni (`depositEth`) celowo bez etykiety i klasy. */
export const relatedLabeledAddresses: LabeledAddress[] = [
  { address: R.kowalBtc, network: 'bitcoin', addressClass: 'private' },
  { address: R.studioBtc, network: 'bitcoin', addressClass: 'private' },
  { address: R.nowakEth, network: 'ethereum', addressClass: 'private' },
  { address: R.wisniewskaEth, network: 'ethereum', addressClass: 'private' },
  { address: R.zajacTron, network: 'tron', addressClass: 'private' },
  { address: R.majTron, network: 'tron', addressClass: 'private' },
];

/** Adresy z pozostałych części scenariusza potrzebne w przelewach. */
export interface RelatedCounterparties {
  exchangeBtc: string;
  exchangeEth: string;
  exchangeTron: string;
  p2pBtc: string;
  p2pTron: string;
  anonBtc: string;
  anonEth: string;
  anonTron: string;
  igorBtc: string;
  darekBtc: string;
}

const row = (time: string, from: string, to: string, asset: string, amount: number): LedgerRow => ({ time, from, to, asset, amount });

export function relatedLedger(C: RelatedCounterparties): LedgerRow[] {
  return [
    // 1) Wspólny adres Rafała Kowalskiego i Julii Kowalskiej: wypłaty na giełdę w dwóch latach.
    row('2024-03-11T10:00:00Z', C.anonBtc, R.kowalBtc, 'BTC', 0.7),
    row('2024-06-18T09:30:00Z', R.kowalBtc, C.exchangeBtc, 'BTC', 0.4),
    row('2024-11-05T14:00:00Z', C.anonBtc, R.kowalBtc, 'BTC', 0.5),
    row('2025-02-20T11:15:00Z', R.kowalBtc, C.exchangeBtc, 'BTC', 0.35),
    row('2025-09-09T16:40:00Z', C.anonBtc, R.kowalBtc, 'BTC', 0.3),
    row('2025-10-02T08:20:00Z', R.kowalBtc, C.exchangeBtc, 'BTC', 0.25),

    // 2) Tomasz Nowak i Ewa Wiśniewska: oboje wysyłają na ten sam adres pośredni, który w ciągu godziny
    //    przekazuje całość na oznaczony portfel giełdy — typowy indywidualny adres wpłat jednego konta giełdowego.
    row('2025-03-04T09:00:00Z', C.anonEth, R.nowakEth, 'ETH', 1.3),
    row('2025-03-10T12:00:00Z', R.nowakEth, R.depositEth, 'ETH', 1.0),
    row('2025-03-10T12:22:00Z', R.depositEth, C.exchangeEth, 'ETH', 1.0),
    row('2025-05-06T15:00:00Z', C.anonEth, R.wisniewskaEth, 'ETH', 0.9),
    row('2025-05-19T18:05:00Z', R.wisniewskaEth, R.depositEth, 'ETH', 0.8),
    row('2025-05-19T18:41:00Z', R.depositEth, C.exchangeEth, 'ETH', 0.8),
    row('2026-01-12T10:00:00Z', C.anonEth, R.nowakEth, 'ETH', 0.6),
    row('2026-02-03T09:10:00Z', R.nowakEth, R.depositEth, 'ETH', 0.5),
    row('2026-02-03T09:38:00Z', R.depositEth, C.exchangeEth, 'ETH', 0.5),

    // 3) Konta ze wspólnym telefonem i e-mailem: drobne wpływy i wypłaty.
    row('2025-07-01T10:00:00Z', C.anonTron, R.zajacTron, 'USDT', 2200),
    row('2025-07-15T12:00:00Z', R.zajacTron, C.p2pTron, 'USDT', 2000),
    row('2025-08-03T10:00:00Z', C.anonTron, R.majTron, 'USDT', 600),
    row('2025-09-01T12:00:00Z', R.majTron, C.exchangeTron, 'USDT', 500),
    row('2025-11-11T10:00:00Z', C.anonBtc, R.studioBtc, 'BTC', 0.08),
    row('2026-01-20T12:00:00Z', R.studioBtc, C.p2pBtc, 'BTC', 0.06),

    // 4) Przelewy w obie strony, wielokrotne i w dłuższym okresie: Igor Baran ↔ Dariusz Mróz.
    row('2024-08-14T10:00:00Z', C.igorBtc, C.darekBtc, 'BTC', 0.2),
    row('2024-12-02T15:30:00Z', C.darekBtc, C.igorBtc, 'BTC', 0.15),
    row('2025-10-21T09:45:00Z', C.igorBtc, C.darekBtc, 'BTC', 0.1),
    row('2026-02-26T13:10:00Z', C.darekBtc, C.igorBtc, 'BTC', 0.12),
    row('2026-05-07T17:00:00Z', C.igorBtc, C.darekBtc, 'BTC', 0.25),
  ];
}
