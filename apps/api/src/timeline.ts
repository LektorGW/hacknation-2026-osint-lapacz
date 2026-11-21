// Oś czasu sprawy: publikacje adresów, założenia kont, przelewy, możliwe wypłaty
// i podmiany adresów w jednym chronologicznym ciągu. Każde zdarzenie ma warstwę:
// fakt ze źródła, wynik obliczeń albo wniosek do weryfikacji.

import type { Finding, ProfileCard, TimelineEvent } from '@olcys/core';
import type { AddressReplacement } from './diff.ts';
import { formatAmount, shortAddress } from './format.ts';

/** Najwyżej tyle zwykłych przelewów (największych kwotą) trafia na oś; wypłaty zawsze wszystkie. */
export const MAX_TIMELINE_TRANSFERS = 300;

export interface TimelineInput {
  /** Adresy powiązane z podmiotem. */
  linked: Finding[];
  profiles: ProfileCard[];
  replacements: AddressReplacement[];
}

export function buildTimeline(input: TimelineInput): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const profile of input.profiles) {
    if (profile.decision === 'rejected' || !profile.attributes.createdAt) continue;
    events.push({
      time: profile.attributes.createdAt,
      kind: 'account_created',
      title: `Założenie konta ${profile.handle ? `„${profile.handle}” ` : ''}w serwisie ${profile.service}`,
      url: profile.url,
      layer: 'fact',
    });
  }

  const transfers: { amount: number; event: TimelineEvent }[] = [];
  for (const finding of input.linked) {
    for (const evidence of finding.evidence) {
      const time = evidence.publishedAt ?? evidence.archivedAt ?? evidence.capturedAt;
      events.push({
        time,
        kind: 'publication',
        title: `Adres ${shortAddress(finding.address)} w serwisie ${evidence.service}`,
        detail: evidence.publishedAt
          ? `Data publikacji podana przez źródło. ${evidence.title}`
          : evidence.archivedAt
            ? `Data zapisania kopii archiwalnej — adres był wtedy opublikowany. ${evidence.title}`
            : `Źródło nie podaje daty publikacji; to data pobrania treści przez narzędzie. ${evidence.title}`,
        address: finding.address,
        url: evidence.url,
        layer: 'fact',
      });
    }

    const cashOutKeys = new Set((finding.chain?.cashOuts ?? []).map((item) => `${item.txid}|${item.counterparty}`));
    for (const cashOut of finding.chain?.cashOuts ?? []) {
      events.push({
        time: cashOut.time,
        kind: 'cash_out',
        title: `Możliwa wypłata: ${formatAmount(cashOut.amount)} ${cashOut.asset} → ${cashOut.counterpartyLabel ?? shortAddress(cashOut.counterparty)}`,
        detail: cashOut.valuation ? `${cashOut.explanation} Wycena: ${cashOut.valuation}.` : cashOut.explanation,
        address: finding.address,
        ...(cashOut.valuePln !== undefined ? { valuePln: cashOut.valuePln } : {}),
        url: cashOut.explorerUrl,
        layer: 'inference',
      });
    }
    for (const transfer of finding.chain?.transfers ?? []) {
      // Przelew będący wskaźnikiem wypłaty jest już na osi jako „możliwa wypłata”.
      if (transfer.direction === 'out' && cashOutKeys.has(`${transfer.txid}|${transfer.counterparty}`)) continue;
      const party = transfer.counterpartyLabel ?? shortAddress(transfer.counterparty);
      transfers.push({ amount: transfer.amount, event: {
        time: transfer.time,
        kind: transfer.direction === 'in' ? 'transfer_in' : 'transfer_out',
        title:
          transfer.direction === 'in'
            ? `Wpływ ${formatAmount(transfer.amount)} ${transfer.asset} od ${party}`
            : `Wypływ ${formatAmount(transfer.amount)} ${transfer.asset} do ${party}`,
        detail: `Transakcja ${shortAddress(transfer.txid)} na adresie ${shortAddress(finding.address)}.`,
        address: finding.address,
        url: transfer.explorerUrl,
        layer: 'fact',
      } });
    }
  }
  const shown =
    transfers.length > MAX_TIMELINE_TRANSFERS
      ? [...transfers].sort((a, b) => b.amount - a.amount).slice(0, MAX_TIMELINE_TRANSFERS)
      : transfers;
  events.push(...shown.map((item) => item.event));

  for (const replacement of input.replacements) {
    events.push({
      time: replacement.observedAt,
      kind: 'address_replaced',
      title: `Podmiana adresu w publikacji: ${shortAddress(replacement.from)} → ${shortAddress(replacement.to)}`,
      detail: `Wersja z ${replacement.archivedAt.slice(0, 10)} zawierała wcześniejszy adres; podmiana nastąpiła najpóźniej w dniu wskazanym jako czas zdarzenia.`,
      address: replacement.to,
      url: replacement.url,
      layer: 'fact',
    });
  }

  const stamp = (event: TimelineEvent) => {
    const value = new Date(event.time).getTime();
    return Number.isNaN(value) ? 0 : value;
  };
  return events.sort((a, b) => stamp(a) - stamp(b));
}
