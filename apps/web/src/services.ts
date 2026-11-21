// Powiązania podmiotu z giełdami, portfelami i innymi usługami wyliczane po stronie
// interfejsu z danych blockchain — używane, gdy API nie zwraca `serviceLinks`.
import type { AddressClass, CashOutKind, Finding, ServiceKind, ServiceLink, ServiceLinkBasis } from '@olcys/core';
import { fmtAmount, fmtDate, fmtPln } from './format.ts';

/** Nazwa usługi z etykiety adresu: `KryptoGiełda: adres depozytowy` → `KryptoGiełda`. */
export function serviceName(label: string): string {
  return (label.split(/\s*[:(]\s*|\s+[—–-]\s+/)[0] ?? label).trim() || label.trim();
}

const KIND_BY_CASH_OUT: Record<CashOutKind, ServiceKind> = {
  exchange_deposit: 'exchange',
  p2p_service: 'p2p',
  payment_gateway: 'payment_gateway',
  crypto_card: 'crypto_card',
  stablecoin_swap: 'defi',
};

const KIND_BY_CLASS: Partial<Record<AddressClass, ServiceKind>> = {
  exchange: 'exchange',
  mixer: 'mixer',
  smart_contract: 'defi',
};

const UNLABELLED: Partial<Record<AddressClass, string>> = {
  exchange: 'Giełda bez etykiety',
  mixer: 'Mikser bez etykiety',
};

const slug = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const YEAR_MS = 365 * 24 * 3600 * 1000;

function describe(link: ServiceLink, topScore: number): Pick<ServiceLink, 'strength' | 'reasons' | 'requestHints'> {
  const reasons: string[] = [];
  let strength = link.transfersOut > 0 ? 50 : 40;
  reasons.push(
    link.transfersOut > 0
      ? `Przelewy z adresów podmiotu do usługi: ${link.transfersOut}.`
      : `Wyłącznie przelewy z usługi na adresy podmiotu: ${link.transfersIn}.`,
  );
  if (link.transfers.length >= 3) {
    strength += 15;
    reasons.push('Powtarzalność: co najmniej 3 przelewy.');
  }
  if ((link.outPln ?? 0) >= 50_000) {
    strength += 15;
    reasons.push(`Szacowana wartość przelewów do usługi: ${fmtPln(link.outPln!)}.`);
  } else if ((link.outPln ?? 0) >= 10_000) {
    strength += 8;
    reasons.push(`Szacowana wartość przelewów do usługi: ${fmtPln(link.outPln!)}.`);
  }
  if (link.transfersOut > 0 && link.transfersIn > 0) {
    strength += 10;
    reasons.push('Przepływy w obu kierunkach.');
  }
  if (link.firstSeen && link.lastSeen && Date.parse(link.lastSeen) - Date.parse(link.firstSeen) > YEAR_MS) {
    strength += 10;
    reasons.push('Relacja trwa dłużej niż rok.');
  }
  // Powiązanie z usługą jest tak pewne, jak przypisanie adresu podmiotowi.
  strength = Math.round(Math.min(100, strength) * (0.5 + topScore / 200));
  reasons.push(`Najwyższy Wskaźnik Pewności adresów biorących udział w przelewach: ${topScore}%.`);

  const byAddress = new Map<string, number>();
  for (const item of link.transfers) byAddress.set(item.serviceAddress, (byAddress.get(item.serviceAddress) ?? 0) + 1);
  const largest = [...link.transfers].sort((a, b) => (b.valuePln ?? 0) - (a.valuePln ?? 0)).slice(0, 3);
  const requestHints = [
    ...[...byAddress].slice(0, 3).map(
      ([address, count]) => `Adres po stronie usługi ${address} (liczba przelewów: ${count}) — dane konta, na które zaksięgowano te wpłaty lub z którego zlecono wypłaty.`,
    ),
    ...largest.map(
      (item) =>
        `Transakcja ${item.txid} z ${fmtDate(item.time)}: ${fmtAmount(item.amount, item.asset)}` +
        `${item.valuePln === undefined ? '' : ` (ok. ${fmtPln(item.valuePln)})`} — ${item.direction === 'out' ? 'wpłata z adresu' : 'wypłata na adres'} ${item.subjectAddress}.`,
    ),
  ];
  if (link.firstSeen && link.lastSeen) {
    requestHints.push(`Okres do objęcia zapytaniem: ${fmtDate(link.firstSeen)} – ${fmtDate(link.lastSeen)}.`);
  }
  return { strength, reasons, requestHints };
}

/** Grupuje przelewy adresów nieodrzuconych po nazwie usługi po stronie kontrahenta. */
export function serviceLinksFromFindings(findings: Finding[]): ServiceLink[] {
  const links = new Map<string, ServiceLink>();
  const topScores = new Map<string, number>();

  for (const finding of findings) {
    if (finding.confidence.excluded || !finding.chain) continue;
    const cashOuts = new Map(finding.chain.cashOuts.map((item) => [item.txid, item]));
    for (const transfer of finding.chain.transfers) {
      const cashOut = cashOuts.get(transfer.txid);
      const label = transfer.counterpartyLabel ?? cashOut?.counterpartyLabel ?? UNLABELLED[transfer.counterpartyClass];
      if (!label) continue;
      const name = serviceName(label);
      const id = `svc-${slug(name)}`;
      const kind: ServiceKind =
        (cashOut && KIND_BY_CASH_OUT[cashOut.kind]) ?? KIND_BY_CLASS[transfer.counterpartyClass] ?? 'other';
      const link: ServiceLink = links.get(id) ?? {
        id,
        name,
        kind,
        networks: [],
        basis: [],
        strength: 0,
        reasons: [],
        inferredOnly: false,
        transfersOut: 0,
        transfersIn: 0,
        transfers: [],
        mentions: [],
        requestHints: [],
      };
      links.set(id, link);
      if (link.kind === 'other') link.kind = kind;
      if (!link.networks.includes(finding.network)) link.networks.push(finding.network);
      const basis: ServiceLinkBasis = transfer.direction === 'out' ? 'transfer_out' : 'transfer_in';
      if (!link.basis.includes(basis)) link.basis.push(basis);
      if (transfer.direction === 'out') link.transfersOut += 1;
      else link.transfersIn += 1;
      const valuePln = cashOut?.valuePln;
      if (valuePln !== undefined) {
        if (transfer.direction === 'out') link.outPln = (link.outPln ?? 0) + valuePln;
        else link.inPln = (link.inPln ?? 0) + valuePln;
      }
      if (!link.firstSeen || transfer.time < link.firstSeen) link.firstSeen = transfer.time;
      if (!link.lastSeen || transfer.time > link.lastSeen) link.lastSeen = transfer.time;
      link.transfers.push({
        txid: transfer.txid,
        time: transfer.time,
        direction: transfer.direction,
        asset: transfer.asset,
        amount: transfer.amount,
        valuePln,
        subjectAddress: finding.address,
        serviceAddress: transfer.counterparty,
        explorerUrl: transfer.explorerUrl,
      });
      topScores.set(id, Math.max(topScores.get(id) ?? 0, finding.confidence.score));
    }
  }

  return [...links.values()]
    .map((link) => {
      link.transfers.sort((a, b) => a.time.localeCompare(b.time));
      return { ...link, ...describe(link, topScores.get(link.id) ?? 0) };
    })
    .sort((a, b) => b.strength - a.strength || a.name.localeCompare(b.name));
}
