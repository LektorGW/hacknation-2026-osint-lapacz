// Sekcje raportu: „Czyj to adres — organizacja”, „Siatka adresu” i „Organizacje i osoby odpowiedzialne (rejestry
// publiczne)”. Treści z internetu i rejestrów przechodzą przez `esc`.

import type { DossierView } from './dossier.ts';
import { formatAmount, roundPln, shortAddress } from './format.ts';
import { calc, esc, fact, inference, link } from './report-html.ts';

export function renderOrganizationSections(dossier: DossierView): string {
  const parts: string[] = [];
  const organizations = dossier.organizations ?? [];
  const addressNetworks = dossier.addressNetwork ?? [];
  if (organizations.length > 0) {
    parts.push(`<h2>Czyj to adres — organizacja (beneficjent zbiórki)</h2>
${organizations
  .map((org) =>
    inference(`<p><strong>${esc(org.name)}</strong>${org.domain ? ` (${esc(org.domain)})` : ''} — ${esc(org.role)}, wskaźnik ${org.indicator}/100, status: hipoteza.</p>
<p>${esc(org.statement)}</p>
<table><tr><th>Reguła</th><th class="liczba">Punkty</th><th>Uzasadnienie</th></tr>
${org.components.map((item) => `<tr><td class="mono">${esc(item.rule)}</td><td class="liczba">${item.delta > 0 ? '+' : ''}${item.delta}</td><td>${esc(item.explanation)}</td></tr>`).join('')}
</table>
<h4>Publikacje wskazujące organizację</h4>
<ul>${org.evidence.map((item) => `<li>${link(item.url)}${item.author ? ` — autor ${esc(item.author)}` : ''}: „${esc(item.quote.slice(0, 220))}”</li>`).join('')}</ul>
${org.officialSite ? `<p>Strona organizacji: ${link(org.officialSite.url)} — ${esc(org.officialSite.note)}</p>` : ''}
<ul>${org.limitations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`),
  )
  .join('')}`);
  }
  if (addressNetworks.length > 0) {
    parts.push(`<h2>Siatka adresu (wpływy i wypływy zbiorczo)</h2>
${addressNetworks
  .map((network) =>
    calc(`<p class="mono">${esc(network.address)}</p>
<ul>${network.statements.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
<h4>Najwięksi nadawcy (adresy, nie osoby)</h4>
<table><tr><th>Adres</th><th class="liczba">Przelewy</th><th class="liczba">Kwota</th><th>Usługa</th></tr>
${network.incoming.top.map((item) => `<tr><td class="mono">${esc(shortAddress(item.address))}</td><td class="liczba">${item.transfers}</td><td class="liczba">${esc(formatAmount(item.amount))} ${esc(item.asset)}</td><td>${esc(item.service ?? 'bez etykiety')}</td></tr>`).join('')}
</table>
<h4>Punkty zapytania</h4>
<ul>${[...network.incoming.inquiryPoints, ...network.outgoing.inquiryPoints].map((point) => `<li>${esc(point.note)}${point.valuePln !== undefined ? ` (${esc(roundPln(point.valuePln))})` : ''}</li>`).join('') || '<li>brak przelewów z usługami z etykietą</li>'}</ul>
<p>${esc(network.privacyNote)}</p>`),
  )
  .join('')}`);
  }
  const network = dossier.organizationNetwork;
  if (network && network.organizations.length > 0) {
    const orgName = (id: string) => network.organizations.find((org) => org.id === id)?.name ?? id;
    parts.push(`<h2>Organizacje i osoby odpowiedzialne (rejestry publiczne)</h2>
${fact(`<p>Osoba pełniąca rolę w organizacji NIE jest właścicielem adresu — to osoba odpowiedzialna za organizację według rejestru publicznego. Powiązanie adresu z organizacją pozostaje hipotezą.</p>
<table><tr><th>Organizacja</th><th>Rozpoznanie</th><th>Identyfikatory</th><th>Źródło</th></tr>
${network.organizations
  .map(
    (org) => `<tr><td>${esc(org.name)}</td><td>${esc(org.matchNote)}</td><td>${esc(Object.entries(org.identifiers).map(([key, value]) => `${key}: ${value}`).join(', '))}</td><td>${org.sources.slice(0, 2).map((source) => `${link(source.url, source.registry)} (${esc(source.retrievedAt)})`).join('<br>')}</td></tr>`,
  )
  .join('')}
</table>
<h4>Osoby w rolach</h4>
<table><tr><th>Osoba</th><th>Rola</th><th>Organizacja</th><th>Okres</th><th>Źródło</th></tr>
${network.persons
  .map(
    (person) => `<tr><td>${esc(person.name)}${person.masked ? ' <span class="meta">(zamaskowane przez rejestr)</span>' : ''}</td><td>${esc(person.role)}</td><td>${esc(orgName(person.organizationId))}</td><td>${esc([person.from, person.to].filter(Boolean).join(' – ') || '—')}</td><td>${link(person.source.url, person.source.registry)}</td></tr>`,
  )
  .join('')}
</table>
${network.relations.length > 0 ? `<h4>Relacje między organizacjami</h4><ul>${network.relations.map((relation) => `<li>${esc(relation.explanation)} [${relation.status === 'computed' ? 'obliczenie' : 'fakt z rejestru'}]</li>`).join('')}</ul>` : ''}
${network.organizations.some((org) => org.weakCandidates?.length) ? `<h4>Wpisy zgodne tylko nazwą (niescalone)</h4><ul>${network.organizations.flatMap((org) => (org.weakCandidates ?? []).map((item) => `<li>${link(item.url, `${item.registry}: ${item.name} (${item.identifier})`)} — ${esc(item.note)}</li>`)).join('')}</ul>` : ''}
<h4>Granice rozszerzania</h4><ul>${network.stops.map((stop) => `<li>${esc(stop.detail)}</li>`).join('')}</ul>
<ul>${network.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>`)}`);
  }
  return parts.join('\n');
}
