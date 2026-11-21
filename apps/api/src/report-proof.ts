// Sekcja raportu „Dowód spieniężenia”: dla każdego ustalenia składniki łącznej pewności,
// tabela kroków ścieżki środków i lista tego, co może potwierdzić tylko usługa.

import { formatAmount, formatPln } from './format.ts';
import type { CashOutProof } from './proof.ts';
import { PROOF_RULES } from './proof.ts';
import { calc, dateTime, esc, fact, inference, link } from './report-html.ts';

const BASIS_LABEL: Record<CashOutProof['addressBasis'], string> = {
  published: 'adres opublikowany przez podmiot',
  analyst: 'adres podany przez analityka',
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
    <h3>Ustalenie ${number}: ${esc(proof.person?.fullName ?? 'osoba ze sprawy')} → ${esc(trail.serviceName)}</h3>
    <p>${esc(proof.statement)}</p>
    <p class="meta">Adres początkowy: <span class="mono">${esc(proof.address)}</span> — ${esc(BASIS_LABEL[proof.addressBasis])}${
      proof.cluster ? `; portfel ustalony od adresu <span class="mono">${esc(proof.cluster.seed)}</span> (${esc(proof.cluster.reason)})` : ''
    }.</p>
    ${score}${hops}${open}
  </section>`;
}

export function renderProofSection(proofs: CashOutProof[]): string {
  if (proofs.length === 0) {
    return '<p>Dane blockchain nie zawierają udokumentowanej ścieżki środków do usługi wymiany. Wskaźniki możliwych wypłat (pojedyncze przelewy) są opisane przy adresach i w sekcji o usługach.</p>';
  }
  return proofs.map((proof, index) => renderProof(proof, index + 1)).join('');
}
