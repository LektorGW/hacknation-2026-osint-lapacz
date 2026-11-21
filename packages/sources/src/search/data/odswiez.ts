// Odświeżenie migawek łącznika `rejestry-publiczne`: lista ostrzeżeń publicznych KNF (jedna strona HTML)
// i plik CSV tymczasowego rejestru MiCA (ESMA). Po jednym żądaniu do każdego źródła, z jawnym User-Agent.
// Uruchomienie ręczne:  node packages/sources/src/search/data/odswiez.ts
// Rejestr działalności w zakresie walut wirtualnych jest publikowany jako PDF — patrz rdww-z-pdf.py.

import { writeFileSync } from 'node:fs';
import { USER_AGENT } from '../../http.ts';
import { ESMA_CSV, ESMA_PAGE, KNF_PAGE, parseEsmaCasps, parseKnfWarnings } from '../registries.ts';
import type { CaspSnapshot, KnfSnapshot } from '../registries.ts';

async function download(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${new URL(url).host}: kod ${response.status}`);
  return response.text();
}

function save(name: string, snapshot: object, count: number, minimum: number): void {
  // Pusta lub podejrzanie krótka lista oznacza zmianę układu źródła — nie nadpisujemy dobrej migawki.
  if (count < minimum) throw new Error(`${name}: tylko ${count} wpisów (oczekiwano co najmniej ${minimum}) — migawka bez zmian`);
  writeFileSync(new URL(`./${name}`, import.meta.url), `${JSON.stringify(snapshot)}\n`);
  console.log(`${name}: zapisano ${count} wpisów.`);
}

const pobrano = new Date().toISOString();

const knf = parseKnfWarnings(await download(KNF_PAGE));
const knfSnapshot: KnfSnapshot = { zrodlo: 'Lista ostrzeżeń publicznych Komisji Nadzoru Finansowego', strona: KNF_PAGE, pobrano, wpisy: knf };
save('knf-ostrzezenia.json', knfSnapshot, knf.length, 100);

const casp = parseEsmaCasps(await download(ESMA_CSV));
const caspSnapshot: CaspSnapshot = {
  zrodlo: 'Tymczasowy rejestr MiCA — dostawcy usług w zakresie kryptoaktywów (ESMA)',
  strona: ESMA_PAGE,
  plik: ESMA_CSV,
  pobrano,
  wpisy: casp,
};
save('esma-casp.json', caspSnapshot, casp.length, 50);
