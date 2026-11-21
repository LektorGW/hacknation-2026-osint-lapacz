// Część scenariusza „miksery i CoinJoin”: środki podmiotu przechodzą przez mikser.
// Wszystkie osoby, konta, usługi i adresy są ZMYŚLONE. „WirMix” to fikcyjny mikser — nie istnieje.
// Adresy wygenerowano skryptem scripts/generate-addresses.ts z losowych danych — nikt nie zna do nich kluczy.
//
// Przebieg (sprawa: nick „e_wirski”, Edward Wirski, Toruń):
//   Web2 — profil w GitPub z adresem BTC do darowizn.
//   Blockchain (Bitcoin) — wpływ 0,9 BTC od anonimowego nadawcy; dwie wpłaty na giełdę (wycena kursem z dnia);
//          dwa przelewy do miksera „WirMix” (0,3 i 0,2 BTC, marzec 2026), potem wpływ 0,45 BTC Z miksera (kwiecień 2026);
//          oraz jedna transakcja z czterema wyjściami po 0,05 BTC do różnych adresów (wzorzec CoinJoin / Whirlpool —
//          w teczce jako hipoteza).
// Plik nie zmienia niczego w pozostałych częściach scenariusza.

import type { Account, LabeledAddress, LedgerRow, Page } from './scenario.ts';

export const MIXER_ADDR = {
  /** Adres podmiotu (Bitcoin). */
  wirskiBtc: 'bc1qwvesxke7vc3zacv89tss38pu0tu58v0zxaxvdj',
  /** Fikcyjny mikser „WirMix” — adres oznaczony w eksploratorze klasą „mixer”. */
  wirmixBtc: '3CnxBR41tSbAigyxeaxGCrucPLCUWv5qnk',
  /** Anonimowy nadawca środków. */
  funderBtc: '18iAHmtSr7Vi6YYERiW4psV3mMSGHzanef',
  /** Wyjścia transakcji o wzorcu CoinJoin (po 0,05 BTC). */
  joinBtc1: 'bc1qceghkvgnzwe4rucygq8v2vsw48w5rgp2psfan4',
  joinBtc2: 'bc1q58u47t3l7qkx7djvjuefwsugcvx205l4kuakds',
  joinBtc3: 'bc1q7r5gxfx25zknju9ce9sq39hu53su7xvdyxl5g5',
  joinBtc4: 'bc1quudchn5522lczzqz0zutt6yev0lfmdya7m4w2v',
} as const;

const M = MIXER_ADDR;
const code = (address: string) => `<code>${address}</code>`;

export const mixerAccounts: Account[] = [{ service: 'gitpub', handle: 'e_wirski', name: 'Edward Wirski', location: 'Toruń', createdAt: '2022-05-10T09:00:00Z' }];

export const mixerPages: Page[] = [
  {
    service: 'gitpub',
    path: '/e_wirski',
    kind: 'profile',
    title: 'e_wirski (Edward Wirski)',
    author: 'e_wirski',
    // Data starsza od pozostałych profili — lista „najnowszych” w innych testach się nie zmienia.
    publishedAt: '2023-03-01T09:00:00Z',
    html: `
<p class="bio">Biblioteki do kompresji obrazów. Toruń.</p>
<h2>Wesprzyj projekt</h2>
<p>Darowizny w BTC: ${code(M.wirskiBtc)}</p>`,
  },
];

export const mixerLabeledAddresses: LabeledAddress[] = [
  { address: M.wirskiBtc, network: 'bitcoin', addressClass: 'private' },
  { address: M.wirmixBtc, network: 'bitcoin', label: 'WirMix: pula miksera (fikcyjny mikser)', addressClass: 'mixer' },
];

/** Jedna transakcja, wiele wyjść o identycznej kwocie — wspólny identyfikator transakcji. */
const JOIN_TXID = 'c0' + '1f'.repeat(31);

const row = (time: string, from: string, to: string, asset: string, amount: number, txid?: string): LedgerRow => ({ time, from, to, asset, amount, ...(txid ? { txid } : {}) });

export function mixerLedger(C: { exchangeBtc: string }): LedgerRow[] {
  return [
    row('2026-02-02T09:00:00Z', M.funderBtc, M.wirskiBtc, 'BTC', 0.9),
    // Wpłaty na giełdę — dają kurs BTC z dnia (wycena przekazań do i z miksera z istniejących wycen).
    row('2026-02-20T12:00:00Z', M.wirskiBtc, C.exchangeBtc, 'BTC', 0.1),
    row('2026-04-10T12:00:00Z', M.wirskiBtc, C.exchangeBtc, 'BTC', 0.05),
    // Dwa przelewy DO miksera.
    row('2026-03-03T18:20:00Z', M.wirskiBtc, M.wirmixBtc, 'BTC', 0.3),
    row('2026-03-05T21:05:00Z', M.wirskiBtc, M.wirmixBtc, 'BTC', 0.2),
    // Wpływ Z miksera — pochodzenie środków zatarte.
    row('2026-04-14T07:45:00Z', M.wirmixBtc, M.wirskiBtc, 'BTC', 0.45),
    // Transakcja o wzorcu CoinJoin: cztery wyjścia po 0,05 BTC (nominał puli Whirlpool) do różnych adresów.
    row('2026-04-25T10:00:00Z', M.wirskiBtc, M.joinBtc1, 'BTC', 0.05, JOIN_TXID),
    row('2026-04-25T10:00:00Z', M.wirskiBtc, M.joinBtc2, 'BTC', 0.05, JOIN_TXID),
    row('2026-04-25T10:00:00Z', M.wirskiBtc, M.joinBtc3, 'BTC', 0.05, JOIN_TXID),
    row('2026-04-25T10:00:00Z', M.wirskiBtc, M.joinBtc4, 'BTC', 0.05, JOIN_TXID),
  ];
}
