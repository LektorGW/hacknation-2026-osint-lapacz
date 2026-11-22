// „Alerty ryzyka”: jedna lista sygnałów ryzyka z teczki (miksery, możliwe oszustwo, listy sankcyjne i KNF, zajęcia,
// pochodzenie środków, zatruwanie adresu, obieg środków, działalność gospodarcza, dane niepełne) — osobny widok teczki;
// w podsumowaniu tylko jeden globalny wskaźnik (najpoważniejszy poziom i liczba alertów). Czysta logika bez DOM.
// Każde pole teczki jest opcjonalne — starsza usługa analizy może go nie podawać.
import type { DossierTab } from './router.ts';
import { fmtPln, fmtPlnCompact, shorten } from './format.ts';
import { fmtShare, hopsText } from './funds.ts';
import { mixerExposureOf } from './mixers.ts';
import { countText } from './ux.ts';

export type WarningSeverity = 'krytyczne' | 'wysokie' | 'uwaga' | 'informacja';

export type WarningCategory =
  | 'Miksery i CoinJoin'
  | 'Możliwe oszustwo'
  | 'Listy sankcyjne i ostrzeżenia KNF'
  | 'Zajęcie środków'
  | 'Pochodzenie środków'
  | 'Zatruwanie adresu'
  | 'Obieg środków'
  | 'Działalność gospodarcza'
  | 'Osoba publiczna'
  | 'Organizacje'
  | 'Dane niepełne';

export interface Warning {
  id: string;
  severity: WarningSeverity;
  category: WarningCategory;
  /** Jedna krótka linia. */
  title: string;
  /** Jedno zdanie dopowiedzenia. */
  detail: string;
  /** Fakt (np. wpis na liście, etykieta adresu) albo hipoteza narzędzia do weryfikacji. */
  status: 'fakt' | 'hipoteza';
  /** Sekcja teczki ze szczegółami i opcjonalnie kotwica bloku w tej sekcji. */
  link: { tab: DossierTab; anchor?: string };
}

/** Kotwice bloków ze szczegółami (te same identyfikatory co w komponentach sekcji). */
export const WARNING_ANCHORS = {
  mixers: 'miksery',
  scam: 'oszustwo',
  seizures: 'zajecie-srodkow',
  funding: 'pochodzenie-srodkow',
  business: 'wskaznik-d-karta',
} as const;

export const SEVERITY_ORDER: WarningSeverity[] = ['krytyczne', 'wysokie', 'uwaga', 'informacja'];

export const SEVERITY_META: Record<WarningSeverity, { label: string; icon: string }> = {
  krytyczne: { label: 'Krytyczne', icon: '⛔' },
  wysokie: { label: 'Wysokie', icon: '▲' },
  uwaga: { label: 'Uwaga', icon: '●' },
  informacja: { label: 'Informacja', icon: 'ℹ' },
};

/** Teczka widziana defensywnie: wszystkie pola opcjonalne, kształty jak w usłudze analizy. */
type Rec = Record<string, unknown>;
const list = <T = Rec>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const rec = (value: unknown): Rec | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const transakcje = (count: number) => countText(count, 'transakcja', 'transakcje', 'transakcji');
const adresy = (count: number) => countText(count, 'adres', 'adresy', 'adresów');

function mixerWarnings(dossier: Rec): Warning[] {
  const exposure = mixerExposureOf(dossier as never);
  if (!exposure) return [];
  const out: Warning[] = [];
  const link = { tab: 'dowod' as const, anchor: WARNING_ANCHORS.mixers };
  if (exposure.level === 'confirmed') {
    const transfers = [...(exposure.outgoing ?? []), ...(exposure.incoming ?? [])];
    const count = new Set(transfers.map((item) => item.txid)).size;
    const outPln = exposure.totals?.outPln;
    const inPln = exposure.totals?.inPln;
    const amount = outPln ? `ok. ${fmtPlnCompact(outPln)} do miksera` : inPln ? `ok. ${fmtPlnCompact(inPln)} z miksera` : undefined;
    // Etykieta rozpoznana wyłącznie po nazwie to hipoteza; etykieta ze zbioru lub od dostawcy — fakt o adresie miksera.
    const labelled = transfers.some((item) => item.status !== 'hypothesis');
    const names = (exposure.mixers ?? []).filter(Boolean);
    out.push({
      id: 'mikser',
      severity: 'krytyczne',
      category: 'Miksery i CoinJoin',
      title: `Środki przeszły przez mikser${names.length > 0 ? ` (${names.join(', ')})` : ''}`,
      detail: [transakcje(count), amount, 'dalsza droga nieustalona'].filter(Boolean).join(' · '),
      status: labelled ? 'fakt' : 'hipoteza',
      link,
    });
  } else {
    const count = (exposure.coinjoins ?? []).length + (exposure.traceStops ?? []).filter((item) => !item.coinjoin && !item.direct).length;
    out.push({
      id: 'coinjoin',
      severity: 'uwaga',
      category: 'Miksery i CoinJoin',
      title: 'Możliwy udział w CoinJoin lub mikserze',
      detail: `${transakcje(Math.max(1, count))} · heurystyka (np. wiele równych wyjść) — do weryfikacji`,
      status: 'hipoteza',
      link,
    });
  }
  (exposure.sanctions ?? []).forEach((hit, index) => {
    out.push({
      id: `mikser-sankcje-${index}`,
      severity: 'krytyczne',
      category: 'Listy sankcyjne i ostrzeżenia KNF',
      title: `Adres miksera na liście sankcyjnej ${hit.list}`,
      detail: `wpis ${hit.entryId}: „${hit.entryName}” · migawka z ${(hit.retrievedAt ?? '').slice(0, 10)} — fakt o liście`,
      status: 'fakt',
      link,
    });
  });
  return out;
}

interface RiskBadge {
  badge?: string;
  status?: string;
  summary?: string;
}

function riskListWarnings(dossier: Rec): Warning[] {
  const badges = Object.values(rec(dossier.riskLists) ?? {}).map((item) => (rec(item) ?? {}) as RiskBadge);
  const groups = new Map<string, RiskBadge[]>();
  for (const badge of badges) {
    const key = `${badge.badge === 'ostrzeżenie KNF' ? 'knf' : 'sankcje'}:${badge.status === 'source_fact' ? 'fakt' : 'hipoteza'}`;
    groups.set(key, [...(groups.get(key) ?? []), badge]);
  }
  const out: Warning[] = [];
  for (const [key, items] of groups) {
    const [kind, status] = key.split(':') as ['knf' | 'sankcje', 'fakt' | 'hipoteza'];
    const fact = status === 'fakt';
    const first = items.map((item) => str(item.summary)).find(Boolean) ?? (kind === 'knf' ? 'wpis na liście ostrzeżeń publicznych KNF' : 'wpis na liście sankcyjnej');
    const more = items.length > 1 ? ` (+${items.length - 1})` : '';
    out.push({
      id: `listy-${kind}-${status}`,
      severity: fact ? (kind === 'sankcje' ? 'krytyczne' : 'wysokie') : 'uwaga',
      category: 'Listy sankcyjne i ostrzeżenia KNF',
      title:
        kind === 'sankcje'
          ? fact
            ? 'Identyfikator na liście sankcyjnej'
            : 'Nazwa zgodna z wpisem na liście sankcyjnej'
          : fact
            ? 'Wpis na liście ostrzeżeń publicznych KNF'
            : 'Nazwa zgodna z wpisem na liście ostrzeżeń KNF',
      detail: `${first}${more}${fact ? ' — fakt o liście' : ' — możliwy imiennik, do weryfikacji'}`,
      status,
      link: { tab: 'graf' },
    });
  }
  return out;
}

function scamWarnings(dossier: Rec): Warning[] {
  const warnings = rec(dossier.scamWarnings);
  if (!warnings) return [];
  const out: Warning[] = [];
  const link = { tab: 'adresy' as const, anchor: WARNING_ANCHORS.scam };
  const flagged = list<Rec>(warnings.addresses).filter((item) => item.level === 'strong' || item.level === 'reports');
  if (flagged.length > 0) {
    const strong = warnings.level === 'strong' || flagged.some((item) => item.level === 'strong');
    const sources = Math.max(0, ...flagged.map((item) => num(item.independentSources) ?? 0));
    const onList = flagged.some((item) => list(item.listHits).length > 0);
    out.push({
      id: 'oszustwo',
      severity: strong ? 'wysokie' : 'uwaga',
      category: 'Możliwe oszustwo',
      title: strong ? 'Silne ostrzeżenie o możliwym oszustwie' : 'Zgłoszenia możliwego oszustwa',
      detail: [adresy(flagged.length), sources > 0 ? countText(sources, 'niezależne źródło', 'niezależne źródła', 'niezależnych źródeł') : undefined, 'autorzy to poszkodowani lub świadkowie'].filter(Boolean).join(' · '),
      status: onList ? 'fakt' : 'hipoteza',
      link,
    });
  }
  const poisoning = list<Rec>(warnings.poisoning);
  if (poisoning.length > 0) {
    const first = poisoning[0]!;
    out.push({
      id: 'zatruwanie',
      severity: 'uwaga',
      category: 'Zatruwanie adresu',
      title: `Możliwe zatruwanie adresu${poisoning.length > 1 ? ` (${poisoning.length})` : ''}`,
      detail: `kontrahent ${shorten(str(first.lookalike) ?? '?', 6, 4)} naśladuje ${shorten(str(first.genuine) ?? '?', 6, 4)} — dotyczy kontrahentów`,
      status: 'hipoteza',
      link,
    });
  }
  return out;
}

function seizureWarnings(dossier: Rec): Warning[] {
  const items = list<Rec>(dossier.seizures);
  if (items.length === 0) return [];
  const first = items[0]!;
  const value = items.reduce((total, item) => total + (num(item.valuePln) ?? 0), 0);
  return [
    {
      id: 'zajecie',
      severity: 'wysokie',
      category: 'Zajęcie środków',
      title: `Przelew na adres organu państwa${items.length > 1 ? ` (${items.length})` : ''}`,
      detail: `${str(first.counterpartyLabel) ?? 'adres organu'}${value > 0 ? ` · ok. ${fmtPln(value)}` : ''} — zajęcie, nie spieniężenie`,
      status: 'fakt',
      link: { tab: 'podsumowanie', anchor: WARNING_ANCHORS.seizures },
    },
  ];
}

function fundingWarnings(dossier: Rec): Warning[] {
  return list<Rec>(dossier.fundingSources)
    .filter((item) => item.category === 'incident' || item.category === 'sanctioned')
    .map((item, index) => {
      const sanctioned = item.category === 'sanctioned';
      const hops = num(item.hops) ?? 1;
      return {
        id: `pochodzenie-${index}`,
        severity: sanctioned ? 'krytyczne' : 'wysokie',
        category: 'Pochodzenie środków',
        title: sanctioned ? 'Środki z adresu na liście sankcyjnej' : 'Środki z adresu oznaczonego jako incydent',
        detail: `${str(item.label) ?? (sanctioned ? 'adres z listy' : 'incydent')} · udział ${fmtShare(num(item.share), num(item.amount))} · ${hopsText(hops)}`,
        status: hops <= 1 ? 'fakt' : 'hipoteza',
        link: { tab: 'podsumowanie', anchor: WARNING_ANCHORS.funding },
      } satisfies Warning;
    });
}

interface Component {
  rule?: string;
  direction?: string;
  applied?: number;
  explanation?: string;
}

function businessWarnings(dossier: Rec): Warning[] {
  const assessment = rec(rec(dossier.indicators)?.businessActivity);
  if (!assessment) return [];
  const out: Warning[] = [];
  const link = { tab: 'wskazniki' as const, anchor: WARNING_ANCHORS.business };
  const indicator = rec(assessment.indicator);
  const score = num(indicator?.score) ?? 0;
  if (score >= 60) {
    out.push({
      id: 'dzialalnosc',
      severity: 'uwaga',
      category: 'Działalność gospodarcza',
      title: `Sygnały działalności gospodarczej: ${score} · ${str(indicator?.level) ?? 'istotne przesłanki'}`,
      detail: 'możliwie niezgłoszona — status podatkowy znają wyłącznie systemy KAS',
      status: 'hipoteza',
      link,
    });
  }
  const registered = rec(assessment.registered);
  if (registered) {
    const track = rec(registered.indicator);
    const trackScore = num(track?.score) ?? 0;
    if (trackScore >= 60) {
      out.push({
        id: 'podmiot-zarejestrowany',
        severity: 'uwaga',
        category: 'Działalność gospodarcza',
        title: `Podmiot zarejestrowany — sygnały do weryfikacji obrotu: ${trackScore}`,
        detail: 'zgodność obrotu i ryzyko prania pieniędzy — sygnał do sprawdzenia, nie stwierdzenie',
        status: 'hipoteza',
        link,
      });
    }
    const components = list<Component>(track?.components).filter((item) => item.direction !== 'contradicts' && (item.applied ?? 1) > 0);
    const flags: { rule: string; id: string; title: string }[] = [
      { rule: 'business.registered.vat_status_inactive_or_removed', id: 'vat-nieaktywny', title: 'Wpływy przy nieaktywnym statusie VAT lub po wykreśleniu' },
      { rule: 'business.registered.insolvency_or_liquidation', id: 'upadlosc', title: 'Podmiot w likwidacji, upadłości lub restrukturyzacji' },
    ];
    for (const flag of flags) {
      const component = components.find((item) => item.rule === flag.rule);
      if (!component) continue;
      out.push({ id: flag.id, severity: 'uwaga', category: 'Działalność gospodarcza', title: flag.title, detail: str(component.explanation) ?? 'sygnał z rejestru publicznego', status: 'hipoteza', link });
    }
  }
  return out;
}

function identityWarnings(dossier: Rec): Warning[] {
  const out: Warning[] = [];
  const figure = rec(dossier.publicFigure);
  if (figure && figure.status === 'hypothesis' && (str(figure.wikidataId) || list(figure.candidates).length > 0)) {
    out.push({
      id: 'osoba-publiczna',
      severity: 'informacja',
      category: 'Osoba publiczna',
      title: 'Możliwa osoba publiczna — dopasowanie niepotwierdzone',
      detail: `${str(figure.label) ?? str(figure.query) ?? 'wpis w Wikidata'}${figure.match === 'name_only' || figure.match === 'ambiguous' ? ' · zgodność samej nazwy, możliwy imiennik' : ''}`,
      status: 'hipoteza',
      link: { tab: 'osoba' },
    });
  }
  const organizations = list<Rec>(dossier.organizations).filter((item) => item.status !== 'confirmed');
  if (organizations.length > 0) {
    const first = organizations[0]!;
    out.push({
      id: 'organizacje',
      severity: 'informacja',
      category: 'Organizacje',
      title: `Organizacja wskazana w cytowaniach adresu${organizations.length > 1 ? ` (${organizations.length})` : ''}`,
      detail: `${str(first.name) ?? 'organizacja'}${str(first.role) ? ` — ${first.role}` : ''} · do potwierdzenia`,
      status: 'hipoteza',
      link: { tab: 'osoba' },
    });
  }
  return out;
}

function incompleteWarnings(dossier: Rec): Warning[] {
  const out: Warning[] = [];
  if (dossier.partial === true) {
    out.push({
      id: 'wynik-czesciowy',
      severity: 'informacja',
      category: 'Dane niepełne',
      title: 'Wynik częściowy — analizę przerwał limit czasu',
      detail: 'część źródeł lub adresów nie została sprawdzona; to, co widać, może być niepełne',
      status: 'fakt',
      link: { tab: 'analizy' },
    });
  }
  const errors = list<Rec>(dossier.sourceErrors);
  if (errors.length > 0) {
    const names = [...new Set(errors.map((item) => str(item.connectorId) ?? str(item.providerId) ?? str(item.source)).filter((name): name is string => !!name))];
    out.push({
      id: 'bledy-zrodel',
      severity: 'informacja',
      category: 'Dane niepełne',
      title: `${countText(errors.length, 'źródło nie odpowiedziało', 'źródła nie odpowiedziały', 'źródeł nie odpowiedziało')}`,
      detail: names.length > 0 ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` i ${names.length - 3} inne` : ''} — wynik może być niepełny` : 'wynik może być niepełny',
      status: 'fakt',
      link: { tab: 'analizy' },
    });
  }
  const unverified = list<Rec>(dossier.findings)
    .flatMap((finding) => list<Rec>(rec(finding.chain)?.transfers))
    .filter((transfer) => String(transfer.asset ?? '').includes('niezweryfikowany')).length;
  if (unverified > 0) {
    out.push({
      id: 'tokeny-niezweryfikowane',
      severity: 'informacja',
      category: 'Dane niepełne',
      title: `Tokeny o niezweryfikowanym kontrakcie (${countText(unverified, 'przelew', 'przelewy', 'przelewów')})`,
      detail: 'nie wiadomo, co naprawdę przesłano — pominięte w wycenie i ocenie spieniężenia',
      status: 'fakt',
      link: { tab: 'przeplywy' },
    });
  }
  return out;
}

function roundTripWarnings(cycles: number): Warning[] {
  if (cycles <= 0) return [];
  return [
    {
      id: 'ping-pong',
      severity: 'uwaga',
      category: 'Obieg środków',
      title: `Obieg środków (ping-pong): ${countText(cycles, 'obieg', 'obiegi', 'obiegów')}`,
      detail: 'środki wróciły na adres sprawy — to, że to te same środki, jest hipotezą',
      status: 'hipoteza',
      link: { tab: 'graf' },
    },
  ];
}

/**
 * Wszystkie ostrzeżenia teczki od najpoważniejszych. `roundTrips` — liczba obiegów środków („Szukaj dalej”)
 * z sieci sprawy (osobne zapytanie), gdy jest znana.
 */
export function collectWarnings(dossier: unknown, options: { roundTrips?: number } = {}): Warning[] {
  const data = rec(dossier);
  if (!data) return [];
  const all = [
    ...mixerWarnings(data),
    ...riskListWarnings(data),
    ...scamWarnings(data),
    ...seizureWarnings(data),
    ...fundingWarnings(data),
    ...roundTripWarnings(options.roundTrips ?? 0),
    ...businessWarnings(data),
    ...identityWarnings(data),
    ...incompleteWarnings(data),
  ];
  // Sortowanie stabilne: w obrębie poziomu kolejność jak wyżej (najpierw przepływy, potem tło).
  return all.map((item, index) => ({ item, index })).sort((a, b) => SEVERITY_ORDER.indexOf(a.item.severity) - SEVERITY_ORDER.indexOf(b.item.severity) || a.index - b.index).map(({ item }) => item);
}

/** Ostrzeżenia pogrupowane po poziomie (tylko niepuste grupy, od krytycznych). */
export function groupWarnings(warnings: Warning[]): { severity: WarningSeverity; items: Warning[] }[] {
  return SEVERITY_ORDER.map((severity) => ({ severity, items: warnings.filter((item) => item.severity === severity) })).filter((group) => group.items.length > 0);
}

/**
 * Jeden globalny wskaźnik ryzyka do nagłówka podsumowania: najpoważniejszy poziom wśród alertów i ich liczba,
 * np. „Ryzyko: krytyczne · 3 alerty”; bez alertów — „Ryzyko: brak alertów”.
 */
export function riskSummary(warnings: Warning[]): { level: WarningSeverity | 'brak'; count: number; text: string } {
  const level = topSeverity(warnings);
  if (!level) return { level: 'brak', count: 0, text: 'Ryzyko: brak alertów' };
  return { level, count: warnings.length, text: `Ryzyko: ${level} · ${countText(warnings.length, 'alert', 'alerty', 'alertów')}` };
}

/** Najpoważniejszy poziom wśród ostrzeżeń (do koloru odznaki); `undefined` — brak ostrzeżeń. */
export function topSeverity(warnings: Warning[]): WarningSeverity | undefined {
  return SEVERITY_ORDER.find((severity) => warnings.some((item) => item.severity === severity));
}
