// Tryb demo: dowody spieniężenia, sugestie modelu językowego, streszczenie, wzmianki i symulowany postęp.
import type { CashOutKind, CashOutTrail, Dossier, FlowHop, Network, TextInsight } from '@olcys/core';
import { ADDR_FORUM, ADDR_MAIN, ADDR_TRON, BALTYK_HOT, fakeHash } from './demo-data.ts';
import { addressKey } from './dossier.ts';
import { fmtAmount, fmtPln, shorten } from './format.ts';
import { proofTier } from './proof.ts';
import type { CashOutProof, Depth, DossierExtras, EvidenceWithInsight, RunProgress } from './proof.ts';

const MODEL = 'model-demonstracyjny';
const PROMPT = 'demo-1';
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

interface ProofSpec {
  /** Adres ze sprawy, od którego zależy prawdopodobieństwo osoba–adres. */
  subject: string;
  network: Network;
  /** Adres początku ścieżki, gdy pochodzi z klastra portfela. */
  cluster?: { address: string; reason: string };
  serviceName: string;
  serviceKind: CashOutKind;
  hops: FlowHop[];
  rate?: number;
  trailConfidence: number;
  reasons: string[];
  openQuestions: string[];
}

const KG_BTC = 'bc1qkryptogielda0depozyt7x9m2c4v6n8b0q5w3e1r';
const KG_ETH = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
const DEX = '0x3F9a2B6c8D0e1F4a5B7c9D2e4F6a8B0c1D3e5F70';
const P2P = 'bc1qwymianap2p4h8k2j6f0d9s7a5g3l1z8x6c4v2b0n';
const BALTYK_DEP = 'TDepBaltykWplata1x7Qm4Lp9Ws2Vb6Nc8Rt';
const BALTYK_SWEEP = 'TBaltykZbiorczyPosredni3Hd8Kq2Zm5Xv7';
const CLUSTER_BTC = 'bc1qklaster0portfela7tomasz4w9x2c5v8n1m3q6e';

const SPECS: ProofSpec[] = [
  {
    subject: ADDR_MAIN,
    network: 'bitcoin',
    serviceName: 'KryptoGiełda',
    serviceKind: 'exchange_deposit',
    hops: [hop(ADDR_MAIN, KG_BTC, '2025-03-14T10:22:00Z', 'BTC', 0.42, { toLabel: 'KryptoGiełda: adres depozytowy', toClass: 'exchange' })],
    rate: 324500,
    trailConfidence: 95,
    reasons: ['Bezpośredni przelew na adres z publiczną etykietą giełdy (95 pkt).', 'Ten sam adres depozytowy przyjął od podmiotu trzy wpłaty w latach 2024–2026.'],
    openQuestions: [
      `KryptoGiełda może potwierdzić właściciela konta, na które zaksięgowano wpłatę 0,42 BTC z 14.03.2025 (adres depozytowy ${KG_BTC}).`,
      'Czy i kiedy środki sprzedano za PLN oraz na jaki rachunek bankowy je wypłacono.',
    ],
  },
  {
    subject: ADDR_TRON,
    network: 'tron',
    serviceName: 'Giełda Bałtyk',
    serviceKind: 'exchange_deposit',
    hops: [
      hop(ADDR_TRON, BALTYK_DEP, '2025-12-19T08:20:00Z', 'USDT', 7500),
      hop(BALTYK_DEP, BALTYK_SWEEP, '2025-12-19T08:26:00Z', 'USDT', 7500, { reason: 'Całość środków przekazana dalej po 6 minutach — adres przelotowy.' }),
      hop(BALTYK_SWEEP, BALTYK_HOT, '2025-12-19T08:41:00Z', 'USDT', 7500, {
        toLabel: 'Giełda Bałtyk: portfel zbiorczy',
        toClass: 'exchange',
        inferred: true,
        reason: 'Adres pośredni zbiera wpłaty z wielu adresów i opróżnia się wyłącznie do portfela zbiorczego giełdy — wnioskowanie z wzorca, nie z etykiety.',
      }),
    ],
    rate: 3.62,
    trailConfidence: 70,
    reasons: ['Ścieżka w 3 krokach przez adres przelotowy (−10 pkt za każdy dodatkowy krok).', 'Ostatni krok ustalony heurystyką portfela zbiorczego (−5 pkt).'],
    openQuestions: [
      `Giełda Bałtyk może potwierdzić, czy ${BALTYK_DEP} jest indywidualnym adresem wpłat i do którego klienta należy.`,
      'Historia wypłat tego klienta w walutach tradycyjnych w grudniu 2025 r.',
    ],
  },
  {
    subject: ADDR_MAIN,
    network: 'bitcoin',
    cluster: { address: CLUSTER_BTC, reason: 'Adres wydany razem z adresem głównym w jednej transakcji (wspólne wejścia) — ten sam portfel.' },
    serviceName: 'WymianaP2P',
    serviceKind: 'p2p_service',
    hops: [hop(CLUSTER_BTC, P2P, '2026-06-17T07:30:00Z', 'BTC', 0.08, { toLabel: 'WymianaP2P: depozyt transakcji', toClass: 'institutional' })],
    rate: 405000,
    trailConfidence: 90,
    reasons: ['Bezpośredni przelew do depozytu serwisu P2P (90 pkt).', 'Adres początkowy pochodzi z klastra portfela, nie z publikacji — współczynnik 0,8 dla osoba–adres.'],
    openQuestions: ['WymianaP2P może wskazać konto, które otworzyło depozyt transakcji z 17.06.2026, oraz drugą stronę wymiany.'],
  },
  {
    subject: ADDR_FORUM,
    network: 'ethereum',
    serviceName: 'KryptoGiełda',
    serviceKind: 'stablecoin_swap',
    hops: [
      hop(ADDR_FORUM, DEX, '2025-05-19T15:27:00Z', 'ETH', 0.5, { toLabel: 'ZamianaDEX: kontrakt wymiany', toClass: 'smart_contract' }),
      hop(DEX, KG_ETH, '2025-05-19T15:27:00Z', 'USDC', 1180, {
        toLabel: 'KryptoGiełda: portfel gorący',
        toClass: 'exchange',
        inferred: true,
        reason: 'Zamiana na stablecoin i wpłata na giełdę w tej samej transakcji; kwota po zamianie odpowiada kursowi z tego dnia.',
      }),
    ],
    rate: 3.98,
    trailConfidence: 60,
    reasons: ['Zamiana ETH na stablecoin przez kontrakt wymiany, następnie wpłata na giełdę.', 'Powiązanie kroków przez kontrakt wymaga wnioskowania (−15 pkt).'],
    openQuestions: ['KryptoGiełda może potwierdzić wpłatę 1 180 USDC z 19.05.2025 i właściciela konta.'],
  },
];

/** Dowody spieniężenia sprawy demonstracyjnej; znikają, gdy adres przestaje być przypisany osobie. */
export function demoProofs(dossier: Dossier): CashOutProof[] {
  const person = dossier.persons[0];
  if (!person) return [];
  return SPECS.flatMap((spec): CashOutProof[] => {
    const link = person.addresses.find((item) => item.key === addressKey({ network: spec.network, address: spec.subject }));
    if (!link) return [];
    const last = spec.hops.at(-1)!;
    const source = spec.cluster?.address ?? spec.subject;
    const personAddressProbability = Math.round(link.probability * (spec.cluster ? 0.8 : 1));
    const combinedConfidence = Math.round((personAddressProbability * spec.trailConfidence) / 100);
    const valuePln = spec.rate === undefined ? undefined : Math.round(last.amount * spec.rate);
    const trail: CashOutTrail = {
      id: `${spec.network}:${spec.hops[0]!.txid}`,
      sourceAddress: source,
      network: spec.network,
      hops: spec.hops,
      serviceName: spec.serviceName,
      serviceKind: spec.serviceKind,
      asset: last.asset,
      amount: last.amount,
      valuePln,
      valuation: spec.rate === undefined ? undefined : `${fmtAmount(last.amount, last.asset)} × ${spec.rate.toLocaleString('pl-PL')} PLN (kurs demonstracyjny z ${last.time.slice(0, 10)})`,
      confidence: spec.trailConfidence,
      reasons: spec.reasons,
      openQuestions: spec.openQuestions,
    };
    return [
      {
        id: trail.id,
        person: { id: person.id, fullName: person.fullName, probability: person.probability },
        address: source,
        network: spec.network,
        addressBasis: spec.cluster ? 'cluster' : 'published',
        cluster: spec.cluster ? { seed: spec.subject, reason: spec.cluster.reason } : undefined,
        personAddressProbability,
        trailConfidence: spec.trailConfidence,
        combinedConfidence,
        tier: proofTier(combinedConfidence),
        components: [
          `P(osoba–adres) = ${personAddressProbability}%: łączne prawdopodobieństwo, że adres ${shorten(source)} należy do osoby ze sprawy${spec.cluster ? ' (adres z klastra portfela × 0,8)' : ''}.`,
          `P(ścieżka) = ${spec.trailConfidence}%: ${spec.reasons.join(' ')}`,
          `Łączna pewność ustalenia = ${personAddressProbability} × ${spec.trailConfidence} / 100 = ${combinedConfidence}% (${proofTier(combinedConfidence)}).`,
        ],
        layer: spec.hops.some((item) => item.inferred) || spec.cluster ? 'inference' : 'calculation',
        serviceName: spec.serviceName,
        statement:
          `Udokumentowano przekazanie ${fmtAmount(last.amount, last.asset)}${valuePln === undefined ? '' : ` (ok. ${fmtPln(valuePln)})`} z adresu ${shorten(source)} ` +
          `do usługi ${spec.serviceName} w ${spec.hops.length} ${spec.hops.length === 1 ? 'kroku' : 'krokach'} — pewność ścieżki ${spec.trailConfidence}%, łączna pewność ustalenia ${combinedConfidence}%.`,
        trail,
      },
    ];
  });
}

/** Odczyt modelu przy śladzie z profilu KodHub: autor podaje własny adres. */
export const demoOwnInsight: { evidenceId: string; insight: TextInsight } = {
  evidenceId: 'ev-kodhub-profil',
  insight: {
    ownership: 'own_address',
    suggestedCategory: 'own_profile',
    offer: { side: 'accepts_payment', asset: 'BTC', paymentMethods: ['BTC'] },
    language: 'pl',
    quote: 'możesz postawić kawę: BTC',
    model: MODEL,
    promptVersion: PROMPT,
  },
};

/** Ślad, który model odczytał jako ostrzeżenie o cudzym adresie — domyślnie niewliczony do wyniku. */
export const demoWarningEvidence: EvidenceWithInsight = {
  id: 'ev-bitrozmowy-ostrzezenie',
  category: 'forum_post',
  service: 'bitrozmowy.example',
  url: 'https://bitrozmowy.example/topic/55120#msg-4',
  capturedAt: '2026-11-20T09:14:38Z',
  identityMatch: 'same_handle',
  identityReasons: ['Zgadza się tylko nick „tomwzor”.'],
  title: 'Scam accusations: USDT seller from Poland',
  author: 'tomwzor',
  publishedAt: '2026-02-03T19:40:00Z',
  excerpt: `Warning: user bitkolekcjoner posts ${ADDR_TRON} in his offers, takes the USDT and never pays out the cash. Do not send anything there.`,
  contentHash: fakeHash('ev-bitrozmowy-ostrzezenie'),
  connectorId: 'sandbox-forum',
  matchedIdentifier: { type: 'nick', value: 'tomwzor' },
  insight: {
    ownership: 'warning_about_address',
    language: 'en',
    polishNexus: { score: 62, reasons: ['Wzmianka „seller from Poland” w tytule wątku.'] },
    translationPl: 'Ostrzeżenie: użytkownik bitkolekcjoner podaje ten adres w swoich ofertach, bierze USDT i nigdy nie wypłaca gotówki. Nic tam nie wysyłajcie.',
    quote: 'user bitkolekcjoner posts',
    model: MODEL,
    promptVersion: PROMPT,
  },
};

export const demoExtras: Required<Pick<DossierExtras, 'partial' | 'mentions' | 'summary'>> = {
  partial: false,
  mentions: [
    { identifier: { type: 'nick', value: 'tomwzor' }, documents: 6, authors: 4, services: ['forum-krypto.example', 'bitrozmowy.example'] },
    { identifier: { type: 'full_name', value: 'Tomasz Wzorcowy' }, documents: 2, authors: 2, services: ['ogloszenia.example'] },
  ],
  summary: {
    text:
      'Za nickiem „tomwzor” i adresem tomasz.wzorcowy@poczta.example najpewniej stoi jedna osoba z Poznania, występująca jako Tomasz Wzorcowy. ' +
      'Opublikowała trzy adresy kryptowalutowe; z dwóch z nich środki trafiały wielokrotnie na giełdy i do serwisu wymiany P2P. ' +
      'Najmocniej udokumentowana jest bezpośrednia wpłata 0,42 BTC na adres depozytowy KryptoGiełdy. Potwierdzenie sprzedaży za złotówki wymaga danych od giełdy.',
    model: MODEL,
    promptVersion: PROMPT,
  },
};

export const demoAi = {
  enabled: true,
  provider: 'tryb demo',
  model: MODEL,
  description: 'Model demonstracyjny: odczyty przy śladach i streszczenie są przygotowane ręcznie; w trybie demo nic nie jest wysyłane poza przeglądarkę.',
  usage: { analyzePublication: 2, summarize: 1, compareAuthors: 0, errors: 0 },
};

export const demoCorpus = { documents: 4812, addresses: 937, services: 23, newestFetchedAt: '2026-11-20T08:30:00Z', retentionDays: 30 };

// ---------- Symulowany postęp analizy ----------

const started = new Map<string, { at: number; depth: Depth }>();

export function startDemoProgress(runId: string, depth: Depth): void {
  started.set(runId, { at: Date.now(), depth });
}

/** Postęp wyliczany z upływu czasu: tryb głęboki trwa dłużej i przegląda więcej źródeł. */
export function demoProgress(runId: string): RunProgress {
  const entry = started.get(runId);
  if (!entry) return { status: 'completed', stage: 'done', connectorsDone: 0, connectorsTotal: 0, documents: 0, addresses: 0 };
  const total = entry.depth === 'deep' ? 14000 : 6000;
  const sources = entry.depth === 'deep' ? 412 : 6;
  const share = Math.min(1, (Date.now() - entry.at) / total);
  const searching = Math.min(1, share / 0.5);
  const later = (['occurrences', 'chain', 'counterparties', 'scoring', 'ai', 'saving'] as const)[Math.min(5, Math.floor(((share - 0.5) / 0.5) * 6))];
  return {
    status: share >= 1 ? 'completed' : 'running',
    depth: entry.depth,
    stage: share >= 1 ? 'done' : share < 0.5 ? 'search' : later!,
    connectorsDone: Math.round(sources * searching),
    connectorsTotal: sources,
    documents: Math.round((entry.depth === 'deep' ? 96 : 14) * searching),
    addresses: share < 0.5 ? 0 : 6,
  };
}
