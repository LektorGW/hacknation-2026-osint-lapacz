// Normalizacja tekstu do porównywania nazw z oficjalnymi listami ryzyka (sankcje, ostrzeżenia).
// Wszystko jest deterministyczne i lokalne: transliteracja cyrylicy, usuwanie znaków diakrytycznych,
// pomijanie form prawnych, szkielet fonetyczny dla wariantów transliteracji, odległość edycyjna,
// kody państw (ISO 3166-1 alfa-2) z nazw polskich i angielskich, postać adresu kryptowalutowego.

// ---------- Transliteracja cyrylicy (uproszczona, zgodna z zapisem paszportowym) ----------

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // ukraiński i białoruski
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
  // serbski i macedoński (podstawowe)
  ђ: 'dj', ј: 'j', љ: 'lj', њ: 'nj', ћ: 'c', џ: 'dz', ѓ: 'gj', ќ: 'kj', ѕ: 'dz',
};

/** Zamienia litery cyrylicy na łacinkę; pozostałe znaki zostawia bez zmian. */
export function transliterateCyrillic(value: string): string {
  let out = '';
  for (const char of value) {
    const lower = char.toLowerCase();
    const latin = CYRILLIC[lower];
    out += latin === undefined ? char : latin;
  }
  return out;
}

const SPECIAL_LATIN: Record<string, string> = { ł: 'l', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', þ: 'th', ı: 'i', ħ: 'h' };

/**
 * Postać do porównań: cyrylica na łacinkę, małe litery, bez znaków diakrytycznych
 * („Łukaszenka” → „lukaszenka”), znaki inne niż litery i cyfry zamienione na spacje.
 */
export function foldText(value: string): string {
  const lower = value.toLowerCase();
  return (/[Ѐ-ӿ]/.test(lower) ? transliterateCyrillic(lower) : lower)
    .replace(/[łßæœøđðþıħ]/g, (char) => SPECIAL_LATIN[char] ?? char)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`ʼ‘]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------- Formy prawne i słowa ogólne ----------

/** Formy prawne pomijane przy porównaniu nazw organizacji (po złożeniu `foldText`). */
const LEGAL_FORM_PHRASES = [
  'spolka z ograniczona odpowiedzialnoscia',
  'prosta spolka akcyjna',
  'spolka komandytowo akcyjna',
  'spolka komandytowa',
  'spolka akcyjna',
  'spolka jawna',
  'spolka cywilna',
  'limited liability company',
  'limited liability partnership',
  'joint stock company',
  'public joint stock company',
  'closed joint stock company',
  'open joint stock company',
  'obshchestvo s ogranichennoy otvetstvennostyu',
  'aktsionernoe obshchestvo',
  'sp z o o',
  'sp k',
  'sp j',
  's a',
  'sa de cv',
  's de rl',
  'sdn bhd',
  'pte ltd',
  'pty ltd',
  'd o o',
  'w likwidacji',
  'w upadlosci',
];

const LEGAL_FORM_TOKENS = new Set([
  'llc', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'jsc', 'ojsc', 'cjsc', 'pjsc', 'pao',
  'oao', 'zao', 'ooo', 'ao', 'tov', 'llp', 'lp', 'plc', 'gmbh', 'ag', 'sarl', 'srl', 'spa', 'bv', 'nv', 'ab', 'oy',
  'fze', 'fzco', 'fzc', 'fzllc', 'dmcc', 'bhd', 'pte', 'pty', 'kft', 'zrt', 'doo', 'eood', 'ood', 'sas', 'kg', 'ohg',
  'ltda', 'cia', 'sro', 'as', 'aps', 'ou', 'uab', 'sia', 'tsk', 'chp', 'fop', 'ip', 'spzoo', 'sa',
]);

/**
 * Słowa ogólne: nie mogą samodzielnie być podstawą dopasowania (nazwa złożona wyłącznie
 * z takich słów nie jest porównywana, a kandydaci muszą dzielić co najmniej jedno inne słowo).
 */
export const GENERIC_TOKENS = new Set([
  'bank', 'banka', 'banco', 'banque', 'company', 'trading', 'trade', 'group', 'grupa', 'holding', 'holdings',
  'international', 'global', 'services', 'service', 'general', 'industrial', 'industries', 'industry', 'the', 'and',
  'of', 'for', 'i', 'oraz', 'w', 'z', 'na', 'de', 'del', 'la', 'le', 'el', 'al', 'bin', 'ibn', 'ben', 'bint', 'abu',
  'haji', 'mr', 'mrs', 'sheikh', 'dr', 'enterprise', 'enterprises', 'investment', 'investments', 'capital', 'finance',
  'financial', 'management', 'consulting', 'solutions', 'technology', 'technologies', 'systems', 'logistics',
  'shipping', 'export', 'import', 'energy', 'oil', 'gas', 'commercial', 'company', 'firma', 'przedsiebiorstwo',
  'handel', 'handlowe', 'uslugi', 'polska', 'poland', 'russia', 'rossii', 'russian', 'state', 'national', 'new',
  'center', 'centre', 'foundation', 'fundacja', 'association', 'stowarzyszenie', 'organization', 'organisation',
  'crypto', 'exchange', 'wallet', 'coin', 'pay', 'online',
]);

/** Jedno wyrażenie dla wszystkich form wielowyrazowych (najdłuższe najpierw), tylko jako całe słowa. */
const LEGAL_FORM_PATTERN = new RegExp(`(?<= )(?:${[...LEGAL_FORM_PHRASES].sort((a, b) => b.length - a.length).join('|')})(?= )`, 'g');

/** Słowa nazwy bez form prawnych, w kolejności z oryginału. */
export function nameTokens(value: string): string[] {
  const text = ` ${foldText(value)} `.replace(LEGAL_FORM_PATTERN, ' ');
  return text
    .split(' ')
    .filter((token) => token !== '' && !LEGAL_FORM_TOKENS.has(token));
}

/** Czy słowo może być podstawą dopasowania (nie jest ogólne i ma co najmniej 2 znaki). */
export const isDistinctiveToken = (token: string): boolean => token.length >= 2 && !GENERIC_TOKENS.has(token);

// ---------- Szkielet fonetyczny ----------

/**
 * Szkielet słowa ujednolicający warianty transliteracji: „Michaił” / „Mikhail”, „Bakalczuk” / „Bakalchuk”,
 * „Jewgienij” / „Evgeny”, „Wasiljewicz” / „Vasilyevich”. Używany wyłącznie w dopasowaniu przybliżonym.
 */
export function skeleton(token: string): string {
  return token
    .replace(/szcz|shch|sch/g, 's')
    .replace(/kh|ch|cz/g, 'h')
    .replace(/sh|sz/g, 's')
    .replace(/zh|rz/g, 'z')
    .replace(/ts|tz/g, 'c')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/w/g, 'v')
    .replace(/[yj]/g, 'i')
    .replace(/ie/g, 'e')
    .replace(/(.)\1+/g, '$1');
}

/** Odległość edycyjna Levenshteina. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Podobieństwo 0–1 dwóch słów: 1 − odległość / długość dłuższego. */
export function tokenSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

// ---------- Państwa ----------

const COUNTRY_ALIASES: Record<string, string> = {
  'russian federation': 'RU', 'federacja rosyjska': 'RU', rosja: 'RU', 'rossiya': 'RU', 'rossiiskaya federatsiya': 'RU',
  burma: 'MM', 'mjanma birma': 'MM', birma: 'MM', 'myanmar burma': 'MM',
  'north korea': 'KP', 'korea north': 'KP', 'democratic people s republic of korea': 'KP', 'korea democratic people s republic of': 'KP',
  'koreanska republika ludowo demokratyczna': 'KP', 'koreanska republika ludowo demokratyczna krld': 'KP', krld: 'KP', 'korea polnocna': 'KP',
  'south korea': 'KR', 'korea south': 'KR', 'republic of korea': 'KR', 'korea republic of': 'KR', 'korea poludniowa': 'KR',
  'iran islamic republic of': 'IR', 'islamic republic of iran': 'IR',
  'syrian arab republic': 'SY', 'venezuela bolivarian republic of': 'VE', 'bolivia plurinational state of': 'BO',
  'democratic republic of the congo': 'CD', 'congo democratic republic of the': 'CD', 'congo democratic republic': 'CD', 'demokratyczna republika konga': 'CD',
  'congo republic of the': 'CG', 'republic of the congo': 'CG', 'tanzania united republic of': 'TZ', 'moldova republic of': 'MD', 'republic of moldova': 'MD',
  'lao people s democratic republic': 'LA', laos: 'LA', 'viet nam': 'VN', turkiye: 'TR', turkey: 'TR', 'czech republic': 'CZ',
  'ivory coast': 'CI', 'cote d ivoire': 'CI', 'cote divoire': 'CI', 'wybrzeze kosci sloniowej': 'CI',
  palestine: 'PS', 'palestinian territories': 'PS', 'occupied palestinian territory': 'PS', 'west bank': 'PS', gaza: 'PS', 'gaza strip': 'PS',
  kosovo: 'XK', uk: 'GB', 'united kingdom': 'GB', 'great britain': 'GB', 'wielka brytania': 'GB',
  usa: 'US', 'united states': 'US', 'united states of america': 'US', 'stany zjednoczone': 'US',
  uae: 'AE', 'brytyjskie wyspy dziewicze': 'VG', 'british virgin islands': 'VG', 'virgin islands british': 'VG',
  'bialorus': 'BY', belarus: 'BY', ukraina: 'UA', ukraine: 'UA', crimea: 'UA', krym: 'UA', polska: 'PL', poland: 'PL',
  'hong kong': 'HK', macau: 'MO', macao: 'MO', taiwan: 'TW', 'sudan poludniowy': 'SS', 'south sudan': 'SS',
  'bosnia and herzegovina': 'BA', 'north macedonia': 'MK', macedonia: 'MK', 'holy see': 'VA', vatican: 'VA',
  'micronesia federated states of': 'FM', 'saint kitts and nevis': 'KN', 'st kitts and nevis': 'KN',
};

let countryIndex: Map<string, string> | undefined;
let countryCodes: Set<string> | undefined;

/**
 * Kody wycofane albo specjalne, które ICU nadal nazywa (np. NH „Nowe Hebrydy” zamiast VU „Vanuatu”,
 * VD „Wietnam Północny”, YD „Jemen Południowy”) — pomijane, żeby nazwa trafiała do kodu bieżącego.
 */
const SKIPPED_CODES = new Set([
  'AN', 'BU', 'CS', 'CT', 'DD', 'DY', 'FQ', 'FX', 'HV', 'JT', 'MI', 'NH', 'NQ', 'NT', 'PC', 'PU', 'PZ', 'RH', 'SU',
  'TP', 'UK', 'VD', 'WK', 'YD', 'YU', 'ZR', 'EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'CQ',
]);

function buildCountryIndex(): Map<string, string> {
  countryCodes = new Set<string>();
  const index = new Map<string, string>();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const locale of ['en', 'pl']) {
    let names: Intl.DisplayNames | undefined;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
    } catch {
      names = undefined;
    }
    if (!names) continue;
    for (const first of letters) {
      for (const second of letters) {
        const code = `${first}${second}`;
        if (SKIPPED_CODES.has(code)) continue;
        let name: string | undefined;
        try {
          name = names.of(code);
        } catch {
          name = undefined;
        }
        if (!name || name === code) continue;
        countryCodes.add(code);
        const key = foldText(name);
        if (key && !index.has(key)) index.set(key, code);
      }
    }
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) index.set(alias, code);
  return index;
}

const VALID_CODE = /^[A-Z]{2}$/;

/**
 * Kod państwa ISO 3166-1 alfa-2 z kodu albo nazwy polskiej lub angielskiej („PL”, „Polska”,
 * „Russian Federation”, „IRAN (ISLAMIC REPUBLIC OF)”). `undefined`, gdy nazwy nie rozpoznano.
 */
export function countryCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (VALID_CODE.test(raw)) return raw === 'UK' ? 'GB' : raw;
  countryIndex ??= buildCountryIndex();
  const key = foldText(raw);
  if (!key) return undefined;
  if (/^[a-z]{2}$/.test(key)) {
    const upper = key === 'uk' ? 'GB' : key.toUpperCase();
    if (countryCodes?.has(upper)) return upper;
  }
  const direct = countryIndex.get(key) ?? countryIndex.get(key.replace(/^the /, ''));
  if (direct) return direct;
  // „Iran (Islamic Republic of)” → „iran”; „Korea, North” → „korea north”.
  const head = foldText(raw.replace(/\(.*?\)/g, ' ').split(',')[0] ?? '');
  return head ? countryIndex.get(head) : undefined;
}

// ---------- Identyfikatory i adresy kryptowalutowe ----------

/** Identyfikator bez spacji, kresek i kropek, wielkimi literami („PL 949-225-44-31” → „PL9492254431”). */
export function normalizeIdentifierValue(value: string): string {
  return value.normalize('NFKC').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/** Wariant numeru bez przedrostka kraju (NIP „PL9492254431” → „9492254431”). */
export function identifierVariants(value: string): string[] {
  const normalized = normalizeIdentifierValue(value);
  const variants = new Set([normalized]);
  const prefixed = /^[A-Z]{2}(\d{6,})$/.exec(normalized);
  if (prefixed) variants.add(prefixed[1]!);
  return [...variants].filter((item) => item.length > 0);
}

/**
 * Klucz adresu kryptowalutowego zależny od sieci: adresy EVM (`0x` + 40 znaków szesnastkowych)
 * i bech32 (`bc1…`, `tb1…`) bez rozróżniania wielkości liter; Base58 (Bitcoin, Tron) — dokładnie.
 */
export function cryptoAddressKey(address: string): string {
  const value = address.trim();
  if (/^0x[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (/^(bc1|tb1|ltc1)/i.test(value)) return value.toLowerCase();
  return value;
}

/** Czy adres ma postać EVM (ta sama postać we wszystkich sieciach zgodnych z Ethereum). */
export const isEvmAddress = (address: string): boolean => /^0x[0-9a-f]{40}$/i.test(address.trim());
