// Siła powiązań w siatce (rozwijanie sieci na żądanie): katalog relacji, siła ścieżki z zanikiem
// na krokach-hipotezach, najsłabsze ogniwo i uczciwa klasyfikacja ścieżki do podmiotu sprawy.
//
// Zasady (wspólne dla usługi analizy i interfejsu — plik bez zależności, czysta logika):
//   - każda relacja ma status (fakt źródłowy / obliczenie / hipoteza / potwierdzenie / odrzucenie) i siłę 0–1;
//   - siła ścieżki = iloczyn sił kroków; krok-hipoteza dodatkowo mnożony przez ZANIK (`HYPOTHESIS_DECAY`);
//   - najpierw szukamy ścieżki złożonej wyłącznie z faktów, obliczeń i potwierdzeń — dopiero gdy jej nie ma,
//     dopuszczamy hipotezy;
//   - BEZPIECZNIK „winy przez skojarzenie”: węzeł osiągalny wyłącznie przez hipotezy nigdy nie jest opisany
//     mocniej niż „w siatce — ścieżka poszlakowa”, bez względu na liczby.

export type NetworkClaimStatus = 'source_fact' | 'computed' | 'hypothesis' | 'confirmed' | 'rejected';

/** Rodzaje relacji tworzonych przez moduły rozwijania (ekspandery). */
export type NetworkRelation =
  | 'publishes_identifier'
  | 'same_email'
  | 'same_phone'
  | 'same_nick'
  | 'same_url'
  | 'links_account'
  | 'mutual_link'
  | 'email_domain'
  | 'rdap_registrant'
  | 'site_contact'
  | 'same_wallet'
  | 'co_depositor'
  | 'counterparty'
  | 'roundtrip_hop'
  | 'cited_in'
  | 'authored'
  | 'holds_role'
  | 'org_parent'
  | 'shared_officer'
  | 'sanctions_hit'
  | 'sanctions_name_match'
  | 'co_mentioned'
  | 'family_relation'
  | 'org_member'
  | 'follows'
  | 'repo_contributor'
  | 'repo_collaboration'
  | 'close_collaboration';

export interface RelationSpec {
  label: string;
  /** Siła bazowa 0–1: jak mocno relacja wiąże dwa byty (nie: jak pewny jest fakt). */
  strength: number;
  status: NetworkClaimStatus;
  /** Czego relacja NIE dowodzi — pokazywane analitykowi. */
  caveat: string;
}

/** Katalog relacji: etykieta, siła bazowa, status i zastrzeżenie. */
export const NETWORK_RELATIONS: Record<NetworkRelation, RelationSpec> = {
  publishes_identifier: { label: 'publikuje identyfikator', strength: 0.9, status: 'source_fact', caveat: 'Konto samo podało ten identyfikator — to deklaracja, nie dowód, że należy do tej samej osoby co inne konta.' },
  same_email: { label: 'ten sam e-mail', strength: 0.85, status: 'source_fact', caveat: 'Identyczny adres e-mail w publicznym profilu; skrzynka może być współdzielona (firma, rodzina).' },
  same_phone: { label: 'ten sam telefon', strength: 0.85, status: 'source_fact', caveat: 'Identyczny numer telefonu; numer bywa firmowy albo przekazany innej osobie.' },
  same_nick: { label: 'wspólny nick', strength: 0.35, status: 'hypothesis', caveat: 'Zbieżność nazwy konta — ten sam nick może należeć do różnych osób.' },
  same_url: { label: 'ta sama strona WWW', strength: 0.6, status: 'source_fact', caveat: 'Ta sama strona wskazana przez oba byty; strona może być wspólna (firma, projekt).' },
  links_account: { label: 'odnośnik do konta', strength: 0.7, status: 'source_fact', caveat: 'Profil wskazuje inne konto odnośnikiem; jednostronny odnośnik nie potwierdza własności.' },
  mutual_link: { label: 'wzajemne odnośniki', strength: 0.9, status: 'computed', caveat: 'Oba konta wskazują się nawzajem — silna przesłanka wspólnego operatora, nie ustalenie osoby.' },
  email_domain: { label: 'domena adresu e-mail', strength: 0.5, status: 'computed', caveat: 'Domena wynika z zapisu adresu e-mail; z jednej domeny korzysta wiele osób.' },
  rdap_registrant: { label: 'abonent domeny (RDAP)', strength: 0.7, status: 'source_fact', caveat: 'Dane abonenta z rejestru domen (RDAP); dane osobowe rejestry redagują (RODO).' },
  site_contact: { label: 'kontakt na stronie domeny', strength: 0.8, status: 'source_fact', caveat: 'Kontakt opublikowany na stronie domeny — dotyczy właściciela strony, nie każdej osoby z tej domeny.' },
  same_wallet: { label: 'ten sam portfel (heurystyka)', strength: 0.6, status: 'hypothesis', caveat: 'Heurystyka portfela (wspólne wejścia, reszta) — wnioskowanie, nie zapis w blockchainie.' },
  co_depositor: { label: 'wspólny adres wpłat', strength: 0.5, status: 'hypothesis', caveat: 'Wpłaty na ten sam adres wpłat usługi — adres wpłat wskazano wnioskowaniem.' },
  counterparty: { label: 'kontrahent przelewu', strength: 0.25, status: 'source_fact', caveat: 'Przelew zapisany w blockchainie; kontrahent (darczyńca, klient) nie jest osobą ze sprawy.' },
  roundtrip_hop: { label: 'przelew w obiegu środków', strength: 0.25, status: 'source_fact', caveat: 'Przelew zapisany w blockchainie (fakt); to, że w obiegu krążą te same środki albo działa ta sama osoba, jest hipotezą.' },
  cited_in: { label: 'cytowany w publikacji', strength: 0.6, status: 'source_fact', caveat: 'Publikacja zawiera ten identyfikator; cytat nie oznacza własności.' },
  authored: { label: 'autor publikacji', strength: 0.9, status: 'source_fact', caveat: 'Autor wskazany przez serwis.' },
  holds_role: { label: 'rola w organizacji (rejestr)', strength: 0.8, status: 'source_fact', caveat: 'Rola w rejestrze publicznym — nie oznacza własności adresu ani udziału w czynach organizacji.' },
  org_parent: { label: 'jednostka dominująca / zależna', strength: 0.8, status: 'source_fact', caveat: 'Relacja kapitałowa według rejestru.' },
  shared_officer: { label: 'wspólny członek zarządu', strength: 0.6, status: 'computed', caveat: 'Ta sama osoba w rolach w obu podmiotach (według rejestru).' },
  sanctions_hit: { label: 'wpis na liście sankcyjnej', strength: 1, status: 'source_fact', caveat: 'Dokładna zgodność identyfikatora z wpisem listy — fakt dotyczy WYŁĄCZNIE bytu z listy, nie osób powiązanych.' },
  sanctions_name_match: { label: 'zgodność nazwy z wpisem listy', strength: 0.4, status: 'hypothesis', caveat: 'Zgodna tylko nazwa — możliwy imiennik; wymaga porównania identyfikatorów.' },
  co_mentioned: { label: 'wspólna wzmianka w publikacji', strength: 0.2, status: 'hypothesis', caveat: 'Dwa identyfikatory w tej samej publikacji — bardzo słaba przesłanka.' },
  family_relation: { label: 'relacja rodzinna według Wikidata', strength: 0.3, status: 'source_fact', caveat: 'Relacja rodzinna według Wikidata — nie jest dowodem czegokolwiek (ani wspólnych interesów, ani udziału w czynach).' },
  // Relacje konta w serwisach z kodem (GitHub; rozwinięcie „relacje w serwisach”, tylko na żądanie).
  org_member: { label: 'członek organizacji w serwisie', strength: 0.5, status: 'source_fact', caveat: 'Publiczne członkostwo konta w organizacji serwisu — relacja zawodowa/projektowa; nie oznacza wspólnego operatora ani udziału w czynach organizacji.' },
  follows: { label: 'obserwuje konto', strength: 0.1, status: 'source_fact', caveat: 'Obserwowanie konta nie świadczy o znajomości — to bardzo słaba relacja.' },
  repo_contributor: { label: 'współtwórca repozytorium', strength: 0.4, status: 'source_fact', caveat: 'Współtwórca repozytorium to relacja zawodowa/projektowa — nie dowodzi znajomości ani wspólnego operatora.' },
  repo_collaboration: { label: 'współpraca w repozytorium', strength: 0.4, status: 'computed', caveat: 'Oba konta mają wkład w to samo repozytorium — relacja zawodowa/projektowa, nie tożsamość.' },
  close_collaboration: { label: 'bliska współpraca (wzajemne obserwowanie i wspólne repozytorium)', strength: 0.55, status: 'computed', caveat: 'Wzajemne obserwowanie i wspólne repozytorium — przesłanka bliskiej współpracy zawodowej, nie znajomości prywatnej ani tożsamości.' },
};

/** Zanik siły na każdym kroku-hipotezie (mnożnik). */
export const HYPOTHESIS_DECAY = 0.6;
/** Od tej siły ścieżka złożona z faktów jest opisana jako udokumentowana. */
export const DOCUMENTED_PATH = 0.5;

export interface PathEdge {
  id: string;
  from: string;
  to: string;
  kind?: string;
  status?: NetworkClaimStatus | string;
  inferred?: boolean;
  weight?: number;
  layer?: 'identity' | 'chain';
  /** Relacja z katalogu (krawędzie z rozwinięć). */
  relation?: string;
  /** Siła 0–1 (krawędzie z rozwinięć); bez niej liczona ze statusu i wagi. */
  strength?: number;
  label?: string;
}

const STATUSES: NetworkClaimStatus[] = ['source_fact', 'computed', 'hypothesis', 'confirmed', 'rejected'];

/** Status krawędzi; nieznany status traktujemy ostrożnie — jak hipotezę. */
export function pathEdgeStatus(edge: Pick<PathEdge, 'status' | 'inferred'>): NetworkClaimStatus {
  if (edge.status !== undefined) return STATUSES.includes(edge.status as NetworkClaimStatus) ? (edge.status as NetworkClaimStatus) : 'hypothesis';
  return edge.inferred ? 'hypothesis' : 'source_fact';
}

/** Siła relacji 0–1: jawna (rozwinięcia), z katalogu relacji, albo szacowana ze statusu i wagi krawędzi teczki. */
export function edgeStrength(edge: PathEdge): number {
  if (typeof edge.strength === 'number') return clamp(edge.strength);
  const spec = edge.relation ? NETWORK_RELATIONS[edge.relation as NetworkRelation] : undefined;
  if (spec) return spec.strength;
  const status = pathEdgeStatus(edge);
  // Przepływy w blockchainie mają wagę względnej wartości, nie siły powiązania tożsamości.
  if (edge.layer === 'chain' || edge.kind === 'transfer' || edge.kind === 'cash_out') return 0.3;
  if (status === 'hypothesis') return clamp(edge.weight !== undefined ? edge.weight / 100 : 0.5);
  if (status === 'computed') return 0.8;
  return 0.9;
}

const clamp = (value: number) => Math.max(0.01, Math.min(1, value));

/** Siła jednego kroku ścieżki: siła relacji × zanik dla hipotezy. */
export function hopStrength(edge: PathEdge): number {
  const status = pathEdgeStatus(edge);
  if (status === 'rejected') return 0;
  return edgeStrength(edge) * (status === 'hypothesis' ? HYPOTHESIS_DECAY : 1);
}

/** Nazwy rodzajów krawędzi grafu teczki — podpis krawędzi bywa kwotą („krok 1: 0,8 BTC”), więc nie służy za nazwę relacji. */
const EDGE_KIND_NAME: Record<string, string> = {
  has_identifier: 'identyfikator podmiotu',
  found_profile: 'konto odnalezione po identyfikatorze',
  links_to: 'wskazanie w profilu',
  publishes: 'publikuje adres',
  transfer: 'przelew',
  cash_out: 'krok ścieżki środków',
  related: 'powiązanie',
  operates: 'hipoteza operatora kont',
  declares: 'występuje pod nazwą',
  documented_by: 'udokumentowane w źródle',
  same_operator: 'wspólny operator',
  beneficiary_of: 'beneficjent zbiórki',
  holds_role: 'rola w organizacji',
  org_relation: 'relacja organizacji',
};

/** Nazwa relacji dla analityka: z katalogu relacji, z rodzaju krawędzi albo z jej podpisu. */
export function relationLabel(edge: PathEdge): string {
  const spec = edge.relation ? NETWORK_RELATIONS[edge.relation as NetworkRelation] : undefined;
  return spec?.label ?? (edge.kind ? EDGE_KIND_NAME[edge.kind] : undefined) ?? edge.label ?? edge.kind ?? 'relacja';
}

export const NETWORK_STATUS_WORD: Record<NetworkClaimStatus, string> = {
  source_fact: 'fakt źródłowy',
  computed: 'obliczenie',
  hypothesis: 'hipoteza',
  confirmed: 'potwierdzone',
  rejected: 'odrzucone',
};

export type PathLevel = 'documented' | 'distant' | 'circumstantial';

export const PATH_LEVEL_LABEL: Record<PathLevel, string> = {
  documented: 'powiązanie udokumentowane faktami (bez hipotez)',
  distant: 'w siatce — powiązanie odległe (same fakty, ale słabe ogniwa)',
  circumstantial: 'w siatce — ścieżka poszlakowa',
};

export interface PathStep {
  edge: PathEdge;
  from: string;
  to: string;
  status: NetworkClaimStatus;
  strength: number;
}

export interface StrengthPath {
  nodes: string[];
  steps: PathStep[];
  /** Iloczyn sił kroków (z zanikiem na hipotezach), 0–1. */
  strength: number;
  hypotheses: number;
  weakest?: { edgeId: string; label: string; status: NetworkClaimStatus; strength: number };
  level: PathLevel;
  /** Np. „ścieżka: 3 kroki, najsłabsze ogniwo: wspólny nick (hipoteza)”. */
  summary: string;
}

/**
 * Najmocniejsza ścieżka między węzłami (relacje nieskierowane). Najpierw wyłącznie fakty, obliczenia
 * i potwierdzenia; gdy takiej drogi nie ma — dopuszczone hipotezy. Relacje odrzucone nie tworzą ścieżki.
 * Przy tej samej podstawie wygrywa większy iloczyn sił (Dijkstra po −log siły).
 */
export function strongestPath(edges: PathEdge[], from: string, to: string): StrengthPath | null {
  if (from === to) return describePath([from], []);
  for (const allowHypotheses of [false, true]) {
    const around = new Map<string, { edge: PathEdge; other: string }[]>();
    for (const edge of edges) {
      const status = pathEdgeStatus(edge);
      if (edge.from === edge.to || status === 'rejected' || (!allowHypotheses && status === 'hypothesis')) continue;
      if (hopStrength(edge) <= 0) continue;
      for (const [a, b] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
        if (!around.has(a)) around.set(a, []);
        around.get(a)!.push({ edge, other: b });
      }
    }
    const cost = new Map<string, number>([[from, 0]]);
    const previous = new Map<string, { edge: PathEdge; node: string }>();
    const done = new Set<string>();
    for (;;) {
      let current: string | undefined;
      for (const [id, value] of cost) if (!done.has(id) && (current === undefined || value < cost.get(current)! || (value === cost.get(current)! && id < current))) current = id;
      if (current === undefined || current === to) break;
      done.add(current);
      for (const { edge, other } of around.get(current) ?? []) {
        // Drobna kara za każdy krok: przy równej sile wygrywa ścieżka krótsza.
        const value = cost.get(current)! - Math.log(hopStrength(edge)) + 1e-6;
        if (value < (cost.get(other) ?? Infinity) - 1e-12) {
          cost.set(other, value);
          previous.set(other, { edge, node: current });
        }
      }
    }
    if (!previous.has(to)) continue;
    const nodes = [to];
    const used: PathEdge[] = [];
    for (let at = to; at !== from; at = previous.get(at)!.node) {
      used.unshift(previous.get(at)!.edge);
      nodes.unshift(previous.get(at)!.node);
    }
    return describePath(nodes, used);
  }
  return null;
}

/** Opis ścieżki: siła, najsłabsze ogniwo, poziom i zdanie podsumowania. */
export function describePath(nodes: string[], edges: PathEdge[]): StrengthPath {
  const steps: PathStep[] = edges.map((edge, index) => ({ edge, from: nodes[index]!, to: nodes[index + 1]!, status: pathEdgeStatus(edge), strength: hopStrength(edge) }));
  const strength = steps.reduce((total, step) => total * step.strength, 1);
  const hypotheses = steps.filter((step) => step.status === 'hypothesis').length;
  let weakest: StrengthPath['weakest'];
  for (const step of steps) {
    if (!weakest || step.strength < weakest.strength) weakest = { edgeId: step.edge.id, label: relationLabel(step.edge), status: step.status, strength: step.strength };
  }
  const level: PathLevel = hypotheses > 0 ? 'circumstantial' : strength >= DOCUMENTED_PATH ? 'documented' : 'distant';
  const count = steps.length;
  const word = count === 1 ? 'krok' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'kroki' : 'kroków';
  const summary =
    count === 0
      ? 'ten sam węzeł'
      : `ścieżka: ${count} ${word}${weakest ? `, najsłabsze ogniwo: ${weakest.label} (${NETWORK_STATUS_WORD[weakest.status]})` : ''}`;
  return { nodes, steps, strength, hypotheses, ...(weakest ? { weakest } : {}), level, summary };
}

/**
 * Bezpiecznik „winy przez skojarzenie”: opis powiązania bytu z podmiotem sprawy.
 * Ścieżka z choćby jedną hipotezą (czyli: brak drogi po samych faktach) daje najwyżej „ścieżka poszlakowa”.
 */
export function linkToSubjectLabel(path: StrengthPath | null): string {
  if (!path) return 'poza siatką podmiotu — brak ścieżki';
  return PATH_LEVEL_LABEL[path.level];
}
