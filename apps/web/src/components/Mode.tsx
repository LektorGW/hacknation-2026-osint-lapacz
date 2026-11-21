// Znaczek trybu pracy (DEMO / SANDBOX / LIVE), przełącznik danych syntetycznych i prawdziwych
// oraz oznaczenie danych syntetycznych przy śladach.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, errorMessage, fetchHealth, isDemo } from '../api.ts';
import {
  DATA_MODES,
  DATA_MODE_DESCRIPTION,
  DATA_MODE_SHORT,
  DATA_MODE_UNAVAILABLE,
  LIVE_CONFIRMATION,
  dataModeStatus,
  isSyntheticSource,
  modeText,
  needsLiveConfirmation,
  resolveMode,
  syntheticConnectorIds,
} from '../mode.ts';
import type { DataMode, DataModeStatus, ModeInfo, SourceRef } from '../mode.ts';
import { useAsync } from '../useAsync.ts';
import type { GlossaryId } from '../glossary.ts';
import { Term } from './ui/Term.tsx';
import '../data-mode.css';

interface ModeValue {
  info: ModeInfo;
  synthetic: ReadonlySet<string>;
  /** Przełącznik trybu danych usługi; `null` w trybie DEMO i przy starszej usłudze. */
  dataMode: DataModeStatus | null;
  /** Zmienia tryb danych w usłudze (od następnej analizy) i odświeża znaczek. */
  changeDataMode(mode: DataMode): Promise<void>;
}

const ModeContext = createContext<ModeValue>({ info: resolveMode(isDemo, null), synthetic: new Set(), dataMode: null, changeDataMode: async () => {} });

const REFRESH_MS = 60_000;

export function ModeProvider({ children }: { children: ReactNode }) {
  const health = useAsync(fetchHealth, 'health');
  // Tryb usługi może się zmienić po restarcie serwera albo w innej karcie — odświeżamy co minutę.
  useEffect(() => {
    if (isDemo) return;
    const timer = setInterval(health.reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [health.reload]);
  const changeDataMode = useCallback(
    async (mode: DataMode) => {
      await api.setDataMode(mode);
      health.reload();
    },
    [health.reload],
  );
  const value = useMemo<ModeValue>(
    () => ({
      info: resolveMode(isDemo, health.data),
      synthetic: syntheticConnectorIds(health.data),
      dataMode: isDemo ? null : dataModeStatus(health.data),
      changeDataMode,
    }),
    [health.data, changeDataMode],
  );
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export const useMode = (): ModeValue => useContext(ModeContext);

const MODE_TERM: Record<ModeInfo['mode'], GlossaryId> = {
  live: 'tryb-live',
  sandbox: 'tryb-sandbox',
  demo: 'tryb-demo',
  unknown: 'tryb-nieustalony',
};

/** Stały, jednoznaczny pasek trybu nad treścią każdego ekranu (także na wydruku). Spokojny, ale zawsze widoczny. */
export function ModeBadge() {
  const { info } = useMode();
  return (
    <div className={`mode-badge mode-${info.mode}`} role="note" aria-label={`Tryb pracy: ${modeText(info)}`}>
      <strong>{info.mode === 'unknown' ? 'TRYB NIEUSTALONY' : info.short}</strong>
      <span>{info.mode === 'unknown' ? 'usługa analizy nie podała, skąd pochodzą dane — traktuj wyniki jak niezweryfikowane' : info.description}</span>
      <DataModeSwitch />
      <span className="mode-what no-print">
        <Term id={MODE_TERM[info.mode]}>co to znaczy?</Term>
      </span>
    </div>
  );
}

/**
 * Kompaktowy przełącznik „Dane: Syntetyczne | Prawdziwe | Oba” w pasku trybu. Zmiana obowiązuje od następnej
 * analizy, bez restartu usługi. Włączenie prawdziwych źródeł wymaga potwierdzenia w oknie dialogowym.
 */
export function DataModeSwitch() {
  const { dataMode, changeDataMode } = useMode();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<DataMode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!dataMode) return null;

  async function apply(mode: DataMode) {
    setBusy(true);
    setError(undefined);
    try {
      await changeDataMode(mode);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function choose(mode: DataMode) {
    if (!dataMode || mode === dataMode.current || busy) return;
    if (needsLiveConfirmation(dataMode.current, mode)) {
      setPending(mode);
      dialog.current?.showModal();
      return;
    }
    void apply(mode);
  }

  return (
    <span className="data-mode no-print">
      <span className="data-mode-label" id="tryb-danych-etykieta">
        Dane:
      </span>
      <span className="segmented data-mode-switch" role="group" aria-labelledby="tryb-danych-etykieta">
        {DATA_MODES.map((mode) => {
          const available = dataMode.available[mode];
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={dataMode.current === mode}
              disabled={busy || !available}
              title={available ? `${DATA_MODE_SHORT[mode]}: ${DATA_MODE_DESCRIPTION[mode]}. Dotyczy nowych analiz.` : DATA_MODE_UNAVAILABLE[mode]}
              onClick={() => choose(mode)}
            >
              {DATA_MODE_SHORT[mode]}
            </button>
          );
        })}
      </span>
      {error && (
        <span className="data-mode-error" role="alert">
          {error}
        </span>
      )}
      <dialog ref={dialog} className="data-mode-dialog" aria-labelledby="tryb-danych-tytul" onClose={() => setPending(undefined)}>
        <h2 id="tryb-danych-tytul">Włączyć prawdziwe źródła?</h2>
        <p>
          <strong>{LIVE_CONFIRMATION}</strong>
        </p>
        <p className="muted">
          Tryb „{pending ? DATA_MODE_SHORT[pending] : ''}”: {pending ? DATA_MODE_DESCRIPTION[pending] : ''}. Do źródeł trafiają wyłącznie identyfikatory potrzebne do zapytania.
          Wcześniejsze analizy zachowują swój tryb.
        </p>
        <form method="dialog" className="help-actions">
          <button
            type="submit"
            className="button button-primary"
            onClick={() => {
              if (pending) void apply(pending);
            }}
          >
            Przełącz na „{pending ? DATA_MODE_SHORT[pending] : ''}”
          </button>
          {/* Atrybut HTML `autofocus`: okno otwiera się z fokusem na bezpiecznym wyborze. */}
          <button type="submit" className="button" {...{ autofocus: '' }}>
            Anuluj
          </button>
        </form>
      </dialog>
    </span>
  );
}

/** Znacznik SANDBOX / LIVE analizy (z jej trybu danych) — w historii spraw i analiz. */
export function RunModeTag({ tag }: { tag: 'SANDBOX' | 'LIVE' | undefined }) {
  if (!tag) return null;
  return (
    <span
      className={`chip chip-run-mode ${tag === 'SANDBOX' ? 'chip-synthetic' : 'chip-ok-soft'}`}
      title={tag === 'SANDBOX' ? 'Analiza na danych syntetycznych (piaskownica, laboratorium).' : 'Analiza z udziałem prawdziwych źródeł publicznych.'}
    >
      {tag}
    </span>
  );
}

/** Znacznik „dane syntetyczne” przy śladzie lub źródle z łącznika piaskownicy albo laboratorium. */
export function SyntheticTag({ source }: { source: SourceRef }) {
  const { synthetic } = useMode();
  if (!isSyntheticSource(source, synthetic)) return null;
  return (
    <span className="chip chip-synthetic" title="Ślad pochodzi z łącznika piaskownicy lub laboratorium — dane wygenerowane do testów, nie z publicznego źródła.">
      <Term id="dane-syntetyczne">dane syntetyczne</Term>
    </span>
  );
}

/** Znak wodny teczki z trybu demo — widoczny na ekranie i na każdej stronie wydruku. */
export function DemoWatermark() {
  if (!isDemo) return null;
  return (
    <>
      <p className="demo-watermark-note" role="note">
        <strong>DEMO — dane przykładowe.</strong> Ta teczka została zbudowana z danych wbudowanych w interfejs. Nie pochodzi ze źródeł publicznych
        ani z blockchaina i nie może być podstawą żadnych ustaleń.
      </p>
      <div className="demo-watermark" aria-hidden="true">
        DEMO — DANE PRZYKŁADOWE
      </div>
    </>
  );
}
