import assert from 'node:assert/strict';
import test from 'node:test';
import { computeConfidence, detectOwnershipDeclaration, foldPreservingLength } from '../src/index.ts';
import type { Evidence } from '../src/index.ts';

const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const TRON = 'TB9EFt6mvRQKihfPRiSQNCkBedqh2BfwwB';
const ETH = '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';

const verdict = (text: string, address = BTC) => detectOwnershipDeclaration(text, address).verdict;

test('zwijanie znaków zachowuje długość (indeksy wskazują ten sam znak)', () => {
  const text = 'Wpłaty łączą Żółć — 😀 „cytat”';
  const folded = foldPreservingLength(text);
  assert.equal(folded.length, text.length);
  assert.ok(folded.startsWith('wplaty lacza zolc'));
});

test('deklaracje w pierwszej osobie po polsku', () => {
  for (const text of [
    `Mój adres BTC: ${BTC}`,
    `Moj portfel to ${BTC}, piszcie na priv.`,
    `Wpłaty na ${BTC} — dziękuję!`,
    `Płatność na ${BTC} albo gotówką przy odbiorze.`,
    `Kto płaci w krypto: przelej na ${BTC} i podeślij potwierdzenie.`,
    `Opłatę można wnieść w BTC na mój adres: ${BTC}`,
    `Adres do wpłaty: ${BTC}`,
    `Wpłaty zbieram na jednym adresie: ${BTC} i raz na kwartał wymieniam.`,
    `Zamówienia przyjmuję na swój adres BTC: ${BTC}`,
  ]) {
    assert.equal(verdict(text), 'declares', text);
  }
  // Przypadki z piaskownicy, których dotąd nie liczono.
  assert.equal(verdict(`U mnie w Suwałkach klienci płacą za naprawy komputerów w USDT, sieć TRON: ${TRON}. Marek Wrona, m.wrona@suwalki-net.example`, TRON), 'declares');
  assert.equal(
    verdict(`Uczę matematyki online, część uczniów mieszka w Irlandii. Od roku przyjmuję od nich USDT w sieci TRON na adres ${TRON} — bez prowizji banku.`, TRON),
    'declares',
  );
  const result = detectOwnershipDeclaration(`Wpłaty na ${BTC} — dziękuję!`, BTC);
  assert.match(result.reason, /„wpłaty na”/);
  assert.ok(result.quote!.includes(BTC));
});

test('deklaracje po angielsku i wiersz „BTC:” w podpisie', () => {
  for (const text of [`My BTC address: ${BTC}`, `Donations welcome, send to my wallet ${BTC}`, `You can pay in ETH: ${ETH}`, `Tips appreciated — buy me a coffee: ${ETH}`]) {
    assert.equal(verdict(text, text.includes(ETH) ? ETH : BTC), 'declares', text);
  }
  assert.equal(verdict(`Dzięki za pomoc z konfiguracją węzła, wszystko działa.\n\n--\nJan, Radom\nBTC: ${BTC}`), 'declares');
  assert.equal(verdict(`Napiwki: ${BTC}`), 'declares');
  // Sama etykieta tickera w środku dłuższej wypowiedzi to nie podpis.
  assert.equal(verdict(`Wczoraj ktoś wysłał tu pytanie.\nBTC: ${BTC}\nCzy to w ogóle działa?\nOdpowiedzcie proszę.\nDzięki z góry.`), 'none');
});

test('ostrzeżenia, pytania, rozdania i opis cudzej wpłaty wykluczają deklarację', () => {
  const cases: [string, RegExp][] = [
    [`Uwaga na oszusta, podaje adres ${BTC} — nie wpłacajcie!`, /ostrzeżenie/],
    [`To scam! Mój adres ${BTC} był w fałszywym ogłoszeniu.`, /ostrzeżenie/],
    [`Nie wpłacajcie na ${BTC}`, /apel/],
    [`Ktoś zna ${BTC}?`, /pytanie o właściciela/],
    [`Czyj to adres? ${BTC}`, /pytanie o właściciela/],
    [`MEGA ROZDANIE — wpłaty na ${BTC}, odsyłamy x2!`, /rozdania/],
    [`Airdrop: send to ${BTC} and receive tokens`, /rozdania/],
    [`Wysłałem 300 na ${BTC} i nic nie wróciło`, /opis własnej wpłaty/],
    [`Wpłaciłam na jego adres ${BTC}`, /opis własnej wpłaty|adres innej osoby/],
    [`To jest adres sprzedawcy: ${BTC}, wpłaty na niego szły tydzień.`, /adres innej osoby/],
    [`Mój adres to nie ${BTC}, tylko inny — sprawdźcie profil.`, /przeczenie/],
    [`${BTC} to nie mój adres, ktoś się pomylił.`, /przeczenie/],
    [`Hakerzy podali adres ${BTC} — nie wysyłajcie tam nic!`, /ostrzeżenie|apel/],
    [`That is not my wallet: ${BTC}`, /przeczenie/],
  ];
  for (const [text, reason] of cases) {
    const result = detectOwnershipDeclaration(text, BTC);
    assert.equal(result.verdict, 'excluded', text);
    assert.match(result.reason, reason, text);
  }
});

test('cytat cudzej deklaracji nie jest deklaracją autora odpowiedzi', () => {
  // Cytat w cudzysłowie.
  assert.equal(verdict(`Jan napisał wczoraj „mój adres to ${BTC}”, a potem zniknął.`), 'excluded');
  // Blok cytatu w stylu forum.
  assert.equal(verdict(`Cytat: krypto_janek\nMój adres do wpłat: ${BTC}\n\nDzięki, przelew poszedł.`), 'excluded');
  assert.equal(verdict(`> Wpłaty na ${BTC}\nPotwierdzam, doszło.`), 'excluded');
  assert.equal(verdict(`krypto_janek napisał: mój adres ${BTC}\nOk, zapisane.`), 'excluded');
  // Adres w cudzysłowie bez innych słów to tylko zapis — deklaracja zostaje.
  assert.equal(verdict(`Mój adres: "${BTC}"`), 'declares');
});

test('sama wzmianka bez deklaracji to „none”', () => {
  assert.equal(verdict(`W dyskusji padł adres ${BTC}`), 'none');
  assert.equal(verdict(`Widziałam adres ${BTC}`), 'none');
  assert.equal(verdict(`Wspierajcie projekt: ${BTC}`), 'none');
  assert.equal(verdict(`Darowizny dla fundacji Pomoc Zwierzętom: ${BTC}`), 'none');
  assert.equal(verdict('Brak adresu w treści.'), 'none');
});

test('podstawa „deklaracja w treści” trafia do księgi bez zmiany punktów', () => {
  const evidence: Evidence = {
    id: 'ev-1',
    category: 'forum_post',
    service: 'forum.example',
    url: 'https://forum.example/t/1',
    capturedAt: '2026-11-21T09:00:00.000Z',
    identityMatch: 'exact_identifier',
    ownershipBasis: { rule: 'text_declaration', quote: `Mój adres ${BTC}` },
  };
  const result = computeConfidence({ evidence: [evidence], addressClass: 'private' });
  assert.equal(result.score, 50);
  assert.deepEqual(result.ledger.map((entry) => [entry.rule, entry.delta]), [['base.forum_post', 50], ['basis.text_declaration', 0]]);
  assert.match(result.ledger[1]!.explanation, /deklaracja własności w treści \(reguła tekstowa\)/);
});
