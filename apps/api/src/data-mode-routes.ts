// Przełącznik trybu danych: GET/PUT /api/settings/data-mode. Zmiana obowiązuje od następnej
// analizy, bez restartu serwera. Uwierzytelnianie (token API) i nagłówki bezpieczeństwa
// obejmują tę trasę tak jak pozostałe — przez wspólne haki aplikacji.

import type { FastifyInstance } from 'fastify';
import { DATA_MODES, DATA_MODE_LABELS, dataModeTag, isDataModeAvailable, unavailableReason } from './data-mode.ts';
import type { DataMode, DataModeState } from './data-mode.ts';

/** Opis stanu przełącznika dla interfejsu i operatora. */
export function describeDataMode(state: DataModeState) {
  const available = state.available();
  const current = state.current();
  const stored = state.stored();
  const modes = Object.fromEntries(
    DATA_MODES.map((mode) => {
      const reason = unavailableReason(mode, available);
      return [mode, { available: isDataModeAvailable(mode, available), label: DATA_MODE_LABELS[mode], ...(reason ? { reason } : {}) }];
    }),
  ) as Record<DataMode, { available: boolean; label: string; reason?: string }>;
  return {
    dataMode: current,
    tag: dataModeTag(current),
    label: DATA_MODE_LABELS[current],
    defaultMode: state.defaultMode(),
    modes,
    ...(stored ? { updatedAt: stored.updatedAt, ...(stored.updatedBy ? { updatedBy: stored.updatedBy } : {}) } : {}),
    // Zapisany tryb, którego to uruchomienie nie obsługuje (np. serwer bez ENABLE_LIVE) — obowiązuje domyślny.
    ...(stored && stored.dataMode !== current
      ? { storedDataMode: stored.dataMode, note: `Zapisany tryb „${stored.dataMode}” jest niedostępny w tym uruchomieniu — obowiązuje „${current}”. ${unavailableReason(stored.dataMode, available) ?? ''}`.trim() }
      : {}),
  };
}

/** Dziennik audytu (jeśli baza go ma): zmiana trybu danych jest odnotowywana jak inne zmiany ustawień. */
type AuditSink = { addAudit?: (entry: { at: string; actor: string; action: string; details: Record<string, unknown> }) => Promise<void> };

export function registerDataModeRoutes(app: FastifyInstance, state: DataModeState, audit?: AuditSink): void {
  app.get('/api/settings/data-mode', async () => describeDataMode(state));

  app.put<{ Body: { dataMode: DataMode } }>(
    '/api/settings/data-mode',
    {
      schema: {
        body: {
          type: 'object',
          required: ['dataMode'],
          additionalProperties: false,
          properties: { dataMode: { type: 'string', enum: [...DATA_MODES] } },
        },
      },
    },
    async (request) => {
      const previous = state.current();
      // Narzędzie nie ma kont użytkowników — autor zmiany jest stały, jak przy decyzjach analityka.
      const saved = await state.set(request.body.dataMode, 'analityk');
      request.log.info({ from: previous, to: saved.dataMode }, 'Zmiana trybu danych analiz.');
      if (typeof audit?.addAudit === 'function') {
        try {
          await audit.addAudit({ at: saved.updatedAt, actor: 'analityk', action: 'ustawienia.tryb-danych', details: { poprzedni: previous, nowy: saved.dataMode } });
        } catch (error) {
          request.log.error({ err: error }, 'Nie udało się zapisać wpisu audytu (zmiana trybu danych).');
        }
      }
      return describeDataMode(state);
    },
  );
}
