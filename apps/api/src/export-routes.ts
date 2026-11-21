// Trasy eksportu danych sprawy: tabele CSV do Excela, teczka JSON z nagłówkiem i pakiet ZIP.
// Pliki powstają lokalnie z zapisanej analizy i rejestru decyzji — nic nie jest wysyłane poza maszynę.

import type { FastifyInstance } from 'fastify';
import { HttpError, TOOL_VERSION } from './http-common.ts';
import type { RouteContext } from './http-common.ts';
import { CSV_FILES, buildCaseExport, buildPackage } from './export.ts';
import type { CsvFileName } from './export.ts';
import { internalHeaders } from './security.ts';

const FILES = [...CSV_FILES, 'teczka.json', 'pakiet.zip'] as const;
type ExportFile = (typeof FILES)[number];

/** Nagłówek Content-Disposition: nazwa ASCII i pełna w UTF-8 (RFC 5987). */
function attachment(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\/;:*?<>|]/g, '_');
  return `attachment; filename="${ascii || 'olcys-eksport'}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerExportRoutes(app: FastifyInstance, context: RouteContext): void {
  const { storage, now, requireCase, requireRun, loadDossier } = context;

  app.get<{ Params: { id: string; file: ExportFile }; Querystring: { run?: string } }>(
    '/api/cases/:id/export/:file',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'file'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, file: { type: 'string', enum: [...FILES] } },
        },
        querystring: { type: 'object', additionalProperties: false, properties: { run: { type: 'string', minLength: 1, maxLength: 64 } } },
      },
    },
    async (request, reply) => {
      const caseSummary = await requireCase(request.params.id);
      // Domyślnie ostatnia zakończona analiza; `?run=` wskazuje inną analizę tej sprawy.
      const chosen = request.query.run
        ? caseSummary.runs.find((run) => run.id === request.query.run)
        : caseSummary.runs.filter((run) => run.status === 'completed').at(-1);
      if (!chosen) throw new HttpError(404, request.query.run ? 'Analiza nie należy do tej sprawy.' : 'Sprawa nie ma jeszcze zakończonej analizy.');
      const run = await requireRun(chosen.id);
      const [dossier, decisions] = await Promise.all([loadDossier(run), storage.listDecisions(caseSummary.id)]);
      const content = buildCaseExport(dossier, {
        toolVersion: TOOL_VERSION,
        generatedAt: now().toISOString(),
        caseName: caseSummary.name,
        caseCreatedAt: caseSummary.createdAt,
        run: { startedAt: run.startedAt, finishedAt: run.finishedAt, connectors: run.connectors },
        rules: context.rules,
        decisions,
      });
      const file = request.params.file;
      const base = `${caseSummary.name.replace(/\s+/g, '-').slice(0, 60)}-${file}`;
      reply.header('Content-Disposition', attachment(base)).header('Cache-Control', 'no-store');
      if (file === 'teczka.json') return reply.type('application/json; charset=utf-8').send(content.json);
      if (file === 'pakiet.zip') {
        // Pełny zapis analizy z istniejącej trasy raportu — ten sam plik co „Pakiet JSON” analizy.
        const analysis = await app.inject({ method: 'GET', url: `/api/runs/${encodeURIComponent(run.id)}/report.json`, headers: internalHeaders() });
        return reply.type('application/zip').send(buildPackage(content, analysis.statusCode === 200 ? analysis.body : undefined));
      }
      return reply.type('text/csv; charset=utf-8').send(content.csv[file as CsvFileName]);
    },
  );
}
