import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectIdentifierType } from '../src/app.ts';

test('imię i nazwisko wpisane małymi literami to full_name, a nie nick', () => {
  // Nazwa konta nie zawiera spacji: „anna wzorcowa” potraktowane jako nick nie trafiało do żadnego źródła.
  assert.equal(detectIdentifierType('anna wzorcowa'), 'full_name');
  assert.equal(detectIdentifierType('Tomasz Przykładowy'), 'full_name');
  assert.equal(detectIdentifierType('anna maria kowalska-nowak'), 'full_name');
  assert.equal(detectIdentifierType('żaneta źdźbło'), 'full_name');
  // Pojedynczy wyraz, cyfry albo znaki nicku — nadal nick.
  assert.equal(detectIdentifierType('kacper'), 'nick');
  assert.equal(detectIdentifierType('krypto_janek 88'), 'nick');
  assert.equal(detectIdentifierType('rkowalski_btc'), 'nick');
  assert.equal(detectIdentifierType('jan.kowalski@poczta.example'), 'email');
  assert.equal(detectIdentifierType('vitalik.eth'), 'ens_name');
});
