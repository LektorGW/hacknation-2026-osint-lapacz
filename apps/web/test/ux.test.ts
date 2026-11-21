import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLOSSARY, GLOSSARY_GROUPS, GLOSSARY_IDS, searchGlossary } from '../src/glossary.ts';
import { TOUR, availableSteps, isTourDone, markTourDone, resetTour } from '../src/tour.ts';
import { HINT_PREFIX, SCORE_KIND, clearFlags, groupKeyFindings, plural, readFlag, splitLead, summarySentence, tierWords, writeFlag } from '../src/ux.ts';

/** Pamięć zgodna z `Storage` — testy działają bez przeglądarki. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

test('słownik obejmuje żargon widoczny w teczce i ma krótkie definicje', () => {
  const required = [
    'wskaznik-pewnosci', 'osoba-adres', 'hipoteza-operatora', 'adres-wplat', 'portfel-powierniczy', 'smart-kontrakt', 'niezalezne-pochodzenie',
    'klaster-portfela', 'szczebel-drabiny', 'sha256', 'wynik-czesciowy', 'tryb-live', 'tryb-sandbox', 'tryb-demo',
  ];
  for (const id of required) assert.ok(GLOSSARY_IDS.includes(id as never), id);
  const groups = new Set(GLOSSARY_GROUPS.map((group) => group.id));
  for (const id of GLOSSARY_IDS) {
    const entry = GLOSSARY[id];
    assert.ok(groups.has(entry.group), id);
    assert.ok(/^[a-z0-9-]+$/.test(id), `identyfikator ${id} bez polskich znaków`);
    // Definicja ma być krótka: najwyżej dwa zdania i ok. 260 znaków.
    assert.ok(entry.short.length <= 260, `${id}: definicja za długa`);
  }
});

test('wyszukiwanie w słowniku ignoruje wielkość liter i polskie znaki', () => {
  assert.ok(searchGlossary('GIELDA').includes('adres-wplat'));
  assert.ok(searchGlossary('odcisk palca').includes('sha256'));
  assert.equal(searchGlossary('').length, GLOSSARY_IDS.length);
  assert.deepEqual(searchGlossary('zzzz-nie-ma'), []);
});

test('polska odmiana liczebników', () => {
  assert.equal(plural(1, 'adres', 'adresy', 'adresów'), 'adres');
  assert.equal(plural(2, 'adres', 'adresy', 'adresów'), 'adresy');
  assert.equal(plural(5, 'adres', 'adresy', 'adresów'), 'adresów');
  assert.equal(plural(12, 'adres', 'adresy', 'adresów'), 'adresów');
  assert.equal(plural(22, 'adres', 'adresy', 'adresów'), 'adresy');
  assert.equal(plural(0, 'adres', 'adresy', 'adresów'), 'adresów');
});

test('poziom wyniku słowami: progi zgodne z kolorami, wykluczenie zawsze „odrzucony”', () => {
  assert.equal(tierWords('publication', 90), 'bardzo mocne powiązanie');
  assert.equal(tierWords('publication', 60), 'mocne powiązanie');
  assert.equal(tierWords('joint', 55), 'umiarkowane powiązanie');
  assert.equal(tierWords('joint', 10), 'słabe powiązanie');
  assert.equal(tierWords('person', 85), 'bardzo prawdopodobne');
  assert.equal(tierWords('publication', 95, true), 'odrzucony');
  for (const kind of Object.values(SCORE_KIND)) assert.ok(GLOSSARY_IDS.includes(kind.glossary));
});

test('ustalenie dzieli się na krótki początek i dopowiedzenie — bez cięcia na skrótach', () => {
  const proof = splitLead('Udokumentowano 3 przekazania łącznie 1 BTC (ok. 353 tys. zł) z adresu bc1q43zhzv…u6wk2g98 do usługi Giełda Bursztyn — łączna pewność ustalenia 52%.');
  assert.equal(proof.lead, 'Udokumentowano 3 przekazania łącznie 1 BTC (ok. 353 tys. zł) z adresu bc1q43zhzv…u6wk2g98 do usługi Giełda Bursztyn');
  assert.equal(proof.rest, 'Łączna pewność ustalenia 52%.');

  const sentence = splitLead('Adres opublikowano na własnym profilu w serwisie gitpub. Drugie źródło potwierdza nick.');
  assert.equal(sentence.lead, 'Adres opublikowano na własnym profilu w serwisie gitpub.');
  assert.equal(sentence.rest, 'Drugie źródło potwierdza nick.');

  assert.deepEqual(splitLead('Krótkie zdanie.'), { lead: 'Krótkie zdanie.' });
  const long = splitLead('a '.repeat(120));
  assert.ok(long.lead.length <= 150 && long.joined && long.rest);

  // Bez końca zdania w zasięgu: nawias trafia do szczegółów.
  const bracket = splitLead(
    'Podmiot jest powiązany z usługą Giełda Bursztyn (giełda): 3 przelewy do usługi o szacunkowej wartości 353 tys. zł w latach 2024–2025 (fakt z blockchaina).',
  );
  assert.equal(bracket.lead, 'Podmiot jest powiązany z usługą Giełda Bursztyn (giełda): 3 przelewy do usługi o szacunkowej wartości 353 tys. zł w latach 2024–2025');
  assert.equal(bracket.rest, '(fakt z blockchaina).');

  // Myślnik wewnątrz nawiasu nie jest miejscem cięcia.
  const inner = splitLead(
    'Adres bc1q43zhzv…u6wk2g98 opublikowano na własnym profilu w serwisie gitpub.sandbox i w ogłoszeniu w serwisie targ.sandbox (Wskaźnik Pewności 90% — bardzo wysokie prawdopodobieństwo; łączne 55%).',
  );
  assert.equal(inner.lead, 'Adres bc1q43zhzv…u6wk2g98 opublikowano na własnym profilu w serwisie gitpub.sandbox i w ogłoszeniu w serwisie targ.sandbox');
});

test('ustalenia w grupach: fakty, obliczenia, wnioski i dokumenty spoza OSINT', () => {
  const groups = groupKeyFindings(
    [
      { text: 'A', layer: 'fact' },
      { text: 'B', layer: 'calculation' },
      { text: 'C', layer: 'inference' },
      { text: 'Odpowiedź usługi X', layer: 'fact' },
    ],
    (text) => text.startsWith('Odpowiedź'),
  );
  assert.deepEqual(groups, { fact: ['A'], calc: ['B'], inference: ['C'], external: ['Odpowiedź usługi X'] });
});

test('zdanie podsumowania mówi, co znaleziono i dokąd trafiły pieniądze', () => {
  assert.equal(
    // Intl wstawia twardą spację w kwotach.
    summarySentence({ person: 'Rafał Kowalski', linked: 1, unconfirmed: 0, services: ['Giełda Bursztyn'], totalPln: 353_000 }).replace(/ /g, ' '),
    'Znaleziono 1 adres powiązany z osobą Rafał Kowalski. Środki trafiły do: Giełda Bursztyn — szacunkowo 353 tys. zł.',
  );
  assert.match(summarySentence({ linked: 0, unconfirmed: 2, services: [], totalPln: 0 }), /2 adresy do potwierdzenia/);
  assert.match(summarySentence({ linked: 0, unconfirmed: 0, services: [], totalPln: 0 }), /Nie znaleziono adresów/);
  assert.match(summarySentence({ linked: 3, unconfirmed: 0, services: ['A', 'B', 'C', 'D'], totalPln: 0 }), /A, B i 2 inne usługi\.$/);
  assert.match(summarySentence({ linked: 5, unconfirmed: 0, services: [], totalPln: 0 }), /5 adresów powiązanych z podmiotem\. Nie wykryto/);
});

test('pamięć wskazówek i przewodnika: odporna na brak dostępu, czyszczenie po prefiksie', () => {
  const storage = memoryStorage();
  writeFlag(`${HINT_PREFIX}a`, true, storage);
  writeFlag(`${HINT_PREFIX}b`, true, storage);
  writeFlag('inny-klucz', true, storage);
  assert.ok(readFlag(`${HINT_PREFIX}a`, storage));
  clearFlags(HINT_PREFIX, storage);
  assert.ok(!readFlag(`${HINT_PREFIX}a`, storage) && !readFlag(`${HINT_PREFIX}b`, storage));
  assert.ok(readFlag('inny-klucz', storage));

  const broken = { getItem: () => { throw new Error('zablokowane'); }, setItem: () => { throw new Error('zablokowane'); }, removeItem: () => {} };
  assert.equal(readFlag('x', broken), false);
  assert.doesNotThrow(() => writeFlag('x', true, broken));

  assert.ok(!isTourDone('dossier', storage));
  markTourDone('dossier', storage);
  assert.ok(isTourDone('dossier', storage));
  resetTour(storage);
  assert.ok(!isTourDone('dossier', storage));
});

test('przewodnik: 4–6 kroków na rozdział, kroki bez celu na ekranie są pomijane', () => {
  for (const steps of Object.values(TOUR)) assert.ok(steps.length >= 3 && steps.length <= 6);
  assert.ok(TOUR.dashboard.length + TOUR.dossier.length >= 4);
  const steps = availableSteps('dossier', (target) => target !== 'score');
  assert.ok(steps.every((step) => step.target !== 'score'));
  assert.equal(steps.length, TOUR.dossier.length - 1);
});
