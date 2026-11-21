import assert from 'node:assert/strict';
import { test } from 'node:test';
import { htmlToText } from '../src/index.ts';
import { extractContent, findEmails, findRelMeLinks } from '../src/html.ts';
import { excerptsAround } from '../src/tor.ts';

test('htmlToText: usuwa skrypty, style i komentarze', () => {
  const text = htmlToText('<head><title>T</title></head><style>p{}</style><p>Widoczne</p><script>var x = "ukryte";</script><!-- uwaga -->');
  assert.equal(text, 'Widoczne');
});

test('htmlToText: bloki i <br> rozdzielają wiersze, odstępy są scalane', () => {
  const text = htmlToText('<div>Pierwszy   wiersz</div><p>Drugi<br>Trzeci</p><ul><li>a</li><li>b</li></ul>');
  assert.equal(text, 'Pierwszy wiersz\nDrugi\nTrzeci\na\nb');
});

test('htmlToText: dekoduje encje, także numeryczne', () => {
  assert.equal(htmlToText('<p>4&nbsp;800 z&#322; &amp; &lt;b&gt; &#x41; &amp;lt;</p>'), '4 800 zł & <b> A &lt;');
});

test('htmlToText: sąsiednie elementy nie sklejają się z adresem, a formatowanie go nie rozrywa', () => {
  const address = 'bc1qxhvk23usdd66dddy8lvafvv47v5aa9jz6kl0ze';
  const text = htmlToText(`<span>adres</span><code>${address}</code><span>koniec</span> <b>bc1q</b>abc`);
  assert.match(text, new RegExp(`adres ${address} koniec`));
  assert.match(text, /bc1qabc/);
});

test('extractContent: wybiera <article>, potem <main>, na końcu całość', () => {
  assert.equal(extractContent('<nav>x</nav><main><article data-kind="post">treść</article><div>komentarz</div></main>'), 'treść');
  assert.equal(extractContent('<nav>x</nav><main>środek</main>'), 'środek');
  assert.equal(extractContent('<p>bez struktury</p>'), '<p>bez struktury</p>');
});

test('findRelMeLinks: tylko odnośniki z rel="me"', () => {
  const html = '<a href="/a">zwykły</a> <a rel="me noopener" href="/gitpub/ktos">mój</a> <a href=\'/b\' rel=\'home\'>inny</a>';
  assert.deepEqual(findRelMeLinks(html), ['/gitpub/ktos']);
});

test('findEmails: unikalne adresy małymi literami', () => {
  assert.deepEqual(findEmails('Pisz: Jan.Testowy@poczta.example lub jan.testowy@poczta.example.'), ['jan.testowy@poczta.example']);
});

test('excerptsAround: zwraca fragment wokół frazy albo null', () => {
  const text = `${'x'.repeat(2000)} nick_testowy sprzedaje ${'y'.repeat(2000)}`;
  const excerpt = excerptsAround(text, 'NICK_testowy');
  assert.ok(excerpt && excerpt.includes('nick_testowy sprzedaje') && excerpt.length < 1300);
  assert.equal(excerptsAround(text, 'nieobecny'), null);
});
