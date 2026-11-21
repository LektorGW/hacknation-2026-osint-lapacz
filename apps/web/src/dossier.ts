// Teczka podmiotu budowana po stronie interfejsu z samej analizy (`AnalysisRun`).
// Używana, gdy usługa analizy nie ma jeszcze trasy `/dossier`, oraz jako podstawa trybu demo.
import type {
  AnalysisRun,
  AnalystDecision,
  CashOutIndicator,
  CashOutKind,
  Dossier,
  Finding,
  GraphEdge,
  GraphNode,
  Identifier,
  IdentityMatch,
  Network,
  PersonCandidate,
  ProfileCard,
  RunDiff,
  TimelineEvent,
} from '@olcys/core';
import { fmtAmount, fmtPln, shorten, sum, truncate, yearOf } from './format.ts';
import { CASH_OUT_KINDS, CASH_OUT_LABEL, CLASS_LABEL, IDENTIFIER_LABEL, NETWORK_LABEL } from './labels.ts';
import { serviceLinksFromFindings } from './services.ts';

/** Pewność 0–100, że profil należy do podmiotu, dla każdego poziomu oceny tożsamości. */
export const IDENTITY_SCORE: Record<IdentityMatch, number> = {
  verified_link: 100,
  exact_identifier: 90,
  linked_profile: 80,
  same_handle: 55,
  common_handle: 30,
  name_only: 25,
};

/**
 * Identyfikator profilu i zarazem klucz decyzji analityka: `serwis|konto` małymi literami,
 * a bez nazwy konta — adres URL (tak samo nadaje go usługa analizy).
 */
export const profileKey = (profile: { service: string; handle?: string; url: string }) =>
  profile.handle ? `${profile.service}|${profile.handle}`.toLowerCase() : profile.url;

export const addressKey = (item: { network: Network; address: string }) => `${item.network}:${item.address}`;

const sameIdentifier = (a: Identifier, b: Identifier) =>
  a.type === b.type && a.value.toLowerCase() === b.value.toLowerCase();

const unique = <T,>(values: T[]) => [...new Set(values)];

/** Profile wynikające ze śladów: jeden profil to jeden autor w jednym serwisie. */
export function profilesFromFindings(findings: Finding[], decisions: AnalystDecision[] = []): ProfileCard[] {
  const profiles = new Map<string, ProfileCard>();
  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      const key = profileKey({ service: evidence.service, handle: evidence.author, url: evidence.url });
      const score = IDENTITY_SCORE[evidence.identityMatch] ?? 0;
      const card: ProfileCard = profiles.get(key) ?? {
        id: key,
        service: evidence.service,
        url: evidence.url,
        handle: evidence.author,
        attributes: { handle: evidence.author },
        identityMatch: evidence.identityMatch,
        identityReasons: [],
        identityScore: score,
        addresses: [],
        evidenceIds: [],
      };
      profiles.set(key, card);
      if (score > card.identityScore) {
        card.identityScore = score;
        card.identityMatch = evidence.identityMatch;
      }
      // Najkrótszy adres to zwykle strona profilu, a nie pojedynczy wpis.
      if (evidence.url.length < card.url.length) card.url = evidence.url;
      card.identityReasons = unique([...card.identityReasons, ...(evidence.identityReasons ?? [])]);
      card.addresses = unique([...card.addresses, addressKey(finding)]);
      card.evidenceIds = unique([...card.evidenceIds, evidence.id]);
    }
  }
  return [...profiles.entries()].map(([key, card]) => {
    const decision = decisions.filter((item) => item.target === 'profile' && item.key === key).at(-1)?.decision;
    if (decision !== 'confirmed') return { ...card, decision };
    return {
      ...card,
      decision,
      identityMatch: 'verified_link',
      identityScore: IDENTITY_SCORE.verified_link,
      identityReasons: [...card.identityReasons, 'Profil potwierdzony decyzją analityka.'],
    };
  });
}

/** Priorytet sprawy 0–100: pewność najlepszego adresu, skala szacowanych wypłat i ich aktualność. */
export function computePriority(
  topScore: number,
  cashOutPlnByYear: Record<string, number>,
  now: Date = new Date(),
): { priority: number; reasons: string[] } {
  if (topScore <= 0) {
    return { priority: 0, reasons: ['Brak adresu powiązanego z podmiotem — priorytet zerowy.'] };
  }
  const total = sum(Object.values(cashOutPlnByYear));
  const scale = Math.min(100, Math.round(Math.sqrt(total / 500_000) * 100));
  const lastYear = Math.max(0, ...Object.entries(cashOutPlnByYear).filter(([, value]) => value > 0).map(([year]) => Number(year)));
  const age = now.getUTCFullYear() - lastYear;
  const recency = lastYear === 0 ? 0 : age <= 0 ? 100 : age === 1 ? 70 : age === 2 ? 40 : 15;
  return {
    priority: Math.round(topScore * 0.5 + scale * 0.35 + recency * 0.15),
    reasons: [
      `Najwyższy Wskaźnik Pewności: ${topScore}% (waga 50%).`,
      total > 0
        ? `Szacowane wypłaty łącznie ${fmtPln(total)} — skala ${scale}/100 (waga 35%; 100 odpowiada 500 tys. zł).`
        : 'Nie wykryto oznak wypłat na waluty tradycyjne — składnik skali równy 0 (waga 35%).',
      lastYear > 0
        ? `Ostatnie oznaki wypłat w roku ${lastYear} — aktualność ${recency}/100 (waga 15%).`
        : 'Brak dat wypłat — składnik aktualności równy 0 (waga 15%).',
    ],
  };
}

const NAME = /^\p{Lu}[\p{L}'’-]+(\s+\p{Lu}[\p{L}'’.-]+)+$/u;

/** Uproszczone ustalenie osoby: jeden kandydat złożony ze wszystkich nieodrzuconych profili. */
function singleCandidate(query: Identifier[], profiles: ProfileCard[], findings: Finding[]): PersonCandidate[] {
  const kept = profiles.filter((profile) => profile.decision !== 'rejected');
  const linked = findings.filter((finding) => !finding.confidence.excluded);
  if (kept.length === 0 && linked.length === 0) return [];
  const names = unique([
    ...query.filter((item) => item.type === 'full_name').map((item) => item.value),
    ...kept.flatMap((profile) => (profile.handle && NAME.test(profile.handle) ? [profile.handle] : [])),
  ]);
  const probability = Math.max(0, ...linked.map((finding) => finding.confidence.score));
  const sourcesOf = (identifier: Identifier) =>
    unique(
      findings.flatMap((finding) =>
        finding.evidence.filter((item) => sameIdentifier(item.matchedIdentifier, identifier)).map((item) => item.service),
      ),
    );
  const attributes: PersonCandidate['attributes'] = [
    ...query
      .filter((item) => item.type === 'email')
      .map((item) => ({ kind: 'email' as const, value: item.value, sources: sourcesOf(item) })),
    ...unique(kept.flatMap((profile) => (profile.handle && !NAME.test(profile.handle) ? [profile.handle] : []))).map(
      (handle) => ({
        kind: 'handle' as const,
        value: handle,
        sources: kept.filter((profile) => profile.handle === handle).map((profile) => profile.service),
      }),
    ),
  ];
  return [
    {
      id: 'osoba-1',
      fullName: names[0],
      nameVariants: names.slice(1),
      probability,
      reasons: [
        'Ustalenie uproszczone, wyliczone w interfejsie: wszystkie odnalezione profile potraktowano jako jedną osobę.',
        `Prawdopodobieństwo przyjęto równe najwyższemu Wskaźnikowi Pewności adresu (${probability}%).`,
      ],
      attributes,
      profileIds: kept.map((profile) => profile.id),
      addresses: linked.map((finding) => ({ key: addressKey(finding), probability: finding.confidence.score })),
    },
  ];
}

export interface DossierInfo {
  name: string;
  replacements?: RunDiff['replacedAddresses'];
  decisions?: AnalystDecision[];
  /** Analiza sprzed zastosowania decyzji — z niej pochodzą profile odrzucone przez analityka. */
  original?: AnalysisRun;
  now?: Date;
}

const subjectNode = 'podmiot';
const identifierNode = (identifier: Identifier) => `id:${identifier.type}:${identifier.value}`;
const addressNode = (finding: { network: Network; address: string }) => `adres:${addressKey(finding)}`;
/** Najwyżej tylu kontrahentów trafia do grafu; reszta jest dostępna na kartach adresów. */
const MAX_COUNTERPARTIES = 30;

export function dossierFromRun(run: AnalysisRun, info: DossierInfo): Dossier {
  const decisions = info.decisions ?? [];
  const profiles = profilesFromFindings((info.original ?? run).findings, decisions);
  const linked = run.findings.filter((finding) => !finding.confidence.excluded);
  const excluded = run.findings.filter((finding) => finding.confidence.excluded);
  const allEvidence = run.findings.flatMap((finding) => finding.evidence);

  // ---------- Podmiot ----------
  const discovered: Identifier[] = [];
  for (const { matchedIdentifier } of allEvidence) {
    const known = [...run.query.identifiers, ...discovered].some((item) => sameIdentifier(item, matchedIdentifier));
    if (!known) discovered.push(matchedIdentifier);
  }
  const identifiers: Dossier['subject']['identifiers'] = [
    ...run.query.identifiers.map((identifier) => ({ identifier, origin: 'analyst' as const })),
    ...discovered.map((identifier) => ({ identifier, origin: 'discovered' as const })),
  ];
  const persons = singleCandidate(run.query.identifiers, profiles, run.findings);

  // ---------- Graf ----------
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addEdge = (edge: Omit<GraphEdge, 'id'>) => {
    const id = `${edge.kind}:${edge.from}>${edge.to}`;
    if (!edges.has(id)) edges.set(id, { id, ...edge });
  };
  nodes.set(subjectNode, { id: subjectNode, kind: 'subject', label: info.name, sublabel: 'badany podmiot' });
  for (const { identifier, origin } of identifiers) {
    const id = identifierNode(identifier);
    nodes.set(id, {
      id,
      kind: 'identifier',
      label: identifier.value,
      sublabel: `${IDENTIFIER_LABEL[identifier.type] ?? identifier.type}${origin === 'discovered' ? ' · odkryty' : ''}`,
    });
    addEdge({ from: subjectNode, to: id, kind: 'has_identifier', inferred: origin === 'discovered' });
  }
  for (const profile of profiles) {
    nodes.set(profile.id, {
      id: profile.id,
      kind: 'profile',
      label: profile.handle ?? profile.service,
      sublabel: profile.service,
      score: profile.identityScore,
      excluded: profile.decision === 'rejected',
      url: profile.url,
    });
  }
  for (const finding of (info.original ?? run).findings) {
    for (const evidence of finding.evidence) {
      const profile = profiles.find((item) => item.evidenceIds.includes(evidence.id));
      if (profile) {
        addEdge({
          from: identifierNode(evidence.matchedIdentifier),
          to: profile.id,
          kind: 'found_profile',
          weight: profile.identityScore,
        });
      }
    }
  }
  const valuedTotals = linked.flatMap((finding) => (finding.chain?.cashOuts ?? []).map((item) => item.valuePln ?? 0));
  const maxValue = Math.max(1, ...valuedTotals);
  const counterparties = new Set<string>();
  for (const finding of run.findings) {
    const id = addressNode(finding);
    const { score, excluded: isExcluded } = finding.confidence;
    nodes.set(id, {
      id,
      kind: 'address',
      label: shorten(finding.address),
      sublabel: `${NETWORK_LABEL[finding.network] ?? finding.network}${isExcluded ? ' · wykluczony' : ''}`,
      score,
      excluded: isExcluded,
    });
    for (const evidence of finding.evidence) {
      const profile = profiles.find((item) => item.evidenceIds.includes(evidence.id));
      if (profile) addEdge({ from: profile.id, to: id, kind: 'publishes', weight: score });
    }
  }
  for (const finding of linked) {
    const cashOuts = new Map((finding.chain?.cashOuts ?? []).map((item) => [item.txid, item]));
    const groups = new Map<string, { count: number; total: number; asset: string; pln: number; label?: string; cls: string; cash: boolean; out: boolean }>();
    for (const transfer of finding.chain?.transfers ?? []) {
      const cashOut = cashOuts.get(transfer.txid);
      const key = `${transfer.counterparty}|${transfer.direction}`;
      const group = groups.get(key) ?? {
        count: 0,
        total: 0,
        asset: transfer.asset,
        pln: 0,
        label: transfer.counterpartyLabel,
        cls: CLASS_LABEL[transfer.counterpartyClass] ?? transfer.counterpartyClass,
        cash: false,
        out: transfer.direction === 'out',
      };
      groups.set(key, group);
      group.count += 1;
      group.total += transfer.amount;
      group.pln += cashOut?.valuePln ?? 0;
      group.cash ||= cashOut !== undefined;
    }
    for (const [key, group] of groups) {
      const counterparty = key.split('|')[0]!;
      const known = run.findings.find((item) => item.address === counterparty);
      // Kontrahent będący adresem z wyników (np. portfel giełdy) nie dostaje osobnego węzła.
      const target = known ? addressNode(known) : `kontrahent:${counterparty}`;
      if (!known) {
        if (!counterparties.has(counterparty) && counterparties.size >= MAX_COUNTERPARTIES) continue;
        counterparties.add(counterparty);
        nodes.set(target, {
          id: target,
          kind: 'service',
          label: group.label ?? shorten(counterparty),
          sublabel: group.cls,
        });
      }
      const own = addressNode(finding);
      addEdge({
        from: group.out ? own : target,
        to: group.out ? target : own,
        kind: group.cash ? 'cash_out' : 'transfer',
        label: `${group.count} × · ${fmtAmount(group.total, group.asset)}${group.pln > 0 ? ` · ${fmtPln(group.pln)}` : ''}`,
        weight: group.cash ? Math.round((group.pln / maxValue) * 100) : Math.min(100, group.count * 20),
        inferred: group.cash,
      });
    }
  }

  // ---------- Oś czasu ----------
  const timeline: TimelineEvent[] = [];
  const seen = new Set<string>();
  for (const finding of run.findings) {
    for (const evidence of finding.evidence) {
      if (!evidence.publishedAt || seen.has(`${evidence.id}|${finding.address}`)) continue;
      seen.add(`${evidence.id}|${finding.address}`);
      timeline.push({
        time: evidence.publishedAt,
        kind: 'publication',
        title: `Publikacja adresu: ${truncate(evidence.title || evidence.url, 90)}`,
        detail: `${evidence.service}${evidence.author ? ` · autor: ${evidence.author}` : ''}`,
        address: finding.address,
        url: evidence.url,
        layer: 'fact',
      });
    }
  }
  for (const finding of linked) {
    const cashOuts = new Map((finding.chain?.cashOuts ?? []).map((item) => [item.txid, item]));
    for (const transfer of finding.chain?.transfers ?? []) {
      const cashOut = cashOuts.get(transfer.txid);
      const who = transfer.counterpartyLabel ?? shorten(transfer.counterparty);
      timeline.push(
        cashOut
          ? {
              time: transfer.time,
              kind: 'cash_out',
              title: `${CASH_OUT_LABEL[cashOut.kind] ?? cashOut.kind}: ${fmtAmount(cashOut.amount, cashOut.asset)} → ${who}`,
              detail: cashOut.explanation,
              address: finding.address,
              valuePln: cashOut.valuePln,
              url: transfer.explorerUrl,
              layer: 'inference',
            }
          : {
              time: transfer.time,
              kind: transfer.direction === 'in' ? 'transfer_in' : 'transfer_out',
              title: `${fmtAmount(transfer.amount, transfer.asset)} ${transfer.direction === 'in' ? 'od' : 'do'} ${who}`,
              detail: CLASS_LABEL[transfer.counterpartyClass] ?? transfer.counterpartyClass,
              address: finding.address,
              url: transfer.explorerUrl,
              layer: 'fact',
            },
      );
    }
  }
  for (const item of info.replacements ?? []) {
    timeline.push({
      time: (item as { observedAt?: string }).observedAt ?? run.startedAt,
      kind: 'address_replaced',
      title: `Podmiana adresu: ${shorten(item.from)} → ${shorten(item.to)}`,
      detail: 'W tym samym miejscu publikacji adres został zastąpiony innym.',
      address: item.to,
      url: item.url,
      layer: 'fact',
    });
  }
  timeline.sort((a, b) => a.time.localeCompare(b.time));

  // ---------- Sumy i kluczowe ustalenia ----------
  const cashOutPlnByYear: Record<string, number> = {};
  for (const finding of linked) {
    for (const [year, value] of Object.entries(finding.chain?.cashOutPlnByYear ?? {})) {
      cashOutPlnByYear[year] = (cashOutPlnByYear[year] ?? 0) + value;
    }
  }
  const topScore = Math.max(0, ...linked.map((finding) => finding.confidence.score));
  const { priority, reasons } = computePriority(topScore, cashOutPlnByYear, info.now);
  const best = linked.find((finding) => finding.confidence.score === topScore);
  const total = sum(Object.values(cashOutPlnByYear));
  const serviceLinks = serviceLinksFromFindings(run.findings);
  const uncertain = profiles.filter((profile) => !profile.decision && profile.identityScore < 60);

  const keyFindings: Dossier['keyFindings'] = [];
  if (run.findings.length > 0) {
    keyFindings.push({
      layer: 'fact',
      text: `W ${unique(allEvidence.map((item) => item.service)).length} serwisach znaleziono ${run.findings.length} adresów w sieciach: ${unique(run.findings.map((finding) => NETWORK_LABEL[finding.network] ?? finding.network)).join(', ')}.`,
    });
  }
  if (best) {
    keyFindings.push({
      layer: 'calculation',
      text: `Najwyższy Wskaźnik Pewności: ${topScore}% (${best.confidence.tier}) dla adresu ${shorten(best.address)}.`,
    });
  }
  if (total > 0) {
    const [topYear, topValue] = Object.entries(cashOutPlnByYear).sort(([, a], [, b]) => b - a)[0]!;
    keyFindings.push({
      layer: 'inference',
      text: `Szacowane wypłaty na waluty tradycyjne: ${fmtPln(total)} łącznie, najwięcej w roku ${topYear} (${fmtPln(topValue)}).`,
    });
  }
  if (serviceLinks.length > 0) {
    keyFindings.push({
      layer: 'fact',
      text: `Przelewy łączą adresy podmiotu z usługami: ${serviceLinks.slice(0, 4).map((link) => link.name).join(', ')}${serviceLinks.length > 4 ? ` i ${serviceLinks.length - 4} innymi` : ''}.`,
    });
  }
  if (excluded.length > 0) {
    keyFindings.push({
      layer: 'calculation',
      text: `Wykluczono ${excluded.length} adresów, których nie przypisuje się podmiotowi (np. giełda, smart kontrakt).`,
    });
  }
  if ((info.replacements ?? []).length > 0) {
    keyFindings.push({ layer: 'fact', text: `Wykryto podmiany adresu w tym samym miejscu publikacji: ${info.replacements!.length}.` });
  }
  if (uncertain.length > 0) {
    keyFindings.push({
      layer: 'inference',
      text: `Profile o niepewnej tożsamości (${uncertain.length}): ${uncertain.map((profile) => profile.service).join(', ')} — mogą należeć do innej osoby.`,
    });
  }

  return {
    caseId: run.caseId,
    runId: run.id,
    generatedAt: (info.now ?? new Date()).toISOString(),
    subject: {
      name: info.name,
      knownNames: unique(persons.flatMap((person) => [...(person.fullName ? [person.fullName] : []), ...person.nameVariants])),
      identifiers,
    },
    persons,
    profiles,
    findings: run.findings,
    relatedPersons: [],
    serviceLinks,
    graph: { nodes: [...nodes.values()], edges: [...edges.values()] },
    timeline,
    totals: {
      linkedAddresses: linked.length,
      excludedAddresses: excluded.length,
      topScore,
      cashOutPlnByYear,
      priority,
      priorityReasons: reasons,
    },
    decisions,
    keyFindings,
  };
}

// ---------- Widoki pochodne teczki ----------

/** Łączne prawdopodobieństwo osoba–adres dla głównego kandydata; brak, gdy adresu mu nie przypisano. */
export function jointProbability(dossier: Dossier, finding: { network: Network; address: string }): number | undefined {
  return dossier.persons?.[0]?.addresses.find((item) => item.key === addressKey(finding))?.probability;
}

export interface CashOutRow extends CashOutIndicator {
  address: string;
  network: Network;
}

/** Wszystkie wskaźniki wypłat z adresów nieodrzuconych. */
export function cashOutRows(findings: Finding[]): CashOutRow[] {
  return findings
    .filter((finding) => !finding.confidence.excluded)
    .flatMap((finding) =>
      (finding.chain?.cashOuts ?? []).map((item) => ({ ...item, address: finding.address, network: finding.network })),
    );
}

export interface YearSeries {
  years: string[];
  series: { kind: CashOutKind; label: string; values: number[] }[];
}

/** Wypłaty w PLN na lata podatkowe w podziale na rodzaje — dane wykresu słupkowego. */
export function cashOutSeries(rows: CashOutRow[]): YearSeries {
  const valued = rows.filter((row) => row.valuePln !== undefined);
  const years = unique(valued.map((row) => yearOf(row.time))).sort();
  const series = CASH_OUT_KINDS.map((kind) => ({
    kind,
    label: CASH_OUT_LABEL[kind],
    values: years.map((year) =>
      sum(valued.filter((row) => row.kind === kind && yearOf(row.time) === year).map((row) => row.valuePln!)),
    ),
  })).filter((item) => item.values.some((value) => value > 0));
  return { years, series };
}

/** Dane diagramu przepływu: adres podmiotu → kontrahent → rok podatkowy. */
export function cashOutFlows(rows: CashOutRow[]) {
  const nodes = new Map<string, { id: string; column: number; label: string }>();
  const links = new Map<string, { source: string; target: string; value: number }>();
  const add = (source: string, target: string, value: number) => {
    const key = `${source}>${target}`;
    const link = links.get(key) ?? { source, target, value: 0 };
    link.value += value;
    links.set(key, link);
  };
  for (const row of rows) {
    if (row.valuePln === undefined) continue;
    const address = `a:${row.address}`;
    const counterparty = `k:${row.counterpartyLabel ?? row.counterparty}`;
    const year = `r:${yearOf(row.time)}`;
    nodes.set(address, { id: address, column: 0, label: shorten(row.address) });
    nodes.set(counterparty, { id: counterparty, column: 1, label: row.counterpartyLabel ?? shorten(row.counterparty) });
    nodes.set(year, { id: year, column: 2, label: `rok ${yearOf(row.time)}` });
    add(address, counterparty, row.valuePln);
    add(counterparty, year, row.valuePln);
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}
