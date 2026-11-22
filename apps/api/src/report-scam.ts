// Sekcja raportu „Ostrzeżenia o możliwym oszustwie”: zdanie, publikacje ostrzegające (z odnośnikami),
// trafienia zbiorów ostrzeżeń, wzorzec rozdania, zatruwanie adresu, skutki dla interpretacji i ograniczenia.
// Pusta, gdy brak ostrzeżeń.

import { shortAddress } from './format.ts';
import { NETWORK_LABEL, dateTime, esc, fact, inference, link } from './report-html.ts';
import type { ScamWarnings } from './scam.ts';

const LEVEL_TEXT = { strong: 'silne ostrzeżenie', reports: 'są zgłoszenia', none: 'poniżej progu ostrzeżenia' } as const;
const BASIS_TEXT = { rule: 'reguła tekstowa', model: 'odczyt modelu językowego', 'rule+model': 'reguła tekstowa i odczyt modelu' } as const;

export function renderScamSection(warnings: ScamWarnings | undefined): string {
  if (!warnings || (warnings.addresses.every((item) => item.level === 'none') && warnings.poisoning.length === 0)) return '';
  const blocks = warnings.addresses
    .filter((item) => item.level !== 'none')
    .map((item) => {
      const publications = item.publications.length
        ? `<h4>Publikacje przy adresie</h4><table><tr><th>Publikacja</th><th>Rodzaj</th><th>Fragment</th></tr>${item.publications
            .map(
              (pub) => `<tr><td>${link(pub.url, pub.title ?? pub.url)}<br><span class="meta">${esc(pub.service)}${pub.author ? ` — „${esc(pub.author)}”` : ''}${pub.publishedAt ? `, ${dateTime(pub.publishedAt)}` : ''}; pochodzenie nr ${pub.origin + 1}</span></td>
              <td>${pub.kind === 'warning' ? 'ostrzeżenie przed adresem' : 'obietnica „rozdania”'}<br><span class="meta">${esc(BASIS_TEXT[pub.basis])}${pub.impersonates ? `; nazwa: „${esc(pub.impersonates)}”` : ''}</span></td>
              <td><blockquote>${esc(pub.quote)}</blockquote></td></tr>`,
            )
            .join('')}</table>`
        : '';
      const lists = item.listHits.length
        ? fact(`<h4>Publiczne zbiory ostrzeżeń (fakt o liście)</h4><ul>${item.listHits
            .map((hit) => `<li>${link(hit.url, hit.listLabel)} — „${esc(hit.comment || 'bez opisu')}”${hit.date ? ` (wpis z ${esc(hit.date)})` : ''}, migawka z ${esc(hit.retrievedAt.slice(0, 10))}, licencja ${esc(hit.licence)}. ${esc(hit.caveat)}</li>`)
            .join('')}</ul>`)
        : '';
      const domains = item.domainHits.length
        ? fact(`<h4>Domeny z listy phishingowej w publikacjach z adresem</h4><ul>${item.domainHits.map((hit) => `<li><span class="mono">${esc(hit.domain)}</span> — ${link(hit.url, hit.listLabel)} (wpis „${esc(hit.matched)}”).</li>`).join('')}</ul>`)
        : '';
      const components = `<table><tr><th>Reguła</th><th class="liczba">Waga</th><th>Źródło</th><th>Uzasadnienie</th></tr>${item.components
        .map((component) => `<tr><td class="mono">${esc(component.rule)}</td><td class="liczba">${component.weight}</td><td>${esc(component.source)}</td><td>${esc(component.explanation)}</td></tr>`)
        .join('')}</table>`;
      return `<h3><span class="mono">${esc(item.address)}</span> <span class="meta">(${esc(NETWORK_LABEL[item.network] ?? item.network)}; ${esc(LEVEL_TEXT[item.level])}, wynik ${item.score}/100)</span></h3>
${(item.listHits.length > 0 ? fact : inference)(`<p><strong>${esc(item.statement)}</strong></p>${components}`)}
${publications}
${lists}
${domains}
${item.chainPattern ? inference(`<p>${esc(item.chainPattern.explanation)}</p>`) : ''}
<p>${item.interpretation.map((text) => esc(text)).join(' ')}</p>
<p class="meta">${esc(item.action)}</p>
<p class="meta">${item.limitations.map((text) => esc(text)).join(' ')}</p>`;
    })
    .join('\n');
  const poisoning = warnings.poisoning.length
    ? inference(`<h4>Możliwe zatruwanie adresu (kontrahenci-podróbki)</h4><ul>${warnings.poisoning
        .map((item) => `<li>Adres sprawy ${esc(shortAddress(item.address))}: kontrahent <span class="mono">${esc(item.lookalike)}</span> naśladuje <span class="mono">${esc(item.genuine)}</span>. ${esc(item.explanation)}</li>`)
        .join('')}</ul>`)
    : '';
  return `<h2>Ostrzeżenia o możliwym oszustwie</h2>
<p>${esc(warnings.statement)}</p>
${blocks}
${poisoning}
<p class="meta">${warnings.limitations.map((text) => esc(text)).join(' ')}</p>`;
}
