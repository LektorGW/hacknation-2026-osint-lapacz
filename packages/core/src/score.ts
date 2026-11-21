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
  /** Usługa, z której pochodzi ślad (np. `github.com`). Jedno z kryteriów niezależności źródeł. */
  service: string;
  url: string;
  /** Czas pozyskania śladu (ISO 8601). */
  capturedAt: string;
  identityMatch: IdentityMatch;
  /** Przesłanki, na których oparto ocenę, czy profil należy do badanego podmiotu. */
  identityReasons?: string[];
  /** Fragment treści z adresem — do rozpoznania kopii tej samej publikacji w innym serwisie. */
  excerpt?: string;
  /** SHA-256 pobranej treści — identyczna treść w dwóch miejscach to jedno pochodzenie. */
  contentHash?: string;
  /** Dla kopii archiwalnej: czas zapisania kopii. Kopia archiwalna nie jest niezależna od oryginału. */
  archivedAt?: string;
  /** Jawny klucz pochodzenia nadany przez źródło (np. identyfikator wpisu przekazanego dalej). */
  originKey?: string;
  /**
   * Podstawa własności spoza kategorii źródła: deklaracja „to mój adres” odczytana regułą tekstową
   * z wypowiedzi (ownership-text.ts). Nie zmienia kategorii ani punktów — trafia do księgi jako osobny wpis.
   */
  ownershipBasis?: { rule: 'text_declaration'; quote: string };
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
  /** Nominalna waga reguły z konfiguracji (`delta` to zmiana faktycznie zastosowana, po ograniczeniu do 0–100). */
  weight?: number;
  /** Adresy publikacji, z których pochodzą ślady tego kroku. */
  sources?: string[];
  /** Jak oceniono niezależność śladów użytych w tym kroku. */
  independence?: string;
  /** Czego ten krok NIE dowodzi. */
  limitations?: string[];
}

/** Ślady o wspólnym pochodzeniu: liczą się jako jedno potwierdzenie. */
export interface ProvenanceGroup {
  /** Identyfikatory śladów w grupie. */
  evidenceIds: string[];
  services: string[];
  /** Dlaczego ślady uznano za zależne (puste dla grupy jednoelementowej). */
  reasons: string[];
}

export interface ScoreResult {
  score: number;
  tier: string;
  excluded: boolean;
  ledger: LedgerEntry[];
  /** Co podniosłoby wynik — wskazówki dla analityka. */
  nextSteps: string[];
  /** Grupy śladów o wspólnym pochodzeniu; liczba grup = liczba niezależnych potwierdzeń. */
  provenance?: ProvenanceGroup[];
  /** Liczba niezależnych pochodzeń (po odjęciu kopii, przedruków i kopii archiwalnych). */
  independentSources?: number;
  /** Wynik jest wskaźnikiem porządkowym z jawnych reguł, nie skalibrowanym prawdopodobieństwem. */
  scale?: 'ordinal_uncalibrated';
  interpretation?: string;
}

export const SCORE_INTERPRETATION =
  'Wskaźnik 0–100 jest sumą jawnych reguł (wag eksperckich), a nie skalibrowanym statystycznie prawdopodobieństwem: ' +
  'porządkuje powiązania od najsłabiej do najmocniej udokumentowanych. Nazwy progów pochodzą z załącznika metodycznego zadania.';

// ---------- Niezależność pochodzenia śladów ----------

/** Od ilu znaków treści (bez samego adresu) fragment jest na tyle swoisty, by rozpoznawać jego kopie. */
const MIN_FINGERPRINT_CHARS = 24;
/** Od jakiego podobieństwa zbiorów wyrazów (Jaccard) dwie treści uznajemy za przedruk. */
const NEAR_DUPLICATE_SIMILARITY = 0.8;
const MIN_TOKENS_FOR_SIMILARITY = 8;

const ADDRESS_LIKE = /\b(?:0x[0-9a-fA-F]{40}|(?:bc1|tb1)[0-9a-z]{20,}|[13][1-9A-HJ-NP-Za-km-z]{24,34}|T[1-9A-HJ-NP-Za-km-z]{33})\b/g;

/** Treść sprowadzona do porównywalnej postaci: bez adresów, odnośników, wielkości liter i interpunkcji. */
export function normalizeForFingerprint(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(ADDRESS_LIKE, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Odcisk treści albo `undefined`, gdy fragment jest zbyt krótki, by odróżnić kopię od zbieżności. */
export function textFingerprint(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = normalizeForFingerprint(text);
  return normalized.replace(/ /g, '').length >= MIN_FINGERPRINT_CHARS ? normalized : undefined;
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(left.split(' '));
  const b = new Set(right.split(' '));
  if (a.size < MIN_TOKENS_FOR_SIMILARITY || b.size < MIN_TOKENS_FOR_SIMILARITY) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Adres publikacji bez przedrostka archiwum, protokołu i końcowego ukośnika. */
function originUrl(url: string): string {
  return url
    .replace(/^https?:\/\/(?:web\.)?archive\.org\/web\/\d+[a-z_]*\//i, '')
    .replace(/^https?:\/\/archive\.(?:ph|today|is)\/(?:\d+\/)?(?=https?:)/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[#?].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Dzieli ślady na grupy o wspólnym pochodzeniu. Dwa ślady są ZALEŻNE (jedna grupa), gdy:
 * pochodzą z tej samej usługi, mają tę samą treść (skrót lub odcisk fragmentu), są przedrukiem
 * (podobieństwo wyrazów ≥ 0,8), jeden jest kopią archiwalną adresu drugiego albo źródło nadało im
 * ten sam klucz pochodzenia. Inna usługa sama w sobie nie czyni śladu niezależnym.
 */
export function provenanceGroups(evidence: Evidence[]): ProvenanceGroup[] {
  const parent = evidence.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  const reasons = new Map<string, Set<string>>();
  const join = (a: number, b: number, reason: string) => {
    const key = `${a}|${b}`;
    reasons.set(key, (reasons.get(key) ?? new Set<string>()).add(reason));
    parent[find(a)] = find(b);
  };
  const prints = evidence.map((item) => textFingerprint(item.excerpt));
  const origins = evidence.map((item) => originUrl(item.url));
  for (let i = 0; i < evidence.length; i++) {
    for (let j = i + 1; j < evidence.length; j++) {
      const [a, b] = [evidence[i]!, evidence[j]!];
      if (a.service.toLowerCase() === b.service.toLowerCase()) join(i, j, `ta sama usługa (${a.service})`);
      if (a.originKey && a.originKey === b.originKey) join(i, j, 'to samo pochodzenie wskazane przez źródło');
      if (a.contentHash && a.contentHash === b.contentHash) join(i, j, 'identyczna treść (ten sam skrót SHA-256)');
      if (origins[i] === origins[j] && origins[i] !== '') join(i, j, 'kopia archiwalna tej samej strony');
      if (prints[i] && prints[j]) {
        if (prints[i] === prints[j]) join(i, j, 'ta sama treść skopiowana do innego miejsca');
        else if (tokenSimilarity(prints[i]!, prints[j]!) >= NEAR_DUPLICATE_SIMILARITY) join(i, j, 'niemal identyczna treść (przedruk)');
      }
    }
  }
  const groups = new Map<number, number[]>();
  evidence.forEach((_, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), index]));
  return [...groups.values()].map((indexes) => {
    const why = new Set<string>();
    for (const [key, set] of reasons) {
      const [a, b] = key.split('|').map(Number);
      if (indexes.includes(a!) && indexes.includes(b!)) for (const reason of set) why.add(reason);
    }
    return {
      evidenceIds: indexes.map((index) => evidence[index]!.id),
      services: [...new Set(indexes.map((index) => evidence[index]!.service.toLowerCase()))],
      reasons: [...why],
    };
  });
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
    ledger[0]!.weight = 0;
    ledger[0]!.sources = input.evidence.map((item) => item.url);
    ledger[0]!.independence = 'nie dotyczy — wykluczenie z klasy adresu';
    ledger[0]!.limitations = ['Publikacja adresu usługi lub kontraktu nie dowodzi, że autor nim dysponuje; klasyfikacja pochodzi z publicznych etykiet i danych sieci.'];
    return { score: 0, tier: tierFor(0, rules), excluded: true, ledger, nextSteps: [], provenance: provenanceGroups(input.evidence), independentSources: 0, scale: 'ordinal_uncalibrated', interpretation: SCORE_INTERPRETATION };
  }

  if (input.evidence.length === 0) {
    return { score: 0, tier: tierFor(0, rules), excluded: false, ledger, nextSteps: [], provenance: [], independentSources: 0, scale: 'ordinal_uncalibrated', interpretation: SCORE_INTERPRETATION };
  }
  const urlOf = new Map(input.evidence.map((item) => [item.id, item.url]));

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
    weight: rules.base[strongest.item.category],
    sources: [strongest.item.url],
    independence: 'pojedynczy ślad — punkt wyjścia oceny',
    limitations:
      strongest.item.category === 'cryptographic_proof'
        ? []
        : ['Publikacja adresu jest deklaracją autora; nie dowodzi dysponowania kluczem prywatnym.'],
  });

  const declared = strongest.item.ownershipBasis;
  if (declared?.rule === 'text_declaration') {
    ledger.push({
      rule: 'basis.text_declaration',
      delta: 0,
      running,
      explanation:
        `Podstawa własności: deklaracja własności w treści (reguła tekstowa) — „${declared.quote}”. ` +
        `Wypowiedź liczona jako publikacja autora z wagą kategorii „${CATEGORY_LABEL[strongest.item.category]}” (${rules.base[strongest.item.category]}), nigdy wyższą.`,
      evidenceIds: [strongest.item.id],
      weight: 0,
      sources: [strongest.item.url],
      independence: 'nie dotyczy — podstawa uznania autora za kandydata na właściciela',
      limitations: [
        'Reguła tekstowa czyta tylko słowa przy adresie (np. „mój adres”, „wpłaty na”, „my wallet”); nie rozpoznaje ironii ani cytatu bez oznaczenia.',
        'Ma niższą moc niż jawna kategoria źródła i odczyt modelu językowego; decyzja analityka „odrzucony” wyłącza ślad.',
      ],
    });
  }

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
      weight: identityDelta,
      sources: [strongest.item.url],
      independence: 'nie dotyczy — korekta za sposób odnalezienia profilu',
      limitations: ['Ocena dotyczy przynależności profilu do podmiotu, nie własności adresu.'],
    });
  }

  // Niezależne są ślady różnego POCHODZENIA: inna usługa, inna treść, nie kopia archiwalna.
  // Ta sama treść wklejona do pięciu serwisów to jedno potwierdzenie, nie pięć.
  const provenance = provenanceGroups(input.evidence);
  const independent = provenance.length;
  const copies = provenance.filter((group) => group.services.length > 1);
  const describeGroups = `niezależnych pochodzeń: ${independent}, śladów: ${input.evidence.length}`;
  if (copies.length > 0) {
    ledger.push({
      rule: 'independence.copies_merged',
      delta: 0,
      running,
      explanation:
        'Ślady z różnych usług o wspólnym pochodzeniu policzono jako jedno potwierdzenie: ' +
        copies.map((group) => `${group.services.join(', ')} — ${group.reasons.filter((reason) => !reason.startsWith('ta sama usługa')).join('; ')}`).join(' | ') +
        '.',
      evidenceIds: copies.flatMap((group) => group.evidenceIds),
      weight: 0,
      sources: copies.flatMap((group) => group.evidenceIds.map((id) => urlOf.get(id)!)),
      independence: describeGroups,
      limitations: ['Kopię rozpoznaje się po treści fragmentu i adresie strony; treść przeredagowana ręcznie może nie zostać rozpoznana.'],
    });
  }
  const groupLabel = (group: ProvenanceGroup) => group.services.join(' + ');
  if (independent >= 2) {
    const before = running;
    running = clamp(running + rules.synergyBonus);
    ledger.push({
      rule: 'synergy.second_source',
      delta: running - before,
      running,
      explanation: `Ten sam adres w ${independent} niezależnych źródłach: ${provenance.map(groupLabel).join(', ')}.`,
      evidenceIds: allIds,
      weight: rules.synergyBonus,
      sources: input.evidence.map((item) => item.url),
      independence: describeGroups,
      limitations: ['Niezależność oceniono po usłudze, treści i adresie strony; nie wyklucza to, że publikacje zamieściła jedna osoba.'],
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
      weight: bonus,
      sources: input.evidence.map((item) => item.url),
      independence: describeGroups,
      limitations: [`Premia ograniczona do ${rules.maxExtraSourceBonus} p.p. bez względu na liczbę źródeł.`],
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
      weight: -rules.sharedAddressPenalty,
      sources: input.evidence.map((item) => item.url),
      independence: 'nie dotyczy — kontrdowód z publikacji innych autorów',
      limitations: ['Liczba publikujących pochodzi tylko z przeszukanych źródeł.'],
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

  return {
    score: running,
    tier: tierFor(running, rules),
    excluded: false,
    ledger,
    nextSteps,
    provenance,
    independentSources: independent,
    scale: 'ordinal_uncalibrated',
    interpretation: SCORE_INTERPRETATION,
  };
}
