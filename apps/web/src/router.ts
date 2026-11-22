// Minimalny routing na `location.hash` — bez zewnętrznych bibliotek.
import { useSyncExternalStore } from 'react';

/** Wszystkie widoki teczki. Identyfikatory są częścią adresów — istniejących nie zmieniamy. */
export const DOSSIER_TABS = [
  { id: 'podsumowanie', label: 'Podsumowanie' },
  { id: 'do-potwierdzenia', label: 'Do potwierdzenia' },
  { id: 'osoba', label: 'Ustalenie osoby' },
  { id: 'profile', label: 'Profile' },
  { id: 'tozsamosci', label: 'Powiązane tożsamości' },
  { id: 'adresy', label: 'Adresy' },
  { id: 'dowod', label: 'Dowód spieniężenia' },
  { id: 'uslugi', label: 'Giełdy i portfele' },
  { id: 'przeplywy', label: 'Przepływy' },
  { id: 'graf', label: 'Graf powiązań' },
  { id: 'wskazniki', label: 'Wskaźniki' },
  { id: 'os-czasu', label: 'Oś czasu' },
  { id: 'osoby', label: 'Osoby powiązane' },
  { id: 'decyzje', label: 'Rejestr decyzji' },
  { id: 'analizy', label: 'Historia analiz' },
] as const;

export type DossierTab = (typeof DOSSIER_TABS)[number]['id'];

export const DEFAULT_TAB: DossierTab = 'podsumowanie';

/**
 * Sekcje teczki w kolejności pracy: najpierw odpowiedź, potem szczegóły.
 * Sekcja z kilkoma widokami pokazuje drugi rząd przełączników.
 */
export const DOSSIER_SECTIONS: { id: string; label: string; tabs: readonly DossierTab[]; description: string }[] = [
  { id: 'podsumowanie', label: 'Podsumowanie', tabs: ['podsumowanie', 'do-potwierdzenia'], description: 'odpowiedź w skrócie, co dalej i co czeka na Twoją decyzję' },
  { id: 'osoba', label: 'Osoba i konta', tabs: ['osoba', 'profile', 'tozsamosci'], description: 'kto to jest i jakie konta prowadzi' },
  { id: 'adresy', label: 'Adresy', tabs: ['adresy'], description: 'adresy krypto i ślady w źródłach' },
  { id: 'pieniadze', label: 'Pieniądze', tabs: ['dowod', 'uslugi', 'przeplywy'], description: 'dokąd trafiły środki' },
  { id: 'graf', label: 'Graf', tabs: ['graf'], description: 'wszystkie powiązania na jednym rysunku' },
  { id: 'wiecej', label: 'Więcej', tabs: ['wskazniki', 'os-czasu', 'osoby', 'decyzje', 'analizy'], description: 'wskaźniki, oś czasu, decyzje, historia' },
];

/** Dodatkowe nazwy w adresie: nazwy sekcji i krótkie skróty prowadzą do właściwego widoku. */
export const TAB_ALIASES: Record<string, DossierTab> = {
  ustalenie: 'osoba',
  konta: 'profile',
  pieniadze: 'dowod',
  spieniezenie: 'dowod',
  gieldy: 'uslugi',
  wiecej: 'wskazniki',
  czas: 'os-czasu',
  historia: 'analizy',
  potwierdz: 'do-potwierdzenia',
  kolejka: 'do-potwierdzenia',
};

export const sectionOf = (tab: DossierTab) => DOSSIER_SECTIONS.find((section) => section.tabs.includes(tab)) ?? DOSSIER_SECTIONS[0]!;

export const tabLabel = (tab: DossierTab) => DOSSIER_TABS.find((item) => item.id === tab)?.label ?? tab;

export type Route =
  | { page: 'dashboard' }
  | { page: 'case'; caseId: string; tab: DossierTab }
  | { page: 'run'; runId: string; tab: DossierTab }
  | { page: 'sweep'; sweepId?: string }
  | { page: 'stats' }
  | { page: 'monitor' }
  | { page: 'rules' }
  | { page: 'security' };

function decode(part: string | undefined): string | undefined {
  if (!part) return undefined;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export const toTab = (value: string | undefined): DossierTab =>
  DOSSIER_TABS.find((tab) => tab.id === value)?.id ?? (value ? TAB_ALIASES[value] : undefined) ?? DEFAULT_TAB;

export function parseRoute(hash: string): Route {
  // Część po „?” to parametry widoku (np. warstwa grafu) — nie wpływa na wybór strony i zakładki.
  const [first, rawSecond, third] = hash.replace(/^#\/?/, '').split('?')[0]!.split('/');
  const second = decode(rawSecond);
  if (first === 'sprawa' && second) return { page: 'case', caseId: second, tab: toTab(third) };
  if (first === 'analiza' && second) return { page: 'run', runId: second, tab: toTab(third) };
  if (first === 'typowanie') return { page: 'sweep', sweepId: second };
  if (first === 'statystyki') return { page: 'stats' };
  if (first === 'monitoring') return { page: 'monitor' };
  if (first === 'zasady') return { page: 'rules' };
  if (first === 'bezpieczenstwo') return { page: 'security' };
  return { page: 'dashboard' };
}

const withTab = (base: string, tab?: DossierTab) => (tab && tab !== DEFAULT_TAB ? `${base}/${tab}` : base);

export const href = {
  dashboard: () => '#/',
  case: (caseId: string, tab?: DossierTab) => withTab(`#/sprawa/${encodeURIComponent(caseId)}`, tab),
  run: (runId: string, tab?: DossierTab) => withTab(`#/analiza/${encodeURIComponent(runId)}`, tab),
  sweep: (sweepId?: string) => (sweepId ? `#/typowanie/${encodeURIComponent(sweepId)}` : '#/typowanie'),
  stats: () => '#/statystyki',
  monitor: () => '#/monitoring',
  rules: () => '#/zasady',
  security: () => '#/bezpieczenstwo',
};

/** Warstwa grafu zapisana w adresie strony: `…/graf?warstwa=osint` albo `…/graf?warstwa=blockchain`. */
export type GraphLayerParam = 'identity' | 'chain' | 'both';

const LAYER_PARAM: Record<string, GraphLayerParam> = { osint: 'identity', blockchain: 'chain', obie: 'both' };

export function graphLayerFromHash(hash: string): GraphLayerParam | undefined {
  const query = hash.split('?')[1];
  if (!query) return undefined;
  return LAYER_PARAM[new URLSearchParams(query).get('warstwa') ?? ''];
}

/** Odnośnik do grafu otwartego od razu we wskazanej warstwie. */
export const withGraphLayer = (graphHref: string, layer: 'osint' | 'blockchain'): string => `${graphHref}?warstwa=${layer}`;

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
