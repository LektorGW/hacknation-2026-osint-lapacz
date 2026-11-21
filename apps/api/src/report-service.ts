// Powiązania z giełdami, portfelami i usługami w postaci do druku: sekcja raportu
// oraz samodzielny „Materiał do zapytania do usługi”. To zestawienie faktów i wniosków
// narzędzia — bez danych rejestrowych usługi i bez gotowej formuły prawnej.

import type { AnalysisRun, ServiceLink } from '@olcys/core';
import type { DossierView } from './dossier.ts';
import { formatAmount, formatPln, shortAddress } from './format.ts';
import { NETWORK_LABEL, STYLE, calc, dateTime, esc, fact, inference, link } from './report-html.ts';
import { serviceBasisLabel, serviceKindLabel } from './services.ts';
import type { CaseSummary } from './storage.ts';

const period = (item: ServiceLink): string =>
  item.firstSeen && item.lastSeen ? `${item.firstSeen.slice(0, 10)} – ${item.lastSeen.slice(0, 10)}` : '—';

const value = (count: number, pln: number | undefined): string =>
  count === 0 ? '—' : `${count}${pln !== undefined ? ` / ${esc(formatPln(pln))}` : ' / bez wyceny'}`;

function transfersTable(item: ServiceLink, full: boolean): string {
  if (item.transfers.length === 0) return '<p>Nie stwierdzono przelewów między adresami podmiotu a adresami tej usługi.</p>';
  const cell = (address: string) => (full ? `<span class="mono">${esc(address)}</span>` : `<span class="mono" title="${esc(address)}">${esc(shortAddress(address))}</span>`);
  return `<table>
    <tr><th>Data i czas</th><th>Kierunek</th><th class="liczba">Kwota</th><th class="liczba">Szacunek PLN</th><th>Adres podmiotu</th><th>Adres po stronie usługi</th><th>Transakcja (txid)</th></tr>
    ${item.transfers
      .map(
        (transfer) => `<tr><td>${dateTime(transfer.time)}</td>
          <td>${transfer.direction === 'out' ? 'do usługi' : 'z usługi'}</td>
          <td class="liczba">${esc(formatAmount(transfer.amount))} ${esc(transfer.asset)}</td>
          <td class="liczba">${transfer.valuePln !== undefined ? esc(formatPln(transfer.valuePln)) : '—'}</td>
          <td>${cell(transfer.subjectAddress)}</td>
          <td>${cell(transfer.serviceAddress)}${transfer.viaAddress ? `<br><span class="meta">przez adres wpłat (wnioskowanie):</span> ${cell(transfer.viaAddress)}` : ''}</td>
          <td class="mono">${link(transfer.explorerUrl, full ? transfer.txid : shortAddress(transfer.txid))}</td></tr>`,
      )
      .join('')}
  </table>`;
}

/** „Karta zapytania”: co wiemy, na jakiej podstawie i po jakich danych usługa znajdzie konto. */
function requestCard(item: ServiceLink, full: boolean): string {
  const chainFacts = item.transfers.some((transfer) => !transfer.viaAddress);
  const inferred = item.transfers.some((transfer) => transfer.viaAddress);
  return `
    ${
      item.transfers.length > 0
        ? fact(`<h4>Przelewy zapisane w blockchainie</h4>
            <p>Sieci: ${esc(item.networks.map((network) => NETWORK_LABEL[network] ?? network).join(', ') || '—')}.
            ${chainFacts ? 'Przelewy na adresy z publiczną etykietą usługi są faktem z blockchaina; etykietę adresu potwierdza dopiero sama usługa.' : ''}</p>
            ${transfersTable(item, full)}`)
        : ''
    }
    ${
      item.outPln !== undefined || item.inPln !== undefined
        ? calc(`<h4>Szacunkowa wartość przelewów</h4>
            <p>Do usługi: ${item.outPln !== undefined ? esc(formatPln(item.outPln)) : 'bez wyceny'} (${item.transfersOut} przel.);
            z usługi: ${item.inPln !== undefined ? esc(formatPln(item.inPln)) : 'bez wyceny'} (${item.transfersIn} przel.).
            Wycena po kursie z dnia transakcji — szacunek, nie ustalenie przychodu.</p>`)
        : ''
    }
    ${
      item.mentions.length > 0
        ? fact(`<h4>Usługa w publicznych treściach podmiotu</h4>
            <table><tr><th>Publikacja</th><th>Cytat lub odnośnik</th></tr>
            ${item.mentions.map((mention) => `<tr><td>${link(mention.url)}</td><td>${esc(mention.excerpt)}</td></tr>`).join('')}</table>`)
        : ''
    }
    ${inference(`<h4>Ocena powiązania: ${item.strength}/100${item.inferredOnly ? ' — wyłącznie wnioskowanie' : ''}</h4>
      <ul>${item.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>
      ${inferred ? '<p>Adres wpłat wskazano na podstawie zachowania adresu pośredniego (szybkie przekazanie środków do portfela usługi). To wnioskowanie narzędzia, nie fakt.</p>' : ''}
      <h4>Dane, po których usługa może odnaleźć konto klienta</h4>
      ${item.requestHints.length === 0 ? '<p>Brak danych pozwalających wskazać konto.</p>' : `<ul>${item.requestHints.map((hint) => `<li>${esc(hint)}</li>`).join('')}</ul>`}`)}`;
}

/** Sekcja raportu: tabela usług i karta zapytania dla każdej z nich. */
export function renderServiceSection(links: ServiceLink[]): string {
  if (links.length === 0) {
    return '<p>Nie stwierdzono powiązań adresów ani publicznych treści podmiotu z giełdami, portfelami ani innymi usługami.</p>';
  }
  return `${calc(`<p>Usługi uporządkowano według rodzaju (najpierw umożliwiające wypłatę na waluty tradycyjne) i siły powiązania.</p>
    <table>
      <tr><th>Usługa</th><th>Rodzaj</th><th>Podstawy</th><th class="liczba">Siła</th><th>Okres</th><th class="liczba">Do usługi (liczba / PLN)</th><th class="liczba">Z usługi (liczba / PLN)</th></tr>
      ${links
        .map(
          (item) => `<tr><td><strong>${esc(item.name)}</strong></td><td>${esc(serviceKindLabel(item.kind))}</td>
            <td>${item.basis.map((basis) => esc(serviceBasisLabel(basis))).join('<br>')}</td>
            <td class="liczba">${item.strength}/100</td><td>${esc(period(item))}</td>
            <td class="liczba">${value(item.transfersOut, item.outPln)}</td><td class="liczba">${value(item.transfersIn, item.inPln)}</td></tr>`,
        )
        .join('')}
    </table>`)}
    ${links.map((item) => `<section class="adres"><h3>Karta zapytania: ${esc(item.name)} <span class="meta">(${esc(serviceKindLabel(item.kind))})</span></h3>${requestCard(item, false)}</section>`).join('')}`;
}

export interface ServiceRequestContext {
  version: string;
  generatedAt: string;
}

/** Samodzielny dokument dla jednej usługi — załącznik pomocniczy do zapytania. */
export function renderServiceRequestHtml(
  caseSummary: CaseSummary,
  run: AnalysisRun,
  dossier: DossierView,
  item: ServiceLink,
  context: ServiceRequestContext,
): string {
  const main = dossier.persons[0];
  const subjectAddresses = [...new Set(item.transfers.map((transfer) => transfer.subjectAddress))];
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Materiał do zapytania — ${esc(item.name)} — ${esc(caseSummary.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Materiał do zapytania do usługi ${esc(item.name)}</h1>
  <p class="meta">Rodzaj usługi: ${esc(serviceKindLabel(item.kind))}. Sprawa: <strong>${esc(caseSummary.name)}</strong> (nr ${esc(caseSummary.id)}), analiza nr ${esc(run.id)}.<br>
    Wygenerowano ${dateTime(context.generatedAt)} narzędziem OŁCyŚ w wersji ${esc(context.version)}.</p>
</header>

<div class="zastrzezenie">
  <strong>Charakter dokumentu.</strong> To materiał pomocniczy: zestawienie publicznie dostępnych faktów (transakcje w blockchainie,
  publikacje) oraz wniosków narzędzia. Nie zawiera danych z rejestrów usługi i nie jest wnioskiem ani żądaniem —
  treść i podstawę prawną zapytania ustala uprawniony organ. Nazwa usługi wynika z publicznej etykiety adresu; właściciela adresu
  potwierdza dopiero sama usługa.
</div>

<h2>1. Kogo dotyczy materiał</h2>
${inference(`<p>${
    main && main.probability > 0
      ? `Najbardziej prawdopodobna osoba według analizy: <strong>${esc(main.fullName ?? 'imię i nazwisko nieustalone')}</strong> (prawdopodobieństwo ${main.probability}%).`
      : 'Analiza nie ustaliła osoby.'
  } Ustalenie osoby jest wnioskiem narzędzia do weryfikacji.</p>
  ${
    subjectAddresses.length > 0
      ? `<p>Adresy przypisywane podmiotowi, których dotyczą przelewy:</p><ul>${subjectAddresses
          .map((address) => {
            const finding = dossier.findings.find((entry) => entry.address === address);
            return `<li><span class="mono">${esc(address)}</span>${finding ? ` — Wskaźnik Pewności ${finding.confidence.score}% (${esc(finding.confidence.tier)})` : ''}</li>`;
          })
          .join('')}</ul>`
      : ''
  }`)}

<h2>2. Co wiemy i na jakiej podstawie</h2>
${requestCard(item, true)}

<div class="zastrzezenie">
  <strong>Zastrzeżenie.</strong> Szacunki kwot i wnioski o adresach wpłat wymagają potwierdzenia danymi usługi.
  Pełny raport z analizy oraz pakiet danych do jej odtworzenia są dostępne w narzędziu (raport nr ${esc(run.id)}).
</div>
</body>
</html>
`;
}
