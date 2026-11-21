// Minimalny routing na `location.hash` — bez zewnętrznych bibliotek.
import { useSyncExternalStore } from 'react';

export const DOSSIER_TABS = [
  { id: 'dowod', label: 'Dowód spieniężenia' },
  { id: 'tozsamosci', label: 'Powiązane tożsamości' },
  { id: 'uslugi', label: 'Giełdy i portfele' },
  { id: 'graf', label: 'Graf powiązań' },
  { id: 'wskazniki', label: 'Wskaźniki' },
  { id: 'profile', label: 'Profile' },
  { id: 'adresy', label: 'Adresy' },
  { id: 'przeplywy', label: 'Przepływy' },
  { id: 'os-czasu', label: 'Oś czasu' },
  { id: 'osoby', label: 'Osoby powiązane' },
  { id: 'decyzje', label: 'Rejestr decyzji' },
  { id: 'analizy', label: 'Historia analiz' },
] as const;

export type DossierTab = (typeof DOSSIER_TABS)[number]['id'];

export type Route =
  | { page: 'dashboard' }
  | { page: 'case'; caseId: string; tab: DossierTab }
  | { page: 'run'; runId: string; tab: DossierTab }
  | { page: 'sweep'; sweepId?: string }
  | { page: 'monitor' }
  | { page: 'rules' };

function decode(part: string | undefined): string | undefined {
  if (!part) return undefined;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

const toTab = (value: string | undefined): DossierTab =>
  DOSSIER_TABS.find((tab) => tab.id === value)?.id ?? 'dowod';

export function parseRoute(hash: string): Route {
  const [first, rawSecond, third] = hash.replace(/^#\/?/, '').split('/');
  const second = decode(rawSecond);
  if (first === 'sprawa' && second) return { page: 'case', caseId: second, tab: toTab(third) };
  if (first === 'analiza' && second) return { page: 'run', runId: second, tab: toTab(third) };
  if (first === 'typowanie') return { page: 'sweep', sweepId: second };
  if (first === 'monitoring') return { page: 'monitor' };
  if (first === 'zasady') return { page: 'rules' };
  return { page: 'dashboard' };
}

const withTab = (base: string, tab?: DossierTab) => (tab && tab !== 'dowod' ? `${base}/${tab}` : base);

export const href = {
  dashboard: () => '#/',
  case: (caseId: string, tab?: DossierTab) => withTab(`#/sprawa/${encodeURIComponent(caseId)}`, tab),
  run: (runId: string, tab?: DossierTab) => withTab(`#/analiza/${encodeURIComponent(runId)}`, tab),
  sweep: (sweepId?: string) => (sweepId ? `#/typowanie/${encodeURIComponent(sweepId)}` : '#/typowanie'),
  monitor: () => '#/monitoring',
  rules: () => '#/zasady',
};

export function navigate(target: string): void {
  location.hash = target;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash);
}
