// Odpowiedź usługi (giełdy, serwisu wymiany) na zapytanie uprawnionego organu — DOKUMENT SPOZA OSINT.
//
// Dane blockchain nigdy nie pokazują, kto jest klientem usługi ani czy wypłacono waluty tradycyjne:
// wie to wyłącznie usługa (dane KYC, historia zleceń i wypłat). Analityk wprowadza jej odpowiedź do sprawy,
// a teczka zamyka łańcuch „osoba → adres → usługa → potwierdzony właściciel konta / wypłata na rachunek”.
//
// Zasady (jedyne miejsce):
//  • odpowiedź dotyczy adresu sprawy tylko wtedy, gdy wskazany w niej adres wpłat, adres usługi albo
//    identyfikator transakcji występuje w przelewach lub ścieżkach tego adresu; odpowiedź niedopasowana
//    zostaje w rejestrze i niczego nie zmienia;
//  • wyjście do walut tradycyjnych (ostatni szczebel wskaźnika C) dokumentuje wyłącznie odpowiedź
//    z co najmniej jedną wypłatą na rachunek; samo potwierdzenie KYC mówi, czyje jest konto, nie że wypłacono;
//  • tożsamość: dane klienta zgodne z kandydatem głównym potwierdzają go; dane wskazujące INNĄ osobę
//    niczego nie potwierdzają i są jawną sprzecznością (konto osoby podstawionej, bliskiej albo inna tożsamość);
//  • narzędzie nie weryfikuje autentyczności dokumentu — odpowiada za niego analityk, a wycofanie odpowiedzi
//    przywraca wynik sprzed jej wprowadzenia i zostawia ślad w rejestrze;
//  • identyfikator klienta (PESEL, NIP, numer dokumentu) i numer rachunku są przechowywane wyłącznie zamaskowane.

import { createHash } from 'node:crypto';
import type { Finding, Identifier, PersonCandidate } from '@olcys/core';
import { formatDate, plural, shortAddress } from './format.ts';

/** Etykieta warstwy — odpowiedź usługi nie jest ani faktem ze źródeł publicznych, ani wnioskiem narzędzia. */
export const SERVICE_REPLY_LABEL = 'dokument spoza OSINT (odpowiedź usługi)';

export type CustomerIdentifierKind = 'PESEL' | 'NIP' | 'dokument' | 'inne';
export const CUSTOMER_IDENTIFIER_KINDS: CustomerIdentifierKind[] = ['PESEL', 'NIP', 'dokument', 'inne'];

/** Adres wpłat albo transakcje, które usługa potwierdziła jako należące do konta klienta. */
export interface ServiceReplyMatch {
  network?: string;
  depositAddress?: string;
  txids?: string[];
}

export interface ServiceReplyCustomer {
  fullName?: string;
  identifierKind?: CustomerIdentifierKind;
  /** Wyłącznie wartość zamaskowana (np. ostatnie 4 znaki) — pełny identyfikator nigdy nie jest zapisywany. */
  identifierMasked?: string;
  accountId?: string;
  emails?: string[];
  phones?: string[];
  registeredAt?: string;
}

/** Wypłata na rachunek bankowy potwierdzona przez usługę. */
export interface ServiceReplyPayout {
  time: string;
  amount: number;
  currency: string;
  bankAccountMasked?: string;
  relatedTxid?: string;
}

export interface ServiceReplyPayload {
  matches: ServiceReplyMatch[];
  customer?: ServiceReplyCustomer;
  fiatPayouts: ServiceReplyPayout[];
  note?: string;
  /** SHA-256 treści dołączonego dokumentu (liczony po stronie serwera, gdy przesłano treść). */
  documentHash?: string;
  /** Odpowiedź wygenerowana przez piaskownicę — dane fikcyjne do demonstracji. */
  syntetyczne?: boolean;
}

/** Zapisana odpowiedź usługi. Wycofana zostaje w rejestrze, ale nie wpływa na wynik. */
export interface ServiceReply {
  id: string;
  caseId: string;
  serviceName: string;
  /** Identyfikator usługi w teczce (`ServiceLink.id`). */
  serviceId: string;
  /** Sygnatura albo numer sprawy z odpowiedzi usługi. */
  reference: string;
  receivedAt: string;
  recordedAt: string;
  recordedBy: string;
  payload: ServiceReplyPayload;
  withdrawnAt?: string;
  withdrawnBy?: string;
}

/** Odwołanie do odpowiedzi przy elemencie teczki, na który wpłynęła. */
export interface ServiceReplyRef {
  replyId: string;
  serviceName: string;
  reference: string;
}

// ---------- Maskowanie i porządkowanie danych wejściowych ----------

const MASK_CHARS = /[*•●·#]/;

/** Zostawia najwyżej 4 ostatnie znaki; reszta to gwiazdki. Wartość już zamaskowana nie jest odsłaniana. */
export function maskIdentifier(value: string): string {
  const clean = value.replace(/\s+/g, '');
  const visible = clean.replace(/[^\p{L}\p{N}]/gu, '');
  if (!visible) return '';
  const keep = MASK_CHARS.test(clean) ? Math.min(4, visible.length) : Math.min(4, Math.floor(visible.length / 2));
  return '*'.repeat(Math.max(3, clean.length - keep)) + (keep > 0 ? visible.slice(-keep) : '');
}

/** Numer rachunku: kod kraju (jeśli jest) i 4 ostatnie cyfry. */
export function maskBankAccount(value: string): string {
  const clean = value.replace(/\s+/g, '');
  const country = /^[A-Za-z]{2}/.exec(clean)?.[0]?.toUpperCase() ?? '';
  const digits = clean.replace(/\D/g, '');
  if (!digits) return '';
  const tail = digits.slice(-Math.min(4, MASK_CHARS.test(clean) ? digits.length : Math.floor(digits.length / 2)));
  return `${country}** **** ${tail}`.trim();
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Dane z żądania: jak `ServiceReplyPayload`, ale dopuszcza pełne wartości, które serwer maskuje. */
export interface ServiceReplyInput {
  matches?: ServiceReplyMatch[];
  customer?: ServiceReplyCustomer & { identifier?: string };
  fiatPayouts?: (ServiceReplyPayout & { bankAccount?: string })[];
  note?: string;
  documentHash?: string;
  syntetyczne?: boolean;
}

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};
const uniqueTrimmed = (values: string[] | undefined): string[] => [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
const isDate = (value: string): boolean => !Number.isNaN(new Date(value).getTime());

/**
 * Porządkuje i sprawdza dane odpowiedzi. Zwraca gotowy ładunek albo komunikat błędu dla analityka.
 * Identyfikator klienta i numer rachunku są maskowane ZAWSZE — także gdy klient przysłał pełną wartość.
 */
export function cleanReplyPayload(input: ServiceReplyInput, documentText?: string): { payload: ServiceReplyPayload } | { error: string } {
  const matches: ServiceReplyMatch[] = [];
  for (const item of input.matches ?? []) {
    const depositAddress = trimmed(item.depositAddress);
    const txids = uniqueTrimmed(item.txids);
    const network = trimmed(item.network)?.toLowerCase();
    if (!depositAddress && txids.length === 0) return { error: 'Każde dopasowanie w odpowiedzi musi wskazywać adres wpłat albo co najmniej jedną transakcję.' };
    matches.push({ ...(network ? { network } : {}), ...(depositAddress ? { depositAddress } : {}), ...(txids.length > 0 ? { txids } : {}) });
  }

  const fiatPayouts: ServiceReplyPayout[] = [];
  for (const item of input.fiatPayouts ?? []) {
    if (!isDate(item.time)) return { error: `„${item.time}” nie jest poprawną datą wypłaty (ISO 8601).` };
    if (!Number.isFinite(item.amount) || item.amount <= 0) return { error: 'Kwota wypłaty musi być liczbą większą od zera.' };
    const currency = item.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { error: `„${item.currency}” nie jest kodem waluty (np. PLN, EUR).` };
    const account = trimmed(item.bankAccountMasked) ?? trimmed(item.bankAccount);
    const bankAccountMasked = account ? maskBankAccount(account) : '';
    const relatedTxid = trimmed(item.relatedTxid);
    fiatPayouts.push({
      time: new Date(item.time).toISOString(),
      amount: item.amount,
      currency,
      ...(bankAccountMasked ? { bankAccountMasked } : {}),
      ...(relatedTxid ? { relatedTxid } : {}),
    });
  }

  let customer: ServiceReplyCustomer | undefined;
  if (input.customer) {
    const source = input.customer;
    const rawIdentifier = trimmed(source.identifierMasked) ?? trimmed(source.identifier);
    const identifierMasked = rawIdentifier ? maskIdentifier(rawIdentifier) : '';
    const registeredAt = trimmed(source.registeredAt);
    if (registeredAt && !isDate(registeredAt)) return { error: `„${registeredAt}” nie jest poprawną datą rejestracji konta (ISO 8601).` };
    const emails = uniqueTrimmed(source.emails);
    const phones = uniqueTrimmed(source.phones);
    const draft: ServiceReplyCustomer = {
      ...(trimmed(source.fullName) ? { fullName: trimmed(source.fullName)!.replace(/\s+/g, ' ') } : {}),
      ...(identifierMasked ? { identifierKind: source.identifierKind ?? 'inne', identifierMasked } : {}),
      ...(trimmed(source.accountId) ? { accountId: trimmed(source.accountId)! } : {}),
      ...(emails.length > 0 ? { emails } : {}),
      ...(phones.length > 0 ? { phones } : {}),
      ...(registeredAt ? { registeredAt: new Date(registeredAt).toISOString() } : {}),
    };
    if (Object.keys(draft).length > 0) customer = draft;
  }

  const note = trimmed(input.note);
  const givenHash = trimmed(input.documentHash)?.toLowerCase();
  if (givenHash && !/^[0-9a-f]{64}$/.test(givenHash)) return { error: 'Skrót dokumentu musi być zapisem SHA-256 (64 znaki szesnastkowe).' };
  // Treść dokumentu nie jest zapisywana — zostaje tylko jej skrót, liczony tutaj.
  const documentHash = documentText !== undefined && documentText.length > 0 ? sha256(documentText) : givenHash;

  if (matches.length === 0 && fiatPayouts.length === 0 && !customer && !note) {
    return { error: 'Odpowiedź usługi jest pusta: podaj dopasowania, dane klienta, wypłaty albo notatkę.' };
  }
  return {
    payload: {
      matches,
      ...(customer ? { customer } : {}),
      fiatPayouts,
      ...(note ? { note } : {}),
      ...(documentHash ? { documentHash } : {}),
      ...(input.syntetyczne === true ? { syntetyczne: true } : {}),
    },
  };
}

// ---------- Dopasowanie do danych sprawy ----------

const fold = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ł/g, 'l').trim().replace(/\s+/g, ' ');
const normAddress = (value: string): string => (/^0x/i.test(value.trim()) ? value.trim().toLowerCase() : value.trim());
const normTxid = (value: string): string => value.trim().toLowerCase().replace(/^0x/, '');
const digits = (value: string): string => value.replace(/\D/g, '').replace(/^(?:48|0048)(?=\d{9}$)/, '');
const keyOf = (finding: { network: string; address: string }): string => `${finding.network}:${finding.address}`;

export interface ReplyAddressMatch {
  /** `network:address` adresu sprawy. */
  key: string;
  address: string;
  network: string;
  /** Na jakiej podstawie odpowiedź dotyczy adresu. */
  by: ('deposit_address' | 'txid')[];
  /** Transakcje adresu objęte odpowiedzią. */
  txids: string[];
  /** Adres wykluczony (klasa adresu, decyzja analityka) — odpowiedź nie zmienia jego wyniku. */
  excluded?: boolean;
}

/** Adresy sprawy, których dotyczy odpowiedź: wspólny adres wpłat / adres usługi albo wspólna transakcja. */
export function matchReplyToFindings(reply: ServiceReply, findings: Finding[], isExcluded: (finding: Finding) => boolean = () => false): ReplyAddressMatch[] {
  const result: ReplyAddressMatch[] = [];
  for (const finding of findings) {
    const chain = finding.chain;
    if (!chain) continue;
    // Wszystkie miejsca, w których adres sprawy styka się z usługą: przelewy, wskaźniki wypłat, kroki ścieżek.
    const hops = [
      ...chain.transfers.map((item) => ({ txid: item.txid, party: item.counterparty })),
      ...chain.cashOuts.map((item) => ({ txid: item.txid, party: item.counterparty })),
      ...(chain.trails ?? []).flatMap((trail) => trail.hops.map((hop) => ({ txid: hop.txid, party: hop.to }))),
    ].filter((hop) => normAddress(hop.party) !== normAddress(finding.address));
    const notes = chain.cashOuts.map((item) => item.explanation ?? '').join(' ');
    const by = new Set<ReplyAddressMatch['by'][number]>();
    const txids = new Set<string>();
    for (const match of reply.payload.matches) {
      if (match.network && match.network !== finding.network) continue;
      if (match.depositAddress) {
        const wanted = normAddress(match.depositAddress);
        const hit = hops.filter((hop) => normAddress(hop.party) === wanted);
        // Portfel zbiorczy usługi bywa znany tylko z uzasadnienia wnioskowania o adresie wpłat.
        if (hit.length > 0 || (wanted.length >= 20 && notes.includes(match.depositAddress.trim()))) by.add('deposit_address');
        for (const hop of hit) txids.add(hop.txid);
      }
      for (const txid of match.txids ?? []) {
        const hit = hops.find((hop) => normTxid(hop.txid) === normTxid(txid));
        if (!hit) continue;
        by.add('txid');
        txids.add(hit.txid);
      }
    }
    if (by.size === 0) continue;
    result.push({ key: keyOf(finding), address: finding.address, network: finding.network, by: [...by], txids: [...txids], ...(isExcluded(finding) ? { excluded: true } : {}) });
  }
  return result;
}

// ---------- Tożsamość: dane klienta a kandydat główny ----------

export type ReplyIdentityOutcome =
  /** Dane klienta zgadzają się z kandydatem głównym — kandydat potwierdzony. */
  | 'confirmed'
  /** Konto w usłudze należy do INNEJ osoby — sprzeczność, kandydat główny NIE jest potwierdzony. */
  | 'other_person'
  /** Usługa podała dane klienta, ale nie da się ich porównać (brak kandydata albo jego nazwiska i kontaktów). */
  | 'inconclusive'
  /** Odpowiedź nie zawiera danych klienta — nic o tożsamości się nie zmienia. */
  | 'no_customer_data'
  /** Odpowiedź niedopasowana do danych sprawy — nie jest stosowana. */
  | 'not_applied';

/** Imię i nazwisko zgodne: te same wyrazy bez względu na kolejność i znaki diakrytyczne (drugie imię może być pominięte). */
export function sameFullName(a: string, b: string): boolean {
  const left = fold(a).split(' ').filter(Boolean);
  const right = fold(b).split(' ').filter(Boolean);
  if (left.length < 2 || right.length < 2) return left.join(' ') === right.join(' ') && left.length > 0;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.every((word) => long.includes(word));
}

/** To samo nazwisko z uwzględnieniem form żeńskich i męskich (Kowalska / Kowalski). */
export function sameSurname(a: string, b: string): boolean {
  const last = (name: string) => fold(name).split(' ').at(-1)!.replace(/(sk|ck|dzk)a$/, '$1i');
  return fold(a).includes(' ') && fold(b).includes(' ') && last(a) === last(b);
}

export interface IdentityComparison {
  outcome: Exclude<ReplyIdentityOutcome, 'not_applied'>;
  /** Na czym opiera się wynik porównania — zdania dla analityka. */
  basis: string[];
}

export function compareCustomer(customer: ServiceReplyCustomer | undefined, main: PersonCandidate | undefined, identifiers: Identifier[]): IdentityComparison {
  const emails = (customer?.emails ?? []).map(fold);
  const phones = (customer?.phones ?? []).map(digits).filter((value) => value.length >= 7);
  if (!customer || (!customer.fullName && emails.length === 0 && phones.length === 0)) {
    return { outcome: 'no_customer_data', basis: ['Odpowiedź nie zawiera imienia i nazwiska, adresu e-mail ani telefonu klienta.'] };
  }
  if (!main || main.probability === 0) {
    return { outcome: 'inconclusive', basis: ['Sprawa nie ma kandydata na osobę, z którym można porównać dane klienta.'] };
  }
  const names = [...new Set([...(main.fullName ? [main.fullName] : []), ...main.nameVariants, ...identifiers.filter((item) => item.type === 'full_name').map((item) => item.value)])];
  const ownEmails = [...main.attributes.filter((item) => item.kind === 'email').map((item) => item.value), ...identifiers.filter((item) => item.type === 'email').map((item) => item.value)].map(fold);
  const ownPhones = main.attributes.filter((item) => item.kind === 'phone').map((item) => digits(item.value));
  const sharedEmail = emails.find((email) => ownEmails.includes(email));
  const sharedPhone = phones.find((phone) => ownPhones.includes(phone));
  const contact = [
    ...(sharedEmail ? [`Adres e-mail klienta (${sharedEmail}) jest wśród adresów e-mail kandydata głównego.`] : []),
    ...(sharedPhone ? ['Telefon klienta jest wśród telefonów kandydata głównego.'] : []),
  ];

  if (customer.fullName) {
    const agreeing = names.find((name) => sameFullName(name, customer.fullName!));
    if (agreeing) return { outcome: 'confirmed', basis: [`Imię i nazwisko klienta („${customer.fullName}”) zgadza się z kandydatem głównym („${agreeing}”).`, ...contact] };
    if (names.length > 0) {
      const related = names.find((name) => sameSurname(name, customer.fullName!));
      return {
        outcome: 'other_person',
        basis: [
          `Imię i nazwisko klienta („${customer.fullName}”) jest inne niż kandydata głównego („${names[0]}”).`,
          ...(related ? ['Nazwisko jest to samo (z uwzględnieniem formy żeńskiej i męskiej) — możliwa osoba bliska.'] : []),
          ...contact.map((text) => `${text} Mimo to właścicielem konta jest według usługi inna osoba.`),
        ],
      };
    }
  }
  if (contact.length > 0) return { outcome: 'confirmed', basis: contact };
  return {
    outcome: 'inconclusive',
    basis: [
      customer.fullName
        ? `Usługa wskazała klienta „${customer.fullName}”, ale kandydat główny nie ma ustalonego imienia i nazwiska ani wspólnego adresu e-mail lub telefonu — do oceny analityka.`
        : 'Adres e-mail i telefon klienta nie występują wśród danych kandydata głównego, a usługa nie podała imienia i nazwiska — do oceny analityka.',
    ],
  };
}

// ---------- Ocena odpowiedzi i widok w teczce ----------

export interface ReplyEvaluation {
  reply: ServiceReply;
  matches: ReplyAddressMatch[];
  identity: ReplyIdentityOutcome;
  identityBasis: string[];
  /** Odpowiedź dokumentuje wypłatę na rachunek dla dopasowanych adresów. */
  documentsFiatExit: boolean;
}

export function evaluateReply(
  reply: ServiceReply,
  findings: Finding[],
  main: PersonCandidate | undefined,
  identifiers: Identifier[],
  isExcluded?: (finding: Finding) => boolean,
): ReplyEvaluation {
  const matches = matchReplyToFindings(reply, findings, isExcluded);
  const applicable = matches.some((item) => !item.excluded);
  if (!applicable) {
    return {
      reply,
      matches,
      identity: 'not_applied',
      identityBasis: [
        matches.length > 0
          ? 'Odpowiedź dotyczy wyłącznie adresów wykluczonych ze sprawy — nie jest stosowana.'
          : 'Żaden adres wpłat ani identyfikator transakcji z odpowiedzi nie występuje w danych sprawy — odpowiedź nie jest stosowana.',
      ],
      documentsFiatExit: false,
    };
  }
  const comparison = compareCustomer(reply.payload.customer, main, identifiers);
  return { reply, matches, identity: comparison.outcome, identityBasis: comparison.basis, documentsFiatExit: reply.payload.fiatPayouts.length > 0 };
}

export const replyRef = (reply: ServiceReply): ServiceReplyRef => ({ replyId: reply.id, serviceName: reply.serviceName, reference: reply.reference });

/** „usługi X, sygn. Y” — stały zapis odwołania do dokumentu. */
export const replyCitation = (reply: { serviceName: string; reference: string }): string => `usługi ${reply.serviceName}, sygn. ${reply.reference}`;

export const formatFiat = (amount: number, currency: string): string =>
  `${amount.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

/** Suma wypłat w podziale na waluty: „12 000,00 PLN i 300,00 EUR”. */
export function payoutSummary(payouts: ServiceReplyPayout[]): string {
  const byCurrency = new Map<string, number>();
  for (const payout of payouts) byCurrency.set(payout.currency, (byCurrency.get(payout.currency) ?? 0) + payout.amount);
  return [...byCurrency].map(([currency, amount]) => formatFiat(amount, currency)).join(' i ');
}

/** Odpowiedź usługi w teczce: zapis z rejestru plus wynik dopasowania i skutki dla ustaleń. */
export interface ServiceReplyView extends ServiceReply {
  /** Warstwa informacji: dokument spoza OSINT wprowadzony przez analityka — nie znalezisko narzędzia. */
  layer: 'external_document';
  layerLabel: string;
  withdrawn: boolean;
  /** Usługa występuje wśród usług powiązanych w tej sprawie. */
  serviceKnown: boolean;
  match: { matched: boolean; addresses: ReplyAddressMatch[]; text: string };
  identity: {
    outcome: ReplyIdentityOutcome;
    text: string;
    basis: string[];
    /** Imię i nazwisko właściciela konta według usługi. */
    holderName?: string;
    /** Powiązana tożsamość z teczki o tym samym imieniu i nazwisku (`LinkedIdentity.id`). */
    linkedIdentityId?: string;
    linkedIdentityName?: string;
  };
  fiatExit: { documented: boolean; addresses: string[]; payouts: number; text: string };
  /** Skutki dla ustaleń teczki — zdania do pokazania analitykowi. */
  effects: string[];
  /** Sprzeczność do rozstrzygnięcia: konto w usłudze należy do innej osoby niż kandydat główny. */
  contradiction?: string;
}

export interface ReplyViewInput {
  evaluation?: ReplyEvaluation;
  reply: ServiceReply;
  serviceKnown: boolean;
  /** Dopasowane adresy zaliczone do adresów podmiotu — tylko dla nich liczony jest wskaźnik C (`network:address`). */
  fiatExitKeys?: string[];
  /** Powiązana tożsamość o imieniu i nazwisku właściciela konta. */
  linkedIdentity?: { id: string; displayName: string; relation: string };
  /** Inny kandydat na osobę o imieniu i nazwisku właściciela konta. */
  otherCandidate?: string;
  mainName?: string;
}

export function buildReplyView(input: ReplyViewInput): ServiceReplyView {
  const { reply, evaluation } = input;
  const base = { ...reply, layer: 'external_document' as const, layerLabel: SERVICE_REPLY_LABEL, serviceKnown: input.serviceKnown };
  const holderName = reply.payload.customer?.fullName;
  if (reply.withdrawnAt || !evaluation) {
    const text = `Odpowiedź wycofana ${formatDate(reply.withdrawnAt ?? reply.recordedAt)}${reply.withdrawnBy ? ` przez: ${reply.withdrawnBy}` : ''} — nie wpływa na wynik; zostaje w rejestrze do audytu.`;
    return {
      ...base,
      withdrawn: true,
      match: { matched: false, addresses: [], text },
      identity: { outcome: 'not_applied', text: 'Odpowiedź wycofana — nie wpływa na ustalenie osoby.', basis: [], ...(holderName ? { holderName } : {}) },
      fiatExit: { documented: false, addresses: [], payouts: reply.payload.fiatPayouts.length, text: 'Odpowiedź wycofana — nie dokumentuje wyjścia do walut tradycyjnych.' },
      effects: [text],
    };
  }

  const applied = evaluation.matches.filter((item) => !item.excluded);
  const matched = applied.length > 0;
  const where = applied.map((item) => shortAddress(item.address)).join(', ');
  const txCount = new Set(applied.flatMap((item) => item.txids)).size;
  const matchText = matched
    ? `Dopasowano do ${applied.length} ${plural(applied.length, 'adresu', 'adresów', 'adresów')} sprawy (${where}) — ` +
      `${txCount} ${plural(txCount, 'transakcja', 'transakcje', 'transakcji')} wskazanych przez usługę występuje w danych blockchain tej sprawy.`
    : evaluation.matches.length > 0
      ? 'Odpowiedź dotyczy wyłącznie adresów wykluczonych ze sprawy — nie zmienia żadnego wyniku.'
      : 'Nie dopasowano do danych sprawy: żaden adres wpłat ani identyfikator transakcji z odpowiedzi nie występuje w przelewach i ścieżkach adresów sprawy. Odpowiedź nie zmienia żadnego wyniku.';

  const cite = replyCitation(reply);
  const payouts = reply.payload.fiatPayouts;
  let identityText: string;
  let contradiction: string | undefined;
  switch (evaluation.identity) {
    case 'confirmed':
      identityText = `Dane klienta zgadzają się z kandydatem głównym${input.mainName ? ` (${input.mainName})` : ''} — osoba potwierdzona odpowiedzią ${cite}; własność dopasowanych adresów liczona jak potwierdzona przez analityka.`;
      break;
    case 'other_person': {
      const link = input.linkedIdentity
        ? ` To imię i nazwisko nosi powiązana tożsamość z tej sprawy: „${input.linkedIdentity.displayName}” (${input.linkedIdentity.relation}).`
        : input.otherCandidate
          ? ` To imię i nazwisko nosi inny kandydat na osobę w tej sprawie („${input.otherCandidate}”).`
          : ' Tej osoby nie ma wśród tożsamości znalezionych w sprawie.';
      contradiction =
        `Sprzeczność: konto w usłudze ${reply.serviceName}, na które trafiły środki z adresu ${where}, należy według odpowiedzi (sygn. ${reply.reference}) do innej osoby` +
        `${holderName ? `: „${holderName}”` : ''}, a nie do kandydata głównego${input.mainName ? ` („${input.mainName}”)` : ''}.${link} ` +
        'Możliwe wyjaśnienia: konto osoby podstawionej lub bliskiej, inna tożsamość tej samej osoby albo błędne przypisanie adresu — rozstrzyga analityk.';
      identityText = `Konto w usłudze należy do innej osoby${holderName ? ` („${holderName}”)` : ''} — kandydat główny NIE został potwierdzony.${link}`;
      break;
    }
    case 'inconclusive':
      identityText = `Usługa podała dane klienta${holderName ? ` („${holderName}”)` : ''}, ale nie da się ich porównać z kandydatem głównym — ustalenie osoby bez zmian.`;
      break;
    case 'no_customer_data':
      identityText = 'Odpowiedź nie zawiera danych klienta — ustalenie osoby bez zmian.';
      break;
    default:
      identityText = 'Odpowiedź niedopasowana — nie wpływa na ustalenie osoby.';
  }

  const exitKeys = input.fiatExitKeys ?? applied.map((item) => item.key);
  const documented = matched && evaluation.documentsFiatExit && exitKeys.length > 0;
  const fiatText = !matched
    ? 'Odpowiedź niedopasowana — nie dokumentuje wyjścia do walut tradycyjnych w tej sprawie.'
    : evaluation.documentsFiatExit && !documented
      ? `Usługa potwierdziła ${payouts.length} ${plural(payouts.length, 'wypłatę', 'wypłaty', 'wypłat')} na rachunek bankowy (łącznie ${payoutSummary(payouts)}), ale dopasowany adres nie jest zaliczony do adresów podmiotu — wskaźnik C jest liczony tylko dla adresów podmiotu.`
      : documented
      ? `Usługa potwierdziła ${payouts.length} ${plural(payouts.length, 'wypłatę', 'wypłaty', 'wypłat')} na rachunek bankowy (łącznie ${payoutSummary(payouts)}) — wskaźnik C dla dopasowanych adresów osiąga szczebel „udokumentowane wyjście do walut tradycyjnych”.`
      : 'Odpowiedź nie zawiera żadnej wypłaty na rachunek — potwierdza najwyżej właściciela konta, a nie wyjście do walut tradycyjnych; wskaźnik C bez zmian.';

  return {
    ...base,
    withdrawn: false,
    match: { matched, addresses: evaluation.matches, text: matchText },
    identity: {
      outcome: evaluation.identity,
      text: identityText,
      basis: evaluation.identityBasis,
      ...(holderName ? { holderName } : {}),
      ...(evaluation.identity === 'other_person' && input.linkedIdentity ? { linkedIdentityId: input.linkedIdentity.id, linkedIdentityName: input.linkedIdentity.displayName } : {}),
    },
    fiatExit: { documented, addresses: documented ? exitKeys : [], payouts: payouts.length, text: fiatText },
    effects: matched ? [matchText, identityText, fiatText] : [matchText],
    ...(contradiction ? { contradiction } : {}),
  };
}

/** Zdania do kluczowych ustaleń: jedno na odpowiedź, sprzeczności najpierw. */
export function replyKeyFindings(views: ServiceReplyView[]): { text: string; layer: 'fact' | 'inference' }[] {
  const active = views.filter((view) => !view.withdrawn && view.match.matched);
  const order = (view: ServiceReplyView) => (view.contradiction ? 0 : view.identity.outcome === 'confirmed' ? 1 : 2);
  return [...active]
    .sort((a, b) => order(a) - order(b))
    .map((view) => {
      const head = `Dokument spoza OSINT — odpowiedź ${replyCitation(view)} (otrzymana ${formatDate(view.receivedAt)}): `;
      if (view.contradiction) {
        return { text: `${head}${view.contradiction}${view.fiatExit.documented ? ` ${view.fiatExit.text}` : ''}`, layer: 'fact' as const };
      }
      return { text: `${head}${view.identity.text} ${view.fiatExit.text}`, layer: 'fact' as const };
    });
}
