// Dane trybu demo: jedna kompletna, w całości fikcyjna sprawa.
// Osoba, serwisy (.example), transakcje i kursy są zmyślone; adresy to publiczne
// wektory testowe ze specyfikacji BIP-173 i EIP-55 (poprawne sumy kontrolne).
import type {
  AnalysisRun,
  ChainActivity,
  Finding,
  Identifier,
  ScoreRules,
  StoredEvidence,
  Transfer,
} from '@olcys/core';
import type { CaseSummary, ConnectorInfo, Replacement } from './api.ts';

const NICK: Identifier = { type: 'nick', value: 'tomwzor' };
const EMAIL: Identifier = { type: 'email', value: 'tomasz.wzorcowy@poczta.example' };
const FULL_NAME: Identifier = { type: 'full_name', value: 'Tomasz Wzorcowy' };
/** Login odkryty w toku analizy — odnośnik z profilu na forum. */
const LINKED_LOGIN: Identifier = { type: 'login', value: 't-wzorcowy' };

const ADDR_MAIN = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const ADDR_FORUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ADDR_FORUM_OLD = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const ADDR_EXCHANGE = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
const ADDR_CONTRACT = '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb';

const EXCHANGE_BTC = 'bc1qkryptogielda0depozyt7x9m2c4v6n8b0q5w3e1r';
const P2P_BTC = 'bc1qwymianap2p4h8k2j6f0d9s7a5g3l1z8x6c4v2b0n';
const PRIVATE_BTC_1 = 'bc1q9f3k7m2x8v4c6n0b5z1a7s3d9g2h4j6l8q0w2e';
const PRIVATE_BTC_2 = 'bc1q4t6y8u0i2o4p6a8s0d2f4g6h8j0k2l4z6x8c0v';
const PRIVATE_ETH = '0x7c1E0b2a94D3f6058a1b9C4e2D7f3A6b8C0d5E19';
const SWAP_ETH = '0x3F9a2B6c8D0e1F4a5B7c9D2e4F6a8B0c1D3e5F70';

export const DEMO_CASE_ID = 'demo-sprawa-1';
export const DEMO_RUN_1 = 'demo-analiza-1';
export const DEMO_RUN_2 = 'demo-analiza-2';

const CLASSIFICATION = 'Zbiór etykiet środowiska demonstracyjnego';
const explorer = (txid: string) => `http://localhost:4100/explorer/tx/${txid}`;

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
  },
  {
    id: 'sandbox-ogloszenia',
    service: 'ogloszenia.example',
    label: 'Ogłoszenia — oferty sprzedaży',
    description: 'Przeszukuje publiczne ogłoszenia, w których sprzedający podaje adres do zapłaty.',
    accepts: ['nick', 'email', 'full_name'],
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

export const demoRules: ScoreRules = {
  base: {
    cryptographic_proof: 95,
    own_profile: 85,
    sale_offer: 70,
    settlement_message: 65,
    forum_post: 50,
    mass_comment: 25,
  },
  identityAdjustment: {
    verified_link: 0,
    exact_identifier: 0,
    linked_profile: -5,
    same_handle: -10,
    common_handle: -20,
    name_only: -20,
  },
  synergyBonus: 15,
  extraSourceBonus: 5,
  maxExtraSourceBonus: 10,
  sharedAddressThreshold: 3,
  sharedAddressPenalty: 30,
  excludedClasses: ['exchange', 'smart_contract', 'charity', 'mixer', 'institutional'],
  tiers: [
    { min: 80, label: 'bardzo wysokie prawdopodobieństwo' },
    { min: 60, label: 'prawdopodobne' },
    { min: 40, label: 'średnie' },
    { min: 10, label: 'niskie / szum' },
    { min: 0, label: 'wykluczone' },
  ],
};

// ---------- Ślady ----------

const evProfile: StoredEvidence = {
  id: 'ev-kodhub-profil',
  category: 'own_profile',
  service: 'kodhub.example',
  url: 'https://kodhub.example/t-wzorcowy',
  capturedAt: '2026-11-20T09:14:32Z',
  identityMatch: 'linked_profile',
  title: 't-wzorcowy — profil w serwisie KodHub',
  author: 't-wzorcowy',
  publishedAt: '2023-05-11T18:02:00Z',
  excerpt: `Buduję narzędzia do analizy danych. Jeśli moje projekty Ci pomagają, możesz postawić kawę: BTC ${ADDR_MAIN} — dziękuję!`,
  contentHash: '9b1f6c2e7a4d0583c1e9f7b2a6d4c8e0f3a5b7d9c1e3f5a7b9d1c3e5f7a9b1d3',
  connectorId: 'sandbox-kodhub',
  matchedIdentifier: LINKED_LOGIN,
};

const evOffer: StoredEvidence = {
  id: 'ev-ogloszenie-laptop',
  category: 'sale_offer',
  service: 'ogloszenia.example',
  url: 'https://ogloszenia.example/oferta/48213-laptop-15-cali',
  capturedAt: '2026-11-20T09:14:41Z',
  identityMatch: 'exact_identifier',
  title: 'Laptop 15 cali, stan bardzo dobry — możliwa płatność BTC',
  author: 'Tomasz W.',
  publishedAt: '2024-10-02T07:45:00Z',
  archivedAt: '2024-10-19T03:10:00Z',
  excerpt: `Kontakt: tomasz.wzorcowy@poczta.example. Przyjmuję zapłatę przelewem albo w bitcoinach na adres ${ADDR_MAIN}. Wysyłka po zaksięgowaniu.`,
  contentHash: '4e8a0c2f6b1d3975e0a2c4f6b8d0e2a4c6f8b0d2e4a6c8f0b2d4e6a8c0f2b4d6',
  connectorId: 'sandbox-ogloszenia',
  matchedIdentifier: EMAIL,
};

const forumPost = (address: string, capturedAt: string, contentHash: string): StoredEvidence => ({
  id: 'ev-forum-watek',
  category: 'forum_post',
  service: 'forum-krypto.example',
  url: 'https://forum-krypto.example/watek/7731#post-12',
  capturedAt,
  identityMatch: 'exact_identifier',
  title: 'Wątek: Rozliczenia za zlecenia — jak przyjmujecie płatności?',
  author: 'tomwzor',
  publishedAt: '2025-01-18T20:31:00Z',
  excerpt: `U mnie od lat to samo: zleceniodawcy z zagranicy płacą w ETH prosto na ${address} i po sprawie, żadnych pośredników.`,
  contentHash,
  connectorId: 'sandbox-forum',
  matchedIdentifier: NICK,
});

const evForumCurrent = forumPost(
  ADDR_FORUM,
  '2026-11-20T09:14:36Z',
  'c7d5e3f1a9b7c5d3e1f9a7b5c3d1e9f7a5b3c1d9e7f5a3b1c9d7e5f3a1b9c7d5',
);
const evForumEarlier = forumPost(
  ADDR_FORUM_OLD,
  '2026-10-03T14:02:11Z',
  '1a3c5e7092b4d6f8a0c2e4f6081a3c5e7092b4d6f8a0c2e4f6081a3c5e7092b4',
);

const evExchange: StoredEvidence = {
  id: 'ev-forum-gielda',
  category: 'forum_post',
  service: 'forum-krypto.example',
  url: 'https://forum-krypto.example/watek/8020#post-3',
  capturedAt: '2026-11-20T09:14:37Z',
  identityMatch: 'exact_identifier',
  title: 'Wątek: KryptoGiełda — opóźnione księgowanie wpłat',
  author: 'tomwzor',
  publishedAt: '2025-06-04T11:12:00Z',
  excerpt: `Wysłałem wczoraj ETH na adres depozytowy ${ADDR_EXCHANGE} i dalej nie widzę środków na koncie. Ktoś ma podobnie?`,
  contentHash: '70f2e4d6c8b0a2941e3d5c7b9a1f0e2d4c6b8a0f2e4d6c8b0a2941e3d5c7b9a1',
  connectorId: 'sandbox-forum',
  matchedIdentifier: NICK,
};

const evContract: StoredEvidence = {
  id: 'ev-kodhub-readme',
  category: 'own_profile',
  service: 'kodhub.example',
  url: 'https://kodhub.example/t-wzorcowy/portfel-narzedzia/README',
  capturedAt: '2026-11-20T09:14:33Z',
  identityMatch: 'linked_profile',
  title: 'portfel-narzedzia — README',
  author: 't-wzorcowy',
  publishedAt: '2024-02-27T16:20:00Z',
  excerpt: `Skrypt odczytuje salda tokena DemoUSD. Adres kontraktu jest wpisany w konfiguracji: ${ADDR_CONTRACT}.`,
  contentHash: 'e2c4a6081b3d5f7092a4c6e8f0b2d4a6c8e0f2a4b6d8c0e2f4a6b8d0c2e4f6a8',
  connectorId: 'sandbox-kodhub',
  matchedIdentifier: LINKED_LOGIN,
};

// ---------- Dane blockchain ----------

const TX = {
  mainIn1: '3a7f1c9e5b2d8046f1a3c5e7b9d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6',
  mainIn2: '8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e',
  mainOut1: 'b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7',
  mainIn3: '2e4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a',
  mainOut2: 'f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3',
  mainOut3: '6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f',
  forumIn: '0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d',
  forumOut1: '9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b',
  forumOut2: '4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e',
};

const transfer = (
  txid: string,
  time: string,
  direction: Transfer['direction'],
  counterparty: string,
  counterpartyClass: Transfer['counterpartyClass'],
  asset: string,
  amount: number,
  counterpartyLabel?: string,
): Transfer => ({
  txid,
  time,
  direction,
  counterparty,
  counterpartyClass,
  counterpartyLabel,
  asset,
  amount,
  explorerUrl: explorer(txid),
});

const chainMain: ChainActivity = {
  profile: {
    address: ADDR_MAIN,
    network: 'bitcoin',
    addressClass: 'private',
    classificationSource: CLASSIFICATION,
    isContract: false,
    txCount: 6,
    firstSeen: '2024-08-14T12:05:00Z',
    lastSeen: '2025-07-09T08:40:00Z',
    totalReceived: 1.05,
    totalSent: 0.87,
    balance: 0.18,
    nativeAsset: 'BTC',
  },
  transfers: [
    transfer(TX.mainIn1, '2024-08-14T12:05:00Z', 'in', PRIVATE_BTC_1, 'private', 'BTC', 0.5),
    transfer(TX.mainIn2, '2024-10-21T17:48:00Z', 'in', PRIVATE_BTC_2, 'unknown', 'BTC', 0.3),
    transfer(TX.mainOut1, '2024-11-06T09:30:00Z', 'out', EXCHANGE_BTC, 'exchange', 'BTC', 0.35, 'KryptoGiełda: adres depozytowy'),
    transfer(TX.mainIn3, '2025-02-02T21:16:00Z', 'in', PRIVATE_BTC_1, 'private', 'BTC', 0.25),
    transfer(TX.mainOut2, '2025-03-14T10:22:00Z', 'out', EXCHANGE_BTC, 'exchange', 'BTC', 0.42, 'KryptoGiełda: adres depozytowy'),
    transfer(TX.mainOut3, '2025-07-09T08:40:00Z', 'out', P2P_BTC, 'institutional', 'BTC', 0.1, 'WymianaP2P: depozyt transakcji'),
  ],
  cashOuts: [
    {
      kind: 'exchange_deposit',
      txid: TX.mainOut1,
      time: '2024-11-06T09:30:00Z',
      asset: 'BTC',
      amount: 0.35,
      counterparty: EXCHANGE_BTC,
      counterpartyLabel: 'KryptoGiełda: adres depozytowy',
      valuePln: 129920,
      valuation: '0,35 BTC × 371 200 PLN (kurs demonstracyjny z 6.11.2024, tabela kursów środowiska demonstracyjnego)',
      explanation: 'Środki wysłano na adres depozytowy giełdy — typowy krok przed sprzedażą za walutę tradycyjną.',
      explorerUrl: explorer(TX.mainOut1),
    },
    {
      kind: 'exchange_deposit',
      txid: TX.mainOut2,
      time: '2025-03-14T10:22:00Z',
      asset: 'BTC',
      amount: 0.42,
      counterparty: EXCHANGE_BTC,
      counterpartyLabel: 'KryptoGiełda: adres depozytowy',
      valuePln: 136290,
      valuation: '0,42 BTC × 324 500 PLN (kurs demonstracyjny z 14.03.2025, tabela kursów środowiska demonstracyjnego)',
      explanation: 'Druga wpłata na ten sam adres depozytowy giełdy.',
      explorerUrl: explorer(TX.mainOut2),
    },
    {
      kind: 'p2p_service',
      txid: TX.mainOut3,
      time: '2025-07-09T08:40:00Z',
      asset: 'BTC',
      amount: 0.1,
      counterparty: P2P_BTC,
      counterpartyLabel: 'WymianaP2P: depozyt transakcji',
      valuePln: 39800,
      valuation: '0,10 BTC × 398 000 PLN (kurs demonstracyjny z 9.07.2025, tabela kursów środowiska demonstracyjnego)',
      explanation: 'Wpłata do depozytu serwisu wymiany P2P — możliwa sprzedaż za gotówkę lub przelew.',
      explorerUrl: explorer(TX.mainOut3),
    },
  ],
  cashOutPlnByYear: { '2024': 129920, '2025': 176090 },
  limitations: [
    'Dane pochodzą z fikcyjnego eksploratora środowiska demonstracyjnego.',
    'Wpłata na giełdę nie dowodzi sprzedaży — wymaga potwierdzenia u operatora giełdy.',
  ],
};

const chainForum: ChainActivity = {
  profile: {
    address: ADDR_FORUM,
    network: 'ethereum',
    addressClass: 'unknown',
    classificationSource: CLASSIFICATION,
    isContract: false,
    txCount: 3,
    firstSeen: '2025-01-25T13:00:00Z',
    lastSeen: '2025-05-19T15:27:00Z',
    totalReceived: 2,
    totalSent: 1.7,
    balance: 0.3,
    nativeAsset: 'ETH',
  },
  transfers: [
    transfer(TX.forumIn, '2025-01-25T13:00:00Z', 'in', PRIVATE_ETH, 'unknown', 'ETH', 2),
    transfer(TX.forumOut1, '2025-04-08T19:03:00Z', 'out', ADDR_EXCHANGE, 'exchange', 'ETH', 1.2, 'KryptoGiełda: portfel gorący'),
    transfer(TX.forumOut2, '2025-05-19T15:27:00Z', 'out', SWAP_ETH, 'smart_contract', 'ETH', 0.5, 'ZamianaDEX: kontrakt wymiany'),
  ],
  cashOuts: [
    {
      kind: 'exchange_deposit',
      txid: TX.forumOut1,
      time: '2025-04-08T19:03:00Z',
      asset: 'ETH',
      amount: 1.2,
      counterparty: ADDR_EXCHANGE,
      counterpartyLabel: 'KryptoGiełda: portfel gorący',
      valuePln: 11820,
      valuation: '1,2 ETH × 9 850 PLN (kurs demonstracyjny z 8.04.2025, tabela kursów środowiska demonstracyjnego)',
      explanation: 'Przelew na adres oznaczony jako portfel giełdy.',
      explorerUrl: explorer(TX.forumOut1),
    },
    {
      kind: 'stablecoin_swap',
      txid: TX.forumOut2,
      time: '2025-05-19T15:27:00Z',
      asset: 'ETH',
      amount: 0.5,
      counterparty: SWAP_ETH,
      counterpartyLabel: 'ZamianaDEX: kontrakt wymiany',
      explanation: 'Zamiana na stablecoin przez kontrakt wymiany — częsty krok pośredni przed wypłatą.',
      explorerUrl: explorer(TX.forumOut2),
    },
  ],
  cashOutPlnByYear: { '2025': 11820 },
  limitations: [
    'Dane pochodzą z fikcyjnego eksploratora środowiska demonstracyjnego.',
    'Brak kursu dla zamiany na stablecoin — tej operacji nie ujęto w szacunku w PLN.',
  ],
};

const excludedChain = (
  address: string,
  addressClass: 'exchange' | 'smart_contract',
  label: string,
  txCount: number,
): ChainActivity => ({
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

// ---------- Powiązania ----------

const PROOF_HINT =
  'Poszukaj dowodu kryptograficznego: rekordu ENS wskazującego profil podmiotu lub podpisanej wiadomości.';
const SECOND_SOURCE_HINT = 'Drugi ślad z niezależnego źródła podniesie wynik o 15 p.p.';
const NO_LABEL_HINT =
  'Adres nie ma etykiety w danych blockchain — zweryfikuj ręcznie, czy nie należy do pośrednika.';

const findingMain: Finding = {
  address: ADDR_MAIN,
  network: 'bitcoin',
  checksumVerified: true,
  evidence: [evProfile, evOffer],
  confidence: {
    score: 95,
    tier: 'bardzo wysokie prawdopodobieństwo',
    excluded: false,
    ledger: [
      {
        rule: 'base.own_profile',
        delta: 85,
        running: 85,
        explanation: 'Najmocniejszy ślad: własny profil podmiotu (kodhub.example).',
        evidenceIds: [evProfile.id],
      },
      {
        rule: 'identity.linked_profile',
        delta: -5,
        running: 80,
        explanation: 'Sposób powiązania śladu z podmiotem: profil odnaleziony pośrednio.',
        evidenceIds: [evProfile.id],
      },
      {
        rule: 'synergy.second_source',
        delta: 15,
        running: 95,
        explanation: 'Ten sam adres w 2 niezależnych źródłach: kodhub.example, ogloszenia.example.',
        evidenceIds: [evProfile.id, evOffer.id],
      },
    ],
    nextSteps: [PROOF_HINT],
  },
  chain: chainMain,
  unrelatedPublishers: 0,
};

/** Stan z pierwszej analizy: znany był tylko ślad z ogłoszenia. */
const findingMainEarlier: Finding = {
  ...findingMain,
  evidence: [{ ...evOffer, capturedAt: '2026-10-03T14:02:19Z' }],
  confidence: {
    score: 70,
    tier: 'prawdopodobne',
    excluded: false,
    ledger: [
      {
        rule: 'base.sale_offer',
        delta: 70,
        running: 70,
        explanation: 'Najmocniejszy ślad: ogłoszenie sprzedaży / oferta P2P (ogloszenia.example).',
        evidenceIds: [evOffer.id],
      },
    ],
    nextSteps: [SECOND_SOURCE_HINT, PROOF_HINT],
  },
};

const forumFinding = (address: string, evidence: StoredEvidence, chain?: ChainActivity): Finding => ({
  address,
  network: 'ethereum',
  checksumVerified: true,
  evidence: [evidence],
  confidence: {
    score: 50,
    tier: 'średnie',
    excluded: false,
    ledger: [
      {
        rule: 'base.forum_post',
        delta: 50,
        running: 50,
        explanation: 'Najmocniejszy ślad: wypowiedź na forum (forum-krypto.example).',
        evidenceIds: [evidence.id],
      },
    ],
    nextSteps: [SECOND_SOURCE_HINT, NO_LABEL_HINT, PROOF_HINT],
  },
  chain,
  unrelatedPublishers: 0,
});

const excludedFinding = (
  address: string,
  evidence: StoredEvidence,
  chain: ChainActivity,
  reason: string,
  unrelatedPublishers: number,
): Finding => ({
  address,
  network: 'ethereum',
  checksumVerified: true,
  evidence: [evidence],
  confidence: {
    score: 0,
    tier: 'wykluczone',
    excluded: true,
    ledger: [
      {
        rule: 'exclusion.address_class',
        delta: 0,
        running: 0,
        explanation: `Wykluczenie: ${reason}. Adresu nie przypisuje się podmiotowi; odnotowano jedynie fakt jego publikacji lub interakcji.`,
        evidenceIds: [evidence.id],
      },
    ],
    nextSteps: [],
  },
  chain,
  unrelatedPublishers,
});

const findingExchange = excludedFinding(
  ADDR_EXCHANGE,
  evExchange,
  excludedChain(ADDR_EXCHANGE, 'exchange', 'KryptoGiełda: portfel gorący', 48211),
  'adres giełdy lub portfela powierniczego',
  5,
);

const findingContract = excludedFinding(
  ADDR_CONTRACT,
  evContract,
  excludedChain(ADDR_CONTRACT, 'smart_contract', 'DemoUSD: kontrakt tokena (ERC-20)', 912004),
  'smart kontrakt',
  2,
);

// ---------- Analizy i sprawa ----------

const query = { identifiers: [FULL_NAME, NICK, EMAIL] };

const runEarlier: AnalysisRun = {
  id: DEMO_RUN_1,
  caseId: DEMO_CASE_ID,
  startedAt: '2026-10-03T14:02:05Z',
  finishedAt: '2026-10-03T14:02:24Z',
  status: 'completed',
  query,
  connectors: ['sandbox-forum', 'sandbox-ogloszenia'],
  findings: [findingMainEarlier, forumFinding(ADDR_FORUM_OLD, evForumEarlier), findingExchange],
  log: [
    { time: '2026-10-03T14:02:05Z', message: 'Start analizy. Źródła: sandbox-forum, sandbox-ogloszenia.' },
    { time: '2026-10-03T14:02:11Z', message: 'forum-krypto.example: 2 dokumenty dla nicku „tomwzor”.' },
    { time: '2026-10-03T14:02:19Z', message: 'ogloszenia.example: 1 dokument dla adresu e-mail.' },
    { time: '2026-10-03T14:02:24Z', message: 'Zakończono: 3 adresy, w tym 1 wykluczony.' },
  ],
};

const runCurrent: AnalysisRun = {
  id: DEMO_RUN_2,
  caseId: DEMO_CASE_ID,
  startedAt: '2026-11-20T09:14:28Z',
  finishedAt: '2026-11-20T09:14:52Z',
  status: 'completed',
  query,
  connectors: ['sandbox-kodhub', 'sandbox-forum', 'sandbox-ogloszenia', 'sandbox-archiwum'],
  findings: [findingMain, forumFinding(ADDR_FORUM, evForumCurrent, chainForum), findingExchange, findingContract],
  log: [
    { time: '2026-11-20T09:14:28Z', message: 'Start analizy. Źródła: sandbox-kodhub, sandbox-forum, sandbox-ogloszenia, sandbox-archiwum.' },
    { time: '2026-11-20T09:14:30Z', message: 'kodhub.example: brak profilu dla nicku „tomwzor”.' },
    { time: '2026-11-20T09:14:31Z', message: 'forum-krypto.example: profil „tomwzor” wskazuje login „t-wzorcowy” w serwisie KodHub — dodano do drugiej rundy.' },
    { time: '2026-11-20T09:14:33Z', message: 'kodhub.example: 2 dokumenty dla loginu „t-wzorcowy”.' },
    { time: '2026-11-20T09:14:37Z', message: 'forum-krypto.example: 2 dokumenty dla nicku „tomwzor”.' },
    { time: '2026-11-20T09:14:41Z', message: 'ogloszenia.example: ogłoszenie wygasło — użyto kopii z archiwum.example z 19.10.2024.' },
    { time: '2026-11-20T09:14:44Z', message: 'Wykryto podmianę adresu w poście forum-krypto.example/watek/7731#post-12 względem poprzedniej analizy.' },
    { time: '2026-11-20T09:14:49Z', message: 'Dane blockchain: pobrano profile 4 adresów; 2 adresy wykluczone (giełda, smart kontrakt).' },
    { time: '2026-11-20T09:14:52Z', message: 'Zakończono: 4 adresy, w tym 2 wykluczone.' },
  ],
};

export const demoRuns: AnalysisRun[] = [runEarlier, runCurrent];

export const demoReplacements: Replacement[] = [{ url: evForumCurrent.url, from: ADDR_FORUM_OLD, to: ADDR_FORUM }];

export const demoCase: Omit<CaseSummary, 'runs'> = {
  id: DEMO_CASE_ID,
  name: 'Tomasz Wzorcowy — sprawa demonstracyjna',
  createdAt: '2026-10-03T13:58:00Z',
  query,
};
