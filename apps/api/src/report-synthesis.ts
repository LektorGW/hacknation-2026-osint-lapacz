// Synteza raportu: pierwsza strona, którą analityk przeczyta w minutę — kto, jaki adres,
// dokąd poszły pieniądze, jakie ryzyka i co zrobić dalej. Szczegóły są w załącznikach.
// Każda pozycja ma znacznik warstwy (fakt / obliczenie / wniosek / dokument spoza OSINT).

import type { DossierView } from './dossier.ts';
import { formatPln as pln, shortAddress as short } from './format.ts';
import { PRIORITY_RULES } from './priority.ts';
import { esc } from './report-html.ts';

export type RiskLevel = 'krytyczne' | 'wysokie' | 'uwaga' | 'informacja';

export interface RiskItem {
  level: RiskLevel;
  text: string;
  /** `fact` — wpis na liście lub etykieta adresu; `inference` — hipoteza do sprawdzenia. */
  layer: 'fact' | 'inference';
}

const LEVEL_ORDER: RiskLevel[] = ['krytyczne', 'wysokie', 'uwaga', 'informacja'];

/** Alerty ryzyka z teczki — ta sama logika wag co w zakładce „Alerty ryzyka” interfejsu (w skrócie). */
export function collectRisks(dossier: DossierView): RiskItem[] {
  const risks: RiskItem[] = [];
  const badges = Object.values(dossier.riskLists ?? {});
  const sanctions = badges.filter((badge) => badge.badge === 'lista sankcyjna' && badge.confidence === 'strong');
  if (sanctions.length > 0) risks.push({ level: 'krytyczne', layer: 'fact', text: `Trafienie na liście sankcyjnej (${sanctions.length})` });
  const knf = badges.filter((badge) => badge.badge === 'ostrzeżenie KNF');
  if (knf.length > 0) risks.push({ level: 'wysokie', layer: knf.some((badge) => badge.status === 'source_fact') ? 'fact' : 'inference', text: `Wpis na liście ostrzeżeń KNF (${knf.length})` });

  const mixer = dossier.mixerExposure;
  if (mixer?.level === 'confirmed') risks.push({ level: 'krytyczne', layer: 'fact', text: `Środki przeszły przez mikser${mixer.mixers.length ? ` (${mixer.mixers.join(', ')})` : ''}` });
  else if (mixer?.level === 'possible') risks.push({ level: 'uwaga', layer: 'inference', text: 'Możliwy udział w CoinJoin lub pośrednio w mikserze' });

  const scam = dossier.scamWarnings;
  if (scam?.level === 'strong') risks.push({ level: 'wysokie', layer: 'inference', text: 'Silne ostrzeżenie o możliwym oszustwie' });
  else if (scam?.level === 'reports') risks.push({ level: 'uwaga', layer: 'inference', text: 'Zgłoszenia możliwego oszustwa' });
  if ((scam?.poisoning.length ?? 0) > 0) risks.push({ level: 'uwaga', layer: 'inference', text: `Możliwe zatruwanie adresu (${scam!.poisoning.length})` });

  if (dossier.seizures.length > 0) risks.push({ level: 'wysokie', layer: 'fact', text: `Przekazania na adres organu państwa — zajęcie środków (${dossier.seizures.length})` });
  const sanctionedFunding = dossier.fundingSources.filter((item) => item.category === 'sanctioned');
  const incidentFunding = dossier.fundingSources.filter((item) => item.category === 'incident');
  // Przelew wprost to fakt z blockchaina; ścieżka przez adres pośredni (heurystyka) to hipoteza.
  const fundingLayer = (items: typeof sanctionedFunding): RiskItem['layer'] => (items.every((item) => item.hops <= 1) ? 'fact' : 'inference');
  if (sanctionedFunding.length > 0) risks.push({ level: 'krytyczne', layer: fundingLayer(sanctionedFunding), text: 'Środki pochodzą z adresu objętego sankcjami' });
  if (incidentFunding.length > 0) risks.push({ level: 'wysokie', layer: fundingLayer(incidentFunding), text: 'Środki pochodzą z adresu oznaczonego jako incydent (np. kradzież)' });

  const business = dossier.indicators?.businessActivity?.indicator;
  if (business && business.score >= 50) risks.push({ level: 'uwaga', layer: 'inference', text: `Sygnały działalności gospodarczej: ${business.score} · ${business.level}` });

  if (dossier.partial) risks.push({ level: 'informacja', layer: 'fact', text: 'Analiza przerwana limitem czasu — wynik częściowy' });
  if (dossier.sourceErrors.length > 0) risks.push({ level: 'informacja', layer: 'fact', text: `${dossier.sourceErrors.length} źródeł nie odpowiedziało` });
  return risks.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}

const TAG: Record<RiskItem['layer'] | 'calc' | 'doc', [string, string]> = {
  fact: ['fakt', 'fakt'],
  inference: ['wniosek', 'hipoteza'],
  calc: ['obliczenie', 'obliczenie'],
  doc: ['dokument', 'dokument spoza OSINT'],
};
const tag = (kind: keyof typeof TAG) => `<span class="znacznik ${TAG[kind][0]}">${TAG[kind][1]}</span>`;

function nextSteps(dossier: DossierView): string[] {
  const steps: string[] = [];
  const replied = new Set((dossier.serviceReplies ?? []).filter((reply) => !reply.withdrawn).map((reply) => reply.serviceName));
  // Miksery i protokoły DeFi nie prowadzą kont klientów — zapytanie o właściciela kierujemy tylko do usług z KYC.
  const toAsk = dossier.serviceLinks.filter((link) => link.transfersOut > 0 && !replied.has(link.name) && link.kind !== 'mixer' && link.kind !== 'defi').slice(0, 3);
  if (toAsk.length > 0) steps.push(`Wyślij zapytanie o właściciela konta i wypłaty do: ${toAsk.map((link) => link.name).join(', ')} (gotowe dane w rozdziale „Powiązania z giełdami”).`);
  const hypotheses = dossier.linkedIdentities.filter((identity) => identity.decision !== 'rejected' && (identity as { status?: string }).status !== 'confirmed');
  if (hypotheses.length > 0) steps.push(`Rozstrzygnij ${hypotheses.length === 1 ? 'powiązaną tożsamość' : `${hypotheses.length} powiązane tożsamości`}: ${hypotheses.slice(0, 3).map((identity) => `„${identity.displayName}”`).join(', ')}.`);
  if (dossier.unconfirmedAddresses.length > 0) steps.push(`Potwierdź albo odrzuć ${dossier.unconfirmedAddresses.length} ${dossier.unconfirmedAddresses.length === 1 ? 'adres' : 'adresów'} do potwierdzenia.`);
  for (const explanation of dossier.explanations) {
    if (steps.length >= 4) break;
    if (explanation.suggestions[0]) steps.push(explanation.suggestions[0]);
  }
  return steps.slice(0, 4);
}

/** Pierwsza strona raportu — synteza w jednym widoku. */
export function renderSynthesis(dossier: DossierView): string {
  const person = dossier.persons[0];
  // Ta sama kwalifikacja co w sumach teczki (priority.ts): próg Wskaźnika Pewności albo adres podany przez analityka.
  const analystAddresses = new Set(dossier.subject.identifiers.filter((item) => item.origin === 'analyst').map((item) => item.identifier.value.toLowerCase()));
  const active = dossier.findings.filter((finding) => !finding.confidence.excluded);
  const accepted = active.filter((finding) => finding.confidence.score >= PRIORITY_RULES.linkedMinScore || analystAddresses.has(finding.address.toLowerCase()));
  const weak = active.length - accepted.length;
  const rejected = dossier.findings.length - active.length;
  const best = [...accepted].sort((a, b) => b.confidence.score - a.confidence.score)[0];
  const services = [...dossier.serviceLinks].filter((link) => link.transfersOut > 0 || (link.outPln ?? 0) > 0).sort((a, b) => (b.outPln ?? 0) - (a.outPln ?? 0));
  const proof = dossier.cashOutProof[0];
  const replies = (dossier.serviceReplies ?? []).filter((reply) => !reply.withdrawn);
  const fiatDocumented = replies.some((reply) => reply.fiatExit?.documented);
  const confirmedByReply = replies.some((reply) => reply.identity?.outcome === 'confirmed');
  const risks = collectRisks(dossier);
  const worst = risks[0]?.level;
  const steps = nextSteps(dossier);

  const who = person?.fullName
    ? `<strong>${esc(person.fullName)}</strong> — ${person.status === 'confirmed' || confirmedByReply ? 'potwierdzona' : 'hipoteza do potwierdzenia'}, pewność ${person.probability}/100 ${confirmedByReply ? tag('doc') : person.status === 'confirmed' ? tag('fact') : tag('inference')}`
    : `Nie ustalono imienia i nazwiska ${tag('inference')}`;
  const publicFigure = dossier.publicFigure?.label ? dossier.publicFigure : undefined;
  const network = dossier.organizationNetwork;

  const addresses = accepted.length === 0
    ? `Brak adresów przypisanych podmiotowi${weak ? ` · słabe ślady poniżej progu ${PRIORITY_RULES.linkedMinScore}%: ${weak}` : ''}${rejected ? ` · odrzucone: ${rejected}` : ''}`
    : `<strong>${accepted.length}</strong> ${accepted.length === 1 ? 'adres powiązany' : 'adresy powiązane'}${best ? ` · najmocniejszy <span class="mono">${esc(short(best.address))}</span> — Wskaźnik Pewności ${best.confidence.score}% (${esc(best.confidence.tier)}) ${tag('calc')}` : ''}${weak ? `<br>Słabe ślady poniżej progu ${PRIORITY_RULES.linkedMinScore}%: ${weak}` : ''}${rejected ? `<br>Odrzucone (giełdy, kontrakty, adresy współdzielone): ${rejected}` : ''}${dossier.unconfirmedAddresses.length ? ` · do potwierdzenia: ${dossier.unconfirmedAddresses.length}` : ''}`;

  const money = services.length === 0 && !proof
    ? 'Nie stwierdzono przekazań do giełd ani usług wymiany'
    : `${dossier.totals.cashOutPlnTotal > 0 ? `<strong>ok. ${esc(pln(dossier.totals.cashOutPlnTotal))}</strong> szacunkowo do usług wymiany ${tag('calc')}<br>` : ''}${
        services.length ? `Usługi: ${services.slice(0, 4).map((link) => `${esc(link.name)}${link.outPln ? ` (${esc(pln(link.outPln))})` : ''}`).join(', ')}${services.length > 4 ? ` i ${services.length - 4} inne` : ''} ${tag('fact')}<br>` : ''
      }${proof ? `Najmocniejszy dowód spieniężenia: łączna pewność ${proof.combinedConfidence}% (${esc(proof.tier)}) ${tag('calc')}<br>` : ''}Wypłata na rachunek bankowy: ${fiatDocumented ? `udokumentowana odpowiedzią usługi ${tag('doc')}` : `niepotwierdzona — potwierdza ją tylko usługa ${tag('inference')}`}`;

  const riskHtml = risks.length === 0
    ? '<span class="ryzyko brak">brak alertów w danych sprawy</span>'
    : `<span class="ryzyko ${worst}">najwyższy poziom: ${worst}</span><ul>${risks.slice(0, 6).map((item) => `<li><span class="poziom ${item.level}">${item.level}</span> ${esc(item.text)} ${tag(item.layer)}</li>`).join('')}${risks.length > 6 ? `<li class="meta">i ${risks.length - 6} więcej — rozdział „Alerty ryzyka”.</li>` : ''}</ul>`;

  return `<section class="synteza" id="synteza">
  <h2>Synteza sprawy</h2>
  ${dossier.partial ? '<p class="alert-czesciowy"><strong>Wynik częściowy:</strong> analiza została przerwana limitem czasu.</p>' : ''}
  <table class="synteza-tab">
    <tr><th>Kto</th><td>${who}${publicFigure ? `<br>Możliwa osoba publiczna: ${esc(publicFigure.label ?? '')} (Wikidata) ${tag('inference')}` : ''}${
      network && (network.organizations.length || network.persons.length) ? `<br>Siatka powiązań: ${network.organizations.length} organizacji, ${network.persons.length} osób ${tag('inference')}` : ''
    }${dossier.linkedIdentities.length ? `<br>Powiązane tożsamości: ${dossier.linkedIdentities.length} ${tag('inference')}` : ''}</td></tr>
    <tr><th>Adresy krypto</th><td>${addresses}</td></tr>
    <tr><th>Pieniądze</th><td>${money}</td></tr>
    <tr><th>Ryzyko</th><td>${riskHtml}</td></tr>
    <tr><th>Priorytet</th><td><strong>${dossier.totals.priority}/100</strong> — porządkuje kolejkę spraw, nie ocenia podmiotu ${tag('calc')}</td></tr>
  </table>
  ${steps.length ? `<h3>Co zrobić dalej</h3><ol class="kroki">${steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}
  <p class="legenda">Znaczniki: ${tag('fact')} wprost ze źródła publicznego lub blockchaina · ${tag('calc')} policzone jawnym wzorem · ${tag('inference')} wymaga potwierdzenia przez analityka · ${tag('doc')} odpowiedź usługi wprowadzona przez analityka.</p>
</section>`;
}

export const SYNTHESIS_STYLE = `
  .synteza { border: 2px solid #1a1a1a; padding: 5mm 6mm; margin: 4mm 0 6mm; break-inside: avoid; }
  .synteza h2 { margin-top: 0; border: 0; }
  .synteza h3 { font-size: 12pt; margin: 4mm 0 1mm; }
  .synteza-tab { width: 100%; border-collapse: collapse; }
  .synteza-tab th { width: 30mm; text-align: left; vertical-align: top; padding: 2mm 3mm 2mm 0; font-size: 10.5pt; color: #333; border-bottom: 1px solid #ddd; }
  .synteza-tab td { padding: 2mm 0; border-bottom: 1px solid #ddd; vertical-align: top; }
  .synteza-tab ul { margin: 1mm 0 0; padding-left: 5mm; }
  .synteza .kroki { margin: 0; padding-left: 6mm; }
  .synteza .legenda { font-size: 9pt; color: #555; margin: 3mm 0 0; }
  .ryzyko, .poziom { display: inline-block; font-weight: bold; font-size: 9pt; padding: 0 2mm; border-radius: 2mm; border: 1px solid #999; text-transform: uppercase; }
  .ryzyko.krytyczne, .poziom.krytyczne { background: #fde2e2; border-color: #b42318; color: #7a1010; }
  .ryzyko.wysokie, .poziom.wysokie { background: #fdebd8; border-color: #c4561a; color: #7a3410; }
  .ryzyko.uwaga, .poziom.uwaga { background: #fdf4d6; border-color: #b98900; color: #5c4400; }
  .ryzyko.informacja, .poziom.informacja { background: #e3edfb; border-color: #3b6fc2; color: #1d3f7a; }
  .ryzyko.brak { background: #f0f0f0; color: #444; text-transform: none; }
  .alert-czesciowy { background: #fdf4d6; padding: 2mm 3mm; }
  .spis { columns: 2; font-size: 10pt; margin: 0 0 6mm; padding-left: 6mm; }
  .spis li { break-inside: avoid; }
  .czesc { margin-top: 8mm; font-size: 15pt; text-transform: uppercase; letter-spacing: .5px; border-bottom: 3px solid #1a1a1a; padding-bottom: 1mm; }
  .czesc.zalaczniki { break-before: page; }
  .zalacznik-wstep { color: #444; font-size: 10pt; }
  .lista-zrodel { font-size: 9.5pt; color: #333; }
`;
