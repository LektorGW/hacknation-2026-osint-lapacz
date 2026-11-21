// Polskie rejestry publiczne: wykaz podatników VAT („biała lista", Ministerstwo Finansów / KAS)
// oraz Krajowy Rejestr Sądowy (otwarte API Ministerstwa Sprawiedliwości). Oba źródła są urzędowe,
// jawne i dostępne bez klucza. Łączniki wiążą numer NIP / KRS / rachunek bankowy znaleziony np. w ofercie
// z nazwą zarejestrowanego podmiotu — nie szukają adresów kryptowalutowych.
//
// Podstawa (sprawdzone 21.11.2026):
//   • Wykaz podatników VAT — https://www.gov.pl/web/kas/api-wykazu-podatnikow-vat : urzędowe API dla systemów
//     zewnętrznych, bez klucza. Limit: „Przy wykorzystaniu metody »search« możesz złożyć 100 zapytań dziennie
//     […] Po wyczerpaniu jednego z limitów dostęp do API może być zablokowany do godziny 0:00." Łącznik liczy
//     własne zapytania i po 80 na dobę przestaje pytać; między żądaniami zachowuje co najmniej 2 s.
//     Od 15.10.2026 usługa działa pod adresem wykazpodatnikowvat.mf.gov.pl (stary wl-api.mf.gov.pl do 1.12.2026).
//   • KRS — https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/<numer>?rejestr=P|S&format=json : otwarte API bez klucza,
//     brak pliku robots.txt (404) i brak opublikowanego limitu; wyszukiwanie WYŁĄCZNIE po numerze KRS.
//     Łącznik wysyła najwyżej 2 żądania na numer (rejestr przedsiębiorców, potem stowarzyszeń) z odstępem 2 s.
//     Imiona i nazwiska członków organów API zwraca zamaskowane („A***") — łącznik niczego nie odtwarza.
//   • CEIDG (dane.biznes.gov.pl/api/ceidg/v3) wymaga tokenu wydawanego po rejestracji (bez niego kod 401) —
//     NIE jest zaimplementowany: bez tokenu nie da się zweryfikować kształtu odpowiedzi.
//
// Identyfikator wpisuje się jako login lub nick w postaci „NIP 1234567890", „KRS 0000012345" albo
// „rachunek <26 cyfr>" (typy identyfikatorów w @olcys/core nie mają osobnego rodzaju „numer rejestrowy").

import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { parseJson } from './http.ts';
import type { HttpClient } from './http.ts';
import { dedupeIdentifiers, discoveredField, parseHttpUrl } from './identity.ts';

const MIN_INTERVAL_MS = 2000;

// ---------- Rozpoznawanie numerów ----------

/** NIP: 10 cyfr z poprawną cyfrą kontrolną (wagi 6,5,7,2,3,4,5,6,7; reszta z dzielenia przez 11). */
export function isValidNip(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(digits)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce((total, weight, i) => total + weight * Number(digits[i]), 0);
  return sum % 11 === Number(digits[9]);
}

/** Numer rachunku w formacie NRB: 26 cyfr z poprawną sumą kontrolną IBAN (mod 97) dla kraju PL. */
export function isValidNrb(value: string): boolean {
  const digits = value.replace(/^PL/i, '').replace(/[\s-]/g, '');
  if (!/^\d{26}$/.test(digits)) return false;
  // IBAN: numer bez cyfr kontrolnych + „PL" (25 21) + cyfry kontrolne; reszta z dzielenia przez 97 ma być 1.
  const rearranged = `${digits.slice(2)}2521${digits.slice(0, 2)}`;
  let remainder = 0;
  for (const char of rearranged) remainder = (remainder * 10 + Number(char)) % 97;
  return remainder === 1;
}

export type RegistryNumber = { kind: 'nip' | 'krs' | 'bank_account'; value: string };

/** Numer rejestrowy z identyfikatora: „NIP …", „PL<NIP>", „KRS …", „rachunek …" / „konto …" / „NRB …" / „PL<26 cyfr>". */
export function registryNumber(identifier: Identifier): RegistryNumber | null {
  if (identifier.type !== 'login' && identifier.type !== 'nick') return null;
  const value = identifier.value.trim();
  const nip = /^(?:NIP[\s:]*(?:PL)?|PL)\s*(\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}|\d{3}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{3})$/i.exec(value);
  if (nip) return isValidNip(nip[1]!) ? { kind: 'nip', value: nip[1]!.replace(/[\s-]/g, '') } : null;
  const krs = /^KRS[\s:]*(\d{1,10})$/i.exec(value);
  if (krs) return Number(krs[1]) > 0 ? { kind: 'krs', value: krs[1]!.padStart(10, '0') } : null;
  const account = /^(?:(?:rachunek|konto|NRB|IBAN)[\s:]*)?((?:PL)?\s*\d{2}(?:[\s-]?\d{4}){6})$/i.exec(value);
  if (account && isValidNrb(account[1]!)) return { kind: 'bank_account', value: account[1]!.replace(/^PL/i, '').replace(/[\s-]/g, '') };
  return null;
}

/**
 * Numery NIP i KRS podane w treści WPROST po etykiecie („NIP: 526-025-02-74", „KRS 0000019193").
 * Sam ciąg cyfr bez etykiety nie jest brany pod uwagę; NIP musi mieć poprawną cyfrę kontrolną.
 */
export function findRegistryNumbers(text: string): RegistryNumber[] {
  const found = new Map<string, RegistryNumber>();
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])NIP(?:[\s:]|\s*nr\.?\s*)*(?:PL)?\s*(\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}|\d{3}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{3})(?!\d)/giu)) {
    const value = match[1]!.replace(/[\s-]/g, '');
    if (isValidNip(value)) found.set(`nip:${value}`, { kind: 'nip', value });
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])KRS(?:[\s:]|\s*nr\.?\s*)*(\d{10})(?!\d)/giu)) {
    if (Number(match[1]) > 0) found.set(`krs:${match[1]}`, { kind: 'krs', value: match[1]! });
  }
  return [...found.values()];
}

/** Zapis numeru jako identyfikator dla łączników rejestrów. */
export const registryIdentifier = (number: RegistryNumber): Identifier => ({
  type: 'login',
  value: number.kind === 'nip' ? `NIP ${number.value}` : number.kind === 'krs' ? `KRS ${number.value}` : `rachunek ${number.value}`,
});

/**
 * Dopisuje do dokumentu identyfikatory rejestrowe (NIP, KRS) podane w jego treści wprost po etykiecie.
 * Tylko dla publikacji własnych (profil, oferta, rozliczenie) pewnie powiązanych z autorem — numer wymieniony
 * w komentarzu albo w dokumencie dopasowanym po samym nazwisku nie uruchamia zapytań do rejestrów.
 */
export function withRegistryIdentifiers(doc: SourceDocument): SourceDocument {
  if (doc.category === 'mass_comment' || doc.category === 'forum_post' || doc.identityMatch === 'name_only') return doc;
  const numbers = findRegistryNumbers(doc.text).slice(0, 3);
  if (numbers.length === 0) return doc;
  const merged = dedupeIdentifiers([...(doc.discoveredIdentifiers ?? []), ...numbers.map(registryIdentifier)], doc.matchedIdentifier);
  return merged.length === (doc.discoveredIdentifiers ?? []).length ? doc : { ...doc, discoveredIdentifiers: merged };
}

const websiteUrl = (value: string | undefined): string | undefined => {
  const url = value ? parseHttpUrl(value.trim().toLowerCase()) : null;
  return url && url.hostname.includes('.') ? url.toString() : undefined;
};

const today = (): string => new Date().toISOString().slice(0, 10);

// ---------- Wykaz podatników VAT („biała lista") ----------

const VAT_ID = 'live-vat-whitelist';
const VAT_SERVICE = 'wykazpodatnikowvat.mf.gov.pl';
const VAT_LABEL = 'Wykaz podatników VAT (MF)';
const VAT_API = 'https://wykazpodatnikowvat.mf.gov.pl/api/search';
/** Urzędowy limit metody „search" to 100 zapytań na dobę; zostawiamy zapas na ręczne sprawdzenia analityka. */
export const VAT_DAILY_LIMIT = 80;

interface VatPerson {
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

interface VatSubject {
  name?: string | null;
  nip?: string | null;
  statusVat?: string | null;
  regon?: string | null;
  krs?: string | null;
  residenceAddress?: string | null;
  workingAddress?: string | null;
  representatives?: VatPerson[] | null;
  authorizedClerks?: VatPerson[] | null;
  partners?: VatPerson[] | null;
  registrationLegalDate?: string | null;
  removalDate?: string | null;
  removalBasis?: string | null;
  accountNumbers?: string[] | null;
  hasVirtualAccounts?: boolean | null;
}

interface VatResponse {
  result?: { subject?: VatSubject | null; subjects?: VatSubject[] | null; requestId?: string; requestDateTime?: string };
  message?: string;
  code?: string;
}

const personNames = (people: VatPerson[] | null | undefined): string[] =>
  (people ?? [])
    .map((person) => person.companyName?.trim() || [person.firstName, person.lastName].filter(Boolean).join(' ').trim())
    .filter((name): name is string => Boolean(name));

export function createVatWhitelistConnector(http: HttpClient): SourceConnector {
  // Licznik dobowy na proces: po przekroczeniu limitu łącznik milknie do północy (czas UTC serwera).
  let countedDay = '';
  let usedToday = 0;

  return {
    id: VAT_ID,
    service: VAT_SERVICE,
    label: VAT_LABEL,
    description:
      'Urzędowy wykaz podatników VAT Ministerstwa Finansów („biała lista", API bez klucza: /api/search/nip/<NIP> oraz ' +
      '/api/search/bank-account/<rachunek>). Wpisz identyfikator jako „NIP 1234567890" albo „rachunek <26 cyfr>" — wynik to nazwa ' +
      'zarejestrowanego podmiotu, status VAT, REGON, KRS, adres i potwierdzenie, czy rachunek jest zgłoszony do wykazu. ' +
      `Limit urzędowy: 100 zapytań na dobę; łącznik kończy po ${VAT_DAILY_LIMIT} i zachowuje 2 s odstępu. Jedno żądanie na identyfikator.`,
    accepts: ['login', 'nick'],
    enabledByDefault: true,

    async search(identifier, context) {
      const number = registryNumber(identifier);
      if (!number || number.kind === 'krs') return [];
      const day = today();
      if (day !== countedDay) {
        countedDay = day;
        usedToday = 0;
      }
      if (usedToday >= VAT_DAILY_LIMIT) {
        context.log(`${VAT_LABEL}: wyczerpano dzienny limit ${VAT_DAILY_LIMIT} zapytań łącznika — pomijam „${identifier.value}" do jutra.`);
        return [];
      }
      usedToday++;
      const path = number.kind === 'nip' ? `nip/${number.value}` : `bank-account/${number.value}`;
      const session = http.session(context, { label: VAT_LABEL, limit: 1 });
      const response = await session.get(`${VAT_API}/${path}?date=${day}`, { headers: { Accept: 'application/json' }, minIntervalMs: MIN_INTERVAL_MS });
      const body = response ? parseJson<VatResponse>(response.text) : null;
      const subjects = (body?.result?.subject ? [body.result.subject] : body?.result?.subjects ?? []).filter((subject) => subject?.name && subject.nip).slice(0, 5);
      if (subjects.length === 0) {
        if (response) context.log(`${VAT_LABEL}: „${identifier.value}" — brak podmiotu w wykazie na dzień ${day}.`);
        return [];
      }

      const documents = subjects.map((subject): SourceDocument => {
        const accounts = subject.accountNumbers ?? [];
        const representatives = personNames(subject.representatives);
        const partners = personNames(subject.partners);
        const entries = [`NIP ${subject.nip} (wykaz podatników VAT: ${subject.statusVat ?? 'status nieznany'})`, ...(subject.krs ? [`KRS ${subject.krs}`] : []), ...(subject.regon ? [`REGON ${subject.regon}`] : [])];
        const discovered: Identifier[] = [];
        if (subject.krs && /^\d{10}$/.test(subject.krs)) discovered.push({ type: 'login', value: `KRS ${subject.krs}` });
        if (number.kind === 'bank_account') discovered.push({ type: 'login', value: `NIP ${subject.nip}` });
        return {
          connectorId: VAT_ID,
          service: VAT_SERVICE,
          // API nie ma stron podmiotów; adres wskazuje zapytanie, którym każdy może powtórzyć sprawdzenie.
          url: `${VAT_API}/nip/${subject.nip}?date=${day}`,
          title: `Wykaz podatników VAT: ${subject.name} (NIP ${subject.nip})`,
          text: [
            `Wpis w urzędowym wykazie podatników VAT (stan na ${day})`,
            `Nazwa: ${subject.name}`,
            `NIP: ${subject.nip}`,
            subject.regon && `REGON: ${subject.regon}`,
            subject.krs && `KRS: ${subject.krs}`,
            `Status VAT: ${subject.statusVat ?? 'brak danych'}`,
            subject.residenceAddress && `Adres siedziby: ${subject.residenceAddress}`,
            subject.workingAddress && `Adres prowadzenia działalności: ${subject.workingAddress}`,
            subject.registrationLegalDate && `Data rejestracji jako podatnik VAT: ${subject.registrationLegalDate}`,
            subject.removalDate && `Data wykreślenia: ${subject.removalDate}${subject.removalBasis ? ` (${subject.removalBasis})` : ''}`,
            representatives.length > 0 && `Reprezentanci: ${representatives.join('; ')}`,
            partners.length > 0 && `Wspólnicy: ${partners.join('; ')}`,
            `Rachunki zgłoszone do wykazu: ${accounts.length}${subject.hasVirtualAccounts ? ' (podmiot używa też rachunków wirtualnych)' : ''}`,
            number.kind === 'bank_account' && `Sprawdzany rachunek ${number.value}: ${accounts.includes(number.value) ? 'figuruje w wykazie jako rachunek tego podmiotu' : 'wskazany przez wykaz jako powiązany z tym podmiotem (rachunek wirtualny lub maska)'}.`,
            body?.result?.requestId && `Identyfikator zapytania w wykazie: ${body.result.requestId}${body.result.requestDateTime ? ` (${body.result.requestDateTime})` : ''}`,
            'Uwaga: wpis dotyczy podmiotu zarejestrowanego pod tym numerem; nie dowodzi, kto faktycznie posługiwał się numerem w publikacji.',
          ]
            .filter(Boolean)
            .join('\n'),
          fetchedAt: new Date().toISOString(),
          // Dane urzędowe o podmiocie, bez adresów kryptowalutowych; kategoria nie wpływa na żaden wskaźnik.
          category: 'forum_post',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: { handle: `NIP ${subject.nip}`, organization: subject.name!, registryEntries: entries },
          ...discoveredField(dedupeIdentifiers(discovered, identifier)),
        };
      });
      context.log(`${VAT_LABEL}: „${identifier.value}" — podmiotów: ${documents.length} (${documents.map((item) => item.profile!.organization).join('; ')}); zapytań dziś: ${usedToday}/${VAT_DAILY_LIMIT}.`);
      return documents;
    },
  };
}

// ---------- Krajowy Rejestr Sądowy ----------

const KRS_ID = 'live-krs';
const KRS_SERVICE = 'api-krs.ms.gov.pl';
const KRS_LABEL = 'Krajowy Rejestr Sądowy (MS)';
const KRS_API = 'https://api-krs.ms.gov.pl/api/krs/OdpisAktualny';

interface KrsMember {
  nazwisko?: { nazwiskoICzlon?: string; nazwiskoIICzlon?: string };
  imiona?: { imie?: string; imieDrugie?: string };
  nazwa?: string;
  funkcjaWOrganie?: string;
}

interface KrsResponse {
  odpis?: {
    naglowekA?: { numerKRS?: string; dataRejestracjiWKRS?: string; stanZDnia?: string };
    dane?: {
      dzial1?: {
        danePodmiotu?: { nazwa?: string; formaPrawna?: string; identyfikatory?: { nip?: string; regon?: string } };
        siedzibaIAdres?: {
          siedziba?: { miejscowosc?: string; wojewodztwo?: string };
          adres?: { ulica?: string; nrDomu?: string; nrLokalu?: string; miejscowosc?: string; kodPocztowy?: string };
          adresStronyInternetowej?: string;
          adresPocztyElektronicznej?: string;
        };
      };
      dzial2?: {
        reprezentacja?: { nazwaOrganu?: string; nazwaOrgan?: string; sposobReprezentacji?: string; sklad?: KrsMember[] };
      };
    };
  };
}

/** Członek organu tak, jak podaje go rejestr (imię i nazwisko są przez API maskowane gwiazdkami). */
const memberLine = (member: KrsMember): string => {
  const name = member.nazwa ?? [member.imiona?.imie, member.imiona?.imieDrugie, member.nazwisko?.nazwiskoICzlon, member.nazwisko?.nazwiskoIICzlon].filter(Boolean).join(' ');
  return `- ${name || 'brak danych'}${member.funkcjaWOrganie ? ` — ${member.funkcjaWOrganie}` : ''}`;
};

export function createKrsConnector(http: HttpClient): SourceConnector {
  return {
    id: KRS_ID,
    service: KRS_SERVICE,
    label: KRS_LABEL,
    description:
      'Otwarte API Krajowego Rejestru Sądowego Ministerstwa Sprawiedliwości (api-krs.ms.gov.pl/api/krs/OdpisAktualny/<numer>, bez klucza). ' +
      'Wyszukiwanie wyłącznie po numerze KRS — wpisz identyfikator jako „KRS 0000012345". Wynik: nazwa i forma prawna podmiotu, NIP, REGON, ' +
      'siedziba, strona WWW i e-mail z rejestru, organ reprezentacji (nazwiska członków API podaje zamaskowane). ' +
      'Najwyżej 2 żądania na numer (rejestr przedsiębiorców, potem stowarzyszeń), odstęp 2 s.',
    accepts: ['login', 'nick'],
    enabledByDefault: true,

    async search(identifier, context) {
      const number = registryNumber(identifier);
      if (number?.kind !== 'krs') return [];
      const session = http.session(context, { label: KRS_LABEL, limit: 2 });
      let body: KrsResponse | null = null;
      let url = '';
      for (const register of ['P', 'S']) {
        url = `${KRS_API}/${number.value}?rejestr=${register}&format=json`;
        const response = await session.get(url, { headers: { Accept: 'application/json' }, minIntervalMs: MIN_INTERVAL_MS, quietMissing: true });
        body = response ? parseJson<KrsResponse>(response.text) : null;
        if (body?.odpis?.dane?.dzial1?.danePodmiotu?.nazwa || session.refused || (session.lastStatus !== 404 && !response)) break;
      }
      const section = body?.odpis?.dane?.dzial1;
      const entity = section?.danePodmiotu;
      if (!entity?.nazwa) {
        context.log(`${KRS_LABEL}: „${identifier.value}" — brak aktualnego odpisu dla numeru ${number.value}.`);
        return [];
      }
      const seat = section?.siedzibaIAdres;
      const address = seat?.adres;
      const addressLine = address ? [[address.ulica, address.nrDomu].filter(Boolean).join(' ') + (address.nrLokalu ? `/${address.nrLokalu}` : ''), [address.kodPocztowy, address.miejscowosc].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
      const website = websiteUrl(seat?.adresStronyInternetowej);
      const email = seat?.adresPocztyElektronicznej?.trim().toLowerCase();
      const board = body!.odpis!.dane!.dzial2?.reprezentacja;
      const nip = entity.identyfikatory?.nip;
      const header = body!.odpis!.naglowekA;

      const discovered: Identifier[] = [];
      if (website) discovered.push({ type: 'profile_url', value: website });
      if (email && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) discovered.push({ type: 'email', value: email });
      // NIP z odpisu prowadzi do wykazu podatników VAT (status, rachunki zgłoszone do wykazu).
      if (nip && isValidNip(nip)) discovered.push({ type: 'login', value: `NIP ${nip}` });

      const document: SourceDocument = {
        connectorId: KRS_ID,
        service: KRS_SERVICE,
        url,
        title: `KRS ${number.value}: ${entity.nazwa}`,
        text: [
          `Odpis aktualny z Krajowego Rejestru Sądowego${header?.stanZDnia ? ` (stan na ${header.stanZDnia})` : ''}`,
          `Nazwa: ${entity.nazwa}`,
          entity.formaPrawna && `Forma prawna: ${entity.formaPrawna}`,
          `KRS: ${number.value}`,
          nip && `NIP: ${nip}`,
          entity.identyfikatory?.regon && `REGON: ${entity.identyfikatory.regon}`,
          header?.dataRejestracjiWKRS && `Data rejestracji w KRS: ${header.dataRejestracjiWKRS}`,
          addressLine && `Adres: ${addressLine}`,
          website && `Strona internetowa podana w rejestrze: ${website}`,
          email && `E-mail podany w rejestrze: ${email}`,
          board?.sklad?.length
            ? `${board.nazwaOrganu ?? board.nazwaOrgan ?? 'Organ reprezentacji'} (dane osobowe zamaskowane przez rejestr):\n${board.sklad.slice(0, 15).map(memberLine).join('\n')}`
            : undefined,
          board?.sposobReprezentacji && `Sposób reprezentacji: ${board.sposobReprezentacji}`,
        ]
          .filter(Boolean)
          .join('\n'),
        fetchedAt: new Date().toISOString(),
        // Dane urzędowe o podmiocie, bez adresów kryptowalutowych; kategoria nie wpływa na żaden wskaźnik.
        category: 'forum_post',
        identityMatch: 'exact_identifier',
        matchedIdentifier: identifier,
        profile: {
          handle: `KRS ${number.value}`,
          organization: entity.nazwa,
          registryEntries: [`KRS ${number.value}`, ...(nip ? [`NIP ${nip}`] : [])],
          ...(website ? { urls: [website] } : {}),
          ...(email ? { emails: [email] } : {}),
        },
        ...discoveredField(dedupeIdentifiers(discovered, identifier)),
      };
      context.log(`${KRS_LABEL}: „${identifier.value}" — ${entity.nazwa}${website ? `, strona ${website}` : ''}.`);
      return [document];
    },
  };
}
