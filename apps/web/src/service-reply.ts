// Odpowiedź usługi (giełdy, serwisu wymiany) wprowadzana przez analityka — DOKUMENT SPOZA OSINT.
// Kształty zgodne z usługą analizy (apps/api/src/service-reply.ts) oraz czysta logika formularza:
// odczyt wklejonego JSON, walidacja po stronie przeglądarki i złożenie żądania. Bez DOM.
//
// Na końcu pliku jest uproszczone zastosowanie odpowiedzi do teczki — wyłącznie dla trybu DEMO
// (dane wbudowane w interfejs); w trybach SANDBOX i LIVE skutki liczy usługa analizy.

import type { CashOutAssessment, Dossier, GraphEdge, GraphNode, PersonCandidate, ServiceLink } from '@olcys/core';

export const SERVICE_REPLY_LABEL = 'dokument spoza OSINT (odpowiedź usługi)';

export type CustomerIdentifierKind = 'PESEL' | 'NIP' | 'dokument' | 'inne';
export const CUSTOMER_IDENTIFIER_KINDS: CustomerIdentifierKind[] = ['PESEL', 'NIP', 'dokument', 'inne'];

export interface ServiceReplyMatch {
  network?: string;
  depositAddress?: string;
  txids?: string[];
}

export interface ServiceReplyCustomer {
  fullName?: string;
  identifierKind?: CustomerIdentifierKind;
  /** Wyłącznie wartość zamaskowana. */
  identifierMasked?: string;
  accountId?: string;
  emails?: string[];
  phones?: string[];
  registeredAt?: string;
}

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
  documentHash?: string;
  syntetyczne?: boolean;
}

export interface ServiceReply {
  id: string;
  caseId: string;
  serviceName: string;
  serviceId: string;
  reference: string;
  receivedAt: string;
  recordedAt: string;
  recordedBy: string;
  payload: ServiceReplyPayload;
  withdrawnAt?: string;
  withdrawnBy?: string;
}

export interface ServiceReplyRef {
  replyId: string;
  serviceName: string;
  reference: string;
}

export type ReplyIdentityOutcome = 'confirmed' | 'other_person' | 'inconclusive' | 'no_customer_data' | 'not_applied';

export interface ReplyAddressMatch {
  key: string;
  address: string;
  network: string;
  by: ('deposit_address' | 'txid')[];
  txids: string[];
  excluded?: boolean;
}

/** Odpowiedź w teczce: zapis z rejestru, wynik dopasowania do danych sprawy i skutki dla ustaleń. */
export interface ServiceReplyView extends ServiceReply {
  layer: 'external_document';
  layerLabel: string;
  withdrawn: boolean;
  serviceKnown: boolean;
  match: { matched: boolean; addresses: ReplyAddressMatch[]; text: string };
  identity: { outcome: ReplyIdentityOutcome; text: string; basis: string[]; holderName?: string; linkedIdentityId?: string; linkedIdentityName?: string };
  fiatExit: { documented: boolean; addresses: string[]; payouts: number; text: string };
  effects: string[];
  contradiction?: string;
}

/** Ładunek w żądaniu: pełny identyfikator i numer rachunku wolno wysłać — usługa analizy je maskuje i nie zapisuje. */
export interface ServiceReplyPayloadInput {
  matches?: ServiceReplyMatch[];
  customer?: ServiceReplyCustomer & { identifier?: string };
  fiatPayouts?: (ServiceReplyPayout & { bankAccount?: string })[];
  note?: string;
  documentHash?: string;
  syntetyczne?: boolean;
}

export interface ServiceReplyBody {
  serviceName: string;
  serviceId?: string;
  reference: string;
  receivedAt: string;
  payload: ServiceReplyPayloadInput;
  documentText?: string;
  force?: boolean;
}

/** Przykładowa odpowiedź z piaskownicy (albo z danych demo) — zawsze oznaczona jako syntetyczna. */
export type ServiceReplySample = Partial<ServiceReplyBody> & { syntetyczne?: boolean; payload: ServiceReplyPayloadInput };

export const IDENTITY_OUTCOME_LABEL: Record<ReplyIdentityOutcome, string> = {
  confirmed: 'właściciel konta zgodny z kandydatem głównym — osoba potwierdzona',
  other_person: 'konto należy do innej osoby — kandydat główny niepotwierdzony',
  inconclusive: 'dane klienta nieporównywalne z kandydatem głównym',
  no_customer_data: 'odpowiedź bez danych klienta',
  not_applied: 'nie dotyczy',
};

/** Czy zdanie (kluczowe ustalenie, zdarzenie osi czasu) opiera się na odpowiedzi usługi, a nie na źródłach publicznych. */
export const isExternalDocumentText = (text: string): boolean => /dokument spoza OSINT/i.test(text);

// ---------- Maskowanie (podgląd w formularzu i tryb demo; usługa analizy maskuje niezależnie) ----------

const MASK_CHARS = /[*•●·#]/;

export function maskIdentifier(value: string): string {
  const clean = value.replace(/\s+/g, '');
  const visible = clean.replace(/[^\p{L}\p{N}]/gu, '');
  if (!visible) return '';
  const keep = MASK_CHARS.test(clean) ? Math.min(4, visible.length) : Math.min(4, Math.floor(visible.length / 2));
  return '*'.repeat(Math.max(3, clean.length - keep)) + (keep > 0 ? visible.slice(-keep) : '');
}

export function maskBankAccount(value: string): string {
  const clean = value.replace(/\s+/g, '');
  const country = /^[A-Za-z]{2}/.exec(clean)?.[0]?.toUpperCase() ?? '';
  const digits = clean.replace(/\D/g, '');
  if (!digits) return '';
  const tail = digits.slice(-Math.min(4, MASK_CHARS.test(clean) ? digits.length : Math.floor(digits.length / 2)));
  return `${country}** **** ${tail}`.trim();
}

// ---------- Formularz ----------

export interface ReplyForm {
  reference: string;
  /** Data otrzymania odpowiedzi (RRRR-MM-DD). */
  receivedAt: string;
  fullName: string;
  identifierKind: CustomerIdentifierKind;
  identifier: string;
  accountId: string;
  /** Adresy e-mail i telefony klienta — rozdzielone przecinkami. */
  emails: string;
  phones: string;
  registeredAt: string;
  /** Sieć, której dotyczą dopasowania (puste = dowolna). */
  network: string;
  /** Adresy wpłat albo adresy usługi potwierdzone przez usługę — po jednym w wierszu. */
  depositAddresses: string;
  /** Identyfikatory transakcji potwierdzone przez usługę — po jednym w wierszu. */
  txids: string;
  /** Wypłaty na rachunek, po jednej w wierszu: `data; kwota; waluta; rachunek; transakcja`. */
  payouts: string;
  note: string;
  /** Treść dokumentu — usługa analizy policzy z niej SHA-256 i jej nie zapisze. */
  documentText: string;
  force: boolean;
  synthetic: boolean;
}

export const emptyReplyForm = (today = ''): ReplyForm => ({
  reference: '',
  receivedAt: today,
  fullName: '',
  identifierKind: 'PESEL',
  identifier: '',
  accountId: '',
  emails: '',
  phones: '',
  registeredAt: '',
  network: '',
  depositAddresses: '',
  txids: '',
  payouts: '',
  note: '',
  documentText: '',
  force: false,
  synthetic: false,
});

const lines = (text: string): string[] => [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
const list = (text: string): string[] => [...new Set(text.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean))];
const isDate = (value: string): boolean => value.trim() !== '' && !Number.isNaN(new Date(value).getTime());
const day = (iso: string | undefined): string => (iso && isDate(iso) ? new Date(iso).toISOString().slice(0, 10) : '');
/** Kwota wpisana po polsku („131 500,50”) albo z kropką. */
const parseAmount = (text: string): number => Number(text.replace(/[\s ]/g, '').replace(',', '.'));

/** Wypełnia formularz z przykładowej odpowiedzi albo z wklejonego JSON. */
export function formFromSample(sample: ServiceReplySample, today = ''): ReplyForm {
  const payload = sample.payload ?? {};
  const customer = payload.customer ?? {};
  const matches = payload.matches ?? [];
  const networks = [...new Set(matches.map((item) => item.network).filter((value): value is string => !!value))];
  return {
    ...emptyReplyForm(today),
    reference: sample.reference ?? '',
    receivedAt: day(sample.receivedAt) || today,
    fullName: customer.fullName ?? '',
    identifierKind: CUSTOMER_IDENTIFIER_KINDS.includes(customer.identifierKind as CustomerIdentifierKind) ? customer.identifierKind! : 'PESEL',
    identifier: customer.identifierMasked ?? customer.identifier ?? '',
    accountId: customer.accountId ?? '',
    emails: (customer.emails ?? []).join(', '),
    phones: (customer.phones ?? []).join(', '),
    registeredAt: day(customer.registeredAt),
    network: networks.length === 1 ? networks[0]! : '',
    depositAddresses: [...new Set(matches.map((item) => item.depositAddress).filter((value): value is string => !!value))].join('\n'),
    txids: [...new Set(matches.flatMap((item) => item.txids ?? []))].join('\n'),
    payouts: (payload.fiatPayouts ?? [])
      .map((item) => [item.time, String(item.amount), item.currency, item.bankAccountMasked ?? item.bankAccount ?? '', item.relatedTxid ?? ''].join('; ').replace(/(?:; )+$/, ''))
      .join('\n'),
    note: payload.note ?? '',
    documentText: sample.documentText ?? '',
    force: false,
    synthetic: sample.syntetyczne === true || payload.syntetyczne === true,
  };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Odczytuje wklejony JSON: pełną odpowiedź (`{ reference, receivedAt, payload }`) albo sam ładunek
 * (`{ matches, customer, fiatPayouts }`). Sprawdza kształt, zanim cokolwiek trafi do formularza.
 */
export function parseReplyJson(text: string): Parsed<ServiceReplySample> {
  if (!text.trim()) return { ok: false, errors: ['Wklej treść JSON odpowiedzi usługi.'] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`To nie jest poprawny JSON: ${error instanceof Error ? error.message : 'błąd składni'}.`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['JSON musi być obiektem z polami odpowiedzi (payload albo matches / customer / fiatPayouts).'] };
  const object = raw as Record<string, unknown>;
  const payload = (object.payload && typeof object.payload === 'object' && !Array.isArray(object.payload) ? object.payload : object) as Record<string, unknown>;
  const errors: string[] = [];
  const isText = (value: unknown): value is string => typeof value === 'string';
  const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

  if (!('matches' in payload) && !('customer' in payload) && !('fiatPayouts' in payload) && !('note' in payload)) {
    errors.push('Brak pól odpowiedzi: oczekiwane „matches”, „customer”, „fiatPayouts” albo „note”.');
  }
  if (payload.matches !== undefined) {
    if (!Array.isArray(payload.matches)) errors.push('Pole „matches” musi być listą.');
    else {
      payload.matches.forEach((item, index) => {
        const match = item as Record<string, unknown> | null;
        if (!match || typeof match !== 'object') errors.push(`matches[${index}]: oczekiwany obiekt.`);
        else if (match.depositAddress !== undefined && !isText(match.depositAddress)) errors.push(`matches[${index}].depositAddress: oczekiwany tekst.`);
        else if (match.txids !== undefined && !isTextList(match.txids)) errors.push(`matches[${index}].txids: oczekiwana lista identyfikatorów transakcji.`);
        else if (!match.depositAddress && !(match.txids as string[] | undefined)?.length) errors.push(`matches[${index}]: podaj adres wpłat albo co najmniej jedną transakcję.`);
      });
    }
  }
  if (payload.customer !== undefined) {
    const customer = payload.customer as Record<string, unknown> | null;
    if (!customer || typeof customer !== 'object' || Array.isArray(customer)) errors.push('Pole „customer” musi być obiektem.');
    else {
      for (const field of ['fullName', 'identifierMasked', 'identifier', 'accountId', 'registeredAt'] as const) {
        if (customer[field] !== undefined && !isText(customer[field])) errors.push(`customer.${field}: oczekiwany tekst.`);
      }
      for (const field of ['emails', 'phones'] as const) {
        if (customer[field] !== undefined && !isTextList(customer[field])) errors.push(`customer.${field}: oczekiwana lista tekstów.`);
      }
      if (customer.identifierKind !== undefined && !CUSTOMER_IDENTIFIER_KINDS.includes(customer.identifierKind as CustomerIdentifierKind)) {
        errors.push(`customer.identifierKind: dozwolone wartości to ${CUSTOMER_IDENTIFIER_KINDS.join(', ')}.`);
      }
    }
  }
  if (payload.fiatPayouts !== undefined) {
    if (!Array.isArray(payload.fiatPayouts)) errors.push('Pole „fiatPayouts” musi być listą.');
    else {
      payload.fiatPayouts.forEach((item, index) => {
        const payout = item as Record<string, unknown> | null;
        if (!payout || typeof payout !== 'object') errors.push(`fiatPayouts[${index}]: oczekiwany obiekt.`);
        else {
          if (!isText(payout.time) || !isDate(payout.time)) errors.push(`fiatPayouts[${index}].time: oczekiwana data (ISO 8601).`);
          if (typeof payout.amount !== 'number' || !(payout.amount > 0)) errors.push(`fiatPayouts[${index}].amount: oczekiwana liczba większa od zera.`);
          if (!isText(payout.currency) || !/^[A-Za-z]{3}$/.test(payout.currency.trim())) errors.push(`fiatPayouts[${index}].currency: oczekiwany kod waluty (np. PLN).`);
        }
      });
    }
  }
  for (const field of ['reference', 'receivedAt', 'serviceName'] as const) {
    if (object[field] !== undefined && !isText(object[field])) errors.push(`${field}: oczekiwany tekst.`);
  }
  if (isText(object.receivedAt) && !isDate(object.receivedAt)) errors.push('receivedAt: oczekiwana data (ISO 8601).');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...(isText(object.serviceName) ? { serviceName: object.serviceName } : {}),
      ...(isText(object.reference) ? { reference: object.reference } : {}),
      ...(isText(object.receivedAt) ? { receivedAt: object.receivedAt } : {}),
      ...(isText(object.documentText) ? { documentText: object.documentText } : {}),
      ...(object.syntetyczne === true ? { syntetyczne: true } : {}),
      payload: payload as ServiceReplyPayloadInput,
    },
  };
}

/** Składa żądanie z formularza; błędy są zdaniami dla analityka. `now` służy do odrzucenia daty z przyszłości. */
export function bodyFromForm(form: ReplyForm, service: { id: string; name: string }, now: Date = new Date()): Parsed<ServiceReplyBody> {
  const errors: string[] = [];
  const reference = form.reference.trim();
  if (!reference) errors.push('Podaj sygnaturę albo numer sprawy z odpowiedzi usługi.');
  if (!isDate(form.receivedAt)) errors.push('Podaj datę otrzymania odpowiedzi.');
  else if (new Date(form.receivedAt).getTime() > now.getTime() + 36 * 3_600_000) errors.push('Data otrzymania odpowiedzi nie może być w przyszłości.');
  if (form.registeredAt.trim() && !isDate(form.registeredAt)) errors.push('Data założenia konta klienta jest niepoprawna.');

  const addresses = lines(form.depositAddresses);
  const txids = lines(form.txids);
  const network = form.network.trim().toLowerCase();
  const matches: ServiceReplyMatch[] = [
    ...addresses.map((depositAddress) => ({ ...(network ? { network } : {}), depositAddress })),
    ...(txids.length > 0 ? [{ ...(network ? { network } : {}), txids }] : []),
  ];

  const fiatPayouts: NonNullable<ServiceReplyPayloadInput['fiatPayouts']> = [];
  lines(form.payouts).forEach((line, index) => {
    const [time = '', amountText = '', currency = '', account = '', relatedTxid = ''] = line.split(';').map((part) => part.trim());
    const amount = parseAmount(amountText);
    const where = `Wypłata ${index + 1}`;
    if (!isDate(time)) errors.push(`${where}: niepoprawna data („${time}”). Format wiersza: data; kwota; waluta; rachunek; transakcja.`);
    else if (!Number.isFinite(amount) || amount <= 0) errors.push(`${where}: kwota musi być liczbą większą od zera.`);
    else if (!/^[A-Za-z]{3}$/.test(currency)) errors.push(`${where}: podaj trzyliterowy kod waluty (np. PLN).`);
    else {
      fiatPayouts.push({
        time: new Date(time).toISOString(),
        amount,
        currency: currency.toUpperCase(),
        ...(account ? { bankAccount: account } : {}),
        ...(relatedTxid ? { relatedTxid } : {}),
      });
    }
  });

  const emails = list(form.emails);
  const phones = list(form.phones);
  for (const email of emails) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`„${email}” nie wygląda na adres e-mail.`);
  const customer: NonNullable<ServiceReplyPayloadInput['customer']> = {
    ...(form.fullName.trim() ? { fullName: form.fullName.trim() } : {}),
    ...(form.identifier.trim() ? { identifierKind: form.identifierKind, identifier: form.identifier.trim() } : {}),
    ...(form.accountId.trim() ? { accountId: form.accountId.trim() } : {}),
    ...(emails.length > 0 ? { emails } : {}),
    ...(phones.length > 0 ? { phones } : {}),
    ...(form.registeredAt.trim() && isDate(form.registeredAt) ? { registeredAt: new Date(form.registeredAt).toISOString() } : {}),
  };
  const hasCustomer = Object.keys(customer).length > 0;
  const note = form.note.trim();
  if (matches.length === 0 && fiatPayouts.length === 0 && !hasCustomer && !note && errors.length === 0) {
    errors.push('Odpowiedź jest pusta: podaj dopasowane transakcje lub adres wpłat, dane klienta, wypłaty albo notatkę.');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      serviceName: service.name,
      serviceId: service.id,
      reference,
      receivedAt: new Date(form.receivedAt).toISOString(),
      payload: {
        matches,
        ...(hasCustomer ? { customer } : {}),
        fiatPayouts,
        ...(note ? { note } : {}),
        ...(form.synthetic ? { syntetyczne: true } : {}),
      },
      ...(form.documentText.trim() ? { documentText: form.documentText } : {}),
      ...(form.force ? { force: true } : {}),
    },
  };
}

/** Uwaga pod formularzem: czego odpowiedź w tej postaci NIE zmieni — żeby wynik nie zaskoczył analityka. */
export function formHints(form: ReplyForm): string[] {
  const hints: string[] = [];
  if (!form.depositAddresses.trim() && !form.txids.trim()) hints.push('Bez adresu wpłat ani transakcji odpowiedź nie zostanie dopasowana do danych sprawy i niczego nie zmieni.');
  if (!form.payouts.trim()) hints.push('Bez wypłat na rachunek odpowiedź potwierdza najwyżej właściciela konta — wskaźnik C nie osiągnie ostatniego szczebla.');
  if (!form.fullName.trim() && !form.emails.trim() && !form.phones.trim()) hints.push('Bez danych klienta ustalenie osoby pozostanie bez zmian.');
  return hints;
}

// ---------- Tryb DEMO: uproszczone zastosowanie odpowiedzi do teczki z danych wbudowanych w interfejs ----------

type ReplyDossier = Dossier & {
  serviceReplies?: ServiceReplyView[];
  cashOutProof?: { address: string; network: string; trail: { hops: { txid: string }[] }; serviceReply?: unknown }[];
  linkedIdentities?: { id: string; displayName: string; fullName?: string }[];
};

const fold = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ł/g, 'l').trim().replace(/\s+/g, ' ');
const normTx = (value: string): string => value.trim().toLowerCase().replace(/^0x/, '');
const normAddr = (value: string): string => (/^0x/i.test(value.trim()) ? value.trim().toLowerCase() : value.trim());

export function sameFullName(a: string, b: string): boolean {
  const left = fold(a).split(' ').filter(Boolean);
  const right = fold(b).split(' ').filter(Boolean);
  if (left.length < 2 || right.length < 2) return left.length > 0 && left.join(' ') === right.join(' ');
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.every((word) => long.includes(word));
}

const fiat = (amount: number, currency: string): string => `${amount.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

/** Porządkuje żądanie tak, jak zrobiłaby to usługa analizy: maskuje identyfikator i rachunek, nie zachowuje treści dokumentu. */
export function recordFromBody(body: ServiceReplyBody, meta: { id: string; caseId: string; recordedAt: string; recordedBy: string }): ServiceReply {
  const customer = body.payload.customer;
  const identifier = customer?.identifierMasked ?? customer?.identifier;
  const cleanCustomer: ServiceReplyCustomer | undefined = customer
    ? {
        ...(customer.fullName ? { fullName: customer.fullName } : {}),
        ...(identifier ? { identifierKind: customer.identifierKind ?? 'inne', identifierMasked: maskIdentifier(identifier) } : {}),
        ...(customer.accountId ? { accountId: customer.accountId } : {}),
        ...(customer.emails?.length ? { emails: customer.emails } : {}),
        ...(customer.phones?.length ? { phones: customer.phones } : {}),
        ...(customer.registeredAt ? { registeredAt: customer.registeredAt } : {}),
      }
    : undefined;
  return {
    ...meta,
    serviceName: body.serviceName,
    serviceId: body.serviceId ?? body.serviceName.toLowerCase(),
    reference: body.reference,
    receivedAt: body.receivedAt,
    payload: {
      matches: body.payload.matches ?? [],
      ...(cleanCustomer && Object.keys(cleanCustomer).length > 0 ? { customer: cleanCustomer } : {}),
      fiatPayouts: (body.payload.fiatPayouts ?? []).map(({ bankAccount, bankAccountMasked, ...rest }) => {
        const account = bankAccountMasked ?? bankAccount;
        return { ...rest, ...(account ? { bankAccountMasked: maskBankAccount(account) } : {}) };
      }),
      ...(body.payload.note ? { note: body.payload.note } : {}),
      ...(body.payload.syntetyczne ? { syntetyczne: true } : {}),
    },
  };
}

/** Przykładowa odpowiedź złożona z przelewów usługi w teczce demo: klientem jest kandydat główny albo (wariant) inna osoba. */
export function sampleFromDossier(dossier: Dossier, link: ServiceLink, variant?: 'inna-osoba'): ServiceReplySample | null {
  const outgoing = link.transfers.filter((item) => item.direction === 'out');
  if (outgoing.length === 0) return null;
  const subject = outgoing[0]!.subjectAddress;
  const own = outgoing.filter((item) => item.subjectAddress === subject);
  const main = dossier.persons[0];
  const other = (dossier as ReplyDossier).linkedIdentities?.find((item) => item.fullName ?? item.displayName);
  const holder = variant === 'inna-osoba' ? (other?.fullName ?? other?.displayName ?? 'Julia Kowalska') : (main?.fullName ?? 'Jan Przykładowy');
  const last = own.map((item) => item.time).sort().at(-1)!;
  return {
    syntetyczne: true,
    serviceName: link.name,
    reference: `DEMO/KYC/${last.slice(0, 4)}/${String(own.length).padStart(4, '0')}`,
    receivedAt: new Date(new Date(last).getTime() + 15 * 86_400_000).toISOString(),
    payload: {
      syntetyczne: true,
      matches: [{ network: link.networks[0], depositAddress: own[0]!.viaAddress ?? own[0]!.serviceAddress, txids: own.map((item) => item.txid) }],
      customer: { fullName: holder, identifierKind: 'PESEL', identifierMasked: '*******0000', accountId: `DEMO-${link.id.toUpperCase()}` },
      fiatPayouts: own.map((item) => ({
        time: new Date(new Date(item.time).getTime() + 26 * 3_600_000).toISOString(),
        amount: Math.round((item.valuePln ?? item.amount * 1000) * 100) / 100,
        currency: 'PLN',
        bankAccountMasked: 'PL** **** 0000',
        relatedTxid: item.txid,
      })),
      note: 'Odpowiedź PRZYKŁADOWA z danych demo — osoby, numery i kwoty są fikcyjne.',
    },
  };
}

/**
 * Tryb DEMO: nakłada odpowiedzi na teczkę zbudowaną w interfejsie. Te same zasady co w usłudze analizy, w uproszczeniu:
 * dopasowanie po transakcji lub adresie z przelewów usług; wyjście do walut tradycyjnych tylko przy wypłacie na rachunek;
 * zgodne dane klienta potwierdzają kandydata głównego, inne — są sprzecznością. Bez obowiązujących odpowiedzi teczka się nie zmienia.
 */
export function applyServiceReplies<T extends Dossier>(dossier: T, replies: ServiceReply[]): T & { serviceReplies: ServiceReplyView[] } {
  const base = dossier as T & ReplyDossier;
  let persons = [...dossier.persons] as (PersonCandidate & { confirmedByReply?: ServiceReplyRef; replyContradictions?: string[] })[];
  let cashOut: CashOutAssessment[] = [...(dossier.indicators?.cashOut ?? [])];
  const nodes: GraphNode[] = [...dossier.graph.nodes];
  const edges: GraphEdge[] = [...dossier.graph.edges];
  const keyFindings = [...dossier.keyFindings];
  const main = persons[0];

  const views = replies.map((reply): ServiceReplyView => {
    const shared = { ...reply, layer: 'external_document' as const, layerLabel: SERVICE_REPLY_LABEL, serviceKnown: dossier.serviceLinks.some((link) => link.id === reply.serviceId) };
    const holderName = reply.payload.customer?.fullName;
    if (reply.withdrawnAt) {
      const text = 'Odpowiedź wycofana — nie wpływa na wynik; zostaje w rejestrze do audytu.';
      return {
        ...shared,
        withdrawn: true,
        match: { matched: false, addresses: [], text },
        identity: { outcome: 'not_applied', text: 'Odpowiedź wycofana — nie wpływa na ustalenie osoby.', basis: [], ...(holderName ? { holderName } : {}) },
        fiatExit: { documented: false, addresses: [], payouts: reply.payload.fiatPayouts.length, text: 'Odpowiedź wycofana — nie dokumentuje wyjścia do walut tradycyjnych.' },
        effects: [text],
      };
    }

    // Dopasowanie: transakcja albo adres (usługi lub pośredni) z przelewów usług tej teczki.
    const byAddress = new Map<string, ReplyAddressMatch>();
    for (const transfer of dossier.serviceLinks.flatMap((link) => link.transfers)) {
      const finding = dossier.findings.find((item) => item.address === transfer.subjectAddress);
      if (!finding || finding.confidence.excluded) continue;
      for (const match of reply.payload.matches) {
        if (match.network && match.network !== finding.network) continue;
        const byTx = (match.txids ?? []).some((txid) => normTx(txid) === normTx(transfer.txid));
        const byAddr = match.depositAddress !== undefined && [transfer.serviceAddress, transfer.viaAddress].some((value) => value !== undefined && normAddr(value) === normAddr(match.depositAddress!));
        if (!byTx && !byAddr) continue;
        const key = `${finding.network}:${finding.address}`;
        const entry = byAddress.get(key) ?? { key, address: finding.address, network: finding.network, by: [], txids: [] };
        if (byTx && !entry.by.includes('txid')) entry.by.push('txid');
        if (byAddr && !entry.by.includes('deposit_address')) entry.by.push('deposit_address');
        if (!entry.txids.includes(transfer.txid)) entry.txids.push(transfer.txid);
        byAddress.set(key, entry);
      }
    }
    const addresses = [...byAddress.values()];
    const matched = addresses.length > 0;
    const cite = `usługi ${reply.serviceName}, sygn. ${reply.reference}`;
    if (!matched) {
      const text = 'Nie dopasowano do danych sprawy: żaden adres wpłat ani identyfikator transakcji z odpowiedzi nie występuje w przelewach adresów sprawy. Odpowiedź nie zmienia żadnego wyniku.';
      return {
        ...shared,
        withdrawn: false,
        match: { matched: false, addresses: [], text },
        identity: { outcome: 'not_applied', text: 'Odpowiedź niedopasowana — nie wpływa na ustalenie osoby.', basis: [], ...(holderName ? { holderName } : {}) },
        fiatExit: { documented: false, addresses: [], payouts: reply.payload.fiatPayouts.length, text: 'Odpowiedź niedopasowana — nie dokumentuje wyjścia do walut tradycyjnych w tej sprawie.' },
        effects: [text],
      };
    }
    const where = addresses.map((item) => item.address).join(', ');
    const matchText = `Dopasowano do adresów sprawy: ${where} — transakcje wskazane przez usługę występują w danych blockchain tej sprawy (${new Set(addresses.flatMap((item) => item.txids)).size}).`;

    const names = [...(main?.fullName ? [main.fullName] : []), ...(main?.nameVariants ?? [])];
    let outcome: ReplyIdentityOutcome;
    if (!holderName && !(reply.payload.customer?.emails?.length || reply.payload.customer?.phones?.length)) outcome = 'no_customer_data';
    else if (!main || !holderName || names.length === 0) outcome = 'inconclusive';
    else outcome = names.some((name) => sameFullName(name, holderName)) ? 'confirmed' : 'other_person';

    const identity = outcome === 'other_person' && holderName ? base.linkedIdentities?.find((item) => [item.fullName, item.displayName].some((name) => name !== undefined && sameFullName(name, holderName))) : undefined;
    const contradiction =
      outcome === 'other_person'
        ? `Sprzeczność: konto w usłudze ${reply.serviceName}, na które trafiły środki z adresu ${where}, należy według odpowiedzi (sygn. ${reply.reference}) do innej osoby: „${holderName}”, a nie do kandydata głównego` +
          `${main?.fullName ? ` („${main.fullName}”)` : ''}.${identity ? ` To imię i nazwisko nosi powiązana tożsamość z tej sprawy: „${identity.displayName}”.` : ' Tej osoby nie ma wśród tożsamości znalezionych w sprawie.'} ` +
          'Możliwe wyjaśnienia: konto osoby podstawionej lub bliskiej, inna tożsamość tej samej osoby albo błędne przypisanie adresu — rozstrzyga analityk.'
        : undefined;
    const identityText =
      outcome === 'confirmed'
        ? `Dane klienta zgadzają się z kandydatem głównym${main?.fullName ? ` (${main.fullName})` : ''} — osoba potwierdzona odpowiedzią ${cite}; własność dopasowanych adresów liczona jak potwierdzona przez analityka.`
        : outcome === 'other_person'
          ? `Konto w usłudze należy do innej osoby („${holderName}”) — kandydat główny NIE został potwierdzony.`
          : outcome === 'inconclusive'
            ? 'Usługa podała dane klienta, ale nie da się ich porównać z kandydatem głównym — ustalenie osoby bez zmian.'
            : 'Odpowiedź nie zawiera danych klienta — ustalenie osoby bez zmian.';

    const payouts = reply.payload.fiatPayouts;
    const documented = payouts.length > 0;
    const total = [...payouts.reduce((sums, item) => sums.set(item.currency, (sums.get(item.currency) ?? 0) + item.amount), new Map<string, number>())].map(([currency, amount]) => fiat(amount, currency)).join(' i ');
    const fiatText = documented
      ? `Usługa potwierdziła wypłaty na rachunek bankowy (${payouts.length}; łącznie ${total}) — wskaźnik C dla dopasowanych adresów osiąga szczebel „udokumentowane wyjście do walut tradycyjnych”.`
      : 'Odpowiedź nie zawiera żadnej wypłaty na rachunek — potwierdza najwyżej właściciela konta, a nie wyjście do walut tradycyjnych; wskaźnik C bez zmian.';

    // Skutki w teczce demo.
    const ref: ServiceReplyRef = { replyId: reply.id, serviceName: reply.serviceName, reference: reply.reference };
    if (outcome === 'confirmed' && main && !persons[0]!.confirmedByReply) {
      persons = [
        { ...persons[0]!, status: 'confirmed', probability: 100, reasons: [`Podstawa 100: potwierdzone odpowiedzią ${cite} — dokument spoza OSINT wprowadzony przez analityka.`, ...persons[0]!.reasons], confirmedByReply: ref },
        ...persons.slice(1),
      ];
    }
    if (contradiction) {
      persons = [{ ...persons[0]!, reasons: [...persons[0]!.reasons, contradiction], replyContradictions: [...(persons[0]!.replyContradictions ?? []), contradiction] }, ...persons.slice(1)];
    }
    if (documented) {
      cashOut = cashOut.map((item) =>
        addresses.some((match) => match.address === item.address) && item.serviceName !== undefined && item.stage !== 'onchain_transfer'
          ? {
              ...item,
              stage: 'documented_fiat_exit' as const,
              status: 'confirmed' as const,
              statement: `Udokumentowane wyjście do walut tradycyjnych: wypłatę na rachunek bankowy potwierdza odpowiedź ${cite} — dokument spoza OSINT wprowadzony przez analityka. Dane blockchain pokazują wyłącznie przekazanie środków.`,
              indicator: {
                ...item.indicator,
                score: 100,
                components: [
                  {
                    rule: 'cashout.documented_service_reply',
                    weight: 100,
                    applied: 100,
                    direction: 'supports' as const,
                    source: `odpowiedź usługi ${reply.serviceName} (dokument spoza OSINT)`,
                    evidence: [{ kind: 'decision' as const, value: `reply:${reply.id}` }],
                    explanation: `Usługa ${reply.serviceName} w odpowiedzi sygn. ${reply.reference} potwierdziła wypłaty na rachunek bankowy (${payouts.length}; łącznie ${total}).`,
                    independence: 'single' as const,
                    limitations: ['Podstawą jest dokument, nie dane blockchain ani źródła publiczne; narzędzie nie weryfikuje jego autentyczności.'],
                  },
                  ...item.indicator.components,
                ],
              },
            }
          : item,
      );
    }
    const nodeId = `reply:${reply.id}`;
    nodes.push({ id: nodeId, kind: 'source', label: `Odpowiedź usługi ${reply.serviceName}`, sublabel: `dokument spoza OSINT — sygn. ${reply.reference}`, status: 'confirmed' });
    const edge = (from: string, label: string): void => {
      if (nodes.some((node) => node.id === from)) edges.push({ id: `documented_by:${from}>${nodeId}`, from, to: nodeId, kind: 'documented_by', label, status: 'confirmed', layer: 'identity', evidence: [{ kind: 'decision', value: nodeId }] });
    };
    edge(`svc:${reply.serviceId}`, 'odpowiedź usługi (dokument spoza OSINT)');
    for (const match of addresses) edge(`addr:${match.key}`, documented ? 'wpłaty i wypłata na rachunek potwierdzone odpowiedzią usługi' : 'wpłaty potwierdzone odpowiedzią usługi');
    if (outcome === 'confirmed') edge('subject', 'tożsamość potwierdzona odpowiedzią usługi');
    keyFindings.splice(Math.min(1, keyFindings.length), 0, {
      layer: 'fact',
      text: `Dokument spoza OSINT — odpowiedź ${cite}: ${contradiction ?? identityText} ${fiatText}`,
    });

    return {
      ...shared,
      withdrawn: false,
      match: { matched: true, addresses, text: matchText },
      identity: { outcome, text: identityText, basis: [], ...(holderName ? { holderName } : {}), ...(identity ? { linkedIdentityId: identity.id, linkedIdentityName: identity.displayName } : {}) },
      fiatExit: { documented, addresses: documented ? addresses.map((item) => item.key) : [], payouts: payouts.length, text: fiatText },
      effects: [matchText, identityText, fiatText],
      ...(contradiction ? { contradiction } : {}),
    };
  });

  if (!views.some((view) => !view.withdrawn && view.match.matched)) return { ...dossier, serviceReplies: views };
  return {
    ...dossier,
    persons,
    keyFindings,
    graph: { nodes, edges },
    ...(dossier.indicators ? { indicators: { ...dossier.indicators, cashOut } } : {}),
    serviceReplies: views,
  };
}
