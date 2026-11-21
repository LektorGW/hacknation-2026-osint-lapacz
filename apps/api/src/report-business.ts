// Sekcja raportu „Wskaźnik D — sygnały działalności gospodarczej”: składniki, obrót według roku podatkowego,
// wyniki sprawdzenia rejestrów, ścieżka „podmiot zarejestrowany” i lista sprawdzeń po stronie KAS.
// Wszystkie dane ze źródeł przechodzą przez `esc`.

import type { BusinessActivityAssessment } from '@olcys/core';
import { formatPln } from './format.ts';
import { calc, esc, fact, inference, link } from './report-html.ts';
import { renderComponents } from './report-proof.ts';

const CHECK_STATUS: Record<string, string> = {
  found: 'znaleziono wpis',
  not_found: 'szukano — brak wpisu',
  not_checked: 'nie sprawdzano',
  unavailable: 'źródło nie odpowiedziało',
};

const BASIS: Record<string, string> = { number: 'numer (NIP/KRS)', domain: 'domena', name: 'nazwa lub nick (zawodne)', none: '—' };

const head = (score: number, level: string) => `<p><span class="wynik">${esc(score)}/100</span> &nbsp; <span class="poziom">${esc(level)}</span> &nbsp; (hipoteza)</p>`;
const list = (items: string[]) => (items.length > 0 ? `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '');

/** Sekcja raportu; starsze teczki (bez wskaźnika D) dostają jedno zdanie wyjaśnienia. */
export function renderBusinessSection(assessment: BusinessActivityAssessment | undefined): string {
  if (!assessment) return '<h2>Wskaźnik D — sygnały działalności gospodarczej</h2>\n<p>Teczka nie zawiera wskaźnika D (analiza sprzed jego wprowadzenia) — ponów analizę, żeby go wyliczyć.</p>';
  const indicator = assessment.indicator;
  const turnover =
    assessment.turnover.length === 0
      ? '<p>Brak wpływów od kontrahentów spoza usług na adresy przypisane podmiotowi.</p>'
      : `<table>
          <tr><th>Rok podatkowy</th><th class="liczba">Wpływy</th><th class="liczba">Wpłacający</th><th class="liczba">Obrót (wpływy) PLN</th><th class="liczba">Wycenione</th></tr>
          ${assessment.turnover
            .map(
              (year) => `<tr><td>${esc(year.year)}</td><td class="liczba">${year.inflows}</td><td class="liczba">${year.payers}</td>
                <td class="liczba">${year.valued > 0 ? esc(formatPln(year.valuePln)) : '—'}</td>
                <td class="liczba">${year.valued}/${year.inflows}${year.sampleRated > 0 ? ` (kurs przykładowy: ${year.sampleRated})` : ''}</td></tr>`,
            )
            .join('')}
        </table>
        <p class="meta">Obrót to suma wpływów po kursie z istniejących wycen tego samego aktywa — <strong>nie dochód ani przychód podatkowy</strong>. Rok według czasu polskiego.</p>`;
  const registry = `<table>
      <tr><th>Rejestr</th><th>Wynik</th><th>Podstawa wyszukiwania</th><th>Co sprawdzono</th><th>Wpisy</th><th>Uwagi</th></tr>
      ${assessment.registryCheck
        .map(
          (check) => `<tr><td>${esc(check.registry)}<br><code>${esc(check.connectorId)}</code></td><td>${esc(CHECK_STATUS[check.status] ?? check.status)}</td>
            <td>${esc(BASIS[check.basis] ?? check.basis)}</td><td>${esc(check.queries.join(', ') || '—')}</td>
            <td>${check.records.length > 0 ? check.records.map((record) => `${esc(record.name)}${record.identifier ? ` (${esc(record.identifier)})` : ''} — ${link(record.url)}${record.nameOnly ? ' <em>(tylko nazwa)</em>' : ''}`).join('<br>') : '—'}</td>
            <td>${esc(check.note)}</td></tr>`,
        )
        .join('')}
    </table>`;
  const registered = assessment.registered;
  const network = assessment.network ?? [];
  return `<h2>Wskaźnik D — sygnały działalności gospodarczej</h2>
${inference(`<p>Sygnały, że podmiot prowadzi działalność gospodarczą, która może nie być zgłoszona. Ocena jest <strong>hipotezą</strong>: narzędzie nie zna statusu podatkowego —
    rozstrzygają wyłącznie systemy KAS (zeznania, CEIDG, JPK).</p>
  <h3>Ścieżka 1: działalność możliwie niezgłoszona</h3>
  ${head(indicator.score, indicator.level)}
  <p>${esc(assessment.statement)}</p>
  ${renderComponents(indicator.components)}
  ${indicator.limitations.length > 0 ? `<p>Ograniczenia wskaźnika:</p>${list(indicator.limitations)}` : ''}`)}
${calc(`<h4>Obrót według roku podatkowego</h4>${turnover}`)}
${fact(`<h4>Sprawdzenie rejestrów publicznych</h4>${registry}`)}
${
  registered
    ? inference(`<h3>Ścieżka 2: podmiot zarejestrowany — weryfikacja zgodności obrotu i ryzyko prania pieniędzy</h3>
        ${head(registered.indicator.score, registered.indicator.level)}
        <p>${esc(registered.statement)}</p>
        <table><tr><th>Podmiot</th><th>Status VAT</th><th>Rejestracja / wykreślenie</th><th>PKD</th><th>Osoby (wg rejestru)</th><th class="liczba">Rachunki w wykazie</th><th>Źródła</th></tr>
        ${registered.entities
          .map(
            (entity) => `<tr><td>${esc(entity.name)}${entity.nip ? `<br>NIP ${esc(entity.nip)}` : ''}${entity.krs ? `<br>KRS ${esc(entity.krs)}` : ''}${entity.capital ? `<br>kapitał ${esc(entity.capital)}` : ''}</td>
              <td>${esc(entity.vatStatus ?? '—')}</td><td>${esc(entity.registrationDate ?? '—')}${entity.removalDate ? ` / ${esc(entity.removalDate)}` : ''}</td>
              <td>${esc(entity.pkd.map((item) => `${item.code}${item.description ? ` ${item.description}` : ''}`).join('; ') || '—')}</td>
              <td>${esc(entity.people.slice(0, 5).join('; ') || '—')}</td><td class="liczba">${entity.whitelistAccounts.length}</td>
              <td>${entity.sources.map((source) => link(source.url, source.registry)).join('<br>')}</td></tr>`,
          )
          .join('')}</table>
        ${renderComponents(registered.indicator.components)}
        ${registered.indicator.limitations.length > 0 ? `<p>Ograniczenia:</p>${list(registered.indicator.limitations)}` : ''}
        <h4>Co sprawdzić (podmiot zarejestrowany)</h4>${list(registered.whatToVerify)}`)
    : ''
}
${
  network.length > 0
    ? inference(`<h4>W siatce: ${network.length} ${network.length === 1 ? 'podmiot' : 'podmiotów'} z sygnałami działalności</h4>
        <table><tr><th>Węzeł</th><th class="liczba">Wskaźnik D</th><th>Reguły</th><th>Ścieżka do podmiotu (najsłabsze ogniwo)</th></tr>
        ${network
          .map(
            (item) => `<tr><td>${esc(item.label)}<br><span class="meta">${esc(item.kind)}</span></td><td class="liczba">${item.score}/100<br>${esc(item.level)}</td>
              <td>${esc(item.rules.join(', '))}</td><td>${item.path ? `${esc(item.path.labels.join(' → '))}<br><span class="meta">${esc(item.path.summary)}; siła ${esc(item.path.strength)}</span>` : 'brak ścieżki do podmiotu'}</td></tr>`,
          )
          .join('')}</table>
        <p class="meta">Powiązanie w siatce nie przenosi sygnałów na podmiot sprawy; ścieżka z hipotezą to najwyżej „ścieżka poszlakowa”.</p>`)
    : ''
}
${inference(`<h4>Co sprawdzić po stronie KAS</h4>${list(assessment.whatToVerify)}<p class="meta">Zalecenia sprawdzeń — nie twierdzenia o statusie podatkowym.</p>`)}`;
}
