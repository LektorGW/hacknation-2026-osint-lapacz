// Usługi wyjścia do walut tradycyjnych rozpoznawane po nazwie i zasada „adres usługi tylko ze źródłem”.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OFFRAMP_KINDS, foldText, getDefaultLabels, loadLabelFile, loadOfframpServices, matchOfframps, offrampFor } from '../src/index.ts';

test('lista usług wyjścia do fiat: każdy wpis ma znany rodzaj, a odmiany polskich nazw są rozpoznawane bez znaków diakrytycznych', () => {
  const services = loadOfframpServices();
  assert.ok(services.length >= 30);
  assert.ok(services.every((item) => OFFRAMP_KINDS.includes(item.kind)));
  for (const kind of OFFRAMP_KINDS) assert.ok(services.some((item) => item.kind === kind), `jest co najmniej jedna usługa rodzaju ${kind}`);
  assert.equal(foldText('Wypłacam GOTÓWKĘ przez Kangę'), 'wyplacam gotowke przez kange');
  assert.deepEqual(matchOfframps('Wypłacam przez KANGĘ, czasem w bitomacie.').map((item) => [item.service.name, item.keyword]), [
    ['Kanga', 'KANGĘ'],
    ['Bitomat (ogólnie)', 'bitomacie'],
  ]);
  // Całe słowa: „kangaroo” to nie Kanga.
  assert.equal(offrampFor('kangaroo'), undefined);
});

test('lista usług nie zawiera adresów, a zbiór etykiet nie oznacza adresu usługi wyjścia do fiat bez publicznego źródła', () => {
  for (const service of loadOfframpServices()) assert.ok(!('address' in service), `${service.name}: lista usług nie zawiera adresów`);
  const dir = mkdtempSync(join(tmpdir(), 'olcys-offramp-'));
  const path = join(dir, 'labels.json');
  writeFileSync(path, JSON.stringify({ labels: [{ network: 'bitcoin', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', label: 'Kantor', addressClass: 'exchange', offrampKind: 'exchange_with_pln' }] }));
  assert.throws(() => loadLabelFile(path), /rodzaj "exchange_with_pln" wymaga pola "source"/);
  writeFileSync(path, JSON.stringify({ labels: [{ network: 'bitcoin', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', label: 'Kantor', addressClass: 'exchange', offrampKind: 'bankomat' }] }));
  assert.throws(() => loadLabelFile(path), /nieznany rodzaj usługi wyjścia do fiat "bankomat"/);
  // Wbudowany zbiór etykiet nadal się wczytuje.
  assert.ok(getDefaultLabels().name.length > 0);
});
