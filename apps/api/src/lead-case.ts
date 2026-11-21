// Założenie sprawy z analizy wykonanej już wcześniej (przegląd źródeł, monitoring):
// analiza staje się pierwszą analizą sprawy, bez ponownego odpytywania źródeł.

import { randomUUID } from 'node:crypto';
import type { AnalysisRun } from '@olcys/core';
import type { CaseSummary, LeadAnalysis, Storage } from './storage.ts';

export async function createCaseFromAnalysis(
  storage: Storage,
  name: string,
  analysis: LeadAnalysis,
  /** Wpis do dziennika analizy: skąd się wzięła. */
  origin: string,
  createdAt: string,
): Promise<CaseSummary> {
  const created = await storage.createCase(name, analysis.query, createdAt);
  const run: AnalysisRun = {
    id: randomUUID(),
    caseId: created.id,
    startedAt: analysis.startedAt,
    finishedAt: analysis.finishedAt,
    status: 'completed',
    query: analysis.query,
    connectors: analysis.connectors,
    findings: analysis.findings,
    log: [...analysis.log, { time: createdAt, message: origin }],
  };
  await storage.saveRun(run);
  await storage.saveDocuments(run.id, analysis.documents);
  await storage.saveRunIntel(run.id, analysis.intel);
  return (await storage.getCase(created.id))!;
}
