// Znaczek trybu pracy (DEMO / SANDBOX / LIVE) i oznaczenie danych syntetycznych przy śladach.
import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { fetchHealth, isDemo } from '../api.ts';
import { isSyntheticSource, modeText, resolveMode, syntheticConnectorIds } from '../mode.ts';
import type { ModeInfo, SourceRef } from '../mode.ts';
import { useAsync } from '../useAsync.ts';

interface ModeValue {
  info: ModeInfo;
  synthetic: ReadonlySet<string>;
}

const ModeContext = createContext<ModeValue>({ info: resolveMode(isDemo, null), synthetic: new Set() });

const REFRESH_MS = 60_000;

export function ModeProvider({ children }: { children: ReactNode }) {
  const health = useAsync(fetchHealth, 'health');
  // Tryb usługi może się zmienić po restarcie serwera — odświeżamy co minutę.
  useEffect(() => {
    if (isDemo) return;
    const timer = setInterval(health.reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [health.reload]);
  const value = useMemo<ModeValue>(() => ({ info: resolveMode(isDemo, health.data), synthetic: syntheticConnectorIds(health.data) }), [health.data]);
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export const useMode = (): ModeValue => useContext(ModeContext);

/** Stały, jednoznaczny pasek trybu nad treścią każdego ekranu (także na wydruku). */
export function ModeBadge() {
  const { info } = useMode();
  return (
    <p className={`mode-badge mode-${info.mode}`} role="note" aria-label={`Tryb pracy: ${modeText(info)}`}>
      <strong>{info.mode === 'unknown' ? 'TRYB NIEUSTALONY' : info.short}</strong>
      <span>{info.mode === 'unknown' ? 'usługa analizy nie podała, skąd pochodzą dane — traktuj wyniki jak niezweryfikowane' : info.description}</span>
    </p>
  );
}

/** Znacznik „dane syntetyczne” przy śladzie lub źródle z łącznika piaskownicy albo laboratorium. */
export function SyntheticTag({ source }: { source: SourceRef }) {
  const { synthetic } = useMode();
  if (!isSyntheticSource(source, synthetic)) return null;
  return (
    <span className="chip chip-synthetic" title="Ślad pochodzi z łącznika piaskownicy lub laboratorium — dane wygenerowane do testów, nie z publicznego źródła.">
      dane syntetyczne
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
