// Tryb demo: powiązane tożsamości sprawy demonstracyjnej; scalenie przelicza sumy wypłat.
import type { AnalystDecision, ProfileCard } from '@olcys/core';
import { ADDR_MAIN, ADDR_TRON, fakeHash } from './demo-data.ts';
import { sum } from './format.ts';
import type { LinkedIdentity } from './identities.ts';
import { linkLabel } from './identities.ts';
import type { FullDossier } from './proof.ts';

const JULIA_KEY = 'ogloszenia.example|julka_wz';
const MARCIN_KEY = 'bazarek-p2p.example|kantor_marcin';
const JULIA_ADDR = 'bc1qjulia0wzorcowa5wlasny8adres2k4m6n8p0q2r';
const MARCIN_ADDR = 'TKantorMarcinWlasny7Qm2pLw9sVbN4cRtX';
const BALTYK_DEP = 'TDepBaltykWplata1x7Qm4Lp9Ws2Vb6Nc8Rt';
const UNKNOWN_ADDR = 'bc1q9f3k7m2x8v4c6n0b5z1a7s3d9g2h4j6l8q0w2e';

const profile = (key: string, service: string, handle: string, displayName: string, location: string, addresses: string[]): ProfileCard => ({
  id: key,
  service,
  url: `https://${service}/u/${handle}`,
  handle,
  attributes: { handle, displayName, location },
  identityMatch: 'linked_profile',
  identityReasons: ['Profil znaleziony przez ślad podmiotu, nie po identyfikatorze podanym w sprawie.'],
  identityScore: 0,
  addresses,
  evidenceIds: [],
});

const IDENTITIES: LinkedIdentity[] = [
  {
    id: 'julia-wzorcowa',
    displayName: 'Julia Wzorcowa',
    fullName: 'Julia Wzorcowa',
    handles: ['julka_wz'],
    relation: 'same_person_likely',
    score: 85,
    reasons: [
      {
        text: 'Ten sam adres Bitcoin podany jako własny w ogłoszeniach konta „julka_wz”.',
        evidence: [
          { kind: 'address', value: ADDR_MAIN },
          { kind: 'url', value: 'https://ogloszenia.example/oferta/51877-aparat-bezlusterkowy' },
        ],
      },
      { text: 'Ten sam numer telefonu kontaktowego co w ogłoszeniu podmiotu.', evidence: [{ kind: 'attribute', value: '+48 555 010 123' }] },
      { text: 'Zgodna lokalizacja (Poznań) i to samo nazwisko w formie żeńskiej.', evidence: [{ kind: 'attribute', value: 'Poznań' }] },
    ],
    profiles: [profile(JULIA_KEY, 'ogloszenia.example', 'julka_wz', 'Julia Wzorcowa', 'Poznań', [`bitcoin:${ADDR_MAIN}`, `bitcoin:${JULIA_ADDR}`])],
    addresses: [
      { address: ADDR_MAIN, network: 'bitcoin', basis: 'shared_with_subject' },
      { address: JULIA_ADDR, network: 'bitcoin', basis: 'published' },
    ],
    cashOutPlnByYear: { '2025': 48000, '2026': 21500 },
    cashOutProof: [
      {
        id: 'julia-1',
        address: JULIA_ADDR,
        serviceName: 'KryptoGiełda',
        amount: 0.12,
        asset: 'BTC',
        valuePln: 48000,
        trailConfidence: 95,
        hops: 1,
        statement: 'Udokumentowano przekazanie 0,12 BTC (ok. 48 000 zł) z adresu Julii Wzorcowej do usługi KryptoGiełda w 1 kroku.',
      },
    ],
    path: [
      'Profil podmiotu na ogloszenia.example („Tomasz W.”) podaje adres bc1qw508…v8f3t4 i telefon +48 555 010 123.',
      'Wyszukiwanie tego adresu w ogłoszeniach zwraca oferty konta „julka_wz”.',
      'Konto „julka_wz” przedstawia się jako Julia Wzorcowa i podaje ten sam telefon oraz drugi, własny adres.',
    ],
    note: 'To samo konto bankowe lub portfel bywa wspólny w rodzinie. Scalenie doliczy wypłaty tej tożsamości do podmiotu — zrób to tylko po potwierdzeniu, że to jedna osoba.',
    mergeWith: [{ target: 'profile', key: JULIA_KEY }],
  },
  {
    id: 'kantor-marcin',
    displayName: 'kantor_marcin',
    handles: ['kantor_marcin'],
    relation: 'possibly_same_or_close',
    score: 58,
    reasons: [
      {
        text: 'Wspólny adres wpłat Giełdy Bałtyk: środki obu kont trafiają na ten sam prawdopodobny adres depozytowy.',
        evidence: [
          { kind: 'address', value: BALTYK_DEP },
          { kind: 'txid', value: fakeHash(`${MARCIN_ADDR}>${BALTYK_DEP}`) },
        ],
      },
      { text: 'Oferty w tym samym serwisie i województwie, o podobnej treści.', evidence: [{ kind: 'url', value: 'https://bazarek-p2p.example/u/kantor_marcin' }] },
    ],
    profiles: [profile(MARCIN_KEY, 'bazarek-p2p.example', 'kantor_marcin', 'Marcin', 'woj. wielkopolskie', [`tron:${MARCIN_ADDR}`])],
    addresses: [
      { address: MARCIN_ADDR, network: 'tron', basis: 'published' },
      { address: BALTYK_DEP, network: 'tron', basis: 'linked:shared_deposit' },
    ],
    cashOutPlnByYear: { '2026': 37000 },
    cashOutProof: [
      {
        id: 'marcin-1',
        address: MARCIN_ADDR,
        serviceName: 'Giełda Bałtyk',
        amount: 9800,
        asset: 'USDT',
        valuePln: 37000,
        trailConfidence: 70,
        hops: 3,
        statement: 'Udokumentowano przekazanie 9 800 USDT (ok. 37 000 zł) z adresu konta „kantor_marcin” do usługi Giełda Bałtyk w 3 krokach.',
      },
    ],
    path: [
      'Profil podmiotu na bazarek-p2p.example („tomwzor”) publikuje adres Tron TXkDemoA…bN4cRt.',
      'Z tego adresu środki trafiają na prawdopodobny adres wpłat Giełdy Bałtyk TDepBalt…Nc8Rt.',
      'Na ten sam adres wpłat przelewa także adres TKantorM…cRtX — adres wpłat jest indywidualny dla klienta giełdy.',
      'Adres TKantorM…cRtX jest opublikowany w ofertach konta „kantor_marcin”.',
    ],
    note: 'Wspólny adres wpłat oznacza jedno konto w giełdzie, ale może z niego korzystać kilka osób (np. wspólnik). Rozstrzygną dane klienta od Giełdy Bałtyk.',
    mergeWith: [{ target: 'profile', key: MARCIN_KEY }],
  },
  {
    id: 'nieznany-bc1q9f3k',
    displayName: 'Nieznany właściciel adresu bc1q9f3k…q0w2e',
    handles: [],
    relation: 'associated',
    score: 35,
    reasons: [{ text: 'Adres dwukrotnie zasilił główny adres podmiotu (0,5 BTC i 0,25 BTC).', evidence: [{ kind: 'address', value: UNKNOWN_ADDR }] }],
    profiles: [],
    addresses: [{ address: UNKNOWN_ADDR, network: 'bitcoin', basis: 'linked:transfer' }],
    cashOutPlnByYear: {},
    cashOutProof: [],
    path: ['Główny adres podmiotu bc1qw508…v8f3t4 otrzymał dwa przelewy z adresu bc1q9f3k…q0w2e.', 'Adresu nie opublikował żaden znany profil — właściciel jest nieznany.'],
    note: 'Trop: analiza samego adresu może wskazać jego właściciela lub giełdę, z której pochodzą środki.',
    mergeWith: [],
  },
];

const add = (a: Record<string, number>, b: Record<string, number>) => {
  const result = { ...a };
  for (const [year, value] of Object.entries(b)) result[year] = (result[year] ?? 0) + value;
  return result;
};

/** Dokleja powiązane tożsamości; scalona znika z listy, a jej wypłaty wchodzą do sum podmiotu. */
export function applyDemoIdentities(dossier: FullDossier, decisions: AnalystDecision[]): FullDossier {
  const decisionOf = (identity: LinkedIdentity) =>
    decisions.filter((item) => item.target === 'profile' && identity.mergeWith.some((target) => target.key === item.key)).at(-1)?.decision;
  // Tożsamości wynikają z adresów podmiotu: bez adresu głównego lub Tron nie ma do nich ścieżki.
  const reachable = IDENTITIES.filter((identity) =>
    dossier.findings.some((finding) => !finding.confidence.excluded && finding.address === (identity.id === 'kantor-marcin' ? ADDR_TRON : ADDR_MAIN)),
  );
  const merged = reachable.filter((identity) => decisionOf(identity) === 'confirmed');
  const listed = reachable
    .filter((identity) => decisionOf(identity) !== 'confirmed')
    .map((identity) => (decisionOf(identity) === 'rejected' ? { ...identity, decision: 'rejected' as const } : identity));

  const own = merged.reduce((total, identity) => add(total, identity.cashOutPlnByYear), dossier.totals.cashOutPlnByYear);
  const likely = listed
    .filter((identity) => identity.relation === 'same_person_likely' && identity.decision !== 'rejected')
    .reduce((total, identity) => add(total, identity.cashOutPlnByYear), own);

  const nodes = [...dossier.graph.nodes];
  const edges = [...dossier.graph.edges];
  for (const identity of listed) {
    const shared = identity.addresses.map((item) => `adres:${item.network}:${item.address}`).find((id) => nodes.some((node) => node.id === id));
    const via = shared ?? (identity.id === 'kantor-marcin' ? `adres:tron:${ADDR_TRON}` : `adres:bitcoin:${ADDR_MAIN}`);
    if (!nodes.some((node) => node.id === via)) continue;
    nodes.push({ id: `identity:${identity.id}`, kind: 'person', label: identity.displayName, sublabel: 'powiązana tożsamość', score: identity.score });
    edges.push({ id: `identity-edge:${identity.id}`, from: via, to: `identity:${identity.id}`, kind: 'related', label: linkLabel(identity), weight: identity.score, inferred: true });
  }

  return {
    ...dossier,
    linkedIdentities: listed,
    graph: { nodes, edges },
    totals: {
      ...dossier.totals,
      cashOutPlnByYear: own,
      cashOutPlnTotal: sum(Object.values(own)),
      cashOutPlnByYearWithLikelySame: likely,
      cashOutPlnTotalWithLikelySame: sum(Object.values(likely)),
    } as FullDossier['totals'],
    keyFindings: [
      ...dossier.keyFindings,
      ...merged.map((identity) => ({ layer: 'inference' as const, text: `Decyzją analityka scalono tożsamość „${identity.displayName}” — jej wypłaty doliczono do sum podmiotu.` })),
    ],
  };
}
