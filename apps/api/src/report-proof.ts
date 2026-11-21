// Sekcja raportu „Dowód spieniężenia”: dla każdego ustalenia składniki łącznej pewności,
// tabela kroków ścieżki środków i lista tego, co może potwierdzić tylko usługa.

import type { CashOutAssessment, EvidenceRef, Indicator, InvestigationIndicators, PersonCandidate, ScoreComponent } from '@olcys/core';
import { CASH_OUT_STAGE_LABEL, INDICATOR_SCALE, SCORE_INTERPRETATION } from '@olcys/core';
import { formatAmount, formatPln } from './format.ts';
import type { CashOutProof } from './proof.ts';
import { PROOF_RULES } from './proof.ts';
import { calc, dateTime, esc, external, fact, inference, link } from './report-html.ts';

const BASIS_LABEL: Record<CashOutProof['addressBasis'], string> = {
  published: 'adres opublikowany przez podmiot',
  analyst: 'adres podany przez analityka',
  confirmed: 'adres potwierdzony decyzją analityka',
  cluster: 'adres z klastra portfela (heurystyka)',
};

function renderProof(proof: CashOutProof, number: number): string {
  const { trail } = proof;
  const hops = fact(`<h4>Ścieżka środków w blockchainie — krok po kroku</h4>
    <table>
      <tr><th>Krok</th><th>Data i czas</th><th>Z adresu</th><th>Na adres</th><th class="liczba">Kwota</th><th>Etykieta adresu docelowego</th><th>Charakter kroku</th><th>Transakcja</th></tr>
      ${trail.hops
        .map(
          (hop, index) => `<tr><td>${index + 1}</td><td>${dateTime(hop.time)}</td>
            <td class="mono">${esc(hop.from)}</td><td class="mono">${esc(hop.to)}</td>
            <td class="liczba">${esc(formatAmount(hop.amount))} ${esc(hop.asset)}</td>
            <td>${esc(hop.toLabel ?? 'brak publicznej etykiety')}</td>
            <td>${hop.inferred ? `<strong>wnioskowanie</strong>${hop.reason ? `: ${esc(hop.reason)}` : ''}` : `zapis transakcji${hop.reason ? ` — ${esc(hop.reason)}` : ''}`}</td>
            <td class="mono">${link(hop.explorerUrl, hop.txid)}</td></tr>`,
        )
        .join('')}
    </table>
    <p class="meta">Kroki oznaczone jako „wnioskowanie” wynikają z heurystyki (np. adres reszty, wspólne wejścia), nie wprost z zapisu transakcji.</p>`);

  const score = calc(`<h4>Łączna pewność ustalenia: ${proof.combinedConfidence}% — ${esc(proof.tier)}</h4>
    <p>${esc(PROOF_RULES.formula)}.</p>
    <ol>${proof.components.map((item) => `<li>${esc(item)}</li>`).join('')}</ol>
    <p>Kwota, która dotarła do usługi: <strong>${esc(formatAmount(trail.amount))} ${esc(trail.asset)}</strong>${
      trail.valuePln !== undefined ? ` — szacunkowo ${esc(formatPln(trail.valuePln))}${trail.valuation ? ` (${esc(trail.valuation)})` : ''}` : ' — bez wyceny w PLN'
    }.</p>`);

  const open = inference(`<h4>Co potwierdzi giełda lub usługa</h4>
    <p>Blockchain pokazuje przekazanie środków do usługi. Tego, kto jest jej klientem i czy wypłacił pieniądze na rachunek, nie pokazuje.</p>
    ${
      trail.openQuestions.length === 0
        ? '<p>Moduł danych blockchain nie wskazał otwartych pytań.</p>'
        : `<ul>${trail.openQuestions.map((question) => `<li>${esc(question)}</li>`).join('')}</ul>`
    }`);

  return `<section class="adres">
    <h3>${proof.ownerUnconfirmed ? 'Ustalenie warunkowe (adres do potwierdzenia)' : 'Ustalenie'} ${number}: ${esc(proof.person?.fullName ?? (proof.addressBasis === 'analyst' ? 'badany adres' : 'osoba ze sprawy'))} → ${esc(proof.serviceName)}</h3>
    <p>${esc(proof.statement)}</p>
    <p class="meta">Adres początkowy: <span class="mono">${esc(proof.address)}</span> — ${esc(BASIS_LABEL[proof.addressBasis])}${
      proof.cluster ? `; portfel ustalony od adresu <span class="mono">${esc(proof.cluster.seed)}</span> (${esc(proof.cluster.reason)})` : ''
    }.</p>
    ${proof.serviceReply ? external(`<p>${proof.serviceReply.outcome === 'other_person' ? '<strong>Sprzeczność do rozstrzygnięcia.</strong> ' : ''}${esc(proof.serviceReply.note)}</p>`) : ''}
    ${score}${hops}${open}
  </section>`;
}

export function renderProofSection(proofs: CashOutProof[]): string {
  if (proofs.length === 0) {
    return '<p>Dane blockchain nie zawierają udokumentowanej ścieżki środków do usługi wymiany. Wskaźniki możliwych wypłat (pojedyncze przelewy) są opisane przy adresach i w sekcji o usługach.</p>';
  }
  return proofs.map((proof, index) => renderProof(proof, index + 1)).join('');
}

// ---------- Trzy wskaźniki śledcze: konto → portfel, wspólny operator, wyjście do walut tradycyjnych ----------
// Każdy wskaźnik jest rozpisany na składniki (reguła, waga, źródło, dowód, wyjaśnienie, niezależność,
// ograniczenia), tak by liczbę dało się odtworzyć i zakwestionować. Hipoteza nigdzie nie jest opisana jak fakt.

const INDEPENDENCE_LABEL: Record<string, string> = {
  independent: 'niezależny',
  dependent: 'zależny — niedoliczony',
  single: 'pojedynczy składnik',
  not_applicable: 'nie dotyczy',
};

const CLAIM_LABEL: Record<string, string> = {
  source_fact: 'fakt źródłowy',
  computed: 'wynik obliczeń',
  hypothesis: 'hipoteza — do weryfikacji',
  confirmed: 'potwierdzone decyzją analityka',
  rejected: 'odrzucone',
};

const HYPOTHESIS_LABEL: Record<string, string> = {
  hypothesis: 'hipoteza — do weryfikacji (konta pozostają osobno)',
  auto_grouped: 'hipoteza — konta zgrupowane automatycznie (nadal wnioskowanie narzędzia)',
  blocked: 'hipoteza zablokowana sprzecznością — kont nie połączono',
  confirmed: 'potwierdzona decyzją analityka',
  rejected: 'odrzucona decyzją analityka',
};

const REF_LABEL: Record<string, string> = {
  txid: 'transakcja',
  attribute: 'cecha',
  address: 'adres',
  evidence_id: 'ślad',
  decision: 'decyzja',
};

const MAX_TXIDS = 10;

function renderRef(ref: EvidenceRef): string {
  if (ref.kind === 'url') return link(ref.value);
  return `${esc(REF_LABEL[ref.kind] ?? ref.kind)}: <span class="mono">${esc(ref.value)}</span>`;
}

const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));

/** Tabela składników wskaźnika — wszystkie pola pochodzą z danych i przechodzą przez `esc`. */
export function renderComponents(components: ScoreComponent[]): string {
  if (components.length === 0) return '<p>Wskaźnik nie ma składników — żadna reguła nie została zastosowana.</p>';
  return `<table>
    <tr><th>Reguła</th><th>Kierunek</th><th class="liczba">Waga</th><th class="liczba">Doliczono</th><th>Źródło</th><th>Dowód</th><th>Wyjaśnienie</th><th>Niezależność</th><th>Ograniczenia</th></tr>
    ${components
      .map(
        (item) => `<tr><td><code>${esc(item.rule)}</code></td>
          <td>${item.direction === 'contradicts' ? `<strong>przeciw</strong>${item.blocking ? ' (kontrdowód twardy — blokuje łączenie)' : ''}` : 'za'}</td>
          <td class="liczba">${esc(signed(item.weight))}</td><td class="liczba"><strong>${esc(signed(item.applied))}</strong></td>
          <td>${esc(item.source)}</td>
          <td>${(item.evidence ?? []).map(renderRef).join('<br>') || '—'}</td>
          <td>${esc(item.explanation)}</td>
          <td>${esc(INDEPENDENCE_LABEL[item.independence] ?? item.independence)}${item.independenceNote ? `<br><span class="meta">${esc(item.independenceNote)}</span>` : ''}</td>
          <td>${(item.limitations ?? []).length > 0 ? `<ul>${item.limitations.map((text) => `<li>${esc(text)}</li>`).join('')}</ul>` : '—'}</td></tr>`,
      )
      .join('')}
  </table>`;
}

function indicatorHead(indicator: Indicator | undefined): string {
  if (!indicator) return '<p>Brak danych wskaźnika.</p>';
  return `<p><span class="wynik">${esc(indicator.score)}/100</span> &nbsp; <span class="poziom">${esc(indicator.level)}</span></p>`;
}

const limitationList = (items: string[] | undefined): string =>
  items && items.length > 0 ? `<p>Ograniczenia wskaźnika:</p><ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '';

/** Ramka metodyczna: jak czytać liczby 0–100 w raporcie. Pojawia się w raporcie raz. */
export function renderMethodologyBox(): string {
  return `<div class="zastrzezenie">
    <strong>Metodyka wskaźników.</strong> ${esc(INDICATOR_SCALE)}
    ${esc(SCORE_INTERPRETATION)}
    Wszystkie liczby 0–100 w tym raporcie (Wskaźnik Pewności, wskaźniki A, B i C, ocena profilu, wskaźnik kandydata na osobę, siła powiązania)
    są <strong>wskaźnikami porządkowymi z jawnych reguł eksperckich — nie są skalibrowanymi prawdopodobieństwami</strong>:
    wynik 80 nie oznacza „80% szans”, lecz mocniejsze udokumentowanie niż wynik 60. Każdy składnik ma regułę, wagę, źródło, dowód,
    ocenę niezależności i ograniczenia, dzięki czemu liczbę można odtworzyć i zakwestionować.
  </div>`;
}

function renderAccountWallet(indicators: InvestigationIndicators | undefined): string {
  const links = indicators?.accountWallet ?? [];
  if (links.length === 0) return '<p>Brak ocen związku konto → portfel (żadne konto nie opublikowało adresu albo teczka nie zawiera wskaźników).</p>';
  return calc(`<p>Na ile <strong>konkretne konto</strong> publicznie deklaruje związek z adresem. Publikacja adresu jest deklaracją autora — nie dowodzi dysponowania kluczem prywatnym.</p>
    <table>
      <tr><th>Konto</th><th>Adres</th><th class="liczba">Wskaźnik</th><th>Poziom</th><th>Klasa adresu</th><th>Status</th></tr>
      ${links
        .map(
          (item) => `<tr><td>${esc(item.service)}<br>${link(item.accountUrl, item.handle ?? item.accountUrl)}</td>
            <td class="mono">${esc(item.address)}<br><span class="meta">${esc(item.network)}</span></td>
            <td class="liczba"><strong>${esc(item.indicator?.score ?? '—')}/100</strong></td><td>${esc(item.indicator?.level ?? '—')}</td>
            <td>${esc(item.addressClass)}${item.notPrivateWallet ? '<br><strong>to nie jest portfel prywatny konta</strong>' : ''}</td>
            <td>${esc(CLAIM_LABEL[item.status] ?? item.status)}</td></tr>`,
        )
        .join('')}
    </table>
    ${links
      .map(
        (item) => `<div class="zrodlo">
          <h4>${esc(item.handle ?? item.accountUrl)} (${esc(item.service)}) → <span class="mono">${esc(item.address)}</span></h4>
          ${indicatorHead(item.indicator)}
          ${item.notPrivateWallet ? '<p>Adres giełdy, kontraktu, zbiórki, miksera lub instytucji: publikację odnotowano, ale adresu nie traktuje się jako portfela prywatnego konta.</p>' : ''}
          ${renderComponents(item.indicator?.components ?? [])}
          ${limitationList(item.indicator?.limitations)}
        </div>`,
      )
      .join('')}`);
}

function renderCommonOperator(indicators: InvestigationIndicators | undefined, persons: PersonCandidate[]): string {
  const hypotheses = indicators?.commonOperator ?? [];
  const blocked = persons.flatMap((person) => person.blockedMerges ?? []);
  if (hypotheses.length === 0 && blocked.length === 0) {
    return '<p>Brak hipotez wspólnego operatora — narzędzie nie znalazło przesłanek, że różne konta obsługuje ten sam operator.</p>';
  }
  return inference(`<p>Na ile dwa <strong>konkretne konta</strong> może obsługiwać ten sam operator. To przesłanki wspólnego operatora — nie ustalenie tożsamości:
      za kontami może stać jedna osoba, osoby bliskie albo osoba podstawiona. Hipoteza nie staje się faktem bez decyzji analityka albo dowodu kryptograficznego.</p>
    ${hypotheses
      .map((item) => {
        const components = item.indicator?.components ?? [];
        const supports = components.filter((component) => component.direction !== 'contradicts');
        const contradicts = components.filter((component) => component.direction === 'contradicts');
        return `<div class="zrodlo">
          <h4>${esc(item.accountLabels?.[0] ?? item.accounts[0])} ↔ ${esc(item.accountLabels?.[1] ?? item.accounts[1])}</h4>
          ${indicatorHead(item.indicator)}
          <p><strong>Status:</strong> ${esc(HYPOTHESIS_LABEL[item.status] ?? item.status)}.${
            item.personas ? ` Deklarowane persony kont: „${esc(item.personas[0])}” i „${esc(item.personas[1])}”.` : ''
          }</p>
          <p>${esc(item.statement)}</p>
          ${(item.path ?? []).length > 0 ? `<p><strong>Ścieżka odkrycia:</strong> ${item.path.map((step) => esc(step)).join(' → ')}</p>` : ''}
          <p>Składniki potwierdzające:</p>
          ${supports.length > 0 ? renderComponents(supports) : '<p>Brak składników potwierdzających.</p>'}
          <p>Składniki przeczące (kontrdowody):</p>
          ${contradicts.length > 0 ? renderComponents(contradicts) : '<p>Nie stwierdzono kontrdowodów w przeszukanych źródłach — to nie wyklucza ich istnienia.</p>'}
          ${
            item.decision
              ? `<p><strong>Decyzja analityka:</strong> ${item.decision.decision === 'confirmed' ? 'potwierdzenie' : 'odrzucenie'} — ${dateTime(item.decision.decidedAt)}, ${esc(item.decision.author)}${item.decision.note ? `: ${esc(item.decision.note)}` : ''}.</p>`
              : ''
          }
          ${limitationList(item.indicator?.limitations)}
        </div>`;
      })
      .join('')}
    ${
      blocked.length > 0
        ? `<h4>Połączenia kont, których nie wykonano</h4>
          <p>Wiązania przekraczały próg łączenia, ale narzędzie ich nie zastosowało — z podanego powodu.</p>
          <table><tr><th>Konta</th><th class="liczba">Waga wiązania</th><th>Powód zablokowania</th></tr>
          ${blocked
            .map(
              (merge) => `<tr><td class="mono">${esc(merge.profileIds[0])}<br>${esc(merge.profileIds[1])}</td>
                <td class="liczba">${esc(merge.weight)}</td><td>${esc(merge.reason)}</td></tr>`,
            )
            .join('')}</table>`
        : ''
    }`);
}

const STAGE_LABEL: Record<string, string> = CASH_OUT_STAGE_LABEL;
const STAGES = Object.keys(STAGE_LABEL);

function renderCashOutAssessment(item: CashOutAssessment): string {
  const position = STAGES.indexOf(item.stage) + 1;
  const txids = item.txids ?? [];
  return `<div class="zrodlo">
    <h4>${item.origin === 'web' ? 'Publikacje kont podmiotu (Web2)' : `<span class="mono">${esc(item.address)}</span>`}${item.serviceName ? ` → ${esc(item.serviceName)}` : ''}</h4>
    ${indicatorHead(item.indicator)}
    <p><strong>Szczebel drabiny dowodowej:</strong> ${position > 0 ? `${position} z ${STAGES.length} — ` : ''}${esc(STAGE_LABEL[item.stage] ?? item.stage)}.
      Status: ${esc(CLAIM_LABEL[item.status] ?? item.status)}.${item.origin === 'web' ? '' : ` Sieć: ${esc(item.network)}.`}${
        item.amount !== undefined ? ` Kwota: ${esc(formatAmount(item.amount))} ${esc(item.asset ?? '')}${item.valuePln !== undefined ? ` (szacunkowo ${esc(formatPln(item.valuePln))})` : ''}.` : ''
      }</p>
    <p>${esc(item.statement)}</p>
    ${item.why ? `<p><strong>Dlaczego to oznaka wypłaty:</strong> ${esc(item.why)}</p>` : ''}
    ${item.confirm ? `<p><strong>Co potwierdzi wypłatę:</strong> ${esc(item.confirm.text)}</p>` : ''}
    ${item.offramp ? `<p class="meta">Rodzaj usługi: ${esc(item.offramp.label)}${item.offramp.registry.length > 0 ? `; ${esc(item.offramp.registry.join('; '))}` : ''}.</p>` : ''}
    ${
      txids.length > 0
        ? `<p class="meta">Transakcje: ${txids.slice(0, MAX_TXIDS).map((txid) => `<span class="mono">${esc(txid)}</span>`).join(', ')}${txids.length > MAX_TXIDS ? ` oraz ${txids.length - MAX_TXIDS} dalszych (pełna lista w pakiecie report.json)` : ''}.</p>`
        : ''
    }
    ${renderComponents(item.indicator?.components ?? [])}
    ${limitationList(item.indicator?.limitations)}
  </div>`;
}

function renderCashOutSignals(indicators: InvestigationIndicators | undefined): string {
  const items = indicators?.cashOut ?? [];
  if (items.length === 0) return '<p>Brak sygnałów wyjścia do walut tradycyjnych w pobranych danych blockchain (albo teczka nie zawiera wskaźników).</p>';
  return inference(`<p>Drabina dowodowa wyjścia do walut tradycyjnych — każdy szczebel wymaga więcej niż poprzedni:
      ${STAGES.map((stage, index) => `${index + 1}. ${esc(STAGE_LABEL[stage])}`).join('; ')}.
      Sam blockchain nie pokazuje wypłaty na rachunek — najwyższy szczebel wymaga dokumentu spoza blockchaina.</p>
    ${items.map(renderCashOutAssessment).join('')}`);
}

/** Trzy sekcje raportu ze wskaźnikami. Pola czytane obronnie: starsze teczki nie mają `indicators`. */
export function renderIndicatorSections(indicators: InvestigationIndicators | undefined, persons: PersonCandidate[]): string {
  return `<h2>Wskaźnik A — konto → portfel</h2>
${renderAccountWallet(indicators)}

<h2>Wskaźnik B — hipotezy wspólnego operatora</h2>
${renderCommonOperator(indicators, persons)}

<h2>Wskaźnik C — sygnały wyjścia do walut tradycyjnych</h2>
${renderCashOutSignals(indicators)}`;
}
