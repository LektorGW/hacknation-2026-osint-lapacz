// Część scenariusza „obieg środków (ping-pong)”: środki wychodzą z adresu podmiotu i wracają na niego.
// Wszystkie osoby, konta i adresy są ZMYŚLONE. Adresy wygenerowano skryptem scripts/generate-addresses.ts
// z losowych danych — nikt nie zna do nich kluczy.
//
// Przebieg (sprawa: nick „l_krag”, Leon Krąg, Kalisz):
//   Web2 — profil w GitPub z adresem BTC do darowizn.
//   Blockchain (Bitcoin) — wpływ 2 BTC od anonimowego nadawcy, potem:
//     • obieg przez dwa adresy pośrednie bez etykiet: podmiot → P1 (0,8) → P2 (0,79) → podmiot (0,78), luty 2026;
//     • bezpośredni ping-pong z tym samym adresem, dwukrotnie: podmiot → B (0,3) → podmiot (0,3) w marcu
//       i podmiot → B (0,25) → podmiot (0,24) w kwietniu 2026;
//     • gałąź bez powrotu: podmiot → S (0,2) → inny adres (0,2).
// Plik nie zmienia niczego w pozostałych częściach scenariusza (bez ogłoszeń, bez adresów usług).

import type { Account, LabeledAddress, LedgerRow, Page } from './scenario.ts';

export const ROUNDTRIP_ADDR = {
  /** Adres podmiotu (Bitcoin). */
  kragBtc: 'bc1qqk6pav9ap2q6wmex7yc40cy9hkjv4uqpcg7s2w',
  /** Anonimowy nadawca środków. */
  funderBtc: '3FCzRGhaYkbMoK6stBF9DBDP3ShJrSmBGu',
  /** Adresy pośrednie obiegu (bez etykiet). */
  hop1Btc: 'bc1qvd3phwwjvw404g6ktx2023m7jqmy65vrcfk0cj',
  hop2Btc: '1PMujJjihdnAQETcVVHP1GKdBSwacDdCrj',
  /** Adres, z którym podmiot dwukrotnie „odbija” środki (ping-pong bezpośredni). */
  partnerBtc: '17nS1UiNApjXquQ3zVb54oy2uXPjoebik',
  /** Gałąź bez powrotu. */
  sideBtc: '12V4KxBT5Dv1xNWM4LPe7NJqY8dzs9HVSv',
  sinkBtc: '1EKid3KZv9xQiyoekLcwLTGcnF5MmqkQot',
} as const;

const R = ROUNDTRIP_ADDR;
const code = (address: string) => `<code>${address}</code>`;

export const roundtripAccounts: Account[] = [{ service: 'gitpub', handle: 'l_krag', name: 'Leon Krąg', location: 'Kalisz', createdAt: '2021-09-14T09:00:00Z' }];

export const roundtripPages: Page[] = [
  {
    service: 'gitpub',
    path: '/l_krag',
    kind: 'profile',
    title: 'l_krag (Leon Krąg)',
    author: 'l_krag',
    // Data starsza od pozostałych profili — lista „najnowszych” w innych testach się nie zmienia.
    publishedAt: '2023-02-01T09:00:00Z',
    html: `
<p class="bio">Narzędzia do analizy logów serwerowych. Kalisz.</p>
<h2>Wesprzyj projekt</h2>
<p>Darowizny w BTC: ${code(R.kragBtc)}</p>`,
  },
];

export const roundtripLabeledAddresses: LabeledAddress[] = [{ address: R.kragBtc, network: 'bitcoin', addressClass: 'private' }];

const row = (time: string, from: string, to: string, amount: number): LedgerRow => ({ time, from, to, asset: 'BTC', amount });

export function roundtripLedger(): LedgerRow[] {
  return [
    row('2026-01-10T09:00:00Z', R.funderBtc, R.kragBtc, 2),
    // Obieg przez dwa adresy pośrednie (3 przelewy, 3 dni).
    row('2026-02-03T10:15:00Z', R.kragBtc, R.hop1Btc, 0.8),
    row('2026-02-04T08:40:00Z', R.hop1Btc, R.hop2Btc, 0.79),
    row('2026-02-06T19:05:00Z', R.hop2Btc, R.kragBtc, 0.78),
    // Gałąź bez powrotu.
    row('2026-02-10T12:00:00Z', R.kragBtc, R.sideBtc, 0.2),
    row('2026-02-12T12:00:00Z', R.sideBtc, R.sinkBtc, 0.2),
    // Ping-pong bezpośredni, powtórzony dwukrotnie.
    row('2026-03-01T11:00:00Z', R.kragBtc, R.partnerBtc, 0.3),
    row('2026-03-02T16:30:00Z', R.partnerBtc, R.kragBtc, 0.3),
    row('2026-04-10T09:20:00Z', R.kragBtc, R.partnerBtc, 0.25),
    row('2026-04-11T10:45:00Z', R.partnerBtc, R.kragBtc, 0.24),
  ];
}
