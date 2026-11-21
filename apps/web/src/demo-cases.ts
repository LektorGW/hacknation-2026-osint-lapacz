// Tryb demo: sprawa samego adresu oraz sprawa założona dla nazwy giełdy (z adresem do potwierdzenia).
import type { AnalystDecision, CashOutTrail, Dossier, FlowHop, StoredEvidence } from '@olcys/core';
import type { CaseSummary } from './api.ts';
import { fakeHash } from './demo-data.ts';
import type { RawRun } from './demo-data.ts';
import { fmtPln } from './format.ts';
import { proofTier } from './proof.ts';
import type { CashOutProof, FullDossier } from './proof.ts';

type StoredCase = Omit<CaseSummary, 'runs'>;

const WHEN = '2026-11-20T09:20:00Z';
const explorer = (address: string) => `http://localhost:4100/explorer/address/${address}`;
const hop = (from: string, to: string, time: string, asset: string, amount: number, extra: Partial<FlowHop> = {}): FlowHop => ({
  txid: fakeHash(`${from}>${to}|${time}`),
  time,
  from,
  to,
  asset,
  amount,
  explorerUrl: explorer(to),
  ...extra,
});

function proof(input: {
  address: string;
  network: CashOutProof['network'];
  basis: CashOutProof['addressBasis'];
  personAddress: number;
  trailConfidence: number;
  serviceName: string;
  hops: FlowHop[];
  valuePln: number;
  opening: string;
  questions: string[];
  conditional?: boolean;
}): CashOutProof {
  const last = input.hops.at(-1)!;
  const whenConfirmed = input.trailConfidence;
  const combined = Math.round((input.personAddress * input.trailConfidence) / 100);
  const trail: CashOutTrail = {
    id: `${input.network}:${input.hops[0]!.txid}`,
    sourceAddress: input.address,
    network: input.network,
    hops: input.hops,
    serviceName: input.serviceName,
    serviceKind: 'exchange_deposit',
    asset: last.asset,
    amount: last.amount,
    valuePln: input.valuePln,
    valuation: 'kurs demonstracyjny z dnia transakcji',
    confidence: input.trailConfidence,
    reasons: [input.hops.length === 1 ? 'Bezpośredni przelew na adres z publiczną etykietą usługi.' : 'Ścieżka przez adres przelotowy; ostatni krok na adres z etykietą usługi.'],
    openQuestions: input.questions,
  };
  return {
    id: trail.id,
    person: null,
    address: input.address,
    network: input.network,
    addressBasis: input.basis,
    personAddressProbability: input.personAddress,
    trailConfidence: input.trailConfidence,
    combinedConfidence: combined,
    tier: proofTier(combined),
    components: [
      `P(osoba–adres) = ${input.personAddress}%${input.basis === 'analyst' ? ': adres podany przez analityka' : input.conditional ? ': własność adresu niepotwierdzona' : ''}.`,
      `P(ścieżka) = ${input.trailConfidence}%: ${trail.reasons[0]}`,
      `Łączna pewność ustalenia = ${input.personAddress} × ${input.trailConfidence} / 100 = ${combined}% (${proofTier(combined)}).`,
    ],
    layer: input.hops.length > 1 ? 'inference' : 'calculation',
    serviceName: input.serviceName,
    statement: `${input.opening} ${last.amount.toLocaleString('pl-PL')} ${last.asset} (ok. ${fmtPln(input.valuePln)}) trafiły do usługi ${input.serviceName} w ${input.hops.length} ${input.hops.length === 1 ? 'kroku' : 'krokach'} — pewność ścieżki ${input.trailConfidence}%.`,
    trail,
    ...(input.conditional ? { ownerUnconfirmed: true, confidenceIfConfirmed: whenConfirmed } : {}),
  };
}

// ---------- Sprawa samego adresu ----------

export const ADDRESS_CASE_ADDR = 'bc1qadres0badany3x7k9m2p4q6r8s0t2v4w6y8z0a2c';
const KG_BTC = 'bc1qkryptogielda0depozyt7x9m2c4v6n8b0q5w3e1r';
const P2P = 'bc1qwymianap2p4h8k2j6f0d9s7a5g3l1z8x6c4v2b0n';
const PASS = 'bc1qprzelotowy5adres8posredni2k4m6n8p0q2r4s6';
const ADDRESS_ID = { type: 'crypto_address' as const, value: ADDRESS_CASE_ADDR };

const mention = (id: string, service: string, author: string, text: string): StoredEvidence => ({
  id,
  category: 'forum_post',
  service,
  url: `https://${service}/watek/${fakeHash(id).slice(0, 6)}`,
  capturedAt: WHEN,
  identityMatch: 'exact_identifier',
  identityReasons: ['Publikacja zawiera badany adres; autor nie jest podmiotem sprawy.'],
  title: `Wpis użytkownika ${author}`,
  author,
  publishedAt: '2026-03-12T18:00:00Z',
  excerpt: text.replace('{a}', ADDRESS_CASE_ADDR),
  contentHash: fakeHash(`${id}|hash`),
  connectorId: 'sandbox-forum',
  matchedIdentifier: ADDRESS_ID,
});

const addressTransfers = [
  hop('bc1qnadawca1nieznany7x9k2m4p6q8r0s2t4v6w8y0z', ADDRESS_CASE_ADDR, '2025-09-02T10:00:00Z', 'BTC', 1.2),
  hop(ADDRESS_CASE_ADDR, KG_BTC, '2025-10-14T08:30:00Z', 'BTC', 0.6, { toLabel: 'KryptoGiełda: adres depozytowy', toClass: 'exchange' }),
  hop(ADDRESS_CASE_ADDR, PASS, '2026-02-03T12:10:00Z', 'BTC', 0.35),
];

export const demoAddressCase: StoredCase = {
  id: 'demo-sprawa-adres',
  name: `Adres ${ADDRESS_CASE_ADDR.slice(0, 8)}…${ADDRESS_CASE_ADDR.slice(-6)}`,
  createdAt: '2026-11-20T09:19:00Z',
  query: { identifiers: [ADDRESS_ID] },
};

export const demoAddressRun: RawRun = {
  id: 'demo-analiza-adres',
  caseId: demoAddressCase.id,
  startedAt: WHEN,
  finishedAt: WHEN,
  status: 'completed',
  query: demoAddressCase.query,
  connectors: ['sandbox-forum', 'sandbox-bazarek'],
  findings: [
    {
      address: ADDRESS_CASE_ADDR,
      network: 'bitcoin',
      checksumVerified: true,
      unrelatedPublishers: 3,
      evidence: [
        mention('ev-adres-forum', 'forum-krypto.example', 'stary_gornik', 'Ktoś kojarzy właściciela {a}? Dostałem z niego zapłatę za koparki.'),
        mention('ev-adres-bazarek', 'bazarek-p2p.example', 'p2p_wroclaw', 'Kupujący prosił o zwrot na {a} — transakcja przeszła bez problemu.'),
      ],
      chain: {
        profile: {
          address: ADDRESS_CASE_ADDR,
          network: 'bitcoin',
          addressClass: 'private',
          classificationSource: 'Zbiór etykiet środowiska demonstracyjnego',
          isContract: false,
          txCount: 3,
          firstSeen: '2025-09-02T10:00:00Z',
          lastSeen: '2026-02-03T12:10:00Z',
          totalReceived: 1.2,
          totalSent: 0.95,
          balance: 0.25,
          nativeAsset: 'BTC',
        },
        transfers: addressTransfers.map((item, index) => ({
          txid: item.txid,
          time: item.time,
          direction: index === 0 ? ('in' as const) : ('out' as const),
          counterparty: index === 0 ? item.from : item.to,
          counterpartyClass: item.toClass ?? 'unknown',
          counterpartyLabel: item.toLabel,
          asset: item.asset,
          amount: item.amount,
          explorerUrl: item.explorerUrl,
        })),
        cashOuts: [
          {
            kind: 'exchange_deposit',
            txid: addressTransfers[1]!.txid,
            time: addressTransfers[1]!.time,
            asset: 'BTC',
            amount: 0.6,
            counterparty: KG_BTC,
            counterpartyLabel: 'KryptoGiełda: adres depozytowy',
            valuePln: 249000,
            valuation: '0,6 BTC × 415 000 PLN (kurs demonstracyjny)',
            explanation: 'Środki wysłano na adres depozytowy giełdy.',
            explorerUrl: explorer(KG_BTC),
          },
        ],
        cashOutPlnByYear: { '2025': 249000 },
        limitations: ['Dane pochodzą z fikcyjnego eksploratora środowiska demonstracyjnego.', 'Historia adresu: pobrano wszystkie 3 transakcje.'],
      },
    },
  ],
  log: [{ time: WHEN, message: 'Analiza samego adresu: dane blockchain i publikacje cytujące adres.' }],
};

/** Teczka sprawy adresu: bez osoby i profili, dwie ścieżki, wzmianki innych autorów. */
export function addressCaseDossier(base: Dossier): FullDossier {
  return {
    ...base,
    persons: [],
    profiles: [],
    subject: { ...base.subject, knownNames: [] },
    graph: { nodes: base.graph.nodes.filter((node) => node.kind !== 'profile'), edges: base.graph.edges.filter((edge) => edge.kind !== 'found_profile' && edge.kind !== 'publishes') },
    cashOutProof: [
      proof({
        address: ADDRESS_CASE_ADDR,
        network: 'bitcoin',
        basis: 'analyst',
        personAddress: 100,
        trailConfidence: 95,
        serviceName: 'KryptoGiełda',
        hops: [addressTransfers[1]!],
        valuePln: 249000,
        opening: 'Środki z badanego adresu:',
        questions: [`KryptoGiełda może wskazać klienta, któremu zaksięgowano 0,6 BTC z 14.10.2025 (adres depozytowy ${KG_BTC}).`],
      }),
      proof({
        address: ADDRESS_CASE_ADDR,
        network: 'bitcoin',
        basis: 'analyst',
        personAddress: 100,
        trailConfidence: 80,
        serviceName: 'WymianaP2P',
        hops: [addressTransfers[2]!, hop(PASS, P2P, '2026-02-03T12:31:00Z', 'BTC', 0.35, { toLabel: 'WymianaP2P: depozyt transakcji', toClass: 'institutional', reason: 'Całość środków przekazana dalej po 21 minutach.' })],
        valuePln: 136500,
        opening: 'Środki z badanego adresu:',
        questions: ['WymianaP2P może wskazać konto, które otworzyło depozyt transakcji z 3.02.2026, oraz drugą stronę wymiany.'],
      }),
    ],
    mentions: [{ identifier: ADDRESS_ID, documents: 5, authors: 3, services: ['forum-krypto.example', 'bazarek-p2p.example'] }],
    explanations: [],
    unconfirmedAddresses: [],
    partial: false,
    summary: null,
  };
}

// ---------- Sprawa z nazwą giełdy ----------

const FAN_ADDR = 'bc1qfan0gieldy4adres7do9potwierdzenia2k5m8p';
const SERVICE_KEY = `bitcoin:${FAN_ADDR}`;

export const demoServiceCase: StoredCase = {
  id: 'demo-sprawa-gielda',
  name: 'KryptoGielda',
  createdAt: '2026-11-20T09:25:00Z',
  query: { identifiers: [{ type: 'nick', value: 'KryptoGielda' }] },
};

export const demoServiceRun: RawRun = {
  id: 'demo-analiza-gielda',
  caseId: demoServiceCase.id,
  startedAt: '2026-11-20T09:25:30Z',
  finishedAt: '2026-11-20T09:26:20Z',
  status: 'completed',
  query: demoServiceCase.query,
  connectors: ['sandbox-forum', 'sandbox-bazarek', 'sandbox-ogloszenia'],
  findings: [],
  log: [{ time: '2026-11-20T09:26:20Z', message: 'Identyfikator „KryptoGielda” odpowiada nazwie usługi ze zbioru etykiet.' }],
};

/** Teczka sprawy z nazwą giełdy: wyjaśnienie, adres do potwierdzenia i ustalenie warunkowe (albo pewne po decyzji). */
export function serviceCaseDossier(base: Dossier, decisions: AnalystDecision[]): FullDossier {
  const decision = decisions.filter((item) => item.target === 'address' && item.key === SERVICE_KEY).at(-1)?.decision;
  const hops = [hop(FAN_ADDR, KG_BTC, '2026-08-19T16:45:00Z', 'BTC', 0.15, { toLabel: 'KryptoGiełda: adres depozytowy', toClass: 'exchange' })];
  const conditional = proof({
    address: FAN_ADDR,
    network: 'bitcoin',
    basis: decision === 'confirmed' ? 'confirmed' : 'published',
    personAddress: decision === 'confirmed' ? 100 : 30,
    trailConfidence: 95,
    serviceName: 'KryptoGiełda',
    hops,
    valuePln: 61500,
    opening: decision === 'confirmed' ? 'Środki z adresu potwierdzonego przez analityka:' : 'Jeśli adres należy do podmiotu:',
    questions: [`KryptoGiełda może wskazać klienta, któremu zaksięgowano 0,15 BTC z 19.08.2026 (adres depozytowy ${KG_BTC}).`],
    conditional: decision !== 'confirmed',
  });
  return {
    ...base,
    decisions,
    cashOutProof: decision === 'rejected' ? [] : [conditional],
    mentions: [{ identifier: demoServiceCase.query.identifiers[0]!, documents: 48, authors: 31, services: ['forum-krypto.example', 'bazarek-p2p.example', 'ogloszenia.example'] }],
    partial: false,
    summary: null,
    explanations: [
      {
        kind: 'service_name',
        text: '„KryptoGielda” to nazwa giełdy ze zbioru publicznych etykiet, a nie identyfikator osoby. O giełdzie pisze wielu autorów, dlatego wyników nie przypisano jednemu podmiotowi i nie śledzono cudzych adresów.',
        suggestions: ['Podaj identyfikator osoby (nick, e-mail, adres profilu), a nie nazwę usługi.', 'Aby zbadać przepływy samej giełdy, analizuj jej oznaczony adres.'],
        addresses: [
          { address: KG_BTC, network: 'bitcoin', label: 'KryptoGiełda: adres depozytowy' },
          { address: '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', network: 'ethereum', label: 'KryptoGiełda: portfel gorący' },
        ],
      },
      ...(decision
        ? []
        : [
            {
              kind: 'only_unconfirmed' as const,
              text: 'Znaleziono jeden adres opublikowany przez konto o nazwie „KryptoGielda_fan” — nie wiadomo, czy należy do podmiotu sprawy, więc nie wliczono go do wyniku.',
              suggestions: ['Potwierdź adres, jeśli wiesz, że należy do podmiotu — teczka i dowód spieniężenia przeliczą się od razu.', 'Uruchom tryb głęboki, żeby poszukać kolejnych publikacji.'],
            },
          ]),
    ],
    unconfirmedAddresses: decision
      ? []
      : [
          {
            address: FAN_ADDR,
            network: 'bitcoin',
            sources: [{ url: 'https://forum-krypto.example/u/KryptoGielda_fan', service: 'forum-krypto.example', author: 'KryptoGielda_fan' }],
            reasons: ['Nick autora tylko zawiera szukaną nazwę — to inne konto.', 'Brak drugiego identyfikatora łączącego konto z podmiotem sprawy.'],
            personAddressProbability: 30,
            chain: { transfers: 4, totalReceived: 0.21, totalSent: 0.15, asset: 'BTC', services: ['KryptoGiełda'], cashOutPlnTotal: 61500, trails: 1 },
            confirmWith: [{ target: 'address', key: SERVICE_KEY }],
          },
        ],
  };
}
