// Przykładowa odpowiedź giełdy na zapytanie o klienta — WYŁĄCZNIE dane syntetyczne do demonstracji.
//
// Prawdziwą odpowiedź (dane KYC, wypłaty na rachunek) może dać tylko usługa, w reakcji na zapytanie
// uprawnionego organu. Piaskownica składa jej fikcyjny odpowiednik z własnej księgi przelewów i własnych,
// zmyślonych kont: wpłaty z podanego adresu do usługi, „klient” spośród autorów, którzy ten adres opublikowali,
// oraz wymyślone wypłaty w złotych. Każda odpowiedź ma pole `"syntetyczne": true`.
//
//   GET /_demo/odpowiedz-gieldy?usluga=<nazwa usługi>&adres=<adres podmiotu>[&wariant=inna-osoba]
//
// Wariant `inna-osoba` zwraca jako właściciela konta inną osobę niż domyślna (jeśli adres opublikowały dwie
// osoby — tę drugą; w przeciwnym razie fikcyjną „Julię Kowalską”) — do pokazania przypadku konta osoby podstawionej.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { validateAddress } from '@olcys/core';
import { scenario } from '../data/scenario.ts';
import type { Account, LedgerRow } from '../data/scenario.ts';

/** Fikcyjne kursy do wyliczenia kwot wypłat — nie mają związku z rynkiem. */
const RATE_PLN: Record<string, number> = { BTC: 250_000, ETH: 12_000, USDT: 4, USDC: 4 };
const HOUR_MS = 3_600_000;
/** Adres pośredni (indywidualny adres wpłat) przekazuje środki do usługi najpóźniej po tylu godzinach. */
const FORWARD_HOURS = 24;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ł/g, 'l').trim();
/** Cyfry z skrótu — do zmyślonych, ale powtarzalnych numerów. */
const digitsOf = (seed: string, count: number): string => BigInt(`0x${sha(seed).slice(0, 15)}`).toString().padStart(count, '0').slice(-count);

/** Identyfikator transakcji tak, jak liczy go eksplorator piaskownicy (skrót wiersza księgi). */
function txidOf(row: LedgerRow): string {
  const hash = sha(JSON.stringify(row));
  return validateAddress(row.from)?.network === 'ethereum' ? `0x${hash}` : hash;
}

/** Nazwa usługi z etykiety adresu: część przed dwukropkiem („Giełda Bursztyn: Hot Wallet” → „Giełda Bursztyn”). */
const serviceNameOf = (label: string): string => (label.split(':')[0] ?? label).trim();

interface Deposit {
  /** Adres po stronie usługi wskazany w odpowiedzi: portfel usługi albo indywidualny adres wpłat. */
  depositAddress: string;
  network: string;
  txids: string[];
  /** Transakcja, którą środki opuściły adres podmiotu. */
  txid: string;
  time: string;
  asset: string;
  amount: number;
  serviceName: string;
}

function depositsOf(address: string, wantedService: string): Deposit[] {
  const labels = new Map(scenario.labeledAddresses.filter((item) => item.label).map((item) => [item.address, serviceNameOf(item.label!)]));
  const matches = (name: string | undefined): name is string => name !== undefined && (wantedService === '' || fold(name).includes(wantedService) || wantedService.includes(fold(name)));
  const network = validateAddress(address)?.network ?? '';
  const result: Deposit[] = [];
  for (const row of scenario.ledger) {
    if (row.from !== address) continue;
    const direct = labels.get(row.to);
    if (matches(direct)) {
      result.push({ depositAddress: row.to, network, txids: [txidOf(row)], txid: txidOf(row), time: row.time, asset: row.asset, amount: row.amount, serviceName: direct });
      continue;
    }
    if (direct !== undefined) continue;
    // Adres bez etykiety, który wkrótce przekazuje środki do usługi: indywidualny adres wpłat klienta.
    const forward = scenario.ledger.find(
      (next) =>
        next.from === row.to &&
        matches(labels.get(next.to)) &&
        new Date(next.time).getTime() >= new Date(row.time).getTime() &&
        new Date(next.time).getTime() - new Date(row.time).getTime() <= FORWARD_HOURS * HOUR_MS,
    );
    if (forward) {
      result.push({ depositAddress: row.to, network, txids: [txidOf(row), txidOf(forward)], txid: txidOf(row), time: row.time, asset: row.asset, amount: row.amount, serviceName: labels.get(forward.to)! });
    }
  }
  return result;
}

/** Konta (z imieniem i nazwiskiem), których autorzy opublikowali adres — od najwcześniej założonego. */
function publishersOf(address: string): Account[] {
  const authors = new Set<string>();
  for (const page of scenario.pages) if (page.html.includes(address)) authors.add(page.author);
  for (const thread of scenario.threads) {
    if (thread.opening?.html.includes(address)) authors.add(thread.opening.author);
    for (const item of thread.items) if (item.html.includes(address)) authors.add(item.author);
  }
  return scenario.accounts
    .filter((account) => authors.has(account.handle) && account.name)
    .sort((a, b) => (a.createdAt ?? '9').localeCompare(b.createdAt ?? '9'));
}

export function registerExchangeReply(app: FastifyInstance): void {
  app.get<{ Querystring: { usluga?: string; adres?: string; wariant?: string } }>('/_demo/odpowiedz-gieldy', (request, reply) => {
    const address = (request.query.adres ?? '').trim();
    const wanted = fold(request.query.usluga ?? '');
    const variant = (request.query.wariant ?? '').trim();
    if (!address) return reply.code(400).send({ error: 'Podaj parametr „adres” — adres podmiotu, z którego środki trafiły do usługi.', syntetyczne: true });
    if (variant !== '' && variant !== 'inna-osoba') return reply.code(400).send({ error: 'Dozwolony wariant: inna-osoba.', syntetyczne: true });

    const deposits = depositsOf(address, wanted);
    if (deposits.length === 0) {
      return reply.code(404).send({ error: `W księdze piaskownicy nie ma wpłat z adresu ${address} do usługi „${request.query.usluga ?? '(dowolna)'}”.`, syntetyczne: true });
    }
    // Jedna odpowiedź dotyczy jednej usługi — tej, do której trafiła pierwsza wpłata.
    const serviceName = deposits[0]!.serviceName;
    const own = deposits.filter((item) => item.serviceName === serviceName);

    const publishers = publishersOf(address);
    const primary = publishers[0];
    const other = publishers.find((account) => primary && fold(account.name!) !== fold(primary.name!));
    const fictional: Account = { service: 'targ', handle: 'julia_kowalska', name: 'Julia Kowalska' };
    const holder = variant === 'inna-osoba' ? (other ?? (primary && fold(primary.name!) === fold(fictional.name!) ? { ...fictional, name: 'Rafał Kowalski' } : fictional)) : (primary ?? fictional);
    // Dane kontaktowe klienta: wszystko, co konta o tym imieniu i nazwisku ujawniają w piaskownicy.
    const sameName = scenario.accounts.filter((account) => account.name && fold(account.name) === fold(holder.name!));
    const emails = [...new Set(sameName.flatMap((account) => (account.email ? [account.email] : [])))];
    const phones = [...new Set(sameName.flatMap((account) => (account.phone ? [account.phone] : [])))];

    const seed = `${serviceName}|${address}|${holder.name}`;
    const firstDeposit = own.map((item) => item.time).sort()[0]!;
    const fiatPayouts = own.map((item) => ({
      time: new Date(new Date(item.time).getTime() + 26 * HOUR_MS).toISOString(),
      amount: Math.round(item.amount * (RATE_PLN[item.asset] ?? 1) * 100) / 100,
      currency: 'PLN',
      bankAccountMasked: `PL** **** ${digitsOf(`${seed}|rachunek`, 4)}`,
      relatedTxid: item.txid,
    }));
    const receivedAt = new Date(new Date(fiatPayouts.map((item) => item.time).sort().at(-1)!).getTime() + 14 * 24 * HOUR_MS).toISOString();
    const reference = `SYNT/KYC/${receivedAt.slice(0, 4)}/${digitsOf(seed, 4)}`;

    // Wpłaty zgrupowane po adresie po stronie usługi.
    const byAddress = new Map<string, Deposit[]>();
    for (const item of own) byAddress.set(item.depositAddress, [...(byAddress.get(item.depositAddress) ?? []), item]);
    const matches = [...byAddress].map(([depositAddress, items]) => ({ network: items[0]!.network, depositAddress, txids: [...new Set(items.flatMap((item) => item.txids))] }));

    const customer = {
      fullName: holder.name!,
      identifierKind: 'PESEL' as const,
      // Od razu zamaskowany — pełny numer nie istnieje nawet w piaskownicy.
      identifierMasked: `*******${digitsOf(`${seed}|pesel`, 4)}`,
      accountId: `SYNT-${sha(seed).slice(0, 8).toUpperCase()}`,
      ...(emails.length > 0 ? { emails } : {}),
      ...(phones.length > 0 ? { phones } : {}),
      registeredAt: new Date(new Date(firstDeposit).getTime() - 30 * 24 * HOUR_MS).toISOString(),
    };
    const note = `Odpowiedź SYNTETYCZNA wygenerowana przez piaskownicę OŁCyŚ — wszystkie osoby, numery i kwoty są fikcyjne.${variant === 'inna-osoba' ? ' Wariant demonstracyjny: konto należy do innej osoby niż autor pierwszej publikacji adresu.' : ''}`;
    const documentText = [
      `${serviceName} — odpowiedź na zapytanie (DANE SYNTETYCZNE, piaskownica OŁCyŚ)`,
      `Sygnatura: ${reference}`,
      `Klient: ${customer.fullName}, konto ${customer.accountId}, identyfikator ${customer.identifierMasked}`,
      ...own.map((item, index) => `Wpłata ${index + 1}: ${item.time} ${item.amount} ${item.asset}, transakcja ${item.txid}, adres ${item.depositAddress}`),
      ...fiatPayouts.map((item, index) => `Wypłata ${index + 1}: ${item.time} ${item.amount.toFixed(2)} ${item.currency} na rachunek ${item.bankAccountMasked}`),
    ].join('\n');

    return {
      syntetyczne: true,
      uwaga: 'Dane fikcyjne z piaskownicy OŁCyŚ — nie pochodzą od żadnej prawdziwej usługi.',
      serviceName,
      reference,
      receivedAt,
      payload: { syntetyczne: true, matches, customer, fiatPayouts, note },
      documentText,
    };
  });
}
