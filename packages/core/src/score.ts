// Wskaźnik Pewności: na ile znaleziony adres jest powiązany z badanym podmiotem.
//
// Wynik powstaje wyłącznie z jawnych reguł. Każdy krok trafia do `ledger`,
// więc analityk widzi, skąd wzięła się liczba, i może ją odtworzyć.
// Progi i wartości reguł są w `ScoreRules` (konfiguracja, nie kod).

/** Rodzaj miejsca, w którym adres został opublikowany. */
export type SourceCategory =
  /** Dowód kryptograficzny lub zapis w blockchainie (rekord ENS, podpisana wiadomość). */
  | 'cryptographic_proof'
  /** Własny, autorski profil podmiotu (GitHub, strona WWW, zweryfikowane konto). */
  | 'own_profile'
  /** Ogłoszenie sprzedaży lub oferta P2P. */
  | 'sale_offer'
  /** Stopka e-maila lub komunikator w kontekście rozliczenia. */
  | 'settlement_message'
  /** Wypowiedź na forum lub w grupie tematycznej. */
  | 'forum_post'
  /** Masowe komentarze: konkursy, promocje, giveawaye. */
  | 'mass_comment';

/** Co o adresie mówią dane blockchain i publiczne etykiety. */
export type AddressClass =
  | 'private'
  | 'unknown'
  | 'exchange'
  | 'smart_contract'
  | 'charity'
  | 'mixer'
  | 'institutional';

/** Jak ślad został powiązany z badanym podmiotem. */
export type IdentityMatch =
  /** Tożsamość profilu potwierdzona: wzajemne odnośniki między profilami albo dowód kryptograficzny. */
  | 'verified_link'
  /**
   * Profil odnaleziony po unikalnym identyfikatorze (e-mail, adres profilu) albo po nicku
   * potwierdzonym drugim identyfikatorem podmiotu w treści profilu.
   */
  | 'exact_identifier'
  /** Ten sam nick w serwisie, bez żadnego innego potwierdzenia, że to ta sama osoba. */
  | 'same_handle'
  /** Jak wyżej, ale nick jest pospolity — różne osoby często używają takiego samego. */
  | 'common_handle'
  /** Profil odnaleziony pośrednio, przez inny potwierdzony profil podmiotu. */
  | 'linked_profile'
  /** Zgodne tylko imię i nazwisko — możliwa zbieżność nazwisk. */
  | 'name_only';

export interface Evidence {
  id: string;
  category: SourceCategory;
  /** Usługa, z której pochodzi ślad (np. `github.com`). Wyznacza niezależność źródeł. */
  service: string;
  url: string;
  /** Czas pozyskania śladu (ISO 8601). */
  capturedAt: string;
  identityMatch: IdentityMatch;
  /** Przesłanki, na których oparto ocenę, czy profil należy do badanego podmiotu. */
  identityReasons?: string[];
}

export interface ScoreInput {
  evidence: Evidence[];
  addressClass: AddressClass;
  /**
   * Liczba innych, niepowiązanych tożsamości publikujących ten sam adres.
   * Adres wklejany przez wiele osób to zwykle zbiórka albo oszustwo.
   */
  unrelatedPublishers?: number;
}

export interface ScoreRules {
  base: Record<SourceCategory, number>;
  identityAdjustment: Record<IdentityMatch, number>;
  /** Premia za drugie niezależne źródło. */
  synergyBonus: number;
  /** Premia za każde kolejne niezależne źródło. */
  extraSourceBonus: number;
  maxExtraSourceBonus: number;
  /** Od ilu niepowiązanych publikujących adres uznajemy za współdzielony. */
  sharedAddressThreshold: number;
  sharedAddressPenalty: number;
  excludedClasses: AddressClass[];
  tiers: { min: number; label: string }[];
}

/** Wartości zgodne z załącznikiem pojęciowo-metodycznym KAS. */
export const DEFAULT_RULES: ScoreRules = {
  base: {
    cryptographic_proof: 95,
    own_profile: 85,
    sale_offer: 70,
    settlement_message: 65,
    forum_post: 50,
    mass_comment: 25,
  },
  identityAdjustment: {
    verified_link: 0,
    exact_identifier: 0,
    linked_profile: -5,
    same_handle: -10,
    common_handle: -20,
    name_only: -20,
  },
  synergyBonus: 15,
  extraSourceBonus: 5,
  maxExtraSourceBonus: 10,
  sharedAddressThreshold: 3,
  sharedAddressPenalty: 30,
  excludedClasses: ['exchange', 'smart_contract', 'charity', 'mixer', 'institutional'],
  tiers: [
    { min: 80, label: 'bardzo wysokie prawdopodobieństwo' },
    { min: 60, label: 'prawdopodobne' },
    { min: 40, label: 'średnie' },
    { min: 10, label: 'niskie / szum' },
    { min: 0, label: 'wykluczone' },
  ],
};

export interface LedgerEntry {
  /** Identyfikator reguły, stały między wersjami — do audytu. */
  rule: string;
  /** Zmiana wyniku w punktach procentowych. */
  delta: number;
  /** Wynik po zastosowaniu reguły. */
  running: number;
  explanation: string;
  /** Ślady, na których opiera się ten krok. */
  evidenceIds: string[];
}

export interface ScoreResult {
  score: number;
  tier: string;
  excluded: boolean;
  ledger: LedgerEntry[];
  /** Co podniosłoby wynik — wskazówki dla analityka. */
  nextSteps: string[];
}

const CLASS_LABEL: Record<AddressClass, string> = {
  private: 'adres prywatny',
  unknown: 'adres bez etykiety',
  exchange: 'adres giełdy lub portfela powierniczego',
  smart_contract: 'smart kontrakt',
  charity: 'adres zbiórki',
  mixer: 'mikser',
  institutional: 'adres instytucjonalny',
};

const CATEGORY_LABEL: Record<SourceCategory, string> = {
  cryptographic_proof: 'dowód kryptograficzny',
  own_profile: 'własny profil podmiotu',
  sale_offer: 'ogłoszenie sprzedaży / oferta P2P',
  settlement_message: 'wiadomość w kontekście rozliczenia',
  forum_post: 'wypowiedź na forum',
  mass_comment: 'masowy komentarz',
};

const IDENTITY_LABEL: Record<IdentityMatch, string> = {
  verified_link: 'tożsamość profilu potwierdzona',
  exact_identifier: 'unikalny lub potwierdzony identyfikator podmiotu',
  linked_profile: 'profil wskazany przez inny profil podmiotu',
  same_handle: 'zgodny tylko nick — bez potwierdzenia, że to ta sama osoba',
  common_handle: 'zgodny tylko pospolity nick',
  name_only: 'zgodne tylko imię i nazwisko',
};

const clamp = (value: number) => Math.max(0, Math.min(100, value));

function tierFor(score: number, rules: ScoreRules): string {
  const sorted = [...rules.tiers].sort((a, b) => b.min - a.min);
  return (sorted.find((tier) => score >= tier.min) ?? sorted[sorted.length - 1]!).label;
}

export function computeConfidence(input: ScoreInput, rules: ScoreRules = DEFAULT_RULES): ScoreResult {
  const ledger: LedgerEntry[] = [];
  const allIds = input.evidence.map((item) => item.id);

  if (rules.excludedClasses.includes(input.addressClass)) {
    ledger.push({
      rule: 'exclusion.address_class',
      delta: 0,
      running: 0,
      explanation:
        `Wykluczenie: ${CLASS_LABEL[input.addressClass]}. Adresu nie przypisuje się podmiotowi; ` +
        'odnotowano jedynie fakt jego publikacji lub interakcji.',
      evidenceIds: allIds,
    });
    return { score: 0, tier: tierFor(0, rules), excluded: true, ledger, nextSteps: [] };
  }

  if (input.evidence.length === 0) {
    return { score: 0, tier: tierFor(0, rules), excluded: false, ledger, nextSteps: [] };
  }

  // Każdy ślad wyceniamy osobno; punktem wyjścia jest najmocniejszy.
  const valued = input.evidence
    .map((item) => ({
      item,
      value: rules.base[item.category] + rules.identityAdjustment[item.identityMatch],
    }))
    .sort((a, b) => b.value - a.value);
  const strongest = valued[0]!;

  let running = clamp(rules.base[strongest.item.category]);
  ledger.push({
    rule: `base.${strongest.item.category}`,
    delta: running,
    running,
    explanation: `Najmocniejszy ślad: ${CATEGORY_LABEL[strongest.item.category]} (${strongest.item.service}).`,
    evidenceIds: [strongest.item.id],
  });

  const identityDelta = rules.identityAdjustment[strongest.item.identityMatch];
  if (identityDelta !== 0) {
    running = clamp(running + identityDelta);
    ledger.push({
      rule: `identity.${strongest.item.identityMatch}`,
      delta: identityDelta,
      running,
      explanation:
        `Czy profil należy do badanego podmiotu: ${IDENTITY_LABEL[strongest.item.identityMatch]}.` +
        (strongest.item.identityReasons?.length ? ` ${strongest.item.identityReasons.join(' ')}` : ''),
      evidenceIds: [strongest.item.id],
    });
  }

  // Niezależne są źródła różnego pochodzenia. Wiele wystąpień w jednej usłudze
  // nie jest dodatkowym potwierdzeniem.
  const byService = new Map<string, Evidence[]>();
  for (const item of input.evidence) {
    const key = item.service.toLowerCase();
    byService.set(key, [...(byService.get(key) ?? []), item]);
  }
  const independent = byService.size;
  if (independent >= 2) {
    const before = running;
    running = clamp(running + rules.synergyBonus);
    ledger.push({
      rule: 'synergy.second_source',
      delta: running - before,
      running,
      explanation: `Ten sam adres w ${independent} niezależnych źródłach: ${[...byService.keys()].join(', ')}.`,
      evidenceIds: allIds,
    });
  }
  if (independent >= 3) {
    const before = running;
    const bonus = Math.min((independent - 2) * rules.extraSourceBonus, rules.maxExtraSourceBonus);
    running = clamp(running + bonus);
    ledger.push({
      rule: 'synergy.extra_sources',
      delta: running - before,
      running,
      explanation: `Dodatkowe niezależne źródła ponad dwa: ${independent - 2}.`,
      evidenceIds: allIds,
    });
  }

  const unrelated = input.unrelatedPublishers ?? 0;
  if (unrelated >= rules.sharedAddressThreshold) {
    const before = running;
    running = clamp(running - rules.sharedAddressPenalty);
    ledger.push({
      rule: 'penalty.shared_address',
      delta: running - before,
      running,
      explanation:
        `Ten sam adres publikuje ${unrelated} niepowiązanych tożsamości — ` +
        'prawdopodobnie adres współdzielony (zbiórka, serwis, oszustwo).',
      evidenceIds: allIds,
    });
  }

  const nextSteps: string[] = [];
  if (independent < 2) {
    nextSteps.push(
      `Drugi ślad z niezależnego źródła podniesie wynik o ${rules.synergyBonus} p.p.`,
    );
  }
  if (strongest.item.identityMatch === 'name_only') {
    nextSteps.push(
      'Powiązanie opiera się na samym imieniu i nazwisku — potwierdź tożsamość profilu dodatkowym identyfikatorem (nick, e-mail).',
    );
  }
  if (strongest.item.identityMatch === 'same_handle' || strongest.item.identityMatch === 'common_handle') {
    nextSteps.push(
      'Zgadza się tylko nick. Podaj drugi identyfikator podmiotu (e-mail, imię i nazwisko, inny profil) — jeśli wystąpi w treści profilu, tożsamość zostanie potwierdzona.',
    );
  }
  if (input.addressClass === 'unknown') {
    nextSteps.push('Adres nie ma etykiety w danych blockchain — zweryfikuj ręcznie, czy nie należy do pośrednika.');
  }
  if (!input.evidence.some((item) => item.category === 'cryptographic_proof')) {
    nextSteps.push('Poszukaj dowodu kryptograficznego: rekordu ENS wskazującego profil podmiotu lub podpisanej wiadomości.');
  }

  return { score: running, tier: tierFor(running, rules), excluded: false, ledger, nextSteps };
}
