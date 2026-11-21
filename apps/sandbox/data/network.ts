// Część scenariusza „siatka” — do demonstracji rozwijania sieci na żądanie („Rozwiń” w grafie).
// Wszystkie osoby, firmy, konta, adresy i WPISY LISTY SANKCYJNEJ są ZMYŚLONE. Lista sankcyjna tej części
// jest SYNTETYCZNA: nie jest kopią żadnej prawdziwej listy, a jej wpisy są wprost oznaczone jako fikcyjne.
// Adresy wygenerowano skryptem scripts/generate-addresses.ts z losowych danych — nikt nie zna do nich kluczy.
//
// Przebieg demonstracji (sprawa: nick „owierzba”):
//   podmiot Oskar Wierzba (GitPub) publikuje adres BTC W1 → przelew z W1 na adres Y
//   → adres Y publikują jako własny DWA konta Targu: „szybki_wymiennik” (Hubert Kos) i „leon_mewa” (Leon Mewa)
//   → „leon_mewa” publikuje też adres USDT (Ethereum) Z → Z figuruje we wpisie SYNTETYCZNEJ listy sankcyjnej
//     „NORDWIND CAPITAL LTD (FIKCYJNA)”.
//   „szybki_wymiennik” i konto forum „kantor_b” podają ten sam e-mail (ta sama osoba w dwóch serwisach).
// Rozwinięcie 1: adres W1, grupy „adresy i przepływy” + „publikacje”, głębokość 2 → konta B i C.
// Rozwinięcie 2: konto „leon_mewa”, grupy „konta i identyfikatory” + „listy sankcyjne” → adres Z → wpis listy.

import type { Account, LabeledAddress, LedgerRow, Page } from './scenario.ts';

export const NETWORK_ADDR = {
  /** Adres wsparcia podmiotu (Oskar Wierzba). */
  wierzbaBtc: 'bc1qc2404vh2fkw50q07zf0rryfw7pmhluuk9slmqy',
  /** Wspólny adres rozliczeń dwóch kont Targu. */
  sharedBtc: '1AaQkkcE45GXGqgN4Wx7Yv79Mr3shMWmWy',
  /** Adres USDT (ERC-20) konta „leon_mewa” — figuruje na liście SYNTETYCZNEJ. */
  nordwindEth: '0x25E6d9F3ac99f2a374D83b82F9a691ccBB2558cF',
  /** Anonimowy darczyńca podmiotu — w grafie wyłącznie adres, nigdy osoba. */
  donorBtc: 'bc1qqc7wfn95hlqy258wunz82upt9t24c7ac4xwu2f',
} as const;

const N = NETWORK_ADDR;
const code = (address: string) => `<code>${address}</code>`;

export const networkAccounts: Account[] = [
  { service: 'gitpub', handle: 'owierzba', name: 'Oskar Wierzba', email: 'oskar.wierzba@skrzynka.example', location: 'Łódź', createdAt: '2022-03-14T09:00:00Z' },
  { service: 'targ', handle: 'szybki_wymiennik', name: 'Hubert Kos', email: 'kantor@szybkiwymiennik.example', phone: '500 000 871', location: 'Łódź', createdAt: '2024-06-01T09:00:00Z' },
  { service: 'forum', handle: 'kantor_b', name: 'Hubert Kos', email: 'kantor@szybkiwymiennik.example', location: 'Łódź', createdAt: '2023-11-20T09:00:00Z' },
  { service: 'targ', handle: 'leon_mewa', name: 'Leon Mewa', phone: '500 000 872', location: 'Gdynia', createdAt: '2025-02-02T09:00:00Z' },
];

export const networkPages: Page[] = [
  {
    service: 'gitpub',
    path: '/owierzba',
    kind: 'profile',
    title: 'owierzba (Oskar Wierzba)',
    author: 'owierzba',
    publishedAt: '2025-08-10T09:00:00Z',
    html: `
<p class="bio">Narzędzia do księgowania kryptowalut. Łódź.</p>
<h2>Wesprzyj projekt</h2>
<p>Darowizny w BTC: ${code(N.wierzbaBtc)}</p>`,
  },
  {
    service: 'targ',
    path: '/oferta/9101',
    kind: 'offer',
    title: 'Szybka wymiana BTC ⇄ PLN, Łódź',
    author: 'szybki_wymiennik',
    publishedAt: '2025-09-02T09:00:00Z',
    html: `
<p><strong>Cena:</strong> kurs dnia · <strong>Lokalizacja:</strong> Łódź</p>
<p>Wymiana gotówka ⇄ BTC bez zbędnych pytań. Rozliczenie na adres (BTC): ${code(N.sharedBtc)}</p>
<p><strong>Kontakt:</strong> tel. 500&nbsp;000&nbsp;871, e-mail: <a href="mailto:kantor@szybkiwymiennik.example">kantor@szybkiwymiennik.example</a></p>`,
  },
  {
    service: 'forum',
    path: '/watek/przedstaw-sie/kantor_b',
    kind: 'post',
    title: 'Przedstawiam się — kantor_b',
    author: 'kantor_b',
    publishedAt: '2024-01-05T09:00:00Z',
    html: `<p>Cześć, prowadzę drobny kantor w Łodzi. Kontakt: kantor@szybkiwymiennik.example</p>`,
  },
  {
    service: 'targ',
    path: '/oferta/9102',
    kind: 'offer',
    title: 'Odbiór gotówki — rozliczenie BTC lub USDT, Trójmiasto',
    author: 'leon_mewa',
    publishedAt: '2025-10-11T09:00:00Z',
    html: `
<p><strong>Cena:</strong> do uzgodnienia · <strong>Lokalizacja:</strong> Gdynia</p>
<p>Odbiór gotówki i rozliczenie w krypto. BTC (wspólny adres z partnerem): ${code(N.sharedBtc)}</p>
<p>USDT (ERC-20): ${code(N.nordwindEth)}</p>
<p><strong>Kontakt:</strong> tel. 500&nbsp;000&nbsp;872, nick: leon_mewa</p>`,
  },
];

export const networkLabeledAddresses: LabeledAddress[] = [];

/** Przelewy części „siatka” — adresy usług z części podstawowej. */
export const networkLedger = (base: { exchangeBtc: string; exchangeEth: string }): LedgerRow[] => [
  { time: '2025-09-01T10:00:00Z', from: N.donorBtc, to: N.wierzbaBtc, asset: 'BTC', amount: 0.9 },
  { time: '2025-09-03T12:00:00Z', from: N.wierzbaBtc, to: N.sharedBtc, asset: 'BTC', amount: 0.85 },
  { time: '2025-09-03T15:30:00Z', from: N.sharedBtc, to: base.exchangeBtc, asset: 'BTC', amount: 0.84 },
  { time: '2025-10-12T08:00:00Z', from: N.nordwindEth, to: base.exchangeEth, asset: 'ETH', amount: 4.2 },
];

// ---------- Lista sankcyjna SYNTETYCZNA (dane zmyślone) ----------

export interface SyntheticSanctionsEntry {
  id: string;
  list: string;
  name: string;
  aliases: string[];
  type: 'person' | 'organization';
  addresses: string[];
  programs: string[];
  listedAt: string;
  note: string;
}

export const SYNTHETIC_LIST = 'Lista sankcyjna SYNTETYCZNA (piaskownica OŁCyŚ — dane zmyślone)';

export const syntheticSanctions: SyntheticSanctionsEntry[] = [
  {
    id: 'SYN-2026-001',
    list: SYNTHETIC_LIST,
    name: 'NORDWIND CAPITAL LTD (FIKCYJNA)',
    aliases: ['Nordwind Capital', 'Nordwind Capital Ltd'],
    type: 'organization',
    addresses: [N.nordwindEth],
    programs: ['DEMO — wpis fikcyjny, nie jest prawdziwą sankcją'],
    listedAt: '2026-03-01',
    note: 'Wpis zmyślony na potrzeby demonstracji rozwijania sieci. Żaden prawdziwy podmiot o tej nazwie nie jest tu opisany.',
  },
  {
    id: 'SYN-2026-002',
    list: SYNTHETIC_LIST,
    name: 'Zbigniew Fikcyjny',
    aliases: [],
    type: 'person',
    addresses: [],
    programs: ['DEMO — wpis fikcyjny, nie jest prawdziwą sankcją'],
    listedAt: '2026-03-01',
    note: 'Wpis zmyślony — tylko do pokazania dopasowania po samej nazwie (hipoteza, możliwy imiennik).',
  },
];

const nameKey = (text: string) =>
  text.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(fikcyjna\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Wyszukiwanie w liście syntetycznej: dokładny adres (identyfikator) albo nazwa / alias. */
export function searchSyntheticSanctions(query: string): (SyntheticSanctionsEntry & { matchedBy: 'address' | 'name' })[] {
  const value = query.trim();
  if (!value) return [];
  const results: (SyntheticSanctionsEntry & { matchedBy: 'address' | 'name' })[] = [];
  for (const entry of syntheticSanctions) {
    if (entry.addresses.some((address) => address.toLowerCase() === value.toLowerCase())) results.push({ ...entry, matchedBy: 'address' });
    else if ([entry.name, ...entry.aliases].some((name) => nameKey(name) === nameKey(value) && nameKey(value).length >= 5)) results.push({ ...entry, matchedBy: 'name' });
  }
  return results;
}
