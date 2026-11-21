// Eksport danych sprawy: tabele CSV do otwarcia w Excelu i teczka JSON z nagłówkiem metadanych.
// Czysta logika bez DOM i bez zależności od przeglądarki: ten sam moduł składa pliki w usłudze analizy
// (apps/api/src/export.ts importuje go wprost) i w przeglądarce w trybie demo, więc kolumny są wszędzie
// identyczne. Wolno tu importować wyłącznie typy i moduły bez efektów ubocznych (labels.ts).
//
// Format CSV: UTF-8 z BOM, separator „;” (domyślny w polskim Excelu), przecinek dziesiętny, CRLF,
// daty jako „RRRR-MM-DD GG:MM:SS” (UTC). Komórki tekstowe zaczynające się od = + - @ tabulatora albo CR
// dostają apostrof na początku — arkusz nie wykona ich jako formuły (ochrona przed „CSV injection”).

import type { AnalystDecision, ClaimStatus, Dossier, Finding, StoredEvidence } from '@olcys/core';
import {
  CASH_OUT_LABEL,
  CATEGORY_LABEL,
  CLAIM_STATUS_LABEL,
  CLASS_LABEL,
  DECISION_LABEL,
  EDGE_KIND_LABEL,
  IDENTITY_LABEL,
  NETWORK_LABEL,
  SERVICE_KIND_LABEL,
} from './labels.ts';

export const CSV_SEPARATOR = ';';

export type ExportFinding = Finding & {
  subjectProbability?: number;
  decision?: 'confirmed' | 'rejected';
  annotations?: string[];
  excludedEvidence?: StoredEvidence[];
  widelyCited?: boolean;
};

/** Decyzja z rejestru: także wycofana (rejestr jest śladem audytowym). */
export type ExportDecision = AnalystDecision & { author?: string; withdrawnAt?: string; withdrawnBy?: string };

/** Teczka w zakresie potrzebnym do eksportu — spełnia ją teczka z usługi i teczka trybu demo. */
export type ExportDossier = Omit<Dossier, 'findings' | 'decisions'> & { findings: ExportFinding[]; decisions: ExportDecision[] };

export const CSV_FILES = ['adresy.csv', 'profile.csv', 'zrodla.csv', 'transakcje.csv', 'uslugi.csv', 'relacje.csv', 'decyzje.csv'] as const;
export type CsvFileName = (typeof CSV_FILES)[number];
export type ExportFileName = CsvFileName | 'teczka.json' | 'pakiet.zip';

/** Pliki eksportu z opisem prostym językiem — ten sam opis trafia do menu i do pliku CZYTAJ-MNIE w pakiecie. */
export const EXPORT_FILES: { name: ExportFileName; title: string; description: string }[] = [
  { name: 'adresy.csv', title: 'Adresy', description: 'Adresy z Wskaźnikiem Pewności, wypłatami i liczbą źródeł — do otwarcia w Excelu.' },
  { name: 'profile.csv', title: 'Profile', description: 'Konta w serwisach z oceną, czy należą do osoby ze sprawy.' },
  { name: 'zrodla.csv', title: 'Źródła', description: 'Publikacje z datą pozyskania i skrótem SHA-256 treści — łańcuch dowodowy.' },
  { name: 'transakcje.csv', title: 'Transakcje', description: 'Przelewy adresów podmiotu z kontrahentem, kwotą i wyceną w PLN.' },
  { name: 'uslugi.csv', title: 'Giełdy i usługi', description: 'Usługi powiązane z podmiotem: liczba przelewów i kwoty w PLN.' },
  { name: 'relacje.csv', title: 'Relacje', description: 'Powiązania z grafu ze statusem (fakt, hipoteza, decyzja) i dowodami.' },
  { name: 'decyzje.csv', title: 'Decyzje', description: 'Rejestr decyzji analityka, łącznie z wycofanymi.' },
  { name: 'teczka.json', title: 'Teczka (JSON)', description: 'Pełna teczka z nagłówkiem: sprawa, analiza, wersja reguł, tryb danych.' },
  { name: 'pakiet.zip', title: 'Pakiet ZIP', description: 'Wszystkie pliki naraz, z kopią analizy i sumami SHA-256 plików.' },
];

/** Uwaga o postępowaniu z plikami — w menu eksportu i w pakiecie. */
export const EXPORT_NOTICE =
  'Pliki zawierają dane sprawy (w tym dane osobowe). Przechowuj je i przekazuj wyłącznie zgodnie z wewnętrznymi zasadami ochrony informacji.';

// ---------- Komórki i plik CSV ----------

export type Cell = string | number | boolean | null | undefined;

/** Liczba po polsku dla Excela: przecinek dziesiętny, bez separatora tysięcy, najwyżej 8 miejsc po przecinku. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(Number.isInteger(value) ? value : Number(value.toFixed(8))).replace('.', ',');
}

/** Data ISO jako „RRRR-MM-DD GG:MM:SS” (UTC) — Excel rozpoznaje ją jako datę; nieczytelna zostaje bez zmian. */
export function excelDate(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Jedna komórka CSV: formuły zneutralizowane apostrofem, cudzysłów przy separatorze, cudzysłowie, nowym wierszu i spacjach brzegowych. */
export function csvCell(value: Cell): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'boolean') text = value ? 'tak' : 'nie';
  else if (typeof value === 'number') text = formatNumber(value);
  else {
    text = value;
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  }
  return text.includes(CSV_SEPARATOR) || /["\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface CsvTable {
  header: string[];
  rows: Cell[][];
}

/** Plik CSV: BOM, nagłówek, wiersze oddzielone CRLF. */
export function toCsv(table: CsvTable): string {
  return `﻿${[table.header, ...table.rows].map((row) => row.map(csvCell).join(CSV_SEPARATOR)).join('\r\n')}\r\n`;
}

// ---------- Tabele ----------

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const round2 = (value: number) => Math.round(value * 100) / 100;
const networkName = (network: string) => (NETWORK_LABEL as Record<string, string>)[network] ?? network;
const claim = (status: ClaimStatus) => CLAIM_STATUS_LABEL[status] ?? status;

export function addressesTable(dossier: ExportDossier): CsvTable {
  return {
    header: [
      'Adres',
      'Sieć',
      'Suma kontrolna',
      'Wskaźnik Pewności (0–100)',
      'Poziom',
      'Wykluczony',
      'Powód wykluczenia / uwagi',
      'Prawdopodobieństwo osoby ze sprawy (%)',
      'Decyzja analityka',
      'Liczba źródeł',
      'Niezależne źródła',
      'Pierwsza publikacja (UTC)',
      'Ostatnia publikacja (UTC)',
      'Aktywność w blockchainie od (UTC)',
      'Aktywność w blockchainie do (UTC)',
      'Szacowane wypłaty (PLN)',
      'Etykieta adresu',
    ],
    rows: dossier.findings.map((finding) => {
      const dates = finding.evidence.map((item) => item.publishedAt ?? item.capturedAt).filter(Boolean).sort();
      const reasons = [
        ...(finding.decision === 'rejected' ? ['odrzucony decyzją analityka'] : []),
        ...(finding.widelyCited ? ['adres cytowany przez wielu autorów — nikomu nieprzypisany'] : []),
        ...(finding.annotations ?? []),
        ...(finding.confidence.excluded ? finding.confidence.ledger.filter((entry) => entry.delta < 0).slice(-2).map((entry) => entry.explanation) : []),
      ];
      const profile = finding.chain?.profile;
      return [
        finding.address,
        networkName(finding.network),
        finding.checksumVerified ? 'zweryfikowana' : 'niezweryfikowana',
        finding.confidence.score,
        finding.confidence.tier,
        finding.confidence.excluded,
        [...new Set(reasons)].join(' | '),
        finding.subjectProbability,
        finding.decision ? DECISION_LABEL[finding.decision] : '',
        finding.evidence.length,
        finding.confidence.independentSources,
        excelDate(dates[0]),
        excelDate(dates.at(-1)),
        excelDate(profile?.firstSeen),
        excelDate(profile?.lastSeen),
        finding.chain ? round2(sum(Object.values(finding.chain.cashOutPlnByYear ?? {}))) : undefined,
        profile?.label,
      ];
    }),
  };
}

export function profilesTable(dossier: ExportDossier): CsvTable {
  const persons = dossier.persons ?? [];
  return {
    header: ['Konto', 'Serwis', 'URL', 'Wynik tożsamości (0–100)', 'Dopasowanie', 'Status', 'Kandydat na osobę', 'Prawdopodobieństwo kandydata (%)', 'Opublikowane adresy', 'Przesłanki'],
    rows: dossier.profiles.map((card) => {
      const index = persons.findIndex((person) => (person.profileIds ?? []).includes(card.id));
      const person = index >= 0 ? persons[index] : undefined;
      return [
        card.handle ?? '',
        card.service,
        card.url,
        card.identityScore,
        IDENTITY_LABEL[card.identityMatch] ?? card.identityMatch,
        card.decision ? `${DECISION_LABEL[card.decision]} przez analityka` : 'bez decyzji analityka',
        person ? `${index === 0 ? 'kandydat główny' : `kandydat ${index + 1}`}${person.fullName ? `: ${person.fullName}` : ''}` : '',
        person?.probability,
        card.addresses.length,
        card.identityReasons.join(' | '),
      ];
    }),
  };
}

export function sourcesTable(dossier: ExportDossier): CsvTable {
  const rows: Cell[][] = [];
  for (const finding of dossier.findings) {
    const items: [StoredEvidence, boolean][] = [...finding.evidence.map((item): [StoredEvidence, boolean] => [item, false]), ...(finding.excludedEvidence ?? []).map((item): [StoredEvidence, boolean] => [item, true])];
    for (const [item, excluded] of items) {
      rows.push([
        item.url,
        item.service,
        CATEGORY_LABEL[item.category] ?? item.category,
        item.title,
        item.author,
        excelDate(item.capturedAt),
        excelDate(item.publishedAt),
        excelDate(item.archivedAt),
        item.contentHash,
        finding.address,
        networkName(finding.network),
        item.matchedIdentifier ? `${item.matchedIdentifier.type}: ${item.matchedIdentifier.value}` : '',
        item.connectorId,
        excluded,
      ]);
    }
  }
  return {
    header: [
      'URL',
      'Serwis',
      'Kategoria',
      'Tytuł',
      'Autor',
      'Pozyskano (UTC)',
      'Opublikowano (UTC)',
      'Kopia archiwalna z (UTC)',
      'SHA-256 treści',
      'Adres',
      'Sieć',
      'Znaleziono po identyfikatorze',
      'Źródło (łącznik)',
      'Pominięty w ocenie',
    ],
    rows,
  };
}

export function transactionsTable(dossier: ExportDossier): CsvTable {
  const rows: Cell[][] = [];
  // Wycena w PLN: wskaźniki wypłat i przelewy do usług (te same transakcje, bez podwójnego liczenia).
  const servicePln = new Map<string, number>();
  for (const link of dossier.serviceLinks ?? []) {
    for (const transfer of link.transfers) if (transfer.valuePln !== undefined) servicePln.set(`${transfer.subjectAddress}|${transfer.txid}`, transfer.valuePln);
  }
  for (const finding of dossier.findings) {
    const chain = finding.chain;
    if (!chain) continue;
    const cashOuts = new Map(chain.cashOuts.map((item) => [item.txid, item]));
    for (const transfer of chain.transfers) {
      const cashOut = cashOuts.get(transfer.txid);
      const pln = cashOut?.valuePln ?? servicePln.get(`${finding.address}|${transfer.txid}`);
      rows.push([
        finding.address,
        networkName(finding.network),
        transfer.txid,
        excelDate(transfer.time),
        transfer.direction === 'out' ? 'wychodzący' : 'przychodzący',
        transfer.counterparty,
        transfer.counterpartyLabel,
        transfer.counterpartyLabel ? chain.profile.classificationSource : '',
        CLASS_LABEL[transfer.counterpartyClass] ?? transfer.counterpartyClass,
        transfer.asset,
        transfer.amount,
        pln === undefined ? undefined : round2(pln),
        cashOut ? CASH_OUT_LABEL[cashOut.kind] ?? cashOut.kind : '',
        transfer.explorerUrl,
      ]);
    }
  }
  return {
    header: [
      'Adres podmiotu',
      'Sieć',
      'Identyfikator transakcji (txid)',
      'Czas (UTC)',
      'Kierunek',
      'Kontrahent',
      'Etykieta kontrahenta',
      'Źródło etykiety',
      'Rodzaj kontrahenta',
      'Aktywo',
      'Kwota',
      'Wartość (PLN)',
      'Możliwa wypłata',
      'Eksplorator',
    ],
    rows,
  };
}

export function servicesTable(dossier: ExportDossier): CsvTable {
  return {
    header: [
      'Usługa',
      'Rodzaj',
      'Siła powiązania (0–100)',
      'Tylko wnioskowanie',
      'Przelewy do usługi',
      'Przelewy z usługi',
      'Do usługi (PLN)',
      'Z usługi (PLN)',
      'Pierwszy przelew (UTC)',
      'Ostatni przelew (UTC)',
      'Sieci',
      'Przesłanki',
    ],
    rows: (dossier.serviceLinks ?? []).map((link) => [
      link.name,
      SERVICE_KIND_LABEL[link.kind] ?? link.kind,
      link.strength,
      link.inferredOnly,
      link.transfersOut,
      link.transfersIn,
      link.outPln === undefined ? undefined : round2(link.outPln),
      link.inPln === undefined ? undefined : round2(link.inPln),
      excelDate(link.firstSeen),
      excelDate(link.lastSeen),
      link.networks.map(networkName).join(', '),
      link.reasons.join(' | '),
    ]),
  };
}

export function relationsTable(dossier: ExportDossier): CsvTable {
  const nodes = new Map((dossier.graph?.nodes ?? []).map((node) => [node.id, node]));
  const name = (id: string) => {
    const node = nodes.get(id);
    return node ? (node.kind === 'address' ? id.split(':').slice(2).join(':') || node.label : node.label) : id;
  };
  return {
    header: ['Od', 'Do', 'Rodzaj relacji', 'Etykieta', 'Status', 'Waga (0–100)', 'Warstwa', 'Wyjaśnienie', 'Dowody', 'Węzeł „od”', 'Węzeł „do”'],
    rows: (dossier.graph?.edges ?? []).map((edge) => [
      name(edge.from),
      name(edge.to),
      EDGE_KIND_LABEL[edge.kind] ?? edge.kind,
      edge.label,
      claim(edge.status ?? (edge.inferred ? 'hypothesis' : 'source_fact')),
      edge.weight === undefined ? undefined : Math.round(edge.weight),
      edge.layer === 'chain' ? 'blockchain' : 'tożsamość',
      edge.explanation,
      (edge.evidence ?? []).map((item) => `${item.kind}: ${item.value}`).join(' | '),
      edge.from,
      edge.to,
    ]),
  };
}

const TARGET_LABEL: Record<string, string> = {
  profile: 'konto',
  address: 'adres',
  evidence: 'pojedynczy ślad',
  link: 'para kont (wspólny operator)',
  cashout: 'wyjście do walut tradycyjnych',
};

export function decisionsTable(decisions: ExportDecision[]): CsvTable {
  return {
    header: ['Identyfikator', 'Cel', 'Klucz', 'Decyzja', 'Notatka', 'Podjęto (UTC)', 'Autor', 'Wycofano (UTC)', 'Wycofał', 'Obowiązuje'],
    rows: decisions.map((item) => [
      item.id,
      TARGET_LABEL[item.target] ?? item.target,
      item.key,
      DECISION_LABEL[item.decision] ?? item.decision,
      item.note,
      excelDate(item.decidedAt),
      item.author,
      excelDate(item.withdrawnAt),
      item.withdrawnBy,
      !item.withdrawnAt,
    ]),
  };
}

/** Wszystkie tabele sprawy. `decisions` — pełny rejestr (z wycofanymi); domyślnie decyzje z teczki. */
export function buildCsvFiles(dossier: ExportDossier, decisions: ExportDecision[] = dossier.decisions ?? []): Record<CsvFileName, string> {
  return {
    'adresy.csv': toCsv(addressesTable(dossier)),
    'profile.csv': toCsv(profilesTable(dossier)),
    'zrodla.csv': toCsv(sourcesTable(dossier)),
    'transakcje.csv': toCsv(transactionsTable(dossier)),
    'uslugi.csv': toCsv(servicesTable(dossier)),
    'relacje.csv': toCsv(relationsTable(dossier)),
    'decyzje.csv': toCsv(decisionsTable(decisions)),
  };
}

// ---------- Teczka JSON z nagłówkiem ----------

/** Źródła demonstracyjne: piaskownica (`sandbox-*`) i laboratorium (`lab-*`, sieć `lab`). */
const isSyntheticSource = (id: string) => id.startsWith('sandbox-') || id.startsWith('lab-');

/** Czy dane sprawy pochodzą ze źródeł syntetycznych: wszystkie, część czy żadne. */
export function syntheticData(dossier: ExportDossier, connectors: string[] = []): { flag: 'tak' | 'częściowo' | 'nie'; sources: string[] } {
  const ids = [...new Set([...connectors, ...dossier.findings.flatMap((finding) => finding.evidence.map((item) => item.connectorId))])].filter((id) => id && id !== 'corpus');
  const synthetic = ids.filter(isSyntheticSource);
  const lab = dossier.findings.some((finding) => finding.network === 'lab');
  if (synthetic.length === 0 && !lab) return { flag: 'nie', sources: [] };
  return { flag: ids.length > 0 && synthetic.length === ids.length ? 'tak' : synthetic.length === 0 && ids.length === 0 ? 'tak' : 'częściowo', sources: synthetic };
}

export interface ExportMeta {
  tool: { name: string; version: string };
  generatedAt: string;
  case: { id: string; name: string; createdAt?: string };
  run: { id: string; startedAt?: string; finishedAt?: string; connectors: string[] };
  /** Wersja jawnych reguł oceny: skrót SHA-256 reguł (inna wartość = inne reguły). */
  rules: { sha256?: string; note: string };
  /** Tryb danych analizy: `sandbox` — wyłącznie źródła demonstracyjne, `live` — choć jedno prawdziwe źródło publiczne. */
  dataMode: { mode: 'live' | 'sandbox'; label: string };
  syntheticData: { flag: 'tak' | 'częściowo' | 'nie'; sources: string[]; label: string };
  notice: string;
  /** Tylko w trybie demo przeglądarki: plik nie może uchodzić za wynik analizy. */
  uwaga?: string;
}

export const TOOL_NAME = 'OŁCyŚ — OSINTowy Łapacz Cyfrowych Śladów';

/** Nagłówek teczki: skąd i kiedy pochodzi, jakimi regułami ją policzono, czy dane są syntetyczne. */
export function exportMeta(
  dossier: ExportDossier,
  input: { toolVersion: string; generatedAt: string; caseName: string; caseCreatedAt?: string; run?: { startedAt?: string; finishedAt?: string; connectors: string[] }; rulesSha256?: string; demoNotice?: string },
): ExportMeta {
  const connectors = input.run?.connectors ?? [];
  // Teczka trybu demo przeglądarki jest w całości przykładowa, bez względu na nazwy łączników w danych.
  const synthetic = input.demoNotice ? { flag: 'tak' as const, sources: syntheticData(dossier, connectors).sources } : syntheticData(dossier, connectors);
  const mode = synthetic.flag === 'tak' ? 'sandbox' : 'live';
  return {
    tool: { name: TOOL_NAME, version: input.toolVersion },
    generatedAt: input.generatedAt,
    case: { id: dossier.caseId, name: input.caseName, ...(input.caseCreatedAt ? { createdAt: input.caseCreatedAt } : {}) },
    run: { id: dossier.runId, ...(input.run?.startedAt ? { startedAt: input.run.startedAt } : {}), ...(input.run?.finishedAt ? { finishedAt: input.run.finishedAt } : {}), connectors },
    rules: {
      ...(input.rulesSha256 ? { sha256: input.rulesSha256 } : {}),
      note: 'Wskaźniki to wyniki porządkowe 0–100 z jawnych reguł (GET /api/rules, GET /api/priority-rules), nie skalibrowane prawdopodobieństwa.',
    },
    dataMode: {
      mode,
      label: mode === 'sandbox' ? 'Tryb demonstracyjny (piaskownica): dane syntetyczne, bez zapytań do prawdziwych serwisów.' : 'Źródła publiczne (live).',
    },
    syntheticData: {
      ...synthetic,
      label:
        synthetic.flag === 'tak'
          ? 'Dane syntetyczne — wyłącznie źródła demonstracyjne.'
          : synthetic.flag === 'częściowo'
            ? 'Część danych pochodzi ze źródeł demonstracyjnych (syntetycznych) — są oznaczone identyfikatorem łącznika.'
            : 'Brak danych ze źródeł demonstracyjnych.',
    },
    notice: EXPORT_NOTICE,
    ...(input.demoNotice ? { uwaga: input.demoNotice } : {}),
  };
}

/** Treść pliku `teczka.json`: nagłówek `meta` i pełna teczka. */
export function dossierJson(meta: ExportMeta, dossier: unknown): string {
  return `${JSON.stringify({ meta, dossier }, null, 2)}\n`;
}

// ---------- Pobieranie: usługa analizy albo tryb demo ----------

/** Adres pliku eksportu w usłudze analizy. */
export const exportUrl = (caseId: string, name: ExportFileName) => `/api/cases/${encodeURIComponent(caseId)}/export/${name}`;

/** Uwaga w plikach trybu demo — jak w „Pakiecie JSON” teczki: plik nie może uchodzić za wynik analizy. */
export const DEMO_EXPORT_NOTICE = 'DEMO — dane przykładowe wbudowane w interfejs; nie pochodzą ze źródeł publicznych ani z blockchaina.';

/** Czy teczkę z trybu demo da się wyeksportować (ma tablice, z których powstają tabele). */
export function isExportDossier(value: unknown): value is ExportDossier {
  const dossier = value as Partial<ExportDossier> | null;
  return Boolean(dossier && typeof dossier === 'object' && typeof dossier.caseId === 'string' && Array.isArray(dossier.findings) && Array.isArray(dossier.profiles));
}

/**
 * Plik eksportu zbudowany w przeglądarce z teczki trybu demo (ten sam builder co w usłudze).
 * Nazwa dostaje przedrostek `DEMO-`; pakiet ZIP w trybie demo nie jest dostępny (`null`).
 */
export function demoExportFile(dossier: ExportDossier, name: ExportFileName, generatedAt: string, toolVersion = 'demo'): { fileName: string; content: string; type: string } | null {
  if (name === 'pakiet.zip') return null;
  if (name === 'teczka.json') {
    const meta = exportMeta(dossier, { toolVersion, generatedAt, caseName: dossier.subject?.name ?? dossier.caseId, run: { connectors: [] }, demoNotice: DEMO_EXPORT_NOTICE });
    return { fileName: `DEMO-${name}`, content: dossierJson(meta, dossier), type: 'application/json' };
  }
  return { fileName: `DEMO-${name}`, content: buildCsvFiles(dossier)[name], type: 'text/csv;charset=utf-8' };
}
