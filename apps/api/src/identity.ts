// Ocena, czy znaleziony profil należy do badanego podmiotu.
//
// Zbieżność nicku albo nazwiska nie dowodzi tożsamości: tego samego nicku używają
// różne osoby w różnych serwisach. Profil uznajemy za należący do podmiotu dopiero,
// gdy odnaleziono go po unikalnym identyfikatorze albo gdy jego treść zawiera drugi,
// niezależny identyfikator podany przez analityka.

import type { Identifier, IdentifierType, IdentityMatch, SourceDocument } from '@olcys/core';

export interface IdentityAssessment {
  match: IdentityMatch;
  reasons: string[];
  /** Liczba kroków od identyfikatora analityka, których nie potwierdza odnośnik zwrotny. */
  distance?: number;
  /** Profil sam odsyła do identyfikatora podmiotu albo do profilu, który go wskazał. */
  mutual?: boolean;
}

/** Położenie profilu na ścieżce odkrywania: który krok i przez jaki identyfikator do niego doszliśmy. */
export interface DiscoveryPath {
  /** Numer kroku wyszukiwania (1 = identyfikator odkryty w profilu znalezionym wprost). */
  step: number;
  /** Niepotwierdzone kroki, jeśli ten profil nie odeśle z powrotem. */
  distance: number;
  /** Identyfikator, po którym odnaleziono profil wskazujący. */
  parent?: Identifier;
}

/** Identyfikatory, które z natury wskazują jedną osobę lub jedno konto. */
const UNIQUE_TYPES: IdentifierType[] = ['email', 'profile_url', 'ens_name', 'messenger_id', 'crypto_address'];

export const isUniqueType = (type: IdentifierType): boolean => UNIQUE_TYPES.includes(type);

const MATCH_RANK: Record<IdentityMatch, number> = {
  verified_link: 5,
  exact_identifier: 4,
  linked_profile: 3,
  same_handle: 2,
  common_handle: 1,
  name_only: 0,
};

/** Porządek ocen tożsamości od najsłabszej (0) do najmocniejszej (5). */
export const matchRank = (match: IdentityMatch): number => MATCH_RANK[match];

const TYPE_LABEL: Record<IdentifierType, string> = {
  full_name: 'imię i nazwisko',
  nick: 'nick',
  login: 'login',
  email: 'e-mail',
  messenger_id: 'identyfikator komunikatora',
  crypto_address: 'adres kryptowalutowy',
  profile_url: 'adres profilu',
  ens_name: 'nazwa ENS',
};

const COMMON_WORDS = new Set([
  'admin', 'user', 'test', 'anon', 'anonim', 'krypto', 'crypto', 'bitcoin', 'btc', 'eth', 'trader', 'hodl',
  'adam', 'anna', 'ania', 'bartek', 'kasia', 'kuba', 'jakub', 'jan', 'janek', 'kamil', 'karol', 'krzysiek',
  'maciek', 'maciej', 'magda', 'marcin', 'marek', 'mateusz', 'michal', 'ola', 'pawel', 'piotr', 'piotrek',
  'tomek', 'tomasz', 'wojtek',
]);

/** Krótki albo słownikowy nick: duże ryzyko, że pod tą samą nazwą kryją się różne osoby. */
export function isCommonHandle(handle: string): boolean {
  const value = handle.trim().replace(/^@/, '').toLowerCase();
  const letters = value.replace(/[\d_.-]+$/g, '');
  return value.length <= 5 || COMMON_WORDS.has(letters);
}

/** Nazwa w postaci porównywalnej między źródłami (bez `@`, małe litery). */
export const normalize = (value: string): string => value.trim().replace(/^@/, '').toLowerCase();

const describe = (items: Identifier[]) =>
  items.map((item) => `${TYPE_LABEL[item.type]} „${item.value}”`).join(', ');

/** Inne identyfikatory wejściowe obecne w treści profilu lub w jego odnośnikach. */
function corroborating(doc: SourceDocument, inputs: Identifier[]): Identifier[] {
  const text = doc.text.toLowerCase();
  const linked = new Set((doc.discoveredIdentifiers ?? []).map((item) => normalize(item.value)));
  const matched = normalize(doc.matchedIdentifier.value);
  return inputs.filter((input) => {
    const value = normalize(input.value);
    // Krótkie wartości trafiałyby przypadkiem we fragmenty innych słów.
    if (value === matched || value.length < 4) return false;
    return linked.has(value) || text.includes(value);
  });
}

const VERIFIED_BY_SOURCE: IdentityAssessment = {
  match: 'verified_link',
  reasons: ['Źródło potwierdza tożsamość profilu.'],
  distance: 0,
};

/** Ocena profilu odnalezionego wprost po identyfikatorze podanym przez analityka. */
export function assessIdentity(doc: SourceDocument, inputs: Identifier[]): IdentityAssessment {
  // Łącznik sam potwierdził tożsamość (np. dowód kryptograficzny) — nie osłabiamy tego.
  if (doc.identityMatch === 'verified_link') return VERIFIED_BY_SOURCE;

  const confirmations = corroborating(doc, inputs);
  const type = doc.matchedIdentifier.type;

  if (doc.identityMatch === 'name_only' || type === 'full_name') {
    const strong = confirmations.filter((item) => item.type !== 'full_name');
    if (strong.length > 0) {
      return {
        match: 'exact_identifier',
        reasons: [`Profil odnaleziony po imieniu i nazwisku zawiera także: ${describe(strong)}.`],
      };
    }
    return {
      match: 'name_only',
      reasons: ['Zgadza się tylko imię i nazwisko — tak samo może nazywać się inna osoba.'],
    };
  }

  if (UNIQUE_TYPES.includes(type)) {
    return {
      match: 'exact_identifier',
      reasons: [`Profil odnaleziony po identyfikatorze unikalnym (${TYPE_LABEL[type]}).`],
    };
  }

  if (confirmations.length > 0) {
    return {
      match: 'exact_identifier',
      reasons: [`Oprócz nicku profil zawiera także: ${describe(confirmations)}.`],
    };
  }
  if (isCommonHandle(doc.matchedIdentifier.value)) {
    return {
      match: 'common_handle',
      reasons: ['Zgadza się tylko nick, w dodatku pospolity — w tym serwisie może go używać inna osoba.'],
    };
  }
  return {
    match: 'same_handle',
    reasons: ['Zgadza się tylko nick; w treści profilu nie ma innego identyfikatora podmiotu.'],
  };
}

/** Wartość porównywalna: adres strony bez protokołu, `www.` i końcowego ukośnika; inne — jak `normalize`. */
function comparable(item: Identifier): string {
  const value = normalize(item.value);
  return item.type === 'profile_url' ? value.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') : value;
}

/**
 * Ocena profilu znalezionego po imieniu i nazwisku, które podał inny, mocno przypisany profil podmiotu
 * (nazwa wyświetlana). Taki profil może należeć do imiennika: potwierdza go dopiero drugi identyfikator —
 * podany przez analityka (`inputs`) albo ustalony w sprawie z profili mocno przypisanych (`known`: e-mail,
 * strona, adres profilu). Bez tego zostaje „zgodne tylko imię i nazwisko”.
 */
export function assessNameSearchProfile(doc: SourceDocument, inputs: Identifier[], known: Identifier[], distance = 1): IdentityAssessment {
  if (doc.identityMatch === 'verified_link') return VERIFIED_BY_SOURCE;
  const direct = corroborating(doc, inputs).filter((item) => item.type !== 'full_name');
  if (direct.length > 0) {
    return { match: 'exact_identifier', reasons: [`Profil odnaleziony po imieniu i nazwisku zawiera także: ${describe(direct)}.`], distance: 0 };
  }
  const text = doc.text.toLowerCase();
  const linked = new Set((doc.discoveredIdentifiers ?? []).map(comparable));
  const ownUrl = comparable({ type: 'profile_url', value: doc.url });
  const hits = known.filter((item) => {
    if (item.type === 'full_name') return false;
    const value = comparable(item);
    if (value.length < 4 || value === ownUrl) return false;
    return linked.has(value) || text.includes(value);
  });
  if (hits.length > 0) {
    return {
      match: 'linked_profile',
      reasons: [`Profil odnaleziony po imieniu i nazwisku z profilu podmiotu zawiera także identyfikator ustalony w sprawie: ${describe(hits)}.`],
      distance,
    };
  }
  return {
    match: 'name_only',
    reasons: ['Profil odnaleziony po imieniu i nazwisku z profilu podmiotu; poza nazwą nie ma w nim żadnego identyfikatora sprawy — możliwy imiennik.'],
    distance,
  };
}

/**
 * Ocena profilu wskazanego przez inny profil podmiotu. Jeśli sam odsyła z powrotem do
 * identyfikatora podmiotu, odnośniki są wzajemne i tożsamość uznajemy za potwierdzoną.
 * Każdy kolejny krok bez odnośnika zwrotnego zwiększa `distance` — ocena słabnie.
 */
export function assessLinkedProfile(
  doc: SourceDocument,
  inputs: Identifier[],
  inherited: IdentityMatch,
  path: DiscoveryPath = { step: 1, distance: 1 },
): IdentityAssessment {
  if (doc.identityMatch === 'verified_link') return VERIFIED_BY_SOURCE;
  if (inherited === 'name_only' || doc.identityMatch === 'name_only') {
    return {
      match: 'name_only',
      reasons: ['Profil wskazany przez dokument dopasowany tylko po imieniu i nazwisku.'],
      distance: path.distance,
    };
  }
  const back = corroborating(doc, inputs);
  if (back.length > 0) {
    return {
      match: 'verified_link',
      reasons: [`Odnośniki wzajemne: profil wskazany przez inny profil podmiotu sam zawiera ${describe(back)}.`],
      distance: 0,
      mutual: true,
    };
  }
  // Dalszy krok: odnośnik zwrotny do profilu pośredniego nie potwierdza podmiotu,
  // ale sprawia, że ten krok nie osłabia oceny bardziej niż profil pośredni.
  if (path.parent && corroborating(doc, [path.parent]).length > 0) {
    return {
      match: 'linked_profile',
      reasons: [
        `Odnośniki wzajemne z profilem pośrednim (${describe([path.parent])}); do identyfikatora podanego przez analityka profil nie odsyła.`,
      ],
      distance: Math.max(1, path.distance - 1),
      mutual: true,
    };
  }
  return {
    match: 'linked_profile',
    reasons: [
      path.distance <= 1
        ? 'Profil wskazany przez inny profil podmiotu; sam nie odsyła z powrotem.'
        : `Profil odnaleziony pośrednio, w ${path.distance} krokach bez odnośnika zwrotnego — każdy taki krok osłabia ocenę.`,
    ],
    distance: path.distance,
  };
}
