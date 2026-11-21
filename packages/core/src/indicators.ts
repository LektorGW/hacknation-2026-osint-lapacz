// Trzy osobne wskaźniki śledcze i wspólny format ich składników.
//
//   A. Konto → portfel   (`account_wallet`)  — na ile KONKRETNE KONTO publicznie deklaruje związek z adresem;
//   B. Wspólny operator  (`common_operator`) — na ile dwa KONKRETNE KONTA może obsługiwać ten sam operator;
//   C. Wyjście do fiat   (`cash_out`)        — na ile dane wskazują wymianę kryptowalut na waluty tradycyjne.
//
// Żaden z nich nie jest skalibrowanym prawdopodobieństwem: to wskaźniki porządkowe 0–100 z jawnych
// reguł eksperckich. Każdy składnik niesie regułę, wagę, źródło, dowód, wyjaśnienie, ocenę
// niezależności i ograniczenia — tak, by analityk mógł odtworzyć liczbę i ją zakwestionować.
//
// Model pojęć (rozdzielone celowo):
//   konto       — jeden profil w jednej usłudze (`ProfileCard`, klucz `usługa|nazwa konta`);
//   persona     — deklarowana tożsamość: nazwa, pod którą występuje jedno lub kilka kont;
//   hipoteza    — przypuszczenie narzędzia, że konta/persony obsługuje wspólny operator;
//   potwierdzenie — hipoteza przyjęta decyzją analityka albo oparta na dowodzie kryptograficznym.
// Hipoteza nigdy nie staje się faktem sama z siebie.

/** Status twierdzenia: skąd wiemy to, co pokazujemy. */
export type ClaimStatus =
  /** Fakt wprost ze źródła: publikacja, rekord, transakcja w blockchainie. */
  | 'source_fact'
  /** Wynik obliczeń na faktach (sumy, wyceny, ścieżka środków wprost z transakcji). */
  | 'computed'
  /** Hipoteza analityczna narzędzia — do weryfikacji. */
  | 'hypothesis'
  /** Hipoteza potwierdzona decyzją analityka. */
  | 'confirmed'
  /** Powiązanie odrzucone decyzją analityka albo wykluczone sprzecznością. */
  | 'rejected';

export interface EvidenceRef {
  kind: 'url' | 'txid' | 'attribute' | 'address' | 'evidence_id' | 'decision';
  value: string;
}

export type Independence =
  /** Składnik opiera się na pochodzeniu niezależnym od pozostałych składników. */
  | 'independent'
  /** Składnik powtarza informację innego składnika (kopia, ta sama cecha) — nie jest liczony ponownie. */
  | 'dependent'
  /** Jedyny składnik danego rodzaju — nie ma z czym porównać. */
  | 'single'
  | 'not_applicable';

/** Jeden składnik punktacji wskaźnika. */
export interface ScoreComponent {
  /** Stały identyfikator reguły, np. `operator.same_email`. */
  rule: string;
  /** Waga reguły w punktach; ujemna dla kontrdowodu. */
  weight: number;
  /** Punkty faktycznie doliczone do wyniku (po zasadzie malejących korzyści i niezależności). */
  applied: number;
  direction: 'supports' | 'contradicts';
  /** Skąd pochodzi przesłanka: usługa, moduł danych blockchain, decyzja analityka. */
  source: string;
  evidence: EvidenceRef[];
  explanation: string;
  independence: Independence;
  independenceNote?: string;
  /** Czego ten składnik nie dowodzi. */
  limitations: string[];
  /** Kontrdowód twardy: wyklucza automatyczne przyjęcie hipotezy bez względu na sumę punktów. */
  blocking?: boolean;
}

export type IndicatorKind = 'account_wallet' | 'common_operator' | 'cash_out';

export interface Indicator {
  kind: IndicatorKind;
  /** Wskaźnik porządkowy 0–100. */
  score: number;
  /** Poziom słowny. */
  level: string;
  calibrated: false;
  /** Jak czytać liczbę. */
  scale: string;
  components: ScoreComponent[];
  limitations: string[];
}

export const INDICATOR_SCALE =
  'Wskaźnik porządkowy 0–100 z jawnych reguł eksperckich; nie jest skalibrowanym statystycznie prawdopodobieństwem.';

export const INDICATOR_LEVELS: { min: number; label: string }[] = [
  { min: 80, label: 'mocne przesłanki' },
  { min: 60, label: 'istotne przesłanki' },
  { min: 40, label: 'umiarkowane przesłanki' },
  { min: 10, label: 'słabe przesłanki' },
  { min: 0, label: 'brak przesłanek' },
];

export const indicatorLevel = (score: number): string => INDICATOR_LEVELS.find((level) => score >= level.min)!.label;

export const COMBINE_RULES = {
  /** Kolejny NIEZALEŻNY składnik potwierdzający dolicza tę część swojej wagi. */
  extraShare: 0.2,
  /** Łączna premia za kolejne składniki nie przekracza tylu punktów. */
  maxExtra: 15,
  /** Bez decyzji analityka albo dowodu kryptograficznego wskaźnik nie przekracza tej wartości. */
  capWithoutConfirmation: 95,
  /** Twardy kontrdowód ogranicza wskaźnik do tej wartości (poniżej progu automatycznego łączenia). */
  capWhenBlocked: 45,
} as const;

export interface ComponentDraft extends Omit<ScoreComponent, 'applied' | 'independence'> {
  /**
   * Klucz pochodzenia: składniki o tym samym kluczu powtarzają tę samą informację
   * (np. ten sam e-mail widoczny w dwóch miejscach) i liczą się raz.
   */
  originKey?: string;
}

/**
 * Składa wskaźnik ze składników. Wynik = najmocniejszy składnik potwierdzający
 * + 20% wagi każdego kolejnego NIEZALEŻNEGO (łącznie najwyżej +15) − kontrdowody,
 * ograniczony do 95 bez potwierdzenia i do 45, gdy istnieje kontrdowód twardy.
 * Składniki powtarzające to samo pochodzenie są pokazane, ale nie doliczane.
 */
export function combineComponents(kind: IndicatorKind, drafts: ComponentDraft[], options: { confirmed?: boolean; limitations?: string[] } = {}): Indicator {
  const supports = drafts.filter((item) => item.direction === 'supports').sort((a, b) => b.weight - a.weight);
  const contradicts = drafts.filter((item) => item.direction === 'contradicts');
  const seen = new Set<string>();
  const components: ScoreComponent[] = [];
  let score = 0;
  let extra = 0;
  const independentCount = new Set(supports.map((item, index) => item.originKey ?? `#${index}`)).size;
  supports.forEach((draft, index) => {
    const { originKey, ...rest } = draft;
    const key = originKey ?? `#${index}`;
    if (seen.has(key)) {
      components.push({ ...rest, applied: 0, independence: 'dependent', independenceNote: rest.independenceNote ?? 'Powtarza informację składnika już policzonego — nie jest doliczany.' });
      return;
    }
    seen.add(key);
    let applied: number;
    if (seen.size === 1) applied = rest.weight;
    else {
      applied = Math.max(0, Math.min(Math.round(rest.weight * COMBINE_RULES.extraShare), COMBINE_RULES.maxExtra - extra));
      extra += applied;
    }
    score += applied;
    components.push({ ...rest, applied, independence: independentCount > 1 ? 'independent' : 'single' });
  });
  for (const draft of contradicts) {
    const { originKey: _origin, ...rest } = draft;
    const applied = -Math.abs(rest.weight);
    score += applied;
    components.push({ ...rest, weight: applied, applied, independence: 'not_applicable' });
  }
  const blocked = contradicts.some((item) => item.blocking);
  score = Math.max(0, Math.min(100, score));
  if (options.confirmed) score = 100;
  else {
    score = Math.min(score, COMBINE_RULES.capWithoutConfirmation);
    if (blocked) score = Math.min(score, COMBINE_RULES.capWhenBlocked);
  }
  return { kind, score, level: indicatorLevel(score), calibrated: false, scale: INDICATOR_SCALE, components, limitations: options.limitations ?? [] };
}

// ---------- A. Konto → portfel ----------

export interface AccountWalletLink {
  id: string;
  /** `ProfileCard.id` konta deklarującego adres. */
  accountId: string;
  service: string;
  handle?: string;
  accountUrl: string;
  address: string;
  network: string;
  /** Klasa adresu według danych blockchain i publicznych etykiet. */
  addressClass: string;
  /** Adres giełdy, kontraktu, zbiórki, miksera lub instytucji: publikacja odnotowana, ale to NIE jest portfel prywatny konta. */
  notPrivateWallet: boolean;
  indicator: Indicator;
  status: ClaimStatus;
}

// ---------- B. Wspólny operator ----------

export type HypothesisStatus =
  /** Przesłanki są, ale konta pozostają osobno — do rozstrzygnięcia. */
  | 'hypothesis'
  /** Przesłanki przekroczyły próg i nie ma kontrdowodu twardego: konta zaliczono do jednego kandydata (nadal wnioskowanie narzędzia). */
  | 'auto_grouped'
  /** Mocne przesłanki, ale kontrdowód twardy (np. sprzeczne deklarowane tożsamości) blokuje łączenie. */
  | 'blocked'
  | 'confirmed'
  | 'rejected';

export interface OperatorHypothesis {
  /** Klucz pary kont: identyfikatory `ProfileCard.id` posortowane i złączone `<->`. Zarazem klucz decyzji `link`. */
  id: string;
  accounts: [string, string];
  accountLabels: [string, string];
  /** Deklarowane persony kont (nazwa wyświetlana albo nick). */
  personas: [string, string];
  indicator: Indicator;
  status: HypothesisStatus;
  /** Zdanie dla analityka: co z tego wynika i czego nie wolno z tego wnosić. */
  statement: string;
  /** Ścieżka odkrycia: jak narzędzie doszło od jednego konta do drugiego. */
  path: string[];
  decision?: { decision: 'confirmed' | 'rejected'; decidedAt: string; author: string; note?: string; id: string };
}

// ---------- C. Wyjście do walut tradycyjnych ----------

/** Szczeble drabiny dowodowej wyjścia do fiat — każdy następny wymaga więcej niż poprzedni. */
export type CashOutStage =
  /** Sam przelew w blockchainie na adres bez etykiety usługi. */
  | 'onchain_transfer'
  /** Przelew na adres publicznie oznaczony jako usługa wymiany (giełda, P2P, bramka, karta). */
  | 'service_interaction'
  /** Wzorzec typowy dla wypłaty: adres wpłat giełdy, zamiana na stablecoin i wpłata, powtarzalne wpłaty. */
  | 'cashout_signal'
  /** Wyjście do fiat udokumentowane poza blockchainem (odpowiedź usługi, decyzja analityka z podstawą). */
  | 'documented_fiat_exit';

export const CASH_OUT_STAGE_LABEL: Record<CashOutStage, string> = {
  onchain_transfer: 'transakcja w blockchainie',
  service_interaction: 'interakcja z usługą wymiany',
  cashout_signal: 'potencjalny sygnał wypłaty',
  documented_fiat_exit: 'udokumentowane wyjście do walut tradycyjnych',
};

export interface CashOutAssessment {
  id: string;
  /** Adres, od którego zaczyna się przepływ. */
  address: string;
  network: string;
  stage: CashOutStage;
  serviceName?: string;
  txids: string[];
  asset?: string;
  amount?: number;
  valuePln?: number;
  indicator: Indicator;
  /** Zawsze `computed` albo `hypothesis`; `confirmed` tylko po decyzji analityka. */
  status: ClaimStatus;
  statement: string;
}

export interface InvestigationIndicators {
  accountWallet: AccountWalletLink[];
  commonOperator: OperatorHypothesis[];
  cashOut: CashOutAssessment[];
}

/** Klucz pary kont — niezależny od kolejności. */
export const linkKey = (a: string, b: string): string => [a.trim().toLowerCase(), b.trim().toLowerCase()].sort().join('<->');
