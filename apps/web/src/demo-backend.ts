// Zastępnik API dla trybu demo: stan trzymany w pamięci karty przeglądarki.
import type { AnalysisRun, RunDiff } from '@olcys/core';
import type { Backend, CaseSummary, RunSummary } from './api.ts';
import { ApiError } from './api.ts';
import { DEMO_RUN_2, demoCase, demoConnectors, demoReplacements, demoRules, demoRuns } from './demo-data.ts';

type StoredCase = Omit<CaseSummary, 'runs'>;

const cases: StoredCase[] = [demoCase];
const runs: AnalysisRun[] = [...demoRuns];
let sequence = 0;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const notFound = (what: string) => new ApiError(`Nie znaleziono: ${what}.`, 404);

function summarizeRun(run: AnalysisRun): RunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    status: run.status,
    findingCount: run.findings.length,
    topScore: Math.max(0, ...run.findings.map((finding) => finding.confidence.score)),
  };
}

function summarizeCase(stored: StoredCase): CaseSummary {
  return { ...stored, runs: runs.filter((run) => run.caseId === stored.id).map(summarizeRun) };
}

function findCase(caseId: string): StoredCase {
  const found = cases.find((item) => item.id === caseId);
  if (!found) throw notFound('sprawa');
  return found;
}

function findRun(runId: string): AnalysisRun {
  const found = runs.find((item) => item.id === runId);
  if (!found) throw notFound('analiza');
  return found;
}

/** Podmiany widoczne w danej analizie: nowy adres jest w wynikach, stary już nie. */
function replacementsFor(run: AnalysisRun) {
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

export const demoBackend: Backend = {
  listConnectors: async () => demoConnectors,
  getRules: async () => demoRules,
  listCases: async () => cases.map(summarizeCase),
  getCase: async (caseId) => summarizeCase(findCase(caseId)),
  getRun: async (runId) => findRun(runId),
  getReplacements: async (runId) => replacementsFor(findRun(runId)),
  getDiff: async (caseId, from, to) => {
    findCase(caseId);
    return diffRuns(findRun(from), findRun(to));
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

  // Sprawa demonstracyjna powtarza ostatni wynik; nowe sprawy nie mają danych.
  startRun: async (caseId, connectors) => {
    const stored = findCase(caseId);
    await wait(900);
    sequence += 1;
    const now = new Date().toISOString();
    const template = stored.id === demoCase.id ? findRun(DEMO_RUN_2) : undefined;
    const run: AnalysisRun = {
      id: `demo-analiza-nowa-${sequence}`,
      caseId,
      startedAt: now,
      finishedAt: now,
      status: 'completed',
      query: stored.query,
      connectors,
      findings: template?.findings ?? [],
      log: template?.log ?? [
        { time: now, message: `Start analizy. Źródła: ${connectors.join(', ') || 'brak'}.` },
        { time: now, message: 'Tryb demo: dla nowych spraw nie ma danych przykładowych — nie znaleziono adresów.' },
      ],
    };
    runs.push(run);
    return run;
  },
};
