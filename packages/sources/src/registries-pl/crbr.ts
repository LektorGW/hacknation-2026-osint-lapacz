// Centralny Rejestr Beneficjentów Rzeczywistych (CRBR) — publiczne API przeglądowe Ministerstwa Finansów.
//
// Podstawa (sprawdzone 22.11.2026; szczegóły i cytaty w docs/ZRODLA-PODSTAWA-PRAWNA.md, sekcja 3):
//   • ustawa z 1.03.2018 r. o przeciwdziałaniu praniu pieniędzy oraz finansowaniu terroryzmu (t.j. Dz.U. 2025 poz. 644):
//     art. 67 „Rejestr jest jawny.”; art. 69 „Informacje, o których mowa w art. 59, zgromadzone w Rejestrze są
//     udostępniane nieodpłatnie.”; art. 70 „… są udostępniane za pomocą środków komunikacji elektronicznej.”
//   • „Usługa API do udostępniania danych z systemu CRBR — Specyfikacja Wejścia-Wyjścia” v3.0.4 (MF, 9.03.2023),
//     rozdz. 3 „Warunki dostępu do usługi”: „Usługa jest dostępna publicznie.” Usługa SOAP 1.2 ApiPrzegladoweCRBR,
//     operacja PobierzInformacjeOSpolkachIBeneficjentach, bez klucza, bez captcha.
//
// Minimalizacja danych (zasady OŁCyŚ):
//   • pytamy WYŁĄCZNIE o spółkę — po NIP albo KRS; wyszukiwanie osoby (PESEL, imię i nazwisko, data urodzenia)
//     celowo nie jest zaimplementowane;
//   • z odpowiedzi NIE odczytujemy numeru PESEL ani daty urodzenia beneficjenta, a także danych reprezentantów
//     (osób zgłaszających) — parser ich po prostu nie czyta;
//   • NIE przenosimy adresu siedziby spółki do wyniku: beneficjent rzeczywisty nigdy nie jest wiązany z adresem;
//   • imiona i nazwiska beneficjentów są pokazywane tak, jak je opublikował rejestr, z rolą
//     „beneficjent rzeczywisty (CRBR)” — to fakt z rejestru o spółce, a nie przypisanie adresu kryptowalutowego osobie.

import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { USER_AGENT } from '../http.ts';
import { isValidNip, registryNumber } from '../registry.ts';
import { decodeXml, withoutBlocks, xmlBlocks, xmlText } from './xml.ts';

export const CRBR_ID = 'live-crbr';
export const CRBR_SERVICE = 'crbr.podatki.gov.pl';
export const CRBR_LABEL = 'Centralny Rejestr Beneficjentów Rzeczywistych (MF)';
/** Adres usługi z rozdz. 4 specyfikacji v3.0.4. */
export const CRBR_ENDPOINT = 'https://bramka-crbr.mf.gov.pl:5058/uslugiBiznesowe/uslugiESB/AP/ApiPrzegladoweCRBR/2022/12/01';
/** Publiczna wyszukiwarka CRBR — odnośnik dla analityka do ręcznego sprawdzenia. */
export const CRBR_SEARCH_PAGE = 'https://crbr.podatki.gov.pl/adcrbr/#/wyszukaj';
export const CRBR_ROLE = 'beneficjent rzeczywisty (CRBR)';
/** Specyfikacja nie podaje limitu; łącznik sam ogranicza się do tylu zapytań na dobę i 1 s odstępu. */
export const CRBR_DAILY_LIMIT = 300;
const CRBR_MIN_INTERVAL_MS = 1000;
const NS_SERVICE = 'http://www.mf.gov.pl/uslugiBiznesowe/uslugiESB/AP/ApiPrzegladoweCRBR/2022/12/01';
const NS_SCHEMA = 'http://www.mf.gov.pl/schematy/AP/ApiPrzegladoweCRBR/2022/12/01';

export type CrbrQuery = { nip: string } | { krs: string };

export interface CrbrBeneficialOwner {
  /** Imię (imiona) i nazwisko tak, jak w rejestrze; dla beneficjenta grupowego trustu — jego nazwa. */
  name: string;
  /** Obywatelstwo (kod kraju) — bez numeru PESEL i daty urodzenia. */
  citizenship?: string;
  /** Państwo zamieszkania (kod kraju) — nie adres. */
  residenceCountry?: string;
  /** Opis udziałów lub uprawnień (np. „udziały: 60 sztuk”). */
  interests: string[];
  group?: boolean;
}

export interface CrbrCompany {
  name: string;
  nip?: string;
  krs?: string;
  legalForm?: string;
  beneficialOwners: CrbrBeneficialOwner[];
  /** Data, od której prezentowane jest zgłoszenie. */
  presentedFrom?: string;
  presentedTo?: string;
  corrected?: string;
  referenceNumber?: string;
  /** Liczba rozbieżności zgłoszonych do zgłoszenia przez instytucje obowiązane / organy (art. 61a ustawy AML). */
  discrepancies: number;
  /** Informacja o postępowaniu (pole „Postepowanie”) — tekst z rejestru. */
  proceeding?: string;
}

export interface CrbrLookup {
  /** `IstniejaInformacje`, `BrakInformacji`, `BladFormalny` (wg specyfikacji) albo `blad` (sieć, SOAP Fault). */
  status: 'IstniejaInformacje' | 'BrakInformacji' | 'BladFormalny' | 'blad';
  companies: CrbrCompany[];
  requestId?: string;
  requestTime?: string;
  httpStatus: number;
  error?: string;
}

/** Odpowiedź potrzebna łącznikowi — zgodna z `fetch` i z atrapami w testach. */
export type CrbrFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'follow' },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface CrbrOptions {
  fetch?: CrbrFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Odstęp między zapytaniami tego procesu (domyślnie 1 s; testy: 0). */
  minIntervalMs?: number;
  userAgent?: string;
}

/** Koperta SOAP 1.2 żądania (przykład z rozdz. 4.1.3 specyfikacji). Numer musi być wcześniej sprawdzony. */
export function crbrRequestXml(query: CrbrQuery): string {
  const criteria = 'nip' in query ? `<ns1:NIP>${query.nip}</ns1:NIP>` : `<ns1:KRS>${query.krs}</ns1:KRS>`;
  return (
    `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:ns="${NS_SERVICE}" xmlns:ns1="${NS_SCHEMA}">` +
    '<soap:Header/><soap:Body><ns:PobierzInformacjeOSpolkachIBeneficjentach><PobierzInformacjeOSpolkachIBeneficjentachDane>' +
    `<ns1:SzczegolyWniosku>${criteria}</ns1:SzczegolyWniosku>` +
    '</PobierzInformacjeOSpolkachIBeneficjentachDane></ns:PobierzInformacjeOSpolkachIBeneficjentach></soap:Body></soap:Envelope>'
  );
}

const numberText = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed).replace('.', ',') : value;
};

/** Opis jednego rodzaju uprawnień: „udziały w spółce: 60 sztuk (uprzywilejowanie: …)”. */
function interestOf(block: string, kind: string): string | undefined {
  const type = xmlText(block, 'RodzajUprawnienWlascicielskich');
  const amount = numberText(xmlText(block, 'Ilosc'));
  const unit = xmlText(block, 'JednostkaMiary');
  const privilege = xmlText(block, 'RodzajUprzywilejowania');
  const privilegeNote = xmlText(block, 'OpisUprzywilejowania');
  if (type || amount) {
    return `${kind}: ${type ?? 'uprawnienia'}${amount ? ` — ${amount}${unit ? ` (${unit})` : ''}` : ''}${privilege && !/^brak$/i.test(privilege) ? `; uprzywilejowanie: ${privilege}${privilegeNote ? ` — ${privilegeNote}` : ''}` : ''}`;
  }
  // Inne uprawnienia mają opis słowny — bierzemy teksty liści (bez numerów identyfikacyjnych osób).
  const leaves = [...block.matchAll(/>([^<>]+)</g)].map((match) => decodeXml(match[1]!).trim()).filter((text) => text && !/^\d{11}$/.test(text));
  return leaves.length > 0 ? `${kind}: ${leaves.slice(0, 3).join('; ')}` : undefined;
}

/**
 * Odczyt odpowiedzi PobierzInformacjeOSpolkachIBeneficjentachOdpowiedz. Nie czyta numerów PESEL, dat urodzenia,
 * reprezentantów ani adresu siedziby — tych danych wynik nie zawiera.
 */
export function parseCrbrResponse(xml: string, httpStatus = 200): CrbrLookup {
  if (/<(?:[\w.-]+:)?Fault[\s>]/.test(xml)) {
    return { status: 'blad', companies: [], httpStatus, error: `SOAP Fault: ${xmlText(xml, 'Text') ?? xmlText(xml, 'faultstring') ?? 'brak opisu'}` };
  }
  const statusText = xmlText(xml, 'Status');
  const status = statusText === 'IstniejaInformacje' || statusText === 'BrakInformacji' || statusText === 'BladFormalny' ? statusText : 'blad';
  const companies: CrbrCompany[] = [];
  for (const block of xmlBlocks(xml, 'SpolkaIBeneficjenci')) {
    const own = withoutBlocks(block, 'ListaBeneficjentowRzeczywistych', 'ListaReprezentantow', 'RejestrZagranicznyTrust', 'ListaInformacjiORozbieznosciach', 'Teryt');
    const name = xmlText(own, 'Nazwa');
    if (!name) continue;
    const owners: CrbrBeneficialOwner[] = [];
    for (const ownerBlock of xmlBlocks(block, 'BeneficjentRzeczywisty')) {
      const group = xmlText(ownerBlock, 'NazwaBeneficjentaGrupowego');
      const personName = [xmlText(ownerBlock, 'PierwszeImie'), xmlText(ownerBlock, 'KolejneImiona')?.replace(/\s*,\s*/g, ' '), xmlText(ownerBlock, 'Nazwisko')].filter(Boolean).join(' ').trim();
      const interests = xmlBlocks(ownerBlock, 'InformacjaOUdzialach').flatMap((info) => [
        ...xmlBlocks(info, 'UprawnieniaWlascicielskieBezposrednie').map((item) => interestOf(item, 'bezpośrednio')),
        ...xmlBlocks(info, 'UprawnieniaWlascicielskiePosrednie').map((item) => interestOf(item, 'pośrednio')),
        ...xmlBlocks(info, 'InneUprawnienia').map((item) => interestOf(item, 'inne uprawnienia')),
      ]);
      const groupRights = xmlText(ownerBlock, 'InformacjeOUprawnieniachPrzyslugujacychBeneficjentowiGrupowemuTrust');
      const ownerName = personName || group;
      if (!ownerName) continue;
      owners.push({
        name: ownerName,
        ...(xmlText(ownerBlock, 'Obywatelstwo') ? { citizenship: xmlText(ownerBlock, 'Obywatelstwo')! } : {}),
        ...(xmlText(ownerBlock, 'KrajZamieszkania') ? { residenceCountry: xmlText(ownerBlock, 'KrajZamieszkania')! } : {}),
        interests: [...interests.filter((item): item is string => Boolean(item)), ...(groupRights ? [`uprawnienia beneficjenta grupowego: ${groupRights}`] : [])].slice(0, 6),
        ...(!personName && group ? { group: true } : {}),
      });
    }
    const nip = xmlText(own, 'NIP');
    const krs = xmlText(own, 'KRS');
    companies.push({
      name,
      ...(nip ? { nip } : {}),
      ...(krs ? { krs } : {}),
      ...(xmlText(own, 'OpisFormyOrganizacyjnej') ? { legalForm: xmlText(own, 'OpisFormyOrganizacyjnej')! } : {}),
      beneficialOwners: owners,
      ...(xmlText(own, 'DataPoczatkuPrezentacjiZgloszenia') ? { presentedFrom: xmlText(own, 'DataPoczatkuPrezentacjiZgloszenia')! } : {}),
      ...(xmlText(own, 'DataKoncaPrezentacjiZgloszenia') ? { presentedTo: xmlText(own, 'DataKoncaPrezentacjiZgloszenia')! } : {}),
      ...(xmlText(own, 'Skorygowane') ? { corrected: xmlText(own, 'Skorygowane')! } : {}),
      ...(xmlText(own, 'NumerReferencyjny') ? { referenceNumber: xmlText(own, 'NumerReferencyjny')! } : {}),
      discrepancies: xmlBlocks(block, 'InformacjaORozbieznosciach').length,
      ...(xmlText(own, 'Postepowanie') ? { proceeding: xmlText(own, 'Postepowanie')! } : {}),
    });
  }
  const requestId = xmlText(xml, 'IdentyfikatorWniosku');
  const requestTime = xmlText(xml, 'DataICzasUdostepnieniaWniosku') ?? xmlText(xml, 'DataICzasZlozeniaWniosku');
  return {
    status,
    companies,
    httpStatus,
    ...(requestId ? { requestId } : {}),
    ...(requestTime ? { requestTime } : {}),
    ...(status === 'blad' ? { error: 'odpowiedź bez rozpoznanego statusu' } : status === 'BladFormalny' ? { error: 'rejestr odrzucił zapytanie jako niepoprawne (BladFormalny)' } : {}),
  };
}

let nextSlot = 0;
let countedDay = '';
let usedToday = 0;

/** Wspólny dla procesu licznik dobowy i odstęp między zapytaniami do usługi CRBR. */
async function pace(minIntervalMs: number, signal?: AbortSignal): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== countedDay) {
    countedDay = day;
    usedToday = 0;
  }
  if (usedToday >= CRBR_DAILY_LIMIT) return false;
  usedToday++;
  const wait = nextSlot - Date.now();
  nextSlot = Math.max(Date.now(), nextSlot) + minIntervalMs;
  if (wait > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  }
  return true;
}

/** Numer do zapytania: NIP z poprawną cyfrą kontrolną albo 10-cyfrowy KRS; inaczej `null` (bez zapytania). */
export function crbrQueryOf(value: { nip?: string; krs?: string }): CrbrQuery | null {
  const nip = value.nip?.replace(/\D/g, '');
  if (nip && isValidNip(nip)) return { nip };
  const krs = value.krs?.replace(/\D/g, '');
  if (krs && /^\d{1,10}$/.test(krs) && Number(krs) > 0) return { krs: krs.padStart(10, '0') };
  return null;
}

/** Jedno zapytanie do API przeglądowego CRBR (spółka po NIP albo KRS). Nigdy nie rzuca wyjątku. */
export async function queryCrbr(query: CrbrQuery, options: CrbrOptions = {}): Promise<CrbrLookup> {
  const doFetch: CrbrFetch = options.fetch ?? ((url, init) => fetch(url, init));
  try {
    if (!(await pace(options.minIntervalMs ?? CRBR_MIN_INTERVAL_MS, options.signal))) {
      return { status: 'blad', companies: [], httpStatus: 0, error: `wyczerpano dobowy limit ${CRBR_DAILY_LIMIT} zapytań łącznika` };
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await doFetch(CRBR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', Accept: 'application/soap+xml, text/xml', 'User-Agent': options.userAgent ?? USER_AGENT },
      body: crbrRequestXml(query),
      signal,
      redirect: 'follow',
    });
    const text = await response.text();
    // SOAP 1.2 zwraca Fault z kodem 500 — odczytujemy opis zamiast samego kodu.
    if (!response.ok && !/Fault/.test(text)) return { status: 'blad', companies: [], httpStatus: response.status, error: `kod ${response.status}` };
    return parseCrbrResponse(text, response.status);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { status: 'blad', companies: [], httpStatus: 0, error: name === 'TimeoutError' || name === 'AbortError' ? 'przekroczono limit czasu lub przerwano' : error instanceof Error ? error.message : String(error) };
  }
}

/** Wiersz beneficjenta w treści dokumentu (format czytany przez business.ts — `registryDetailsOf`). */
export function beneficialOwnerLine(owner: CrbrBeneficialOwner): string {
  const facts = [
    owner.group ? 'beneficjent grupowy (trust)' : undefined,
    owner.citizenship ? `obywatelstwo: ${owner.citizenship}` : undefined,
    owner.residenceCountry ? `państwo zamieszkania: ${owner.residenceCountry}` : undefined,
    ...owner.interests,
  ].filter(Boolean);
  return `Beneficjent rzeczywisty: ${owner.name}${facts.length > 0 ? ` (${facts.join('; ')})` : ''}`;
}

/** Dokument źródłowy z wpisu CRBR — dane o spółce; beneficjenci w roli z rejestru, bez adresu i bez PESEL. */
export function crbrDocument(company: CrbrCompany, lookup: CrbrLookup, identifier: Identifier, fetchedAt: string): SourceDocument {
  const key = company.nip ? `NIP ${company.nip}` : company.krs ? `KRS ${company.krs}` : identifier.value;
  const discovered: Identifier[] = [];
  if (company.krs && /^\d{10}$/.test(company.krs) && !/KRS/i.test(identifier.value)) discovered.push({ type: 'login', value: `KRS ${company.krs}` });
  if (company.nip && isValidNip(company.nip) && !/NIP/i.test(identifier.value)) discovered.push({ type: 'login', value: `NIP ${company.nip}` });
  return {
    connectorId: CRBR_ID,
    service: CRBR_SERVICE,
    // Usługa SOAP nie ma stron wpisów; odnośnik do publicznej wyszukiwarki z numerem do powtórzenia sprawdzenia.
    url: `${CRBR_SEARCH_PAGE}?${company.nip ? `nip=${company.nip}` : `krs=${company.krs ?? ''}`}`,
    title: `CRBR: ${company.name} (${key})`,
    text: [
      `Wpis w Centralnym Rejestrze Beneficjentów Rzeczywistych (API przeglądowe CRBR, Ministerstwo Finansów${lookup.requestTime ? `; stan na ${lookup.requestTime}` : ''})`,
      `Nazwa: ${company.name}`,
      company.nip && `NIP: ${company.nip}`,
      company.krs && `KRS: ${company.krs}`,
      company.legalForm && `Forma organizacyjna: ${company.legalForm}`,
      `Liczba beneficjentów rzeczywistych w zgłoszeniu: ${company.beneficialOwners.length}`,
      ...company.beneficialOwners.slice(0, 15).map(beneficialOwnerLine),
      company.presentedFrom && `Zgłoszenie prezentowane od: ${company.presentedFrom}${company.presentedTo ? ` do ${company.presentedTo}` : ''}`,
      company.corrected && `Korekta: ${company.corrected}`,
      company.referenceNumber && `Numer referencyjny zgłoszenia: ${company.referenceNumber}`,
      company.discrepancies > 0 && `Zgłoszone rozbieżności do wpisu: ${company.discrepancies} (rejestr publikuje informację o rozbieżnościach zgłoszonych przez instytucje obowiązane lub organy)`,
      company.proceeding && `Postępowanie: ${company.proceeding}`,
      lookup.requestId && `Identyfikator zapytania w CRBR: ${lookup.requestId}`,
      'Uwaga: beneficjent rzeczywisty to rola wobec spółki według zgłoszenia do jawnego rejestru (art. 67 ustawy AML) — nie dowodzi, kto posługuje się adresami kryptowalutowymi spółki. Numerów PESEL, dat urodzenia ani adresów osób narzędzie nie pobiera.',
    ]
      .filter(Boolean)
      .join('\n'),
    fetchedAt,
    // Dane urzędowe o spółce, bez adresów kryptowalutowych; kategoria nie wpływa na wskaźniki przypisania adresu.
    category: 'forum_post',
    identityMatch: 'exact_identifier',
    matchedIdentifier: identifier,
    profile: { handle: key, organization: company.name, registryEntries: [key, ...(company.krs && company.nip ? [`KRS ${company.krs}`] : [])] },
    ...(discovered.length > 0 ? { discoveredIdentifiers: discovered } : {}),
  };
}

export interface CrbrConnectorOptions extends Omit<CrbrOptions, 'signal'> {}

/**
 * Łącznik `live-crbr`: identyfikator „NIP 1234567890” albo „KRS 0000012345” → wpis spółki w CRBR i jej beneficjenci
 * rzeczywiści (imię i nazwisko, obywatelstwo, państwo zamieszkania, udziały). Jedno zapytanie na identyfikator.
 */
export function createCrbrConnector(options: CrbrConnectorOptions = {}): SourceConnector {
  return {
    id: CRBR_ID,
    service: CRBR_SERVICE,
    label: CRBR_LABEL,
    description:
      'Centralny Rejestr Beneficjentów Rzeczywistych — publiczne API przeglądowe Ministerstwa Finansów (SOAP, bez klucza; rejestr jawny z mocy art. 67 ustawy AML). ' +
      'Wpisz identyfikator jako „NIP 1234567890” albo „KRS 0000012345” — wynik: nazwa spółki i jej beneficjenci rzeczywiści (imię i nazwisko, obywatelstwo, ' +
      'państwo zamieszkania, udziały), liczba zgłoszonych rozbieżności. Narzędzie nie pobiera numerów PESEL, dat urodzenia ani adresów osób i nie szuka po osobie. ' +
      `Jedno zapytanie na identyfikator, odstęp 1 s, najwyżej ${CRBR_DAILY_LIMIT} na dobę.`,
    accepts: ['login', 'nick'],
    enabledByDefault: true,

    async search(identifier, context) {
      const number = registryNumber(identifier);
      if (!number || number.kind === 'bank_account') return [];
      const query = number.kind === 'nip' ? { nip: number.value } : { krs: number.value };
      const lookup = await queryCrbr(query, { ...options, ...(context.signal ? { signal: context.signal } : {}) });
      if (lookup.status === 'blad' || lookup.status === 'BladFormalny') {
        context.log(`${CRBR_LABEL}: „${identifier.value}” — ${lookup.error ?? 'błąd'}; brak wyniku nie oznacza braku wpisu.`);
        return [];
      }
      if (lookup.companies.length === 0) {
        context.log(`${CRBR_LABEL}: „${identifier.value}” — brak informacji w rejestrze (spółka nie podlega zgłoszeniu albo go nie złożyła).`);
        return [];
      }
      const fetchedAt = new Date().toISOString();
      const documents = lookup.companies.slice(0, 3).map((company) => crbrDocument(company, lookup, identifier, fetchedAt));
      context.log(`${CRBR_LABEL}: „${identifier.value}” — ${lookup.companies.map((company) => `${company.name}: beneficjentów ${company.beneficialOwners.length}`).join('; ')}.`);
      return documents;
    },
  };
}
