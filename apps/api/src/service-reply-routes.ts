// Trasy odpowiedzi usług: rejestr dokumentów spoza OSINT wprowadzanych przez analityka
// (lista, zapis z walidacją i maskowaniem, wycofanie ze śladem audytowym) oraz przykładowa,
// syntetyczna odpowiedź z piaskownicy — pobierana przez API, żeby przeglądarka nie łączyła się z piaskownicą.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HttpError, idParams } from './http-common.ts';
import type { RouteContext } from './http-common.ts';
import { CUSTOMER_IDENTIFIER_KINDS, cleanReplyPayload } from './service-reply.ts';
import type { ServiceReply, ServiceReplyInput } from './service-reply.ts';
import { CONTRACTS_LINK_ID, serviceIdOf } from './services.ts';

/** Narzędzie nie ma jeszcze kont użytkowników — autor wpisu jest stały. */
const REPLY_AUTHOR = 'analityk';
const SANDBOX_TIMEOUT_MS = 5_000;
/** Odpowiedź nie może być „otrzymana” w przyszłości (z zapasem na strefy czasowe). */
const FUTURE_TOLERANCE_MS = 36 * 3_600_000;

const text = (maxLength: number) => ({ type: 'string', maxLength }) as const;

/** Schemat ładunku: nieznane pola nie są zapisywane, listy i napisy mają limity. */
const payloadSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matches: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { network: text(20), depositAddress: text(200), txids: { type: 'array', maxItems: 100, items: text(200) } },
      },
    },
    customer: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fullName: text(200),
        identifierKind: { type: 'string', enum: CUSTOMER_IDENTIFIER_KINDS },
        // Pełna wartość jest przyjmowana tylko po to, żeby ją zamaskować — nigdy nie trafia do bazy.
        identifierMasked: text(100),
        identifier: text(100),
        accountId: text(200),
        emails: { type: 'array', maxItems: 10, items: text(200) },
        phones: { type: 'array', maxItems: 10, items: text(50) },
        registeredAt: text(40),
      },
    },
    fiatPayouts: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['time', 'amount', 'currency'],
        additionalProperties: false,
        properties: {
          time: { type: 'string', minLength: 4, maxLength: 40 },
          amount: { type: 'number', exclusiveMinimum: 0, maximum: 1e12 },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
          bankAccountMasked: text(100),
          bankAccount: text(100),
          relatedTxid: text(200),
        },
      },
    },
    note: text(4000),
    documentHash: text(64),
    syntetyczne: { type: 'boolean' },
  },
} as const;

interface ReplyBody {
  serviceName: string;
  serviceId?: string;
  reference: string;
  receivedAt: string;
  payload: ServiceReplyInput;
  /** Treść dołączonego dokumentu — serwer liczy z niej SHA-256 i jej NIE zapisuje. */
  documentText?: string;
  /** Zapisz mimo że usługa nie występuje wśród usług powiązanych w sprawie. */
  force?: boolean;
}

const sameName = (a: string, b: string): boolean => a.trim().toLocaleLowerCase('pl') === b.trim().toLocaleLowerCase('pl');

export function registerServiceReplyRoutes(app: FastifyInstance, context: RouteContext): void {
  const { storage, now, requireCase, requireRun, loadDossier, deps } = context;

  /** Teczka ostatniej zakończonej analizy sprawy; `null`, gdy sprawa nie ma jeszcze analizy. */
  const latestDossier = async (caseId: string) => {
    const caseSummary = await requireCase(caseId);
    const last = caseSummary.runs.filter((run) => run.status === 'completed').at(-1);
    return last ? loadDossier(await requireRun(last.id)) : null;
  };

  app.get<{ Params: { id: string } }>('/api/cases/:id/service-replies', { schema: { params: idParams } }, async (request) => {
    await requireCase(request.params.id);
    return storage.listServiceReplies(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: ReplyBody }>(
    '/api/cases/:id/service-replies',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['serviceName', 'reference', 'receivedAt', 'payload'],
          additionalProperties: false,
          properties: {
            serviceName: { type: 'string', minLength: 1, maxLength: 200 },
            serviceId: { type: 'string', minLength: 1, maxLength: 200 },
            reference: { type: 'string', minLength: 1, maxLength: 200 },
            receivedAt: { type: 'string', minLength: 4, maxLength: 40 },
            payload: payloadSchema,
            documentText: text(500_000),
            force: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const caseSummary = await requireCase(request.params.id);
      const name = request.body.serviceName.trim();
      const reference = request.body.reference.trim();
      if (!name || !reference) throw new HttpError(400, 'Nazwa usługi i sygnatura odpowiedzi nie mogą być puste.');
      const received = new Date(request.body.receivedAt);
      if (Number.isNaN(received.getTime())) throw new HttpError(400, `„${request.body.receivedAt}” nie jest poprawną datą otrzymania odpowiedzi (ISO 8601).`);
      if (received.getTime() > now().getTime() + FUTURE_TOLERANCE_MS) throw new HttpError(400, 'Data otrzymania odpowiedzi nie może być w przyszłości.');

      // Usługa musi być jedną z usług powiązanych w sprawie — chyba że analityk świadomie zapisuje inną (`force`).
      const dossier = await latestDossier(caseSummary.id);
      const wantedId = request.body.serviceId?.trim() || serviceIdOf(name, deps.matchService);
      const known = (dossier?.serviceLinks ?? []).filter((link) => link.id !== CONTRACTS_LINK_ID);
      const link = known.find((item) => item.id === wantedId) ?? known.find((item) => sameName(item.name, name));
      if (!link && request.body.force !== true) {
        throw new HttpError(
          400,
          `Usługa „${name}” nie występuje wśród usług powiązanych w tej sprawie` +
            `${known.length > 0 ? ` (${known.map((item) => item.name).join(', ')})` : ''}. Sprawdź nazwę albo zapisz odpowiedź z opcją „mimo braku powiązania” (force).`,
        );
      }

      const cleaned = cleanReplyPayload(request.body.payload, request.body.documentText);
      if ('error' in cleaned) throw new HttpError(400, cleaned.error);

      const serviceId = link?.id ?? wantedId;
      const existing = await storage.listServiceReplies(caseSummary.id);
      if (existing.some((item) => !item.withdrawnAt && item.serviceId === serviceId && sameName(item.reference, reference))) {
        throw new HttpError(409, `Odpowiedź usługi ${link?.name ?? name} o sygnaturze „${reference}” jest już zapisana w tej sprawie. Wycofaj ją, aby wprowadzić poprawioną.`);
      }

      const record: ServiceReply = {
        id: randomUUID(),
        caseId: caseSummary.id,
        serviceName: link?.name ?? name,
        serviceId,
        reference,
        receivedAt: received.toISOString(),
        recordedAt: now().toISOString(),
        recordedBy: REPLY_AUTHOR,
        payload: cleaned.payload,
      };
      await storage.addServiceReply(record);
      context.invalidateDossiers();
      return reply.code(201).send(record);
    },
  );

  app.delete<{ Params: { id: string; replyId: string } }>(
    '/api/cases/:id/service-replies/:replyId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'replyId'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, replyId: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      await requireCase(request.params.id);
      // Wycofanie nie usuwa wpisu: odpowiedź zostaje w rejestrze z czasem i autorem wycofania (ślad audytowy).
      if (!(await storage.withdrawServiceReply(request.params.id, request.params.replyId, { at: now().toISOString(), by: REPLY_AUTHOR }))) {
        throw new HttpError(404, 'Nie znaleziono obowiązującej odpowiedzi usługi w tej sprawie.');
      }
      context.invalidateDossiers();
      return reply.code(204).send();
    },
  );

  // ---------- Przykładowa (syntetyczna) odpowiedź z piaskownicy ----------

  app.get<{ Params: { id: string }; Querystring: { service?: string; address?: string; variant?: string } }>(
    '/api/cases/:id/service-replies/sandbox-sample',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: { service: text(200), address: text(200), variant: { type: 'string', enum: ['', 'inna-osoba'] } },
        },
      },
    },
    async (request) => {
      if (!deps.sandboxUrl) throw new HttpError(404, 'Przykładowa odpowiedź jest dostępna tylko przy skonfigurowanej piaskownicy (dane demonstracyjne).');
      const dossier = await latestDossier(request.params.id);
      if (!dossier) throw new HttpError(404, 'Sprawa nie ma jeszcze zakończonej analizy.');
      const wanted = request.query.service?.trim();
      const link = dossier.serviceLinks.find((item) => item.id !== CONTRACTS_LINK_ID && (!wanted || item.id === wanted || sameName(item.name, wanted)));
      if (!link) throw new HttpError(404, 'Analiza nie wykazała powiązania z taką usługą.');
      // Adres podmiotu: wskazany w żądaniu albo pierwszy, z którego środki trafiły do tej usługi.
      const address = request.query.address?.trim() || link.transfers.find((transfer) => transfer.direction === 'out')?.subjectAddress || link.transfers[0]?.subjectAddress;
      if (!address) throw new HttpError(404, `Brak przelewów między adresami sprawy a usługą ${link.name} — piaskownica nie ma z czego złożyć odpowiedzi.`);

      const url = new URL('/_demo/odpowiedz-gieldy', deps.sandboxUrl);
      url.searchParams.set('usluga', link.name);
      url.searchParams.set('adres', address);
      if (request.query.variant) url.searchParams.set('wariant', request.query.variant);
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(SANDBOX_TIMEOUT_MS), headers: { accept: 'application/json' } });
      } catch {
        throw new HttpError(424, 'Piaskownica nie odpowiada — uruchom ją albo wprowadź odpowiedź ręcznie.');
      }
      const body = (await response.json().catch(() => null)) as { syntetyczne?: boolean; error?: string } | null;
      if (!response.ok || !body) {
        throw new HttpError(response.status === 404 ? 404 : 424, body?.error ?? 'Piaskownica nie zwróciła przykładowej odpowiedzi (starsza wersja piaskownicy nie ma tej funkcji — uruchom ją ponownie).');
      }
      // Przyjmujemy wyłącznie odpowiedź jawnie oznaczoną jako syntetyczna.
      if (body.syntetyczne !== true) throw new HttpError(424, 'Piaskownica zwróciła odpowiedź bez oznaczenia danych syntetycznych — odrzucono.');
      return { ...body, serviceId: link.id, serviceName: link.name };
    },
  );
}
