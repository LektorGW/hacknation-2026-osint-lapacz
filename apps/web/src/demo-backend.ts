// Zastępnik API dla trybu demo: stan trzymany w pamięci karty przeglądarki.
// Wskaźnik Pewności liczy ta sama funkcja co w usłudze analizy, więc decyzje
// analityka zmieniają wynik według prawdziwych reguł.
import type {
  AnalysisRun,
  AnalystDecision,
  Dossier,
  Finding,
  Identifier,
  Lead,
  MonitorStatus,
  PersonCandidate,
  RunDiff,
  ScoreResult,
  StoredEvidence,
  Sweep,
  WatchHit,
} from '@olcys/core';
import { DEFAULT_RULES, computeConfidence } from '../../../packages/core/src/score.ts';
import type { Backend, CaseSummary, Overview, RunSummary } from './api.ts';
import { ApiError } from './api.ts';
import {
  ADDR_FORUM,
  ADDR_MAIN,
  ADDR_NAMESAKE,
  ADDR_TRON,
  BALTYK_HOT,
  DEMO_CASE_ID,
  DEMO_NOW,
  DEMO_RUN_2,
  KEY_BAZAREK,
  KEY_FORUM,
  KEY_FOTO,
  KEY_GRY,
  KEY_KODHUB,
  KEY_MIKROBLOG,
  KEY_OFFER,
  demoCase,
  demoConnectors,
  demoDiscovered,
  demoExtraProfiles,
  demoLeads,
  demoMentionServices,
  demoPriorityRules,
  demoProfileAttributes,
  demoProfileLinks,
  demoRelatedPersons,
  demoReplacements,
  demoRuns,
  demoSweepLog,
  fakeHash,
} from './demo-data.ts';
import type { RawFinding, RawRun } from './demo-data.ts';
import { demoHits, demoMonitorSources } from './demo-monitor.ts';
import { demoAi, demoCorpus, demoExtras, demoOwnInsight, demoProgress, demoProofs, demoWarningEvidence, startDemoProgress } from './demo-proof.ts';
import type { DossierFinding, FullDossier } from './proof.ts';
import { applyDemoIdentities } from './demo-identities.ts';
import { applyDemoInvestigation } from './demo-indicators.ts';
import type { DecisionRecord } from './decisions.ts';
import { ADDRESS_CASE_ADDR, addressCaseDossier, demoAddressCase, demoAddressRun, demoServiceCase, demoServiceRun, serviceCaseDossier } from './demo-cases.ts';
import { IDENTITY_SCORE, addressKey, computePriority, dossierFromRun, profileKey } from './dossier.ts';
import { fmtPln, sum } from './format.ts';

type StoredCase = Omit<CaseSummary, 'runs'>;

const NOW = new Date(DEMO_NOW);
const cases: StoredCase[] = [demoCase, demoAddressCase, demoServiceCase];
const runs: RawRun[] = [...demoRuns, demoAddressRun, demoServiceRun];
const decisions: DecisionRecord[] = [];
const sweeps: Sweep[] = [];
let sequence = 0;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const notFound = (what: string) => new ApiError(`Nie znaleziono: ${what}.`, 404);
const evidenceKey = (item: StoredEvidence) => profileKey({ service: item.service, handle: item.author, url: item.url });
/** Decyzje obowiązujące: wycofane zostają w rejestrze, ale nie wpływają na wynik. */
const decisionsOf = (caseId: string): AnalystDecision[] => decisions.filter((item) => item.caseId === caseId && !item.withdrawnAt);
const historyOf = (caseId: string): DecisionRecord[] => decisions.filter((item) => item.caseId === caseId);

/** Wycena analizy z uwzględnieniem decyzji: odrzucony profil traci ślady, potwierdzony zyskuje pewną tożsamość. */
function scoreRun(run: RawRun, applied: AnalystDecision[]): AnalysisRun {
  const keys = (target: AnalystDecision['target'], decision: AnalystDecision['decision']) =>
    new Set(applied.filter((item) => item.target === target && item.decision === decision).map((item) => item.key));
  const rejectedProfiles = keys('profile', 'rejected');
  const confirmedProfiles = keys('profile', 'confirmed');
  const rejectedAddresses = keys('address', 'rejected');

  const findings = run.findings.flatMap((raw): Finding[] => {
    const evidence = raw.evidence
      .filter((item) => !rejectedProfiles.has(evidenceKey(item)))
      .map((item): StoredEvidence =>
        confirmedProfiles.has(evidenceKey(item))
          ? {
              ...item,
              identityMatch: 'verified_link',
              identityReasons: [...(item.identityReasons ?? []), 'Profil potwierdzony decyzją analityka.'],
            }
          : item,
      );
    if (evidence.length === 0) return [];
    const confidence: ScoreResult = rejectedAddresses.has(addressKey(raw))
      ? {
          score: 0,
          tier: 'wykluczone',
          excluded: true,
          ledger: [
            {
              rule: 'exclusion.analyst_decision',
              delta: 0,
              running: 0,
              explanation: 'Adres odrzucony decyzją analityka — nie jest przypisywany podmiotowi.',
              evidenceIds: evidence.map((item) => item.id),
            },
          ],
          nextSteps: [],
        }
      : computeConfidence({
          evidence,
          addressClass: raw.chain?.profile.addressClass ?? 'unknown',
          unrelatedPublishers: raw.unrelatedPublishers,
        });
    return [{ ...raw, evidence, confidence }];
  });
  return { ...run, findings };
}

function summarizeRun(run: RawRun): RunSummary {
  const scored = scoreRun(run, decisionsOf(run.caseId));
  return {
    id: run.id,
    startedAt: run.startedAt,
    status: run.status,
    findingCount: scored.findings.length,
    topScore: Math.max(0, ...scored.findings.map((finding) => finding.confidence.score)),
  };
}

const summarizeCase = (stored: StoredCase): CaseSummary => ({
  ...stored,
  runs: runs.filter((run) => run.caseId === stored.id).map(summarizeRun),
});

function findCase(caseId: string): StoredCase {
  const found = cases.find((item) => item.id === caseId);
  if (!found) throw notFound('sprawa');
  return found;
}

function findRun(runId: string): RawRun {
  const found = runs.find((item) => item.id === runId);
  if (!found) throw notFound('analiza');
  return found;
}

/** Podmiany widoczne w danej analizie: nowy adres jest w wynikach, stary już nie. */
function replacementsFor(run: RawRun) {
  const addresses = new Set(run.findings.map((finding) => finding.address));
  return demoReplacements.filter((item) => addresses.has(item.to) && !addresses.has(item.from));
}

function diffRuns(from: AnalysisRun, to: AnalysisRun): RunDiff {
  const before = new Map(from.findings.map((finding) => [finding.address, finding.confidence.score]));
  const after = new Map(to.findings.map((finding) => [finding.address, finding.confidence.score]));
  return {
    fromRunId: from.id,
    toRunId: to.id,
    addedAddresses: [...after.keys()].filter((address) => !before.has(address)),
    removedAddresses: [...before.keys()].filter((address) => !after.has(address)),
    scoreChanges: [...after]
      .filter(([address, score]) => before.has(address) && before.get(address) !== score)
      .map(([address, score]) => ({ address, from: before.get(address)!, to: score })),
    replacedAddresses: demoReplacements.filter((item) => before.has(item.from) && after.has(item.to)),
  };
}

// ---------- Teczka ----------

const MAIN_KEYS = [KEY_FORUM, KEY_KODHUB, KEY_OFFER, KEY_MIKROBLOG, KEY_BAZAREK];
const MAIN_PROBABILITY = 88;

/** Kandydaci na rzeczywistą osobę w sprawie demonstracyjnej; decyzje analityka przenoszą profile między nimi. */
function demoPersons(dossier: Dossier, applied: AnalystDecision[]): PersonCandidate[] {
  const decisionFor = (key: string) => applied.find((item) => item.target === 'profile' && item.key === key)?.decision;
  const present = (key: string) => dossier.profiles.some((profile) => profile.id === key);
  const mainKeys = [
    ...MAIN_KEYS.filter((key) => decisionFor(key) !== 'rejected'),
    ...[KEY_FOTO, KEY_GRY].filter((key) => decisionFor(key) === 'confirmed'),
  ].filter(present);
  const addressesOf = (keys: string[], probability: number) =>
    dossier.findings
      .filter(
        (finding) =>
          !finding.confidence.excluded && finding.evidence.some((item) => keys.includes(evidenceKey(item))),
      )
      .map((finding) => ({
        key: addressKey(finding),
        probability: Math.round((probability * finding.confidence.score) / 100),
      }));
  const other = (key: string, candidate: Omit<PersonCandidate, 'profileIds' | 'addresses'>): PersonCandidate[] =>
    decisionFor(key) || !present(key)
      ? []
      : [{ ...candidate, profileIds: [key], addresses: addressesOf([key], candidate.probability) }];

  return [
    {
      id: 'osoba-glowna',
      fullName: 'Tomasz Wzorcowy',
      nameVariants: ['Tomasz W.', 'Tomek W.', 'tomwzor', 't-wzorcowy'],
      probability: MAIN_PROBABILITY,
      reasons: [
        'Adres e-mail podany w sprawie występuje w dwóch niezależnych serwisach (forum-krypto.example, ogloszenia.example).',
        'Profile na forum-krypto.example i mikroblog.example wskazują na siebie wzajemnie — ta sama osoba prowadzi oba.',
        'Profil kodhub.example jest wskazany z forum i odsyła z powrotem do forum.',
        'Zgodna lokalizacja (Poznań) w czterech profilach.',
        'Imię i nazwisko zgodne z inicjałem „Tomasz W.” w ogłoszeniu i profilu KodHub.',
        'Profil bazarek-p2p.example dołączono na podstawie samego nicku i województwa — najsłabsze ogniwo.',
      ],
      attributes: [
        { kind: 'email', value: 'tomasz.wzorcowy@poczta.example', sources: ['forum-krypto.example', 'ogloszenia.example'] },
        { kind: 'phone', value: '+48 555 010 123', sources: ['ogloszenia.example'] },
        { kind: 'location', value: 'Poznań', sources: ['forum-krypto.example', 'kodhub.example', 'ogloszenia.example', 'mikroblog.example'] },
        { kind: 'website', value: 'https://kodhub.example/t-wzorcowy', sources: ['forum-krypto.example'] },
        { kind: 'handle', value: 'tomwzor', sources: ['forum-krypto.example', 'mikroblog.example', 'bazarek-p2p.example'] },
        { kind: 'handle', value: 't-wzorcowy', sources: ['kodhub.example'] },
      ],
      profileIds: mainKeys,
      addresses: addressesOf(mainKeys, MAIN_PROBABILITY),
    },
    ...other(KEY_FOTO, {
      id: 'osoba-imiennik',
      fullName: 'Tomasz Wzorcowy',
      nameVariants: [],
      probability: 22,
      reasons: [
        'Rozdzielono: zgadza się wyłącznie imię i nazwisko.',
        'Inna lokalizacja (Gdańsk zamiast Poznania) i inny zawód (fotograf ślubny).',
        'Brak wspólnych adresów e-mail, nicków, odnośników i przepływów między adresami.',
      ],
      attributes: [
        { kind: 'location', value: 'Gdańsk', sources: ['fotoportfolio.example'] },
        { kind: 'email', value: 'kontakt@fotoportfolio.example', sources: ['fotoportfolio.example'] },
        { kind: 'website', value: 'https://fotoportfolio.example/tomasz-wzorcowy', sources: ['fotoportfolio.example'] },
      ],
    }),
    ...other(KEY_GRY, {
      id: 'osoba-nick',
      nameVariants: ['tomwzor'],
      probability: 9,
      reasons: [
        'Rozdzielono: zgadza się tylko nick, który w serwisach z grami powtarza się u wielu osób.',
        'Inna lokalizacja (Rzeszów) i deklarowany rok urodzenia 2008.',
      ],
      attributes: [
        { kind: 'handle', value: 'tomwzor', sources: ['gry-online.example'] },
        { kind: 'location', value: 'Rzeszów', sources: ['gry-online.example'] },
      ],
    }),
  ];
}

/** Uzupełnia teczkę sprawy demonstracyjnej o to, czego nie da się wyprowadzić z samej analizy. */
function enrichDemo(dossier: Dossier, summary: StoredCase, applied: AnalystDecision[]): Dossier {
  const decisionFor = (key: string) => applied.find((item) => item.target === 'profile' && item.key === key)?.decision;
  const profiles = [
    ...dossier.profiles.map((profile) => {
      const extra = demoProfileAttributes[profileKey(profile)];
      return extra ? { ...profile, url: extra.url, attributes: extra.attributes } : profile;
    }),
    ...demoExtraProfiles.map((profile) => {
      const decision = decisionFor(profileKey(profile));
      return decision === 'confirmed'
        ? { ...profile, decision, identityMatch: 'verified_link' as const, identityScore: IDENTITY_SCORE.verified_link }
        : { ...profile, decision };
    }),
  ];

  const inQuery = (identifier: Identifier) =>
    summary.query.identifiers.some((item) => item.type === identifier.type && item.value === identifier.value);
  const identifiers = [
    ...dossier.subject.identifiers.map((item) =>
      item.origin === 'discovered' ? { ...item, sourceUrl: 'https://forum-krypto.example/u/tomwzor' } : item,
    ),
    ...demoDiscovered
      .filter((item) => !inQuery(item.identifier))
      .map((item) => ({ identifier: item.identifier, origin: 'discovered' as const, sourceUrl: item.sourceUrl })),
  ];

  const nodes = [...dossier.graph.nodes];
  const edges = [...dossier.graph.edges];
  const has = (id: string) => nodes.some((node) => node.id === id);
  for (const profile of demoExtraProfiles) {
    nodes.push({
      id: profile.id,
      kind: 'profile',
      label: profile.handle ?? profile.service,
      sublabel: profile.service,
      score: profile.identityScore,
      excluded: decisionFor(profileKey(profile)) === 'rejected',
      url: profile.url,
    });
    edges.push({ id: `found:${profile.id}`, from: 'id:nick:tomwzor', to: profile.id, kind: 'found_profile', weight: profile.identityScore });
  }
  for (const [from, to] of demoProfileLinks) {
    if (has(from) && has(to)) {
      edges.push({ id: `link:${from}>${to}`, from, to, kind: 'links_to', label: 'odnośnik w profilu' });
    }
  }
  for (const item of demoDiscovered) {
    const id = `id:${item.identifier.type}:${item.identifier.value}`;
    if (!has(id)) {
      nodes.push({ id, kind: 'identifier', label: item.identifier.value, sublabel: 'odkryty w profilu' });
      edges.push({ id: `has:${id}`, from: 'podmiot', to: id, kind: 'has_identifier', inferred: true });
    }
    if (has(item.profileKey)) {
      edges.push({ id: `reveals:${id}`, from: item.profileKey, to: id, kind: 'links_to', label: 'ujawniony w profilu' });
    }
  }
  for (const person of demoRelatedPersons) {
    const target =
      person.node.target === 'profile'
        ? person.node.key
        : person.node.target === 'address'
          ? `adres:tron:${person.node.key}`
          : `kontrahent:${person.node.key}`;
    if (!has(target)) continue;
    nodes.push({ id: `osoba:${person.id}`, kind: 'person', label: person.handle, sublabel: person.services.join(', '), score: person.strength, url: person.profileUrls[0] });
    edges.push({
      id: `related:${person.id}`,
      from: target,
      to: `osoba:${person.id}`,
      kind: 'related',
      label: person.relations[0]!.description,
      weight: person.strength,
      inferred: true,
    });
  }

  const timeline = [
    ...dossier.timeline,
    ...profiles.flatMap((profile) =>
      profile.attributes.createdAt
        ? [
            {
              time: profile.attributes.createdAt,
              kind: 'account_created' as const,
              title: `Założenie konta ${profile.handle ?? ''} w serwisie ${profile.service}`.replace('  ', ' '),
              detail: 'Data podana przez serwis w publicznym profilu.',
              url: profile.url,
              layer: 'fact' as const,
            },
          ]
        : [],
    ),
  ].sort((a, b) => a.time.localeCompare(b.time));

  // Giełda Bałtyk: powiązanie wyłącznie przez prawdopodobne adresy wpłat.
  const serviceLinks = [
    ...dossier.serviceLinks.map((link) =>
      link.name !== 'Giełda Bałtyk'
        ? link
        : {
            ...link,
            kind: 'exchange' as const,
            basis: ['deposit_address' as const],
            inferredOnly: true,
            strength: Math.min(link.strength, 55),
            reasons: [
              'Adresy odbiorców w kilka minut przekazują całość środków do portfela zbiorczego Giełdy Bałtyk — wzorzec indywidualnych adresów wpłat.',
              'Brak publicznej etykiety adresów wpłat: powiązanie jest wnioskiem narzędzia.',
              ...link.reasons.slice(1),
            ],
            transfers: link.transfers.map((item) => ({ ...item, viaAddress: item.serviceAddress, serviceAddress: BALTYK_HOT })),
            requestHints: [
              ...[...new Set(link.transfers.map((item) => item.serviceAddress))].map(
                (address) => `Prawdopodobny adres wpłat ${address} — do którego klienta jest przypisany?`,
              ),
              ...link.requestHints.slice(-4),
            ],
          },
    ),
    ...demoMentionServices,
  ].sort((a, b) => b.strength - a.strength);

  const enriched: Dossier = {
    ...dossier,
    subject: { ...dossier.subject, identifiers },
    profiles,
    relatedPersons: demoRelatedPersons.map(({ node: _node, ...person }) => person),
    serviceLinks,
    graph: { nodes, edges },
    timeline,
  };
  const persons = demoPersons(enriched, applied);
  const main = persons[0]!;
  const valued = serviceLinks.filter((link) => (link.outPln ?? 0) > 0);
  return {
    ...enriched,
    persons,
    subject: { ...enriched.subject, knownNames: [main.fullName!, ...main.nameVariants] },
    keyFindings: [
      {
        layer: 'inference',
        text: `Ustalono osobę: ${main.fullName}, prawdopodobieństwo ${main.probability}% — ${main.profileIds.length} profili połączonych e-mailem, wzajemnymi odnośnikami i lokalizacją.`,
      },
      {
        layer: 'calculation',
        text: `Przelewy do ${valued.length} usług na łączną szacunkową kwotę ${fmtPln(sum(valued.map((link) => link.outPln!)))}; najwięcej: ${valued[0]?.name ?? '—'}.`,
      },
      ...dossier.keyFindings.filter((item) => !item.text.startsWith('Przelewy łączą')),
      ...(persons.length > 1
        ? [{ layer: 'inference' as const, text: `Część śladów prawdopodobnie należy do innych osób (${persons.length - 1}): imiennik z Gdańska i zbieżny nick w serwisie z grami.` }]
        : []),
    ],
  };
}

/** Teczka demo ze wskaźnikami A/B/C, statusami relacji grafu i pełną historią decyzji (także wycofanych). */
function buildDossier(raw: RawRun): FullDossier {
  const caseId = findCase(raw.caseId).id;
  return { ...applyDemoInvestigation(buildBaseDossier(raw), decisionsOf(caseId)), decisions: historyOf(caseId) };
}

function buildBaseDossier(raw: RawRun): FullDossier {
  const summary = findCase(raw.caseId);
  const applied = decisionsOf(raw.caseId);
  const demo = raw.caseId === DEMO_CASE_ID && raw.findings.some((finding) => finding.address === ADDR_TRON);
  // Ślad odczytany przez model jako ostrzeżenie o cudzym adresie wchodzi do oceny dopiero po decyzji analityka.
  const modelOverridden = applied.some((item) => (item.target as string) === 'evidence' && item.key === demoWarningEvidence.id);
  const run: RawRun =
    demo && modelOverridden
      ? { ...raw, findings: raw.findings.map((finding) => (finding.address === ADDR_TRON ? { ...finding, evidence: [...finding.evidence, demoWarningEvidence] } : finding)) }
      : raw;
  const base = dossierFromRun(scoreRun(run, applied), {
    name: summary.name,
    replacements: replacementsFor(run),
    decisions: applied,
    original: scoreRun(run, []),
    now: NOW,
  });
  if (raw.caseId === demoAddressCase.id) return addressCaseDossier(base);
  if (raw.caseId === demoServiceCase.id) return serviceCaseDossier(base, applied);
  if (!(raw.caseId === DEMO_CASE_ID && raw.findings.length > 0)) return { ...base, cashOutProof: [], mentions: [], partial: false, summary: null };

  const enriched = enrichDemo(base, summary, applied);
  const findings = enriched.findings.map((finding): DossierFinding => ({
    ...finding,
    evidence: finding.evidence.map((item) => (item.id === demoOwnInsight.evidenceId ? { ...item, insight: demoOwnInsight.insight } : item)),
    subjectProbability: enriched.persons[0]?.addresses.find((item) => item.key === addressKey(finding))?.probability ?? 0,
    ...(demo && !modelOverridden && finding.address === ADDR_TRON
      ? {
          excludedEvidence: [demoWarningEvidence],
          annotations: ['Model językowy odczytał wpis z bitrozmowy.example jako ostrzeżenie o cudzym adresie — ślad nie podnosi wyniku (reguła ai.ownership).'],
        }
      : {}),
  }));
  return applyDemoIdentities({ ...enriched, findings, cashOutProof: demo ? demoProofs(enriched) : [], ...demoExtras }, applied);
}

const latestRun = (caseId: string) => runs.filter((run) => run.caseId === caseId && run.status === 'completed').at(-1);

// ---------- Typowanie ----------

const leadWithPriority = (lead: (typeof demoLeads)[number]): Lead => {
  const { priority, reasons } = computePriority(lead.topScore, lead.cashOutPlnByYear, NOW);
  // Wskazanie „bitkolekcjoner” publikuje adres Tron znany ze sprawy demonstracyjnej.
  const known = lead.handle === 'bitkolekcjoner' ? { knownFromCases: [{ address: ADDR_TRON, caseId: DEMO_CASE_ID, caseName: demoCase.name }] } : {};
  return { ...lead, priority, priorityReasons: reasons, ...known };
};

function buildSweep(connectors: string[], limit: number, startedAt: string): Sweep {
  sequence += 1;
  const services = new Set(demoConnectors.filter((item) => connectors.includes(item.id)).map((item) => item.service));
  const leads = demoLeads
    .filter((lead) => lead.services.some((service) => services.has(service)))
    .map((lead) => ({ ...leadWithPriority(lead), caseId: lead.caseId ?? cases.find((item) => item.id === `demo-sprawa-${lead.id}`)?.id }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
  return {
    id: `demo-przeglad-${sequence}`,
    startedAt,
    finishedAt: startedAt,
    status: 'completed',
    connectors,
    documentsScanned: 136,
    leads,
    log: [...demoSweepLog, `Zakończono: wytypowano ${leads.length} podmiotów.`].map((message) => ({ time: startedAt, message })),
  };
}

sweeps.push(buildSweep(['sandbox-forum', 'sandbox-ogloszenia', 'sandbox-bazarek'], 20, '2026-11-19T07:30:00Z'));

/** Analiza sprawy założonej ze wskazania: po jednym śladzie i jednej wypłacie rocznie na adres. */
function runFromLead(lead: Lead, caseId: string, identifiers: Identifier[]): RawRun {
  const now = new Date().toISOString();
  const findings = lead.addresses.map((item, index): RawFinding => {
    const service = lead.services[index % lead.services.length]!;
    const asset = item.network === 'ethereum' ? 'ETH' : item.network === 'tron' ? 'USDT' : 'BTC';
    const rate = asset === 'ETH' ? 10400 : asset === 'USDT' ? 3.8 : 395000;
    const cashOuts = Object.entries(lead.cashOutPlnByYear).map(([year, value]) => {
      const txid = fakeHash(`${item.address}|${year}`);
      const valuePln = Math.round(value / lead.addresses.length);
      return {
        kind: 'exchange_deposit' as const,
        txid,
        time: `${year}-06-15T10:00:00Z`,
        asset,
        amount: Math.round((valuePln / rate) * 1e4) / 1e4,
        counterparty: `${item.network === 'tron' ? 'T' : item.network === 'ethereum' ? '0x' : 'bc1q'}${fakeHash('kryptogielda').slice(0, 30)}`,
        counterpartyLabel: 'KryptoGiełda: adres depozytowy',
        valuePln,
        valuation: `kurs demonstracyjny ${rate} PLN`,
        explanation: 'Środki wysłano na adres depozytowy giełdy.',
        explorerUrl: `http://localhost:4100/explorer/tx/${txid}`,
      };
    });
    return {
      address: item.address,
      network: item.network,
      checksumVerified: true,
      unrelatedPublishers: 0,
      evidence: [
        {
          id: `ev-${lead.id}-${index}`,
          category: item.score >= 85 ? 'own_profile' : item.score >= 60 ? 'sale_offer' : 'forum_post',
          service,
          url: `https://${service}/u/${lead.handle}/wpis/${index + 1}`,
          capturedAt: now,
          identityMatch: item.score === 60 ? 'same_handle' : 'exact_identifier',
          identityReasons: ['Publikacja wskazana przez przegląd źródeł; autor zgodny z nazwą konta.'],
          title: `Publikacja użytkownika ${lead.handle}`,
          author: lead.handle,
          publishedAt: '2026-11-10T12:00:00Z',
          excerpt: `Rozliczenie na adres ${item.address}.`,
          contentHash: fakeHash(`${lead.id}|${index}`),
          connectorId: 'sandbox-bazarek',
          matchedIdentifier: identifiers[0]!,
        },
      ],
      chain: {
        profile: {
          address: item.address,
          network: item.network,
          addressClass: 'private',
          classificationSource: 'Zbiór etykiet środowiska demonstracyjnego',
          isContract: false,
          txCount: cashOuts.length,
          totalReceived: 0,
          totalSent: 0,
          balance: 0,
          nativeAsset: asset,
        },
        transfers: cashOuts.map((cashOut) => ({
          txid: cashOut.txid,
          time: cashOut.time,
          direction: 'out' as const,
          counterparty: cashOut.counterparty,
          counterpartyClass: 'exchange' as const,
          counterpartyLabel: cashOut.counterpartyLabel,
          asset,
          amount: cashOut.amount,
          explorerUrl: cashOut.explorerUrl,
        })),
        cashOuts,
        cashOutPlnByYear: Object.fromEntries(cashOuts.map((cashOut) => [cashOut.time.slice(0, 4), cashOut.valuePln])),
        limitations: ['Dane uproszczone trybu demo — wygenerowane ze wskazania przeglądu źródeł.'],
      },
    };
  });
  sequence += 1;
  return {
    id: `demo-analiza-nowa-${sequence}`,
    caseId,
    startedAt: now,
    finishedAt: now,
    status: 'completed',
    query: { identifiers },
    connectors: demoConnectors.filter((item) => item.enabledByDefault).map((item) => item.id),
    findings,
    log: [{ time: now, message: `Analiza podmiotu wytypowanego w przeglądzie źródeł: ${lead.handle}.` }],
  };
}

// ---------- Monitoring ----------

const monitor = { enabled: true, everyMinutes: 30, autoAnalyzeThreshold: 150, lastRunAt: '2026-11-20T08:30:00Z', running: false };
const monitorSources = demoMonitorSources.map((source) => ({ ...source }));

/** Wynik analizy autora trafienia w postaci wskazania — tak jak w przeglądzie źródeł. */
function leadFromHit(hit: WatchHit, spec: [number, Record<string, number>]): Lead {
  const [topScore, cashOutPlnByYear] = spec;
  const { priority, reasons } = computePriority(topScore, cashOutPlnByYear, NOW);
  return {
    id: `lead-${hit.id}`,
    handle: hit.author ?? hit.service,
    services: [hit.service],
    profileUrls: [hit.url],
    addresses: hit.addresses.map((item) => ({ ...item, score: topScore })),
    topScore,
    cashOutPlnByYear,
    cashOutPlnTotal: sum(Object.values(cashOutPlnByYear)),
    priority,
    priorityReasons: reasons,
  };
}

const hits: WatchHit[] = demoHits.map(({ leadSpec, ...hit }) => ({
  ...hit,
  ...(leadSpec ? { lead: leadFromHit(hit, leadSpec) } : {}),
  ...(hit.author === 'tomwzor' ? { knownFromCases: [{ address: ADDR_FORUM, caseId: DEMO_CASE_ID, caseName: demoCase.name }] } : {}),
}));

function findHit(hitId: string): WatchHit {
  const found = hits.find((item) => item.id === hitId);
  if (!found) throw notFound('trafienie');
  return found;
}

function monitorStatus(): MonitorStatus {
  const next = new Date(Date.parse(monitor.lastRunAt) + monitor.everyMinutes * 60_000).toISOString();
  return {
    ...monitor,
    nextRunAt: monitor.enabled ? next : undefined,
    sources: monitorSources,
    totals: {
      documentsSeen: sum(monitorSources.map((source) => source.documentsSeen)),
      hits: sum(monitorSources.map((source) => source.hits)),
      analyzed: hits.filter((hit) => hit.status === 'analyzed').length,
      newHits: hits.filter((hit) => hit.status === 'new').length,
    },
  };
}

/** Analiza autora w trybie demo: wynik zależy od ocen trafienia, żeby był powtarzalny. */
function analyzeHit(hit: WatchHit): WatchHit {
  if (!hit.lead) {
    const topScore = hit.suspicion.score >= 60 ? 70 : 50;
    const scale = Math.round((hit.suspicion.score * hit.polishNexus.score) / 10) * 100;
    hit.lead = leadFromHit(hit, [topScore, scale > 0 ? { '2026': scale } : {}]);
  }
  hit.status = 'analyzed';
  return hit;
}

const DEMO_VALUES = ['tomwzor', 'tomasz wzorcowy', 'tomasz.wzorcowy@poczta.example', 't-wzorcowy', ADDR_MAIN, ADDR_FORUM, ADDR_TRON, ADDR_NAMESAKE].map(
  (value) => value.toLowerCase(),
);

export const demoBackend: Backend = {
  listConnectors: async () => demoConnectors,
  getRules: async () => DEFAULT_RULES,
  getPriorityRules: async () => demoPriorityRules,
  listCases: async () => cases.map(summarizeCase),
  getCase: async (caseId) => summarizeCase(findCase(caseId)),
  getRun: async (runId) => {
    const run = findRun(runId);
    return scoreRun(run, decisionsOf(run.caseId));
  },
  getReplacements: async (runId) => replacementsFor(findRun(runId)),
  getDiff: async (caseId, from, to) => {
    const applied = decisionsOf(findCase(caseId).id);
    return diffRuns(scoreRun(findRun(from), applied), scoreRun(findRun(to), applied));
  },

  createCase: async (name, identifiers) => {
    sequence += 1;
    const created: StoredCase = {
      id: `demo-sprawa-nowa-${sequence}`,
      name,
      createdAt: new Date().toISOString(),
      query: { identifiers },
    };
    cases.unshift(created);
    return summarizeCase(created);
  },

  addIdentifiers: async (caseId, identifiers) => {
    const stored = findCase(caseId);
    const known = new Set(stored.query.identifiers.map((item) => `${item.type}|${item.value}`));
    stored.query = { identifiers: [...stored.query.identifiers, ...identifiers.filter((item) => !known.has(`${item.type}|${item.value}`))] };
    return summarizeCase(stored);
  },

  // Sprawa demonstracyjna powtarza ostatni wynik; nowe sprawy nie mają danych.
  startRun: async (caseId, connectors, options = {}) => {
    const depth = options.depth ?? 'standard';
    const stored = findCase(caseId);
    sequence += 1;
    const now = new Date().toISOString();
    const used = connectors ?? demoConnectors.filter((item) => item.enabledByDefault).map((item) => item.id);
    const template = latestRun(caseId) ?? (caseId === DEMO_CASE_ID ? findRun(DEMO_RUN_2) : undefined);
    const run: RawRun = {
      id: `demo-analiza-nowa-${sequence}`,
      caseId,
      startedAt: now,
      finishedAt: now,
      status: 'completed',
      query: stored.query,
      connectors: used,
      findings: template?.findings ?? [],
      log: template?.log ?? [
        { time: now, message: `Start analizy. Źródła: ${used.join(', ') || 'brak'}.` },
        { time: now, message: 'Tryb demo: dla nowych spraw nie ma danych przykładowych — nie znaleziono adresów.' },
      ],
    };
    runs.push(run);
    startDemoProgress(run.id, depth);
    return { id: run.id, status: 'running' };
  },
  getProgress: async (runId) => demoProgress(runId),
  getAi: async () => demoAi,
  getCorpusStats: async () => demoCorpus,

  getCaseDossier: async (caseId) => {
    const run = latestRun(findCase(caseId).id);
    if (!run) throw notFound('zakończona analiza sprawy');
    return buildDossier(run);
  },
  getRunDossier: async (runId) => buildDossier(findRun(runId)),

  addDecision: async (caseId, input) => {
    findCase(caseId);
    sequence += 1;
    const now = new Date().toISOString();
    const created: DecisionRecord = { id: `demo-decyzja-${sequence}`, caseId, ...input, target: input.target as AnalystDecision['target'], decidedAt: now, author: 'analityk (demo)' };
    // Nowa decyzja zastępuje wcześniejszą dla tego samego obiektu: poprzednia zostaje w historii jako wycofana.
    for (const item of decisions) {
      if (item.caseId === caseId && item.target === input.target && item.key === input.key && !item.withdrawnAt) {
        item.withdrawnAt = now;
        item.withdrawnBy = 'analityk (demo) — zastąpiona nową decyzją';
      }
    }
    decisions.push(created);
    return created;
  },
  removeDecision: async (caseId, decisionId) => {
    // Wycofanie miękkie: decyzja zostaje w historii zmian i przestaje wpływać na wynik.
    const found = decisions.find((item) => item.caseId === caseId && item.id === decisionId);
    if (!found) throw notFound('decyzja');
    if (!found.withdrawnAt) {
      found.withdrawnAt = new Date().toISOString();
      found.withdrawnBy = 'analityk (demo)';
    }
  },

  getOverview: async (): Promise<Overview> => {
    const dossiers = cases.flatMap((item) => {
      const run = latestRun(item.id);
      return run ? [{ item, dossier: buildDossier(run) }] : [];
    });
    const cashOutPlnByYear: Record<string, number> = {};
    for (const { dossier } of dossiers) {
      for (const [year, value] of Object.entries(dossier.totals.cashOutPlnByYear)) {
        cashOutPlnByYear[year] = (cashOutPlnByYear[year] ?? 0) + value;
      }
    }
    return {
      cases: cases.length,
      runs: runs.length,
      linkedAddresses: sum(dossiers.map(({ dossier }) => dossier.totals.linkedAddresses)),
      cashOutPlnByYear,
      topCases: dossiers
        .map(({ item, dossier }) => ({
          caseId: item.id,
          name: item.name,
          priority: dossier.totals.priority,
          topScore: dossier.totals.topScore,
          cashOutPlnTotal: sum(Object.values(dossier.totals.cashOutPlnByYear)),
          services: dossier.serviceLinks.map((link) => link.name),
        }))
        .sort((a, b) => b.priority - a.priority),
      monitor: { enabled: monitor.enabled, lastRunAt: monitor.lastRunAt, newHits: hits.filter((hit) => hit.status === 'new').length },
    };
  },

  startSweep: async (connectors, limit) => {
    await wait(1600);
    const sweep = buildSweep(connectors, limit, new Date().toISOString());
    sweeps.unshift(sweep);
    return sweep;
  },
  listSweeps: async () => sweeps.map((sweep) => ({ ...sweep, log: [] })),
  getSweep: async (sweepId) => {
    const found = sweeps.find((item) => item.id === sweepId);
    if (!found) throw notFound('przegląd źródeł');
    return found;
  },
  createCaseFromLead: async (sweepId, leadId) => {
    const lead = sweeps.find((item) => item.id === sweepId)?.leads.find((item) => item.id === leadId);
    if (!lead) throw notFound('wskazanie');
    if (lead.caseId) return summarizeCase(findCase(lead.caseId));
    const identifiers: Identifier[] = [
      { type: 'nick', value: lead.handle },
      ...lead.profileUrls.map((value): Identifier => ({ type: 'profile_url', value })),
    ];
    const created: StoredCase = {
      id: `demo-sprawa-${lead.id}`,
      name: `${lead.handle} — wskazanie z przeglądu źródeł`,
      createdAt: new Date().toISOString(),
      query: { identifiers },
    };
    cases.unshift(created);
    runs.push(runFromLead(lead, created.id, identifiers));
    for (const sweep of sweeps) {
      for (const item of sweep.leads) if (item.id === leadId) item.caseId = created.id;
    }
    return summarizeCase(created);
  },

  getMonitor: async () => monitorStatus(),
  updateMonitor: async (settings) => {
    const { sources, ...rest } = settings;
    Object.assign(monitor, rest);
    for (const source of monitorSources) {
      if (sources?.[source.connectorId] !== undefined) source.enabled = sources[source.connectorId]!;
    }
    return monitorStatus();
  },
  runMonitor: async () => {
    await wait(1800);
    const now = new Date().toISOString();
    monitor.lastRunAt = now;
    for (const source of monitorSources) {
      if (!source.enabled) continue;
      source.lastRunAt = now;
      source.documentsSeen += 12;
    }
    // Trafienia powyżej progu są analizowane automatycznie.
    for (const hit of hits) {
      if (hit.status === 'new' && hit.polishNexus.score + hit.suspicion.score >= monitor.autoAnalyzeThreshold) analyzeHit(hit);
    }
    return { status: monitorStatus(), newHits: 0 };
  },
  recheckMonitor: async () => {
    // Dane demo powstały według bieżących reguł — przeliczenie niczego nie odrzuca.
    const kept = hits.filter((hit) => hit.status !== 'dismissed').length;
    return { checked: hits.length, kept, dismissed: 0, status: monitorStatus() };
  },
  listHits: async (limit) => hits.slice(0, limit),
  analyzeHit: async (hitId) => {
    await wait(900);
    return analyzeHit(findHit(hitId));
  },
  dismissHit: async (hitId) => {
    const hit = findHit(hitId);
    hit.status = 'dismissed';
    return hit;
  },
  createCaseFromHit: async (hitId) => {
    const hit = analyzeHit(findHit(hitId));
    if (hit.caseId) return summarizeCase(findCase(hit.caseId));
    const identifiers: Identifier[] = [
      ...(hit.author ? [{ type: 'nick' as const, value: hit.author.replace(/^@/, '') }] : []),
      { type: 'profile_url', value: hit.url },
    ];
    const created: StoredCase = {
      id: `demo-sprawa-${hit.id}`,
      name: `${hit.author ?? hit.service} — trafienie monitoringu`,
      createdAt: new Date().toISOString(),
      query: { identifiers },
    };
    cases.unshift(created);
    runs.push(runFromLead(hit.lead!, created.id, identifiers));
    hit.caseId = created.id;
    return summarizeCase(created);
  },

  // Znane identyfikatory prowadzą do sprawy demonstracyjnej; pozostałe idą zwykłą ścieżką.
  quick: async (value, _type, options = {}) => {
    const wanted = value.trim().toLowerCase();
    const target = wanted === ADDRESS_CASE_ADDR ? demoAddressCase : wanted === 'kryptogielda' ? demoServiceCase : DEMO_VALUES.includes(wanted) ? demoCase : undefined;
    if (!target) return null;
    sequence += 1;
    const id = `demo-postep-${sequence}`;
    startDemoProgress(id, options.depth ?? 'standard');
    return { case: summarizeCase(target), run: { id, status: 'running' } };
  },
  hasServiceRequest: async () => false,
};
