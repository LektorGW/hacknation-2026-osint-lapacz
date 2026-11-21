// Część scenariusza „wyjście do walut tradycyjnych” (wskaźnik C, Fiat Cash-Out).
// Wszystkie osoby, konta, giełdy i adresy są ZMYŚLONE. „Giełda Wisła” to fikcyjna polska giełda — nie istnieje.
// Adresy wygenerowano skryptem scripts/generate-addresses.ts z losowych danych — nikt nie zna do nich kluczy.
//
// Przebieg (sprawa: nick „teo_usdt_waw”, Teodor Kaliszuk, Warszawa):
//   Web2 — ogłoszenie na Targu „Sprzedam USDT za gotówkę, Warszawa, BLIK” i jego kopia na Forum (jedno pochodzenie),
//          profil w Społeczności: „płacę kartą krypto, resztę wypłacam w bitomacie”;
//          odpowiedź innego autora pod postem wymienia nick podmiotu — wzmianka innej osoby się nie liczy.
//   Blockchain (Ethereum) — 12 ETH zamienione na USDT przez „WymianaSwap” (ok. 99,6 tys. zł po kursie przykładowym),
//          potem cztery wpłaty USDT na „Giełda Wisła: portfel giełdy” w lutym, kwietniu, czerwcu i sierpniu 2026 r.,
//          każda o wartości bliskiej okrągłej kwocie w PLN; po ostatniej wpłacie adres milknie.
// Plik nie zmienia niczego w pozostałych częściach scenariusza.

import type { Account, LabeledAddress, LedgerRow, Page, Thread } from './scenario.ts';

export const FIAT_ADDR = {
  /** Adres podmiotu (Ethereum, USDT ERC-20). */
  teoEth: '0x356319Fa5DC4e72Bd521900Be5f517f2c01Da584',
  /** Portfel fikcyjnej polskiej giełdy „Giełda Wisła”. */
  wislaEth: '0x63253cEd9734529F06fa9684e9f5bE00e1Bf20A8',
} as const;

const F = FIAT_ADDR;
const code = (address: string) => `<code>${address}</code>`;

/** Akapit oferty — identyczny na Targu i na Forum (kopia liczy się raz). */
const offer = `Sprzedam USDT za gotówkę, Warszawa, BLIK. Odbiór osobisty w centrum (okolice metra Centrum) albo przelew na konto po zaksięgowaniu tokenów. Kwoty od 1 000 do 30 000 zł, kurs dnia, bez prowizji. Adres do rozliczeń w sieci Ethereum: ${code(F.teoEth)}`;

export const fiatAccounts: Account[] = [
  { service: 'targ', handle: 'teo_usdt_waw', name: 'Teodor Kaliszuk', phone: '500 000 891', location: 'Warszawa', createdAt: '2024-11-02T09:00:00Z' },
  { service: 'forum', handle: 'teo_usdt_waw', name: 'Teodor Kaliszuk', location: 'Warszawa', createdAt: '2025-01-15T09:00:00Z' },
  { service: 'spolecznosc', handle: 'teo_usdt_waw', name: 'Teodor Kaliszuk', location: 'Warszawa', createdAt: '2024-12-01T09:00:00Z' },
  { service: 'forum', handle: 'obserwator_waw', location: 'Warszawa', createdAt: '2023-05-05T09:00:00Z' },
];

export const fiatPages: Page[] = [
  {
    service: 'targ',
    path: '/oferta/4101',
    kind: 'offer',
    title: 'USDT za gotówkę — Warszawa, BLIK',
    author: 'teo_usdt_waw',
    publishedAt: '2026-01-20T09:00:00Z',
    html: `
<p><strong>Cena:</strong> kurs dnia · <strong>Lokalizacja:</strong> Warszawa</p>
<p>${offer}</p>
<p><strong>Kontakt:</strong> tel. 500&nbsp;000&nbsp;891, nick: teo_usdt_waw</p>`,
  },
  {
    service: 'spolecznosc',
    path: '/u/teo_usdt_waw',
    kind: 'profile',
    title: 'Teodor Kaliszuk (@teo_usdt_waw)',
    author: 'teo_usdt_waw',
    publishedAt: '2026-02-01T09:00:00Z',
    html: `
<p class="bio">Handluję USDT od 2024 r., Warszawa. Na co dzień płacę kartą krypto, a gotówkę wypłacam w bitomacie.</p>
<p>Adres do rozliczeń: ${code(F.teoEth)}</p>`,
  },
];

export const fiatThreads: Thread[] = [
  {
    service: 'forum',
    path: '/watek/41',
    title: 'Giełda: kupię / sprzedam (Mazowsze)',
    itemKind: 'post',
    itemSegment: 'post',
    items: [
      // Kopia oferty z Targu — ta sama treść, jedno pochodzenie.
      { author: 'teo_usdt_waw', publishedAt: '2026-01-20T09:30:00Z', html: `<p>${offer}</p>` },
      // Wzmianka INNEJ osoby — nie jest publikacją podmiotu i nie wchodzi do oceny.
      { author: 'obserwator_waw', publishedAt: '2026-01-21T18:00:00Z', html: '<p>Kupowałem od teo_usdt_waw, podobno sprzedaje też BTC za gotówkę przez Binance P2P.</p>' },
    ],
  },
];

export const fiatLabeledAddresses: LabeledAddress[] = [
  { address: F.teoEth, network: 'ethereum', addressClass: 'private' },
  { address: F.wislaEth, network: 'ethereum', label: 'Giełda Wisła: portfel giełdy', addressClass: 'exchange' },
];

/** Adresy z pozostałych części scenariusza potrzebne w przelewach. */
export interface FiatCounterparties {
  swapEth: string;
  anonEth: string;
}

const row = (time: string, from: string, to: string, asset: string, amount: number): LedgerRow => ({ time, from, to, asset, amount });

export function fiatLedger(C: FiatCounterparties): LedgerRow[] {
  return [
    row('2026-02-03T10:00:00Z', C.anonEth, F.teoEth, 'ETH', 12),
    // Zamiana 12 ETH na USDT (kurs przykładowy 02.2026: 8 300 zł/ETH → ok. 99,6 tys. zł).
    row('2026-02-05T10:00:00Z', F.teoEth, C.swapEth, 'ETH', 12),
    row('2026-02-05T10:00:30Z', C.swapEth, F.teoEth, 'USDT', 27_700),
    // Wpłaty na giełdę w czterech różnych miesiącach; wartość w PLN po kursie przykładowym bliska okrągłej kwocie.
    row('2026-02-07T12:00:00Z', F.teoEth, F.wislaEth, 'USDT', 8_333),
    row('2026-04-09T12:00:00Z', F.teoEth, F.wislaEth, 'USDT', 5_525),
    row('2026-06-11T12:00:00Z', F.teoEth, F.wislaEth, 'USDT', 8_264),
    row('2026-08-12T12:00:00Z', F.teoEth, F.wislaEth, 'USDT', 5_494),
    // Po 12.08.2026 adres nie ma żadnych transakcji.
  ];
}
