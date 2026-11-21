// Raport z analizy jako samodzielny dokument HTML do druku, składany z teczki podmiotu.
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
import type { DossierFinding, DossierView } from './dossier.ts';
import { formatAmount as amount, formatPln as pln, shortAddress as short } from './format.ts';
import { NETWORK_LABEL, STYLE, calc, dateTime, esc, fact, inference, layerTag, link } from './report-html.ts';
import { renderProofSection } from './report-proof.ts';
import { renderServiceSection } from './report-service.ts';
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

function renderFinding(finding: DossierFinding, number: number, rules: ScoreRules): string {
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

  return `<section class="adres${confidence.excluded ? ' odrzucony' : ''}">${header}${score}${renderAnnotations(finding)}${conclusion}${sources}${chain}</section>`;
}

function renderRejected(finding: DossierFinding): string {
  const reason =
    (finding.confidence.ledger.find((entry) => entry.rule === 'decision.address_rejected') ?? finding.confidence.ledger[0])?.explanation ??
    'Adres wykluczony regułą klasyfikacji.';
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

/** Strona tytułowa: to, co analityk ma wiedzieć po minucie czytania. */
function renderKeyFindings(dossier: DossierView): string {
  return `<div class="ustalenia">
    <h3>Kluczowe ustalenia</h3>
    ${dossier.partial ? '<p><strong>Uwaga: analiza została przerwana limitem czasu — wynik jest częściowy.</strong></p>' : ''}
    ${
      dossier.summary
        ? `<p><em>Streszczenie wygenerowane przez model językowy (${esc(dossier.summary.model)}, wersja polecenia ${esc(dossier.summary.promptVersion)}) z ustaleń poniżej — nie jest samodzielnym ustaleniem:</em><br>${esc(dossier.summary.text)}</p>`
        : ''
    }
    ${
      dossier.explanations.length > 0
        ? `<p><strong>Czego brakuje i co można zrobić:</strong></p><ul>${dossier.explanations
            .map((item) => `<li>${esc(item.text)}<ul>${item.suggestions.map((hint) => `<li>${esc(hint)}</li>`).join('')}</ul></li>`)
            .join('')}</ul>`
        : ''
    }
    <ol>${dossier.keyFindings.map((item) => `<li>${layerTag(item.layer)} ${esc(item.text)}</li>`).join('')}</ol>
    <p><span class="priorytet">Priorytet sprawy: ${dossier.totals.priority}/100</span></p>
    <ul>${dossier.totals.priorityReasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>
    <p class="meta">Priorytet jest wynikiem obliczeń według jawnego wzoru i służy do porządkowania kolejki spraw; nie jest oceną podmiotu.</p>
  </div>`;
}

const ATTRIBUTE_LABEL: Record<string, string> = {
  email: 'e-mail',
  phone: 'telefon',
  location: 'lokalizacja',
  website: 'strona WWW',
  handle: 'nazwa konta',
  organization: 'organizacja',
  registry_entry: 'wpis w rejestrze',
};

function renderPersons(dossier: DossierView): string {
  if (dossier.persons.length === 0) {
    return '<p>W przeszukanych źródłach nie znaleziono profili, z których można by ustalić osobę.</p>';
  }
  return inference(`<p>Narzędzie automatycznie połączyło znalezione profile w kandydatów na osoby. Pierwszy kandydat to ustalenie główne;
      kolejni oznaczają, że część śladów może należeć do kogoś innego (np. imiennika). To wniosek do weryfikacji, nie ustalenie tożsamości.</p>
    ${dossier.persons
      .map((person, index) => {
        const profiles = dossier.profiles.filter((profile) => person.profileIds.includes(profile.id));
        return `<div class="zrodlo">
          <h4>${index === 0 ? 'Osoba główna' : `Inny kandydat ${index}`}: ${esc(person.fullName ?? 'imię i nazwisko nieustalone')} — prawdopodobieństwo ${person.probability}%</h4>
          ${person.nameVariants.length > 0 ? `<p>Inne zapisy nazwy: ${esc(person.nameVariants.join(', '))}.</p>` : ''}
          <p>Przesłanki, krok po kroku:</p><ol>${person.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ol>
          <p>Profile: ${profiles.map((profile) => `${esc(profile.handle ?? '—')} (${esc(profile.service)})`).join(', ') || '—'}.</p>
          ${
            person.attributes.length > 0
              ? `<table><tr><th>Cecha</th><th>Wartość</th><th>Potwierdzają serwisy</th></tr>
                ${person.attributes.map((item) => `<tr><td>${esc(ATTRIBUTE_LABEL[item.kind] ?? item.kind)}</td><td>${esc(item.value)}</td><td>${esc(item.sources.join(', '))}</td></tr>`).join('')}</table>`
              : ''
          }
          ${
            person.addresses.length > 0
              ? `<table><tr><th>Adres przypisany tej osobie</th><th class="liczba">Łączne prawdopodobieństwo osoba–adres</th></tr>
                ${person.addresses.map((item) => `<tr><td class="mono">${esc(item.key)}</td><td class="liczba">${item.probability}%</td></tr>`).join('')}</table>`
              : ''
          }
        </div>`;
      })
      .join('')}`);
}

function renderProfiles(dossier: DossierView): string {
  if (dossier.profiles.length === 0) return '<p>Analiza nie zapisała żadnego profilu.</p>';
  return inference(`<p>Ocena 0–100 mówi, na ile profil należy do osoby głównej. Wynika z jawnych przesłanek wymienionych przy każdym profilu.</p>
    <table>
      <tr><th>Serwis / konto</th><th class="liczba">Ocena</th><th>Poziom</th><th>Przesłanki</th><th class="liczba">Adresy</th><th>Decyzja analityka</th></tr>
      ${dossier.profiles
        .map(
          (profile) => `<tr><td>${esc(profile.service)}<br>${link(profile.url, profile.handle ?? profile.url)}</td>
            <td class="liczba"><strong>${profile.identityScore}</strong></td>
            <td>${esc(IDENTITY_LABEL[profile.identityMatch] ?? profile.identityMatch)}</td>
            <td><ul>${profile.identityReasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul></td>
            <td class="liczba">${profile.addresses.length}</td>
            <td>${profile.decision === 'confirmed' ? 'potwierdzony' : profile.decision === 'rejected' ? 'odrzucony' : '—'}</td></tr>`,
        )
        .join('')}
    </table>`);
}

const RELATION_LABEL: Record<string, string> = {
  shared_address: 'wspólny adres',
  transacted: 'bezpośredni przelew',
  common_counterparty: 'wspólny kontrahent',
  shared_attribute: 'wspólna cecha profili',
};

function renderRelated(dossier: DossierView): string {
  if (dossier.relatedPersons.length === 0) return '<p>Nie wskazano osób powiązanych.</p>';
  return inference(`<p>Powiązania są wskazówką do weryfikacji, nigdy ustaleniem: wspólny adres może być zbiórką, a przelew — zwykłą płatnością.</p>
    <table>
      <tr><th>Osoba / sprawa</th><th class="liczba">Siła</th><th>Na czym opiera się powiązanie</th></tr>
      ${dossier.relatedPersons
        .map(
          (person) => `<tr><td><strong>${esc(person.handle)}</strong>${person.services.length > 0 ? `<br><span class="meta">${esc(person.services.join(', '))}</span>` : ''}</td>
            <td class="liczba">${person.strength}/100</td>
            <td><ul>${person.relations.map((relation) => `<li><em>${esc(RELATION_LABEL[relation.kind] ?? relation.kind)}</em>: ${esc(relation.description)}</li>`).join('')}</ul></td></tr>`,
        )
        .join('')}
    </table>`);
}

const MAX_TIMELINE_ROWS = 150;

function renderTimeline(dossier: DossierView): string {
  if (dossier.timeline.length === 0) return '<p>Brak zdarzeń z datą.</p>';
  const shown = dossier.timeline.slice(-MAX_TIMELINE_ROWS);
  return `<table>
      <tr><th>Czas</th><th>Warstwa</th><th>Zdarzenie</th><th class="liczba">Szacunek PLN</th></tr>
      ${shown
        .map(
          (event) => `<tr><td class="meta" style="white-space:nowrap">${dateTime(event.time)}</td><td>${layerTag(event.layer)}</td>
            <td>${event.url ? link(event.url, event.title) : esc(event.title)}${event.detail ? `<br><span class="meta">${esc(event.detail)}</span>` : ''}</td>
            <td class="liczba">${event.valuePln !== undefined ? esc(pln(event.valuePln)) : '—'}</td></tr>`,
        )
        .join('')}
    </table>
    ${dossier.timeline.length > shown.length ? `<p class="meta">Pokazano ${shown.length} najnowszych z ${dossier.timeline.length} zdarzeń; pełna oś czasu jest w teczce sprawy.</p>` : ''}`;
}

function renderDecisions(dossier: DossierView): string {
  if (dossier.decisions.length === 0) {
    return '<p>Analityk nie podjął żadnej decyzji — wszystkie wyniki pochodzą z automatycznej oceny narzędzia.</p>';
  }
  return fact(`<table>
      <tr><th>Kiedy</th><th>Kto</th><th>Dotyczy</th><th>Decyzja</th><th>Notatka</th></tr>
      ${dossier.decisions
        .map(
          (decision) => `<tr><td style="white-space:nowrap">${dateTime(decision.decidedAt)}</td><td>${esc(decision.author)}</td>
            <td>${decision.target === 'profile' ? 'profil' : 'adres'}: <span class="mono">${esc(decision.key)}</span></td>
            <td>${decision.decision === 'confirmed' ? 'potwierdzenie' : 'odrzucenie'}</td><td>${esc(decision.note ?? '—')}</td></tr>`,
        )
        .join('')}
    </table>
    <p class="meta">Dla każdego profilu i adresu obowiązuje najnowsza decyzja; wcześniejsze pozostają w rejestrze.</p>`);
}

/** Adnotacje teczki: dlaczego wynik adresu różni się od zapisanego w analizie. */
function renderAnnotations(finding: DossierFinding): string {
  const notes = finding.annotations ?? [];
  const dropped = finding.excludedEvidence ?? [];
  if (notes.length === 0 && dropped.length === 0) return '';
  return inference(`<h4>Korekty względem zapisanej analizy</h4>
    ${notes.length > 0 ? `<ul>${notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
    ${dropped.length > 0 ? `<p>Ślady pominięte w ocenie: ${dropped.map((item) => link(item.url)).join(', ')}.</p>` : ''}`);
}

export function renderReportHtml(
  caseSummary: CaseSummary,
  run: AnalysisRun,
  dossier: DossierView,
  replacements: AddressReplacement[],
  context: ReportContext,
): string {
  const findings = dossier.findings;
  const accepted = findings.filter((finding) => !finding.confidence.excluded);
  const rejected = findings.filter((finding) => finding.confidence.excluded);
  const usedConnectors = run.connectors.map(
    (id) => context.connectors.find((connector) => connector.id === id) ?? { id, label: id, service: '—', description: 'Łącznik nie jest już dostępny w konfiguracji.' },
  );
  const discovered = dossier.subject.identifiers.filter((item) => item.origin === 'discovered');

  const summaryRows = findings
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

${renderKeyFindings(dossier)}

<h2>Ustalenie osoby</h2>
${renderPersons(dossier)}

<h2>Dowód spieniężenia</h2>
${renderProofSection(dossier.cashOutProof)}

${
  dossier.unconfirmedAddresses.length > 0
    ? `<h2>Adresy do potwierdzenia</h2>
      ${inference(`<p>Adresy znalezione w analizie, których nie przypisano podmiotowi. Nie wchodzą do sum ani priorytetu; decyzja analityka „potwierdzony” dla profilu lub adresu przeliczy teczkę.</p>
        <table>
          <tr><th>Adres</th><th class="liczba">Prawdopodobieństwo osoba–adres</th><th>Dlaczego niepotwierdzony</th><th>Aktywność w blockchainie</th></tr>
          ${dossier.unconfirmedAddresses
            .map(
              (item) => `<tr><td class="mono">${esc(item.address)}<br><span class="meta">${esc(NETWORK_LABEL[item.network] ?? item.network)}; źródła: ${item.sources.map((source) => link(source.url, source.service)).join(', ')}</span></td>
                <td class="liczba">${item.personAddressProbability}%</td>
                <td><ul>${item.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul></td>
                <td>${
                  item.chain
                    ? `przelewów: ${item.chain.transfers}; otrzymano ${esc(amount(item.chain.totalReceived))}, wysłano ${esc(amount(item.chain.totalSent))} ${esc(item.chain.asset)}; usługi: ${esc(item.chain.services.join(', ') || 'brak')}; ścieżek do usług: ${item.chain.trails}`
                    : 'nie analizowano'
                }</td></tr>`,
            )
            .join('')}
        </table>`)}`
    : ''
}

<h2>Powiązania z giełdami, portfelami i usługami</h2>
${renderServiceSection(dossier.serviceLinks)}

<h2>Jak czytać ten raport</h2>
<p>Każda informacja należy do jednej z trzech warstw. Warstwy są oznaczone etykietą i rodzajem obramowania:</p>
${fact('<p>Informacja pobrana wprost z publicznego źródła lub z blockchaina. Można ją sprawdzić pod podanym adresem; skrót SHA-256 pozwala potwierdzić, że zapisana kopia treści nie została zmieniona.</p>')}
${calc('<p>Liczba policzona przez narzędzie według jawnych reguł (np. Wskaźnik Pewności, suma w PLN, priorytet). Każdy krok obliczenia jest pokazany i można go powtórzyć.</p>')}
${inference('<p>Interpretacja narzędzia (np. ustalenie osoby, wskaźnik wypłaty, osoby powiązane). Nie jest ustaleniem faktycznym — wymaga potwierdzenia przez analityka, np. danymi od giełdy lub innego pośrednika.</p>')}

<h2>1. Dane wejściowe i parametry wyszukiwania</h2>
${fact(`
  <h4>Identyfikatory podmiotu podane przez analityka</h4>
  <table>
    <tr><th>Rodzaj</th><th>Wartość</th></tr>
    ${run.query.identifiers.map((identifier) => `<tr><td>${esc(IDENTIFIER_LABEL[identifier.type] ?? identifier.type)}</td><td>${esc(identifier.value)}</td></tr>`).join('')}
  </table>
  ${
    discovered.length > 0
      ? `<h4>Identyfikatory odkryte w toku analizy — ścieżka dojścia</h4>
        <table>
          <tr><th>Krok</th><th>Identyfikator</th><th>Wskazany w publikacji</th><th>Do której doprowadził</th><th>Wyszukiwany dalej</th></tr>
          ${discovered
            .map(
              (item) => `<tr><td>${item.step ?? '—'}</td><td>${esc(IDENTIFIER_LABEL[item.identifier.type] ?? item.identifier.type)} „${esc(item.identifier.value)}”</td>
                <td>${item.sourceUrl ? link(item.sourceUrl) : '—'}</td>
                <td>${item.via ? `${esc(IDENTIFIER_LABEL[item.via.type] ?? item.via.type)} „${esc(item.via.value)}”` : '—'}</td>
                <td>${item.followed ? 'tak' : 'nie (limit kroków lub liczby identyfikatorów)'}</td></tr>`,
            )
            .join('')}
        </table>`
      : ''
  }
  <h4>Przeszukane źródła (łączniki)</h4>
  <table>
    <tr><th>Źródło</th><th>Usługa</th><th>Co i jak jest przeszukiwane</th></tr>
    ${usedConnectors.map((connector) => `<tr><td>${esc(connector.label)}<br><code>${esc(connector.id)}</code></td><td>${esc(connector.service)}</td><td>${esc(connector.description)}</td></tr>`).join('')}
  </table>
  <p class="meta">Wyszukiwanie obejmuje identyfikatory wejściowe oraz kolejne kroki dla identyfikatorów odkrytych w znalezionych profilach
    (z limitem kroków i liczby identyfikatorów). Przeszukiwane są wyłącznie źródła publiczne, bez logowania i bez obchodzenia zabezpieczeń.</p>`)}

<h2>2. Podsumowanie wyników</h2>
${calc(
  findings.length === 0
    ? '<p>W przeszukanych źródłach nie znaleziono żadnego adresu kryptowalutowego.</p>'
    : `<p>Znalezione adresy: ${findings.length}, w tym odrzucone: ${rejected.length}. Wyniki liczone względem osoby głównej, z uwzględnieniem decyzji analityka.</p>
      <table>
        <tr><th>Adres</th><th>Sieć</th><th class="liczba">Wskaźnik Pewności</th><th>Poziom</th><th class="liczba">Ślady</th><th>Klasyfikacja</th></tr>
        ${summaryRows}
      </table>
      <p class="meta">Poziomy: ${[...context.rules.tiers].sort((a, b) => b.min - a.min).map((tier) => `od ${tier.min}% — ${esc(tier.label)}`).join('; ')}.</p>`,
)}

<h2>3. Profile i ocena tożsamości</h2>
${renderProfiles(dossier)}

<h2>4. Adresy powiązane z podmiotem</h2>
${accepted.length === 0 ? '<p>Brak adresów, które można rozważać jako powiązane z podmiotem.</p>' : accepted.map((finding, index) => renderFinding(finding, index + 1, context.rules)).join('')}

<h2>5. Adresy odrzucone</h2>
<p>Adresy znalezione przy podmiocie, których <strong>nie</strong> przypisuje się mu, ponieważ należą do pośredników lub są współdzielone
  (giełdy, smart kontrakty, zbiórki, miksery, instytucje) albo zostały odrzucone decyzją analityka.</p>
${rejected.length === 0 ? '<p>Żaden adres nie został odrzucony.</p>' : rejected.map(renderRejected).join('')}

<h2>6. Podmiany adresów w czasie</h2>
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

<h2>7. Osoby powiązane</h2>
${renderRelated(dossier)}

<h2>8. Oś czasu</h2>
${renderTimeline(dossier)}

<h2>9. Rejestr decyzji analityka</h2>
${renderDecisions(dossier)}

<h2>10. Dziennik przebiegu analizy</h2>
<table>
  <tr><th>Czas</th><th>Zdarzenie</th></tr>
  ${run.log.map((entry) => `<tr><td class="meta" style="white-space:nowrap">${dateTime(entry.time)}</td><td>${esc(entry.message)}</td></tr>`).join('')}
</table>

<div class="zastrzezenie">
  <strong>Zastrzeżenie.</strong> Raport jest materiałem analitycznym wspierającym pracę analityka, a nie rozstrzygnięciem.
  Wskaźnik Pewności i ustalenie osoby wyrażają siłę publicznie dostępnych przesłanek; nie dowodzą własności adresu, tożsamości ani osiągnięcia przychodu.
  Wnioski oznaczone jako „Wniosek do weryfikacji” oraz szacunki kwot wymagają potwierdzenia w toku czynności prowadzonych przez uprawniony organ.
  Pełne dane pozwalające odtworzyć analizę (wyniki, reguły, kopie treści) zawiera pakiet <code>report.json</code>.
</div>
</body>
</html>
`;
}
