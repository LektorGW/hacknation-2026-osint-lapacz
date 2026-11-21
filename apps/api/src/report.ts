// Raport z analizy jako samodzielny dokument HTML do druku.
// Bez zewnętrznych zasobów i skryptów. Wszystkie dane pochodzące ze źródeł
// (tytuły, cytaty, etykiety, adresy URL) są niezaufane i przechodzą przez `esc`.

import type {
  AddressClass,
  AnalysisRun,
  CashOutKind,
  ChainActivity,
  Finding,
  IdentifierType,
  IdentityMatch,
  ScoreRules,
  SourceCategory,
  StoredEvidence,
} from '@olcys/core';
import type { AddressReplacement } from './diff.ts';
import type { CaseSummary } from './storage.ts';

export interface ConnectorInfo {
  id: string;
  service: string;
  label: string;
  description: string;
  accepts: IdentifierType[];
  enabledByDefault: boolean;
}

export interface ReportContext {
  /** Opisy łączników — parametry wyszukiwania pokazywane w raporcie. */
  connectors: ConnectorInfo[];
  rules: ScoreRules;
  version: string;
  generatedAt: string;
}

const IDENTIFIER_LABEL: Record<IdentifierType, string> = {
  full_name: 'imię i nazwisko',
  nick: 'pseudonim (nick)',
  login: 'login',
  email: 'adres e-mail',
  messenger_id: 'identyfikator komunikatora',
  profile_url: 'adres profilu lub strony',
  ens_name: 'nazwa ENS',
  crypto_address: 'adres kryptowalutowy',
};

const CATEGORY_LABEL: Record<SourceCategory, string> = {
  cryptographic_proof: 'dowód kryptograficzny',
  own_profile: 'własny profil podmiotu',
  sale_offer: 'ogłoszenie sprzedaży / oferta P2P',
  settlement_message: 'wiadomość w kontekście rozliczenia',
  forum_post: 'wypowiedź na forum',
  mass_comment: 'masowy komentarz',
};

const IDENTITY_LABEL: Record<IdentityMatch, string> = {
  verified_link: 'tożsamość profilu potwierdzona (wzajemne odnośniki lub dowód kryptograficzny)',
  exact_identifier: 'unikalny lub potwierdzony identyfikator podmiotu',
  same_handle: 'zgodny tylko nick — bez potwierdzenia, że to ta sama osoba',
  common_handle: 'zgodny tylko pospolity nick — duże ryzyko innej osoby',
  linked_profile: 'profil odnaleziony pośrednio (przez inny profil podmiotu)',
  name_only: 'zgodne tylko imię i nazwisko — możliwa zbieżność nazwisk',
};

const CLASS_LABEL: Record<AddressClass, string> = {
  private: 'adres prywatny',
  unknown: 'adres bez etykiety',
  exchange: 'adres giełdy lub portfela powierniczego',
  smart_contract: 'smart kontrakt',
  charity: 'adres zbiórki',
  mixer: 'mikser',
  institutional: 'adres instytucjonalny',
};

const CASH_OUT_LABEL: Record<CashOutKind, string> = {
  exchange_deposit: 'wpłata na giełdę',
  p2p_service: 'serwis wymiany P2P',
  payment_gateway: 'bramka płatnicza',
  crypto_card: 'karta kryptowalutowa',
  stablecoin_swap: 'zamiana na stablecoin',
};

const NETWORK_LABEL: Record<string, string> = {
  bitcoin: 'Bitcoin',
  'bitcoin-testnet': 'Bitcoin (sieć testowa)',
  ethereum: 'Ethereum',
  tron: 'TRON',
};

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Odnośnik tylko dla adresów http(s) — inne schematy (np. `javascript:`) zostają zwykłym tekstem. */
function link(url: string, text: string = url): string {
  if (!/^https?:\/\//i.test(url)) return esc(text);
  return `<a href="${esc(url)}" rel="noreferrer noopener">${esc(text)}</a>`;
}

function dateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return esc(iso);
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

const amount = (value: number) => value.toLocaleString('pl-PL', { maximumFractionDigits: 8 });
const pln = (value: number) =>
  `${value.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const short = (text: string) => (text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text);

// Trzy warstwy raportu — każda ma własną etykietę i kolor obramowania.
const fact = (body: string) => layer('fakt', 'Fakt źródłowy', body);
const calc = (body: string) => layer('obliczenie', 'Wynik obliczeń', body);
const inference = (body: string) => layer('wniosek', 'Wniosek do weryfikacji', body);

function layer(kind: string, label: string, body: string): string {
  return `<div class="warstwa ${kind}"><span class="etykieta">${label}</span>${body}</div>`;
}

const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fff; max-width: 210mm; margin: 0 auto; padding: 12mm; line-height: 1.45; font-size: 11pt; }
  h1 { font-size: 20pt; margin: 0 0 2mm; }
  h2 { font-size: 15pt; margin: 9mm 0 3mm; border-bottom: 2px solid #1a1a1a; padding-bottom: 1mm; }
  h3 { font-size: 12.5pt; margin: 6mm 0 2mm; }
  h4 { font-size: 11pt; margin: 4mm 0 1.5mm; }
  p { margin: 0 0 2mm; }
  table { width: 100%; border-collapse: collapse; margin: 2mm 0; font-size: 9.5pt; }
  th, td { border: 1px solid #999; padding: 1.2mm 1.8mm; text-align: left; vertical-align: top; }
  th { background: #eee; }
  td.liczba, th.liczba { text-align: right; white-space: nowrap; }
  code, .mono { font-family: Consolas, 'Courier New', monospace; font-size: 9pt; overflow-wrap: anywhere; }
  blockquote { margin: 1.5mm 0; padding: 1.5mm 3mm; border-left: 3px solid #999; background: #f6f6f6; font-size: 9.5pt; overflow-wrap: anywhere; }
  a { color: #0b3d91; overflow-wrap: anywhere; }
  .meta { color: #444; font-size: 9.5pt; }
  .warstwa { border: 1px solid; border-left-width: 6px; padding: 2.5mm 3mm; margin: 3mm 0; break-inside: avoid-page; }
  .warstwa .etykieta { display: inline-block; font-family: Arial, sans-serif; font-size: 8pt; font-weight: bold; text-transform: uppercase; letter-spacing: .05em; color: #fff; padding: .5mm 2mm; margin-bottom: 1.5mm; }
  .fakt { border-color: #1b5e20; } .fakt .etykieta { background: #1b5e20; }
  .obliczenie { border-color: #0b3d91; border-style: dashed; border-left-style: solid; } .obliczenie .etykieta { background: #0b3d91; }
  .wniosek { border-color: #b45309; border-style: dotted; border-left-style: solid; } .wniosek .etykieta { background: #b45309; }
  .adres { border: 2px solid #1a1a1a; padding: 3mm 4mm; margin: 6mm 0; }
  .adres.odrzucony { border-color: #888; }
  .wynik { font-family: Arial, sans-serif; font-size: 22pt; font-weight: bold; }
  .poziom { font-family: Arial, sans-serif; font-size: 11pt; font-weight: bold; text-transform: uppercase; }
  .zrodlo { border-top: 1px solid #ccc; padding-top: 2mm; margin-top: 2mm; }
  .zastrzezenie { border: 2px solid #1a1a1a; padding: 3mm 4mm; margin-top: 8mm; font-size: 10pt; }
  ul, ol { margin: 1mm 0 2mm; padding-left: 6mm; }
  @media print { body { padding: 0; max-width: none; } h2 { break-after: avoid; } a { color: inherit; } }
  @page { size: A4; margin: 15mm; }
`;

function renderEvidence(evidence: StoredEvidence, number: number): string {
  return `<div class="zrodlo">
    <p><strong>Ślad Ś${number}: ${esc(evidence.title)}</strong></p>
    <table>
      <tr><th>Adres publikacji (URL)</th><td>${link(evidence.url)}</td></tr>
      <tr><th>Usługa / łącznik</th><td>${esc(evidence.service)} / ${esc(evidence.connectorId)}</td></tr>
      <tr><th>Autor</th><td>${evidence.author ? esc(evidence.author) : 'źródło nie podaje'}</td></tr>
      <tr><th>Data publikacji</th><td>${evidence.publishedAt ? dateTime(evidence.publishedAt) : 'źródło nie podaje'}</td></tr>
      ${evidence.archivedAt ? `<tr><th>Wersja archiwalna z</th><td>${dateTime(evidence.archivedAt)}</td></tr>` : ''}
      <tr><th>Data i czas pozyskania</th><td>${dateTime(evidence.capturedAt)}</td></tr>
      <tr><th>Skrót SHA-256 pobranej treści</th><td class="mono">${esc(evidence.contentHash)}</td></tr>
      <tr><th>Rodzaj miejsca publikacji</th><td>${esc(CATEGORY_LABEL[evidence.category] ?? evidence.category)}</td></tr>
      <tr><th>Sposób odnalezienia</th><td>${esc(IDENTIFIER_LABEL[evidence.matchedIdentifier.type] ?? evidence.matchedIdentifier.type)}
        „${esc(evidence.matchedIdentifier.value)}”</td></tr>
      <tr><th>Czy to profil badanego podmiotu</th><td>${esc(IDENTITY_LABEL[evidence.identityMatch] ?? evidence.identityMatch)}${
        evidence.identityReasons?.length ? ` — ${esc(evidence.identityReasons.join(' '))}` : ''
      }</td></tr>
    </table>
    <p class="meta">Cytat z pobranej treści (fragment z adresem):</p>
    <blockquote>${esc(evidence.excerpt)}</blockquote>
  </div>`;
}

function renderLedger(finding: Finding): string {
  const numbers = new Map(finding.evidence.map((item, index) => [item.id, index + 1]));
  if (finding.confidence.ledger.length === 0) {
    return '<p>Brak śladów publikacji tego adresu przez badany podmiot — żadna reguła nie została zastosowana, wynik 0%.</p>';
  }
  const rows = finding.confidence.ledger
    .map((entry, index) => {
      const basis = entry.evidenceIds
        .map((id) => numbers.get(id))
        .filter((value) => value !== undefined)
        .map((value) => `Ś${value}`)
        .join(', ');
      const delta = entry.delta > 0 ? `+${entry.delta}` : String(entry.delta);
      return `<tr><td>${index + 1}</td><td>${esc(entry.explanation)}<br><span class="meta">reguła: <code>${esc(entry.rule)}</code></span></td>
        <td>${basis || '—'}</td><td class="liczba">${delta} p.p.</td><td class="liczba"><strong>${entry.running}%</strong></td></tr>`;
    })
    .join('');
  return `<table>
    <tr><th>Krok</th><th>Zastosowana reguła</th><th>Podstawa</th><th class="liczba">Zmiana</th><th class="liczba">Wynik po kroku</th></tr>
    ${rows}
  </table>`;
}

/** Kontrahent transakcji: etykieta (jeśli jest) i skrócony adres. */
function counterparty(address: string, label: string | undefined, addressClass?: AddressClass): string {
  const known = label ?? (addressClass && addressClass !== 'unknown' ? CLASS_LABEL[addressClass] : undefined);
  return `${known ? `${esc(known)} ` : ''}<span class="mono" title="${esc(address)}">${esc(short(address))}</span>`;
}

const MAX_TRANSFER_ROWS = 200;

function renderChain(chain: ChainActivity): string {
  const { profile } = chain;
  const transfers = [...chain.transfers].sort((a, b) => a.time.localeCompare(b.time));

  const classification = fact(`
    <h4>Klasyfikacja adresu i dane z blockchaina</h4>
    <table>
      <tr><th>Klasyfikacja</th><td>${esc(CLASS_LABEL[profile.addressClass] ?? profile.addressClass)}${profile.label ? ` — etykieta publiczna: „${esc(profile.label)}”` : ''}</td></tr>
      <tr><th>Źródło klasyfikacji</th><td>${esc(profile.classificationSource)}</td></tr>
      <tr><th>Rodzaj</th><td>${profile.isContract ? 'smart kontrakt' : 'zwykły adres (nie kontrakt)'}</td></tr>
      <tr><th>Liczba transakcji</th><td>${profile.txCount}</td></tr>
      <tr><th>Pierwsza / ostatnia aktywność</th><td>${dateTime(profile.firstSeen)} / ${dateTime(profile.lastSeen)}</td></tr>
      <tr><th>Łącznie otrzymano / wysłano</th><td>${amount(profile.totalReceived)} / ${amount(profile.totalSent)} ${esc(profile.nativeAsset)}</td></tr>
      <tr><th>Saldo</th><td>${amount(profile.balance)} ${esc(profile.nativeAsset)}</td></tr>
    </table>`);

  const shown = transfers.slice(0, MAX_TRANSFER_ROWS);
  const incoming = transfers.filter((transfer) => transfer.direction === 'in').length;
  const flow = fact(`
    <h4>Przepływ środków — opis chronologiczny</h4>
    ${
      transfers.length === 0
        ? '<p>Brak pobranych transakcji dla tego adresu.</p>'
        : `<p>Pobrano ${transfers.length} transakcji (wpływów: ${incoming}, wypływów: ${transfers.length - incoming})
            w okresie od ${dateTime(transfers[0]!.time)} do ${dateTime(transfers[transfers.length - 1]!.time)}.
            Kolejność od najstarszej.</p>
          <table>
            <tr><th>Lp.</th><th>Data i czas</th><th>Kierunek</th><th class="liczba">Kwota</th><th>Druga strona</th><th>Transakcja</th></tr>
            ${shown
              .map(
                (transfer, index) => `<tr><td>${index + 1}</td><td>${dateTime(transfer.time)}</td>
                  <td>${transfer.direction === 'in' ? 'wpływ na adres' : 'wypływ z adresu'}</td>
                  <td class="liczba">${amount(transfer.amount)} ${esc(transfer.asset)}</td>
                  <td>${counterparty(transfer.counterparty, transfer.counterpartyLabel, transfer.counterpartyClass)}</td>
                  <td class="mono">${link(transfer.explorerUrl, short(transfer.txid))}</td></tr>`,
              )
              .join('')}
          </table>
          ${transfers.length > shown.length ? `<p class="meta">Pokazano pierwsze ${shown.length} z ${transfers.length} transakcji; pełna lista jest w pakiecie report.json.</p>` : ''}`
    }`);

  const cashOuts = [...chain.cashOuts].sort((a, b) => a.time.localeCompare(b.time));
  const indicators = inference(`
    <h4>Wskaźniki możliwej wypłaty na waluty tradycyjne</h4>
    ${
      cashOuts.length === 0
        ? '<p>W pobranych transakcjach nie znaleziono przepływów do znanych giełd, serwisów P2P, bramek płatniczych ani wystawców kart.</p>'
        : `<p>Poniższe transakcje trafiły do podmiotów, które umożliwiają zamianę kryptowalut na waluty tradycyjne.
            Sam przelew nie dowodzi wypłaty — potwierdzenie wymaga danych od wskazanego pośrednika.</p>
          <table>
            <tr><th>Data i czas</th><th>Rodzaj wskaźnika</th><th class="liczba">Kwota</th><th>Odbiorca</th><th>Wyjaśnienie</th><th>Transakcja</th></tr>
            ${cashOuts
              .map(
                (item) => `<tr><td>${dateTime(item.time)}</td><td>${esc(CASH_OUT_LABEL[item.kind] ?? item.kind)}</td>
                  <td class="liczba">${amount(item.amount)} ${esc(item.asset)}</td>
                  <td>${counterparty(item.counterparty, item.counterpartyLabel)}</td>
                  <td>${esc(item.explanation)}</td>
                  <td class="mono">${link(item.explorerUrl, short(item.txid))}</td></tr>`,
              )
              .join('')}
          </table>`
    }`);

  const years = Object.entries(chain.cashOutPlnByYear).sort(([a], [b]) => a.localeCompare(b));
  const valued = cashOuts.filter((item) => item.valuePln !== undefined);
  const unvalued = cashOuts.length - valued.length;
  const estimate =
    cashOuts.length === 0
      ? ''
      : calc(`
    <h4>Szacunek wypłat w PLN w podziale na lata podatkowe</h4>
    ${
      years.length === 0
        ? '<p>Nie udało się wycenić żadnej transakcji (brak kursów) — szacunek nie został policzony.</p>'
        : `<table>
            <tr><th>Rok podatkowy</th><th class="liczba">Szacunkowa suma wypłat</th></tr>
            ${years.map(([year, value]) => `<tr><td>${esc(year)}</td><td class="liczba">${pln(value)}</td></tr>`).join('')}
          </table>`
    }
    ${
      valued.length > 0
        ? `<p>Sposób wyceny poszczególnych transakcji:</p>
          <table>
            <tr><th>Data i czas</th><th class="liczba">Kwota</th><th class="liczba">Wartość</th><th>Opis wyceny</th></tr>
            ${valued
              .map(
                (item) => `<tr><td>${dateTime(item.time)}</td><td class="liczba">${amount(item.amount)} ${esc(item.asset)}</td>
                  <td class="liczba">${pln(item.valuePln!)}</td><td>${esc(item.valuation ?? 'źródło nie podało opisu wyceny')}</td></tr>`,
              )
              .join('')}
          </table>`
        : ''
    }
    ${unvalued > 0 ? `<p>Transakcji bez wyceny (brak kursu): ${unvalued} — nie są ujęte w sumach.</p>` : ''}
    <p class="meta">Szacunek dotyczy wyłącznie transakcji wskazanych wyżej jako wskaźniki wypłat. Nie jest ustaleniem przychodu ani podstawy opodatkowania.</p>`);

  const limitations = `<h4>Ograniczenia danych</h4>
    ${
      chain.limitations.length === 0
        ? '<p>Dostawca danych nie zgłosił ograniczeń.</p>'
        : `<ul>${chain.limitations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
    }`;

  return classification + flow + indicators + estimate + limitations;
}

function renderFinding(finding: Finding, number: number, rules: ScoreRules): string {
  const { confidence } = finding;
  const header = `<h3>${number}. <span class="mono">${esc(finding.address)}</span></h3>
    <p class="meta">Sieć: ${esc(NETWORK_LABEL[finding.network] ?? finding.network)}.
      Suma kontrolna adresu: ${finding.checksumVerified ? 'potwierdzona' : 'niepotwierdzona (zapis bez sumy kontrolnej)'}.</p>`;

  const score = calc(`
    <h4>Wskaźnik Pewności powiązania adresu z podmiotem</h4>
    <p><span class="wynik">${confidence.score}%</span> &nbsp; <span class="poziom">${esc(confidence.tier)}</span></p>
    <p>Wynik powstał wyłącznie z jawnych reguł, krok po kroku:</p>
    ${renderLedger(finding)}
    ${
      finding.unrelatedPublishers > 0
        ? `<p>Ten sam adres opublikowało także ${finding.unrelatedPublishers} innych autorów, których nie powiązano z podmiotem
            (próg uznania adresu za współdzielony: ${rules.sharedAddressThreshold}).</p>`
        : ''
    }`);

  const conclusion = inference(`
    <h4>Co z tego wynika</h4>
    <p>${
      confidence.excluded
        ? 'Adres nie jest przypisywany badanemu podmiotowi. Odnotowano jedynie fakt jego publikacji lub użycia.'
        : finding.evidence.length === 0
          ? 'Adres został podany przez analityka; w przeszukanych źródłach nie znaleziono jego publikacji przez badany podmiot.'
          : `Powiązanie adresu z podmiotem oceniono jako: <strong>${esc(confidence.tier)}</strong>. To ocena prawdopodobieństwa, nie ustalenie własności adresu.`
    }</p>
    ${
      confidence.nextSteps.length > 0
        ? `<p>Co pozwoliłoby potwierdzić lub podnieść ocenę:</p><ul>${confidence.nextSteps.map((step) => `<li>${esc(step)}</li>`).join('')}</ul>`
        : ''
    }`);

  const sources = fact(`
    <h4>Źródła — gdzie adres został opublikowany</h4>
    ${
      finding.evidence.length === 0
        ? '<p>Brak publikacji przypisanych badanemu podmiotowi.</p>'
        : finding.evidence.map((item, index) => renderEvidence(item, index + 1)).join('')
    }`);

  const chain = finding.chain
    ? renderChain(finding.chain)
    : '<h4>Dane z blockchaina</h4><p>Nie udało się pobrać danych blockchain dla tego adresu — klasyfikacja „adres bez etykiety”, brak opisu przepływów. Szczegóły w dzienniku analizy.</p>';

  return `<section class="adres${confidence.excluded ? ' odrzucony' : ''}">${header}${score}${conclusion}${sources}${chain}</section>`;
}

function renderRejected(finding: Finding): string {
  const reason = finding.confidence.ledger[0]?.explanation ?? 'Adres wykluczony regułą klasyfikacji.';
  const profile = finding.chain?.profile;
  return `<section class="adres odrzucony">
    <h3><span class="mono">${esc(finding.address)}</span></h3>
    <p class="meta">Sieć: ${esc(NETWORK_LABEL[finding.network] ?? finding.network)}.</p>
    ${calc(`<h4>Wskaźnik Pewności: <span class="poziom">0% — ${esc(finding.confidence.tier)}</span></h4>
      <p><strong>Powód odrzucenia:</strong> ${esc(reason)}</p>`)}
    ${
      profile
        ? fact(`<h4>Klasyfikacja adresu</h4>
            <p>${esc(CLASS_LABEL[profile.addressClass] ?? profile.addressClass)}${profile.label ? ` — etykieta publiczna: „${esc(profile.label)}”` : ''}.
            Źródło klasyfikacji: ${esc(profile.classificationSource)}.</p>`)
        : ''
    }
    ${fact(`<h4>Gdzie adres wystąpił</h4>
      ${
        finding.evidence.length === 0
          ? '<p>Brak publikacji.</p>'
          : finding.evidence.map((item, index) => renderEvidence(item, index + 1)).join('')
      }`)}
  </section>`;
}

export function renderReportHtml(
  caseSummary: CaseSummary,
  run: AnalysisRun,
  replacements: AddressReplacement[],
  context: ReportContext,
): string {
  const accepted = run.findings.filter((finding) => !finding.confidence.excluded);
  const rejected = run.findings.filter((finding) => finding.confidence.excluded);
  const usedConnectors = run.connectors.map(
    (id) => context.connectors.find((connector) => connector.id === id) ?? { id, label: id, service: '—', description: 'Łącznik nie jest już dostępny w konfiguracji.' },
  );

  const summaryRows = run.findings
    .map(
      (finding) => `<tr><td class="mono">${esc(finding.address)}</td><td>${esc(NETWORK_LABEL[finding.network] ?? finding.network)}</td>
        <td class="liczba">${finding.confidence.score}%</td><td>${esc(finding.confidence.tier)}</td>
        <td class="liczba">${finding.evidence.length}</td>
        <td>${esc(CLASS_LABEL[finding.chain?.profile.addressClass ?? 'unknown'])}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raport OŁCyŚ — ${esc(caseSummary.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Raport z analizy śladów kryptowalutowych</h1>
  <p class="meta">Sprawa: <strong>${esc(caseSummary.name)}</strong> (nr ${esc(caseSummary.id)})<br>
    Analiza nr ${esc(run.id)} — rozpoczęta ${dateTime(run.startedAt)}, zakończona ${dateTime(run.finishedAt)}, stan: ${esc(run.status)}<br>
    Raport wygenerowano ${dateTime(context.generatedAt)} narzędziem OŁCyŚ w wersji ${esc(context.version)}</p>
</header>

<h2>Jak czytać ten raport</h2>
<p>Każda informacja należy do jednej z trzech warstw. Warstwy są oznaczone etykietą i rodzajem obramowania:</p>
${fact('<p>Informacja pobrana wprost z publicznego źródła lub z blockchaina. Można ją sprawdzić pod podanym adresem; skrót SHA-256 pozwala potwierdzić, że zapisana kopia treści nie została zmieniona.</p>')}
${calc('<p>Liczba policzona przez narzędzie według jawnych reguł (np. Wskaźnik Pewności, suma w PLN). Każdy krok obliczenia jest pokazany i można go powtórzyć.</p>')}
${inference('<p>Interpretacja narzędzia. Nie jest ustaleniem faktycznym — wymaga potwierdzenia przez analityka, np. danymi od giełdy lub innego pośrednika.</p>')}

<h2>1. Dane wejściowe i parametry wyszukiwania</h2>
${fact(`
  <h4>Identyfikatory podmiotu podane przez analityka</h4>
  <table>
    <tr><th>Rodzaj</th><th>Wartość</th></tr>
    ${run.query.identifiers.map((identifier) => `<tr><td>${esc(IDENTIFIER_LABEL[identifier.type] ?? identifier.type)}</td><td>${esc(identifier.value)}</td></tr>`).join('')}
  </table>
  <h4>Przeszukane źródła (łączniki)</h4>
  <table>
    <tr><th>Źródło</th><th>Usługa</th><th>Co i jak jest przeszukiwane</th></tr>
    ${usedConnectors.map((connector) => `<tr><td>${esc(connector.label)}<br><code>${esc(connector.id)}</code></td><td>${esc(connector.service)}</td><td>${esc(connector.description)}</td></tr>`).join('')}
  </table>
  <p class="meta">Wyszukiwanie obejmuje identyfikatory wejściowe oraz jedną dodatkową rundę dla identyfikatorów odkrytych w znalezionych dokumentach.
    Przeszukiwane są wyłącznie źródła publiczne, bez logowania i bez obchodzenia zabezpieczeń.</p>`)}

<h2>2. Podsumowanie wyników</h2>
${calc(
  run.findings.length === 0
    ? '<p>W przeszukanych źródłach nie znaleziono żadnego adresu kryptowalutowego.</p>'
    : `<p>Znalezione adresy: ${run.findings.length}, w tym odrzucone jako fałszywe trafienia: ${rejected.length}.</p>
      <table>
        <tr><th>Adres</th><th>Sieć</th><th class="liczba">Wskaźnik Pewności</th><th>Poziom</th><th class="liczba">Ślady</th><th>Klasyfikacja</th></tr>
        ${summaryRows}
      </table>
      <p class="meta">Poziomy: ${[...context.rules.tiers].sort((a, b) => b.min - a.min).map((tier) => `od ${tier.min}% — ${esc(tier.label)}`).join('; ')}.</p>`,
)}

<h2>3. Adresy powiązane z podmiotem</h2>
${accepted.length === 0 ? '<p>Brak adresów, które można rozważać jako powiązane z podmiotem.</p>' : accepted.map((finding, index) => renderFinding(finding, index + 1, context.rules)).join('')}

<h2>4. Adresy odrzucone</h2>
<p>Adresy znalezione przy podmiocie, których <strong>nie</strong> przypisuje się mu, ponieważ należą do pośredników lub są współdzielone
  (giełdy, smart kontrakty, zbiórki, miksery, instytucje).</p>
${rejected.length === 0 ? '<p>Żaden adres nie został odrzucony.</p>' : rejected.map(renderRejected).join('')}

<h2>5. Podmiany adresów w czasie</h2>
${
  replacements.length === 0
    ? '<p>Nie stwierdzono podmiany adresu między wersją archiwalną a bieżącą żadnej publikacji.</p>'
    : fact(`<p>W tym samym miejscu publikacji starsza wersja zawierała inny adres niż nowsza:</p>
        <table>
          <tr><th>Publikacja</th><th>Adres wcześniejszy</th><th>Stan z</th><th>Adres późniejszy</th><th>Stan z</th></tr>
          ${replacements.map((item) => `<tr><td>${link(item.url)}</td><td class="mono">${esc(item.from)}</td><td>${dateTime(item.archivedAt)}</td><td class="mono">${esc(item.to)}</td><td>${dateTime(item.observedAt)}</td></tr>`).join('')}
        </table>`) +
      inference('<p>Podmiana adresu w profilu może oznaczać zmianę portfela przez podmiot albo próbę ukrycia wcześniejszego adresu. Oba adresy warto analizować łącznie.</p>')
}

<h2>6. Dziennik przebiegu analizy</h2>
<table>
  <tr><th>Czas</th><th>Zdarzenie</th></tr>
  ${run.log.map((entry) => `<tr><td class="meta" style="white-space:nowrap">${dateTime(entry.time)}</td><td>${esc(entry.message)}</td></tr>`).join('')}
</table>

<div class="zastrzezenie">
  <strong>Zastrzeżenie.</strong> Raport jest materiałem analitycznym wspierającym pracę analityka, a nie rozstrzygnięciem.
  Wskaźnik Pewności wyraża siłę publicznie dostępnych przesłanek, nie dowodzi własności adresu ani osiągnięcia przychodu.
  Wnioski oznaczone jako „Wniosek do weryfikacji” oraz szacunki kwot wymagają potwierdzenia w toku czynności prowadzonych przez uprawniony organ.
  Pełne dane pozwalające odtworzyć analizę (wyniki, reguły, kopie treści) zawiera pakiet <code>report.json</code>.
</div>
</body>
</html>
`;
}
