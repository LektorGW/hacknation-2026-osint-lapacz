// Dane trybu demo: rozbudowana, w całości fikcyjna sprawa oraz przegląd źródeł.
// Osoby, serwisy (.example), adresy, transakcje i kursy są zmyślone.
import type {
  AddressClass,
  AnalysisRun,
  CashOutKind,
  ChainActivity,
  Finding,
  Identifier,
  IdentityMatch,
  Lead,
  Network,
  ProfileAttributes,
  ProfileCard,
  RelatedPerson,
  ServiceLink,
  SourceCategory,
  StoredEvidence,
  Transfer,
} from '@olcys/core';
import type { CaseSummary, ConnectorInfo, Replacement } from './api.ts';

/** Powiązanie przed wyceną — Wskaźnik Pewności liczy zastępnik API z uwzględnieniem decyzji. */
export type RawFinding = Omit<Finding, 'confidence'>;
export type RawRun = Omit<AnalysisRun, 'findings'> & { findings: RawFinding[] };

const NICK: Identifier = { type: 'nick', value: 'tomwzor' };
const EMAIL: Identifier = { type: 'email', value: 'tomasz.wzorcowy@poczta.example' };
const FULL_NAME: Identifier = { type: 'full_name', value: 'Tomasz Wzorcowy' };
/** Login odkryty w toku analizy — odnośnik z profilu na forum. */
const LINKED_LOGIN: Identifier = { type: 'login', value: 't-wzorcowy' };

export const ADDR_MAIN = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
export const ADDR_FORUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ADDR_FORUM_OLD = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
export const ADDR_TRON = 'TXkDemoAdresFikcyjny7Qm2pLw9sVbN4cRt';
export const ADDR_NAMESAKE = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const ADDR_EXCHANGE = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
const ADDR_CONTRACT = '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb';
export const BALTYK_HOT = 'TBaLtykPortfelZbiorczy4n8Qw2Zx6Vc1Mk';

export const DEMO_CASE_ID = 'demo-sprawa-1';
export const DEMO_RUN_1 = 'demo-analiza-1';
export const DEMO_RUN_2 = 'demo-analiza-2';
export const DEMO_NOW = '2026-11-20T09:14:52Z';

const CLASSIFICATION = 'Zbiór etykiet środowiska demonstracyjnego';

/** Pseudoskrót (64 znaki szesnastkowe) — deterministyczny zamiennik identyfikatorów transakcji i skrótów treści. */
export function fakeHash(seed: string): string {
  let hash = 0x811c9dc5;
  let out = '';
  for (let round = 0; round < 8; round += 1) {
    for (const char of `${seed}#${round}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out;
}

export const demoConnectors: ConnectorInfo[] = [
  {
    id: 'sandbox-kodhub',
    service: 'kodhub.example',
    label: 'KodHub — profile programistów',
    description: 'Pobiera publiczny profil i pliki README użytkownika o podanym nicku lub loginie.',
    accepts: ['nick', 'login'],
    enabledByDefault: true,
  },
  {
    id: 'sandbox-forum',
    service: 'forum-krypto.example',
    label: 'Forum Krypto — wypowiedzi i podpisy',
    description: 'Wyszukuje publiczne posty i sygnatury autora po nicku, e-mailu lub imieniu i nazwisku.',
    accepts: ['nick', 'email', 'full_name'],
    enabledByDefault: true,
    discovers: true,
  },
  {
    id: 'sandbox-ogloszenia',
    service: 'ogloszenia.example',
    label: 'Ogłoszenia — oferty sprzedaży',
    description: 'Przeszukuje publiczne ogłoszenia, w których sprzedający podaje adres do zapłaty.',
    accepts: ['nick', 'email', 'full_name'],
    enabledByDefault: true,
    discovers: true,
  },
  {
    id: 'sandbox-bazarek',
    service: 'bazarek-p2p.example',
    label: 'Bazarek P2P — oferty wymiany kryptowalut',
    description: 'Publiczne oferty kupna i sprzedaży kryptowalut z adresem do rozliczenia.',
    accepts: ['nick', 'messenger_id'],
    enabledByDefault: true,
    discovers: true,
  },
  {
    id: 'sandbox-profile',
    service: 'strony i mikroblogi',
    label: 'Strony własne i mikroblogi',
    description: 'Strony wizytówkowe i mikroblogi odnalezione po imieniu i nazwisku, nicku lub adresie profilu.',
    accepts: ['nick', 'full_name', 'profile_url'],
    enabledByDefault: true,
  },
  {
    id: 'sandbox-archiwum',
    service: 'archiwum.example',
    label: 'Archiwum stron — kopie historyczne',
    description: 'Sprawdza zapisane kopie odnalezionych stron; pozwala wykryć usunięte treści i podmiany adresów.',
    accepts: ['nick', 'login', 'email', 'full_name'],
    enabledByDefault: true,
  },
  {
    id: 'live-search',
    service: 'wyszukiwarka publiczna',
    label: 'Wyszukiwarka publiczna (tryb na żywo)',
    description: 'Zapytania do publicznej wyszukiwarki o strony zawierające identyfikator. Wymaga dostępu do internetu.',
    accepts: ['nick', 'login', 'email', 'full_name', 'messenger_id', 'crypto_address'],
    enabledByDefault: false,
  },
];

// ---------- Ślady ----------

interface EvidenceSpec {
  id: string;
  service: string;
  author: string;
  category: SourceCategory;
  identityMatch: IdentityMatch;
  identityReasons: string[];
  url: string;
  title: string;
  publishedAt: string;
  excerpt: string;
  matched: Identifier;
  connectorId: string;
  capturedAt?: string;
  archivedAt?: string;
}

const evidence = (spec: EvidenceSpec): StoredEvidence => ({
  id: spec.id,
  category: spec.category,
  service: spec.service,
  url: spec.url,
  capturedAt: spec.capturedAt ?? '2026-11-20T09:14:36Z',
  identityMatch: spec.identityMatch,
  identityReasons: spec.identityReasons,
  title: spec.title,
  author: spec.author,
  publishedAt: spec.publishedAt,
  archivedAt: spec.archivedAt,
  excerpt: spec.excerpt,
  contentHash: fakeHash(`${spec.id}|${spec.excerpt}`),
  connectorId: spec.connectorId,
  matchedIdentifier: spec.matched,
});

const FORUM_REASONS = [
  'Nick „tomwzor” podany przez analityka.',
  'W profilu widnieje e-mail tomasz.wzorcowy@poczta.example — drugi identyfikator podmiotu.',
];

const evProfile = evidence({
  id: 'ev-kodhub-profil',
  service: 'kodhub.example',
  author: 't-wzorcowy',
  category: 'own_profile',
  identityMatch: 'linked_profile',
  identityReasons: ['Profil wskazany odnośnikiem z profilu „tomwzor” na forum-krypto.example.'],
  url: 'https://kodhub.example/t-wzorcowy',
  title: 't-wzorcowy — profil w serwisie KodHub',
  publishedAt: '2023-05-11T18:02:00Z',
  excerpt: `Buduję narzędzia do analizy danych. Jeśli moje projekty Ci pomagają, możesz postawić kawę: BTC ${ADDR_MAIN} — dziękuję! Sprzęt trzymam na Sejf One.`,
  matched: LINKED_LOGIN,
  connectorId: 'sandbox-kodhub',
});

const evOffer = evidence({
  id: 'ev-ogloszenie-laptop',
  service: 'ogloszenia.example',
  author: 'Tomasz W.',
  category: 'sale_offer',
  identityMatch: 'exact_identifier',
  identityReasons: ['Ogłoszenie zawiera adres e-mail podany przez analityka.'],
  url: 'https://ogloszenia.example/oferta/48213-laptop-15-cali',
  title: 'Laptop 15 cali, stan bardzo dobry — możliwa płatność BTC',
  publishedAt: '2024-10-02T07:45:00Z',
  archivedAt: '2024-10-19T03:10:00Z',
  excerpt: `Kontakt: tomasz.wzorcowy@poczta.example, tel. +48 555 010 123. Przyjmuję zapłatę przelewem albo w bitcoinach na adres ${ADDR_MAIN}. Odbiór osobisty: Poznań.`,
  matched: EMAIL,
  connectorId: 'sandbox-ogloszenia',
});

const forumPost = (address: string, capturedAt: string): StoredEvidence =>
  evidence({
    id: 'ev-forum-watek',
    service: 'forum-krypto.example',
    author: 'tomwzor',
    category: 'forum_post',
    identityMatch: 'exact_identifier',
    identityReasons: FORUM_REASONS,
    url: 'https://forum-krypto.example/watek/7731#post-12',
    title: 'Wątek: Rozliczenia za zlecenia — jak przyjmujecie płatności?',
    publishedAt: '2025-01-18T20:31:00Z',
    excerpt: `U mnie od lat to samo: zleceniodawcy z zagranicy płacą w ETH prosto na ${address} i po sprawie. Wypłacam przez KryptoGiełdę, a konto na Giełdzie Atlas mam z polecenia.`,
    matched: NICK,
    connectorId: 'sandbox-forum',
    capturedAt,
  });

const evExchange = evidence({
  id: 'ev-forum-gielda',
  service: 'forum-krypto.example',
  author: 'tomwzor',
  category: 'forum_post',
  identityMatch: 'exact_identifier',
  identityReasons: FORUM_REASONS,
  url: 'https://forum-krypto.example/watek/8020#post-3',
  title: 'Wątek: KryptoGiełda — opóźnione księgowanie wpłat',
  publishedAt: '2025-06-04T11:12:00Z',
  excerpt: `Wysłałem wczoraj ETH na adres depozytowy ${ADDR_EXCHANGE} i dalej nie widzę środków na koncie. Ktoś ma podobnie?`,
  matched: NICK,
  connectorId: 'sandbox-forum',
});

const evContract = evidence({
  id: 'ev-kodhub-readme',
  service: 'kodhub.example',
  author: 't-wzorcowy',
  category: 'own_profile',
  identityMatch: 'linked_profile',
  identityReasons: ['Profil wskazany odnośnikiem z profilu „tomwzor” na forum-krypto.example.'],
  url: 'https://kodhub.example/t-wzorcowy/portfel-narzedzia/README',
  title: 'portfel-narzedzia — README',
  publishedAt: '2024-02-27T16:20:00Z',
  excerpt: `Skrypt odczytuje salda tokena DemoUSD. Adres kontraktu jest wpisany w konfiguracji: ${ADDR_CONTRACT}.`,
  matched: LINKED_LOGIN,
  connectorId: 'sandbox-kodhub',
});

const evBazarek = evidence({
  id: 'ev-bazarek-usdt',
  service: 'bazarek-p2p.example',
  author: 'tomwzor',
  category: 'sale_offer',
  identityMatch: 'same_handle',
  identityReasons: [
    'Zgadza się tylko nick „tomwzor”.',
    'Profil nie zawiera e-maila ani odnośników do innych profili podmiotu.',
    'Zgodne województwo (wielkopolskie) — przesłanka pomocnicza.',
  ],
  url: 'https://bazarek-p2p.example/u/tomwzor/oferta/9912',
  title: 'Sprzedam USDT (TRC-20), większe kwoty — rozliczenie gotówką lub BLIK',
  publishedAt: '2025-05-22T09:05:00Z',
  excerpt: `Sprzedam USDT, od 2 tys. w górę. Kupujący wpłaca na ${ADDR_TRON}, ja oddaję gotówką lub BLIK-iem. Kontakt na komunikatorze: @tomwzor_tg.`,
  matched: NICK,
  connectorId: 'sandbox-bazarek',
});

const evFoto = evidence({
  id: 'ev-foto-wsparcie',
  service: 'fotoportfolio.example',
  author: 'Tomasz Wzorcowy',
  category: 'own_profile',
  identityMatch: 'name_only',
  identityReasons: [
    'Zgodne tylko imię i nazwisko.',
    'Inna lokalizacja (Gdańsk) i inny zawód (fotograf ślubny) niż w pozostałych profilach.',
    'Brak wspólnych adresów e-mail, nicków i odnośników.',
  ],
  url: 'https://fotoportfolio.example/tomasz-wzorcowy',
  title: 'Tomasz Wzorcowy — fotografia ślubna, Gdańsk',
  publishedAt: '2025-08-14T12:00:00Z',
  excerpt: `Fotografuję śluby na Pomorzu od 2012 roku. Zadatek można wpłacić także w bitcoinach: ${ADDR_NAMESAKE}.`,
  matched: FULL_NAME,
  connectorId: 'sandbox-profile',
});

// ---------- Dane blockchain ----------

interface Counterparty {
  address: string;
  cls: AddressClass;
  label?: string;
}

const CP = {
  kgBtc: { address: 'bc1qkryptogielda0depozyt7x9m2c4v6n8b0q5w3e1r', cls: 'exchange', label: 'KryptoGiełda: adres depozytowy' },
  kgEth: { address: ADDR_EXCHANGE, cls: 'exchange', label: 'KryptoGiełda: portfel gorący' },
  p2p: { address: 'bc1qwymianap2p4h8k2j6f0d9s7a5g3l1z8x6c4v2b0n', cls: 'institutional', label: 'WymianaP2P: depozyt transakcji' },
  gateway: { address: 'bc1qplatnosckrypto5t7y9u1i3o5p7a9s1d3f5g7h9j', cls: 'institutional', label: 'PłatnośćKrypto: bramka płatnicza' },
  cardBtc: { address: 'bc1qkartakrypto2w4e6r8t0y2u4i6o8p0a2s4d6f8g0', cls: 'institutional', label: 'KartaKrypto: doładowanie karty' },
  cardTron: { address: 'TKartaKryptoDoladowanie5Hn3Bv7Cx9Zq1', cls: 'institutional', label: 'KartaKrypto: doładowanie karty' },
  dex: { address: '0x3F9a2B6c8D0e1F4a5B7c9D2e4F6a8B0c1D3e5F70', cls: 'smart_contract', label: 'ZamianaDEX: kontrakt wymiany' },
  baltykDep1: { address: 'TDepBaltykWplata1x7Qm4Lp9Ws2Vb6Nc8Rt', cls: 'unknown', label: 'Giełda Bałtyk: prawdopodobny adres wpłat' },
  baltykDep2: { address: 'TDepBaltykWplata2k3Jh5Gf7Ds9Aq1Zx4Cv', cls: 'unknown', label: 'Giełda Bałtyk: prawdopodobny adres wpłat' },
  client1: { address: 'bc1q9f3k7m2x8v4c6n0b5z1a7s3d9g2h4j6l8q0w2e', cls: 'private' },
  client2: { address: 'bc1q4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v', cls: 'unknown' },
  client3: { address: 'bc1q7h5j3k1l9z7x5c3v1b9n7m5q3w1e9r7t5y3u1i', cls: 'private' },
  client4: { address: 'bc1q2s4d6f8g0h2j4k6l8z0x2c4v6b8n0m2q4w6e8r', cls: 'unknown' },
  client5: { address: 'bc1q8p6o4i2u0y8t6r4e2w0q8a6s4d2f0g8h6j4k2l', cls: 'private' },
  payerA: { address: '0x7c1E0b2a94D3f6058a1b9C4e2D7f3A6b8C0d5E19', cls: 'unknown' },
  payerB: { address: '0x91Ab3C5d7E9f1A3b5C7d9E1f3A5b7C9d1E3f5A7b', cls: 'private' },
  buyer1: { address: 'TKupujacyPierwszy8Wq2Er4Ty6Ui8Op0As2', cls: 'private' },
  buyer2: { address: 'TKupujacyDrugi3Df5Gh7Jk9Lz1Xc3Vb5Nm7', cls: 'unknown' },
  buyer3: { address: 'TKupujacyTrzeci6Qa8Ws0Ed2Rf4Tg6Yh8Uj', cls: 'unknown' },
  donor: { address: 'bc1q5m3n1b9v7c5x3z1l9k7j5h3g1f9d7s5a3p1o9i', cls: 'private' },
} satisfies Record<string, Counterparty>;

type Tx = [
  time: string,
  direction: Transfer['direction'],
  counterparty: Counterparty,
  amount: number,
  asset: string,
  cashOut?: { kind: CashOutKind; rate?: number; note: string },
];

const fmtNumber = (value: number) => value.toLocaleString('pl-PL', { maximumFractionDigits: 8 });

function chain(
  address: string,
  network: Network,
  nativeAsset: string,
  addressClass: AddressClass,
  txs: Tx[],
  limitations: string[],
): ChainActivity {
  const transfers: Transfer[] = txs.map(([time, direction, counterparty, amount, asset], index) => {
    const txid = fakeHash(`${address}|${time}|${index}`);
    return {
      txid,
      time,
      direction,
      counterparty: counterparty.address,
      counterpartyClass: counterparty.cls,
      counterpartyLabel: counterparty.label,
      asset,
      amount,
      explorerUrl: `http://localhost:4100/explorer/tx/${txid}`,
    };
  });
  const cashOuts = txs.flatMap(([time, , counterparty, amount, asset, cashOut], index) => {
    if (!cashOut) return [];
    const transfer = transfers[index]!;
    return [
      {
        kind: cashOut.kind,
        txid: transfer.txid,
        time,
        asset,
        amount,
        counterparty: counterparty.address,
        counterpartyLabel: counterparty.label,
        valuePln: cashOut.rate === undefined ? undefined : Math.round(amount * cashOut.rate),
        valuation:
          cashOut.rate === undefined
            ? undefined
            : `${fmtNumber(amount)} ${asset} × ${fmtNumber(cashOut.rate)} PLN (kurs demonstracyjny z ${time.slice(0, 10)}, tabela kursów środowiska demonstracyjnego)`,
        explanation: cashOut.note,
        explorerUrl: transfer.explorerUrl,
      },
    ];
  });
  const cashOutPlnByYear: Record<string, number> = {};
  for (const item of cashOuts) {
    if (item.valuePln === undefined) continue;
    const year = item.time.slice(0, 4);
    cashOutPlnByYear[year] = (cashOutPlnByYear[year] ?? 0) + item.valuePln;
  }
  const native = (direction: Transfer['direction']) =>
    transfers
      .filter((item) => item.direction === direction && item.asset === nativeAsset)
      .reduce((total, item) => total + item.amount, 0);
  const times = transfers.map((item) => item.time).sort();
  return {
    profile: {
      address,
      network,
      addressClass,
      classificationSource: CLASSIFICATION,
      isContract: false,
      txCount: transfers.length,
      firstSeen: times[0],
      lastSeen: times.at(-1),
      totalReceived: native('in'),
      totalSent: native('out'),
      balance: Math.round((native('in') - native('out')) * 1e8) / 1e8,
      nativeAsset,
    },
    transfers,
    cashOuts,
    cashOutPlnByYear,
    limitations: ['Dane pochodzą z fikcyjnego eksploratora środowiska demonstracyjnego.', ...limitations],
  };
}

const EXCHANGE_NOTE = 'Środki wysłano na adres depozytowy giełdy — typowy krok przed sprzedażą za walutę tradycyjną.';
const DEPOSIT_NOTE =
  'Adres odbiorcy w kilka minut przekazuje całość do portfela zbiorczego giełdy — prawdopodobny indywidualny adres wpłat (wnioskowanie).';

const chainMain = chain(
  ADDR_MAIN,
  'bitcoin',
  'BTC',
  'private',
  [
    ['2024-08-14T12:05:00Z', 'in', CP.client1, 0.5, 'BTC'],
    ['2024-09-30T16:40:00Z', 'in', CP.client2, 0.12, 'BTC'],
    ['2024-10-21T17:48:00Z', 'in', CP.client3, 0.3, 'BTC'],
    ['2024-11-06T09:30:00Z', 'out', CP.kgBtc, 0.35, 'BTC', { kind: 'exchange_deposit', rate: 371200, note: EXCHANGE_NOTE }],
    ['2024-12-18T14:12:00Z', 'out', CP.cardBtc, 0.04, 'BTC', { kind: 'crypto_card', rate: 402000, note: 'Doładowanie karty płatniczej rozliczanej w walucie tradycyjnej.' }],
    ['2025-02-02T21:16:00Z', 'in', CP.client1, 0.25, 'BTC'],
    ['2025-03-14T10:22:00Z', 'out', CP.kgBtc, 0.42, 'BTC', { kind: 'exchange_deposit', rate: 324500, note: 'Druga wpłata na ten sam adres depozytowy giełdy.' }],
    ['2025-05-27T08:55:00Z', 'in', CP.client4, 0.2, 'BTC'],
    ['2025-07-09T08:40:00Z', 'out', CP.p2p, 0.1, 'BTC', { kind: 'p2p_service', rate: 398000, note: 'Wpłata do depozytu serwisu wymiany P2P — możliwa sprzedaż za gotówkę lub przelew.' }],
    ['2025-10-03T13:27:00Z', 'out', CP.gateway, 0.06, 'BTC', { kind: 'payment_gateway', rate: 415000, note: 'Płatność przez bramkę przeliczającą kryptowalutę na walutę tradycyjną.' }],
    ['2026-01-22T19:02:00Z', 'in', CP.client2, 0.18, 'BTC'],
    ['2026-03-05T11:45:00Z', 'out', CP.kgBtc, 0.22, 'BTC', { kind: 'exchange_deposit', rate: 388000, note: 'Kolejna wpłata na adres depozytowy giełdy.' }],
    ['2026-06-17T07:30:00Z', 'out', CP.p2p, 0.08, 'BTC', { kind: 'p2p_service', rate: 405000, note: 'Druga wpłata do depozytu serwisu wymiany P2P.' }],
    ['2026-09-11T15:20:00Z', 'in', CP.client5, 0.15, 'BTC'],
  ],
  ['Wpłata na giełdę nie dowodzi sprzedaży — wymaga potwierdzenia u operatora giełdy.'],
);

const chainForum = chain(
  ADDR_FORUM,
  'ethereum',
  'ETH',
  'unknown',
  [
    ['2025-01-25T13:00:00Z', 'in', CP.payerA, 2, 'ETH'],
    ['2025-04-08T19:03:00Z', 'out', CP.kgEth, 1.2, 'ETH', { kind: 'exchange_deposit', rate: 9850, note: 'Przelew na adres oznaczony jako portfel giełdy.' }],
    ['2025-05-19T15:27:00Z', 'out', CP.dex, 0.5, 'ETH', { kind: 'stablecoin_swap', note: 'Zamiana na stablecoin przez kontrakt wymiany — częsty krok pośredni przed wypłatą.' }],
    ['2025-08-30T10:10:00Z', 'in', CP.payerB, 1.4, 'ETH'],
    ['2025-11-12T18:44:00Z', 'out', CP.kgEth, 0.9, 'ETH', { kind: 'exchange_deposit', rate: 11900, note: 'Przelew na adres oznaczony jako portfel giełdy.' }],
    ['2026-02-14T09:18:00Z', 'in', CP.payerA, 1.1, 'ETH'],
    ['2026-05-06T12:00:00Z', 'in', CP.kgEth, 0.3, 'ETH'],
    ['2026-07-21T16:36:00Z', 'out', CP.kgEth, 0.7, 'ETH', { kind: 'exchange_deposit', rate: 10400, note: 'Przelew na adres oznaczony jako portfel giełdy.' }],
  ],
  ['Brak kursu dla zamiany na stablecoin — tej operacji nie ujęto w szacunku w PLN.'],
);

const chainTron = chain(
  ADDR_TRON,
  'tron',
  'TRX',
  'private',
  [
    ['2025-06-10T10:00:00Z', 'in', CP.buyer1, 4200, 'USDT'],
    ['2025-06-28T12:30:00Z', 'out', CP.baltykDep1, 4000, 'USDT', { kind: 'exchange_deposit', rate: 3.74, note: DEPOSIT_NOTE }],
    ['2025-12-05T17:15:00Z', 'in', CP.buyer2, 7800, 'USDT'],
    ['2025-12-19T08:20:00Z', 'out', CP.baltykDep1, 7500, 'USDT', { kind: 'exchange_deposit', rate: 3.62, note: DEPOSIT_NOTE }],
    ['2026-03-29T20:05:00Z', 'in', CP.buyer1, 5100, 'USDT'],
    ['2026-04-11T09:40:00Z', 'out', CP.baltykDep2, 5000, 'USDT', { kind: 'exchange_deposit', rate: 3.86, note: DEPOSIT_NOTE }],
    ['2026-08-08T14:50:00Z', 'in', CP.buyer3, 2600, 'USDT'],
    ['2026-08-20T11:11:00Z', 'out', CP.cardTron, 2500, 'USDT', { kind: 'crypto_card', rate: 3.68, note: 'Doładowanie karty płatniczej rozliczanej w walucie tradycyjnej.' }],
  ],
  ['Przypisanie adresów wpłat do Giełdy Bałtyk wynika z analizy dalszych przepływów, nie z publicznej etykiety.'],
);

const chainNamesake = chain(
  ADDR_NAMESAKE,
  'bitcoin',
  'BTC',
  'private',
  [
    ['2025-09-01T10:00:00Z', 'in', CP.donor, 0.01, 'BTC'],
    ['2026-05-05T10:00:00Z', 'out', CP.kgBtc, 0.009, 'BTC', { kind: 'exchange_deposit', rate: 400000, note: EXCHANGE_NOTE }],
  ],
  [],
);

const excludedChain = (address: string, addressClass: AddressClass, label: string, txCount: number): ChainActivity => ({
  profile: {
    address,
    network: 'ethereum',
    addressClass,
    label,
    classificationSource: CLASSIFICATION,
    isContract: addressClass === 'smart_contract',
    txCount,
    totalReceived: 0,
    totalSent: 0,
    balance: 0,
    nativeAsset: 'ETH',
  },
  transfers: [],
  cashOuts: [],
  cashOutPlnByYear: {},
  limitations: ['Adres wykluczony — pobrano wyłącznie klasyfikację, przepływów nie analizowano.'],
});

// ---------- Analizy i sprawa ----------

const raw = (
  address: string,
  network: Network,
  items: StoredEvidence[],
  activity?: ChainActivity,
  unrelatedPublishers = 0,
): RawFinding => ({ address, network, checksumVerified: true, evidence: items, chain: activity, unrelatedPublishers });

const findingExchange = raw(ADDR_EXCHANGE, 'ethereum', [evExchange], excludedChain(ADDR_EXCHANGE, 'exchange', 'KryptoGiełda: portfel gorący', 48211), 5);
const query = { identifiers: [FULL_NAME, NICK, EMAIL] };

export const demoRuns: RawRun[] = [
  {
    id: DEMO_RUN_1,
    caseId: DEMO_CASE_ID,
    startedAt: '2026-10-03T14:02:05Z',
    finishedAt: '2026-10-03T14:02:24Z',
    status: 'completed',
    query,
    connectors: ['sandbox-forum', 'sandbox-ogloszenia'],
    findings: [
      raw(ADDR_MAIN, 'bitcoin', [{ ...evOffer, capturedAt: '2026-10-03T14:02:19Z' }], chainMain),
      raw(ADDR_FORUM_OLD, 'ethereum', [forumPost(ADDR_FORUM_OLD, '2026-10-03T14:02:11Z')]),
      findingExchange,
    ],
    log: [
      { time: '2026-10-03T14:02:05Z', message: 'Start analizy. Źródła: sandbox-forum, sandbox-ogloszenia.' },
      { time: '2026-10-03T14:02:11Z', message: 'forum-krypto.example: 2 dokumenty dla nicku „tomwzor”.' },
      { time: '2026-10-03T14:02:19Z', message: 'ogloszenia.example: 1 dokument dla adresu e-mail.' },
      { time: '2026-10-03T14:02:24Z', message: 'Zakończono: 3 adresy, w tym 1 wykluczony.' },
    ],
  },
  {
    id: DEMO_RUN_2,
    caseId: DEMO_CASE_ID,
    startedAt: '2026-11-20T09:14:28Z',
    finishedAt: DEMO_NOW,
    status: 'completed',
    query,
    connectors: demoConnectors.filter((item) => item.enabledByDefault).map((item) => item.id),
    findings: [
      raw(ADDR_MAIN, 'bitcoin', [evProfile, evOffer], chainMain),
      raw(ADDR_FORUM, 'ethereum', [forumPost(ADDR_FORUM, '2026-11-20T09:14:36Z')], chainForum),
      raw(ADDR_TRON, 'tron', [evBazarek], chainTron, 1),
      raw(ADDR_NAMESAKE, 'bitcoin', [evFoto], chainNamesake),
      findingExchange,
      raw(ADDR_CONTRACT, 'ethereum', [evContract], excludedChain(ADDR_CONTRACT, 'smart_contract', 'DemoUSD: kontrakt tokena (ERC-20)', 912004), 2),
    ],
    log: [
      { time: '2026-11-20T09:14:28Z', message: 'Start analizy. Źródła: wszystkie domyślne łączniki środowiska demonstracyjnego.' },
      { time: '2026-11-20T09:14:30Z', message: 'kodhub.example: brak profilu dla nicku „tomwzor”.' },
      { time: '2026-11-20T09:14:31Z', message: 'forum-krypto.example: profil „tomwzor” wskazuje login „t-wzorcowy” w serwisie KodHub — dodano do drugiej rundy.' },
      { time: '2026-11-20T09:14:33Z', message: 'kodhub.example: 2 dokumenty dla loginu „t-wzorcowy”.' },
      { time: '2026-11-20T09:14:37Z', message: 'forum-krypto.example: 2 dokumenty dla nicku „tomwzor”.' },
      { time: '2026-11-20T09:14:39Z', message: 'bazarek-p2p.example: 1 oferta użytkownika „tomwzor” — zgodny tylko nick.' },
      { time: '2026-11-20T09:14:40Z', message: 'fotoportfolio.example: strona osoby o tym samym imieniu i nazwisku — możliwy imiennik.' },
      { time: '2026-11-20T09:14:41Z', message: 'ogloszenia.example: ogłoszenie wygasło — użyto kopii z archiwum.example z 19.10.2024.' },
      { time: '2026-11-20T09:14:44Z', message: 'Wykryto podmianę adresu w poście forum-krypto.example/watek/7731#post-12 względem poprzedniej analizy.' },
      { time: '2026-11-20T09:14:49Z', message: 'Dane blockchain: pobrano profile 6 adresów; 2 adresy wykluczone (giełda, smart kontrakt).' },
      { time: DEMO_NOW, message: 'Zakończono: 6 adresów, w tym 2 wykluczone.' },
    ],
  },
];

export const demoReplacements: Replacement[] = [
  { url: 'https://forum-krypto.example/watek/7731#post-12', from: ADDR_FORUM_OLD, to: ADDR_FORUM },
];

export const demoCase: Omit<CaseSummary, 'runs'> = {
  id: DEMO_CASE_ID,
  name: 'Tomasz Wzorcowy — sprawa demonstracyjna',
  createdAt: '2026-10-03T13:58:00Z',
  query,
};

// ---------- Uzupełnienia teczki demonstracyjnej ----------

export const KEY_FORUM = 'forum-krypto.example|tomwzor';
export const KEY_KODHUB = 'kodhub.example|t-wzorcowy';
export const KEY_OFFER = 'ogloszenia.example|tomasz w.';
export const KEY_BAZAREK = 'bazarek-p2p.example|tomwzor';
export const KEY_FOTO = 'fotoportfolio.example|tomasz wzorcowy';
export const KEY_MIKROBLOG = 'mikroblog.example|tomwzor';
export const KEY_GRY = 'gry-online.example|tomwzor';

/** Atrybuty profili ujawnione przez źródła (klucz: `service|handle`). */
export const demoProfileAttributes: Record<string, { url: string; attributes: ProfileAttributes }> = {
  [KEY_FORUM]: {
    url: 'https://forum-krypto.example/u/tomwzor',
    attributes: {
      handle: 'tomwzor',
      displayName: 'tomwzor',
      emails: [EMAIL.value],
      urls: ['https://kodhub.example/t-wzorcowy', 'https://mikroblog.example/@tomwzor'],
      location: 'Poznań',
      bio: 'Programista, zlecenia zdalne. Rozliczam się w krypto.',
      createdAt: '2019-03-12T10:00:00Z',
    },
  },
  [KEY_KODHUB]: {
    url: 'https://kodhub.example/t-wzorcowy',
    attributes: {
      handle: 't-wzorcowy',
      displayName: 'Tomasz W.',
      urls: ['https://forum-krypto.example/u/tomwzor'],
      location: 'Poznań, Polska',
      bio: 'Narzędzia do analizy danych. Portfel sprzętowy: Sejf One.',
      createdAt: '2020-06-01T08:30:00Z',
    },
  },
  [KEY_OFFER]: {
    url: 'https://ogloszenia.example/uzytkownik/tomasz-w-48213',
    attributes: {
      displayName: 'Tomasz W.',
      emails: [EMAIL.value],
      phones: ['+48 555 010 123'],
      location: 'Poznań',
      createdAt: '2022-01-15T12:00:00Z',
    },
  },
  [KEY_BAZAREK]: {
    url: 'https://bazarek-p2p.example/u/tomwzor',
    attributes: {
      handle: 'tomwzor',
      location: 'woj. wielkopolskie',
      bio: 'Sprzedaż USDT, rozliczenie gotówką lub BLIK. Komunikator: @tomwzor_tg',
      createdAt: '2025-05-20T07:00:00Z',
    },
  },
  [KEY_FOTO]: {
    url: 'https://fotoportfolio.example/tomasz-wzorcowy',
    attributes: {
      displayName: 'Tomasz Wzorcowy',
      emails: ['kontakt@fotoportfolio.example'],
      location: 'Gdańsk',
      bio: 'Fotografia ślubna na Pomorzu od 2012 roku.',
      createdAt: '2017-04-03T09:00:00Z',
    },
  },
};

/** Profile bez opublikowanych adresów — znane tylko z etapu łączenia tożsamości. */
export const demoExtraProfiles: ProfileCard[] = [
  {
    id: KEY_MIKROBLOG,
    service: 'mikroblog.example',
    url: 'https://mikroblog.example/@tomwzor',
    handle: 'tomwzor',
    attributes: {
      handle: 'tomwzor',
      displayName: 'Tomek W.',
      urls: ['https://forum-krypto.example/u/tomwzor', 'https://gielda-atlas.example/polecam/tomwzor'],
      location: 'Poznań',
      bio: 'O kodzie i krypto. Konto na Giełdzie Atlas z mojego polecenia: gielda-atlas.example/polecam/tomwzor',
      createdAt: '2021-09-09T18:00:00Z',
    },
    identityMatch: 'verified_link',
    identityReasons: [
      'Wzajemne odnośniki: profil na forum-krypto.example wskazuje ten mikroblog, a mikroblog — profil na forum.',
      'Zgodna lokalizacja (Poznań).',
    ],
    identityScore: 100,
    addresses: [],
    evidenceIds: [],
  },
  {
    id: KEY_GRY,
    service: 'gry-online.example',
    url: 'https://gry-online.example/gracz/tomwzor',
    handle: 'tomwzor',
    attributes: { handle: 'tomwzor', location: 'Rzeszów', bio: 'Gram w strategie. Rocznik 2008.', createdAt: '2023-02-11T16:00:00Z' },
    identityMatch: 'common_handle',
    identityReasons: [
      'Zgadza się tylko nick; w serwisach z grami powtarza się u wielu osób.',
      'Inna lokalizacja (Rzeszów) i deklarowany rok urodzenia 2008.',
    ],
    identityScore: 30,
    addresses: [],
    evidenceIds: [],
  },
];

/** Identyfikatory odkryte w profilach, poza tymi, które wynikają ze śladów. */
export const demoDiscovered: { identifier: Identifier; sourceUrl: string; profileKey: string }[] = [
  { identifier: { type: 'profile_url', value: 'https://mikroblog.example/@tomwzor' }, sourceUrl: 'https://forum-krypto.example/u/tomwzor', profileKey: KEY_FORUM },
  { identifier: { type: 'messenger_id', value: '@tomwzor_tg' }, sourceUrl: 'https://bazarek-p2p.example/u/tomwzor', profileKey: KEY_BAZAREK },
];

/** Odnośniki między profilami: [skąd, dokąd]. */
export const demoProfileLinks: [string, string][] = [
  [KEY_FORUM, KEY_KODHUB],
  [KEY_FORUM, KEY_MIKROBLOG],
  [KEY_MIKROBLOG, KEY_FORUM],
  [KEY_KODHUB, KEY_FORUM],
];

export const demoRelatedPersons: (RelatedPerson & { node: { target: 'address' | 'profile' | 'counterparty'; key: string } })[] = [
  {
    id: 'osoba-krypto-marek',
    handle: 'krypto_marek',
    services: ['forum-krypto.example'],
    relations: [
      {
        kind: 'transacted',
        via: CP.client1.address,
        description: 'Adres z podpisu użytkownika „krypto_marek” dwukrotnie zasilił główny adres podmiotu (0,5 BTC i 0,25 BTC).',
      },
    ],
    strength: 72,
    profileUrls: ['https://forum-krypto.example/u/krypto_marek'],
    node: { target: 'counterparty', key: CP.client1.address },
  },
  {
    id: 'osoba-anna-wzorcowa',
    handle: 'anna.wzorcowa',
    services: ['ogloszenia.example'],
    relations: [
      {
        kind: 'shared_attribute',
        via: '+48 555 010 123',
        description: 'Ten sam numer telefonu kontaktowego w ogłoszeniach obu kont.',
      },
    ],
    strength: 58,
    profileUrls: ['https://ogloszenia.example/uzytkownik/anna-wzorcowa'],
    node: { target: 'profile', key: KEY_OFFER },
  },
  {
    id: 'osoba-bitkolekcjoner',
    handle: 'bitkolekcjoner',
    services: ['bazarek-p2p.example', 'forum-krypto.example'],
    relations: [
      {
        kind: 'shared_address',
        via: ADDR_TRON,
        description: 'Ten sam adres Tron widnieje w ofertach użytkownika „bitkolekcjoner”.',
      },
      {
        kind: 'common_counterparty',
        via: 'Giełda Bałtyk',
        description: 'Obaj korzystają z tych samych prawdopodobnych adresów wpłat Giełdy Bałtyk.',
      },
    ],
    strength: 44,
    profileUrls: ['https://bazarek-p2p.example/u/bitkolekcjoner'],
    node: { target: 'address', key: ADDR_TRON },
  },
];

/** Usługi znane wyłącznie ze wzmianek i odnośników — bez przelewów. */
export const demoMentionServices: ServiceLink[] = [
  {
    id: 'svc-gielda-atlas',
    name: 'Giełda Atlas',
    kind: 'exchange',
    networks: [],
    basis: ['web_mention', 'account_link'],
    strength: 38,
    reasons: [
      'Odnośnik polecający z nickiem podmiotu w profilu na mikroblog.example — wskazuje na posiadanie konta.',
      'Wzmianka o koncie w poście na forum-krypto.example.',
      'Brak przelewów między adresami podmiotu a adresami giełdy.',
    ],
    inferredOnly: false,
    transfersOut: 0,
    transfersIn: 0,
    transfers: [],
    mentions: [
      {
        url: 'https://mikroblog.example/@tomwzor',
        excerpt: 'Konto na Giełdzie Atlas z mojego polecenia: gielda-atlas.example/polecam/tomwzor',
      },
      {
        url: 'https://forum-krypto.example/watek/7731#post-12',
        excerpt: 'Wypłacam przez KryptoGiełdę, a konto na Giełdzie Atlas mam z polecenia.',
        evidenceId: 'ev-forum-watek',
      },
    ],
    requestHints: [
      'Kod polecający / nazwa konta: „tomwzor” (odnośnik gielda-atlas.example/polecam/tomwzor) — dane właściciela konta.',
      'Adres e-mail do sprawdzenia w bazie klientów: tomasz.wzorcowy@poczta.example.',
      'Historia wpłat i wypłat konta, w tym rachunki bankowe użyte do wypłat w walutach tradycyjnych.',
    ],
  },
  {
    id: 'svc-sejf-one',
    name: 'Sejf One',
    kind: 'wallet',
    networks: [],
    basis: ['web_mention'],
    strength: 18,
    reasons: [
      'Podmiot wymienia portfel sprzętowy Sejf One w profilu na kodhub.example.',
      'Portfel sprzętowy nie jest usługą powierniczą — producent nie zna sald ani transakcji.',
    ],
    inferredOnly: false,
    transfersOut: 0,
    transfersIn: 0,
    transfers: [],
    mentions: [
      {
        url: 'https://kodhub.example/t-wzorcowy',
        excerpt: 'Sprzęt trzymam na Sejf One.',
        evidenceId: 'ev-kodhub-profil',
      },
    ],
    requestHints: [
      'Dane zamówienia urządzenia na adres e-mail tomasz.wzorcowy@poczta.example (sklep producenta).',
      'Uwaga: producent portfela sprzętowego nie ma dostępu do adresów ani środków klienta.',
    ],
  },
];

// ---------- Przegląd źródeł (typowanie) ----------

type LeadSpec = [handle: string, services: string[], addresses: [Network, number][], byYear: Record<string, number>, caseId?: string];

const LEADS: LeadSpec[] = [
  ['usdt_hurt_wlkp', ['bazarek-p2p.example', 'ogloszenia.example'], [['tron', 85], ['bitcoin', 70]], { '2025': 412000, '2026': 268000 }],
  ['tomwzor', ['bazarek-p2p.example'], [['tron', 60]], { '2025': 42110, '2026': 28500 }, DEMO_CASE_ID],
  ['kantor_bez_pytan', ['bazarek-p2p.example'], [['tron', 70], ['tron', 70]], { '2026': 356000 }],
  ['bitkolekcjoner', ['bazarek-p2p.example', 'forum-krypto.example'], [['tron', 70], ['bitcoin', 50]], { '2025': 96000, '2026': 61000 }],
  ['elektro_okazje', ['ogloszenia.example'], [['bitcoin', 85]], { '2024': 38000, '2025': 74000 }],
  ['miner_z_garazu', ['forum-krypto.example', 'ogloszenia.example'], [['ethereum', 70], ['bitcoin', 50]], { '2024': 122000 }],
  ['zlecenia_it_24', ['forum-krypto.example'], [['ethereum', 50]], { '2026': 18500 }],
  ['nowy_w_krypto', ['forum-krypto.example'], [['bitcoin', 50]], {}],
];

/** Wskazania przeglądu bez priorytetu — liczy go zastępnik API tą samą funkcją co dla spraw. */
export const demoLeads: Omit<Lead, 'priority' | 'priorityReasons'>[] = LEADS.map(([handle, services, addresses, byYear, caseId]) => ({
  id: `lead-${handle}`,
  handle,
  services,
  profileUrls: services.map((service) => `https://${service}/u/${handle}`),
  addresses: addresses.map(([network, score], index) => ({
    network,
    score,
    address:
      network === 'ethereum'
        ? `0x${fakeHash(`${handle}${index}`).slice(0, 40)}`
        : network === 'tron'
          ? `T${fakeHash(`${handle}${index}`).slice(0, 33).toUpperCase().replace(/0/g, 'x')}`
          : `bc1q${fakeHash(`${handle}${index}`).slice(0, 38).replace(/[1bio]/g, 'q')}`,
  })),
  topScore: Math.max(...addresses.map(([, score]) => score)),
  cashOutPlnByYear: byYear,
  cashOutPlnTotal: Object.values(byYear).reduce((total, value) => total + value, 0),
  caseId,
}));

export const demoSweepLog = [
  'Start przeglądu źródeł: świeże publikacje z adresami kryptowalutowymi.',
  'bazarek-p2p.example: 46 ofert, 31 z adresem do rozliczenia.',
  'ogloszenia.example: 38 ogłoszeń, 9 z adresem do zapłaty.',
  'forum-krypto.example: 52 posty, 14 z adresem w treści lub podpisie.',
  'Pogrupowano publikacje po autorach; odrzucono adresy giełd i kontraktów.',
  'Pobrano dane blockchain i wyceniono oznaki wypłat.',
];

export const demoPriorityRules = {
  description:
    'Priorytet (0–100) porządkuje sprawy i wskazania: łączy pewność powiązania najlepszego adresu ze skalą szacowanych wypłat w PLN i ich aktualnością.',
  components: [
    { name: 'Najwyższy Wskaźnik Pewności adresu', weight: '50%', description: 'Wynik 0–100 najlepszego adresu nieodrzuconego.' },
    { name: 'Skala szacowanych wypłat', weight: '35%', description: 'Pierwiastek z ilorazu sumy wypłat i 500 tys. zł, ograniczony do 100.' },
    { name: 'Aktualność', weight: '15%', description: 'Wypłaty w bieżącym roku: 100; rok wcześniej: 70; dwa lata: 40; starsze: 15.' },
  ],
};
