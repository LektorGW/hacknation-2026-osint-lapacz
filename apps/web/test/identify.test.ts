import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectIdentifierType, normalizeIdentifier, suggestCaseName } from '../src/identify.ts';

test('rozpoznawanie typu identyfikatora po formacie', () => {
  const cases: [string, string][] = [
    ['tomasz.wzorcowy@poczta.example', 'email'],
    ['https://kodhub.example/t-wzorcowy', 'profile_url'],
    ['kodhub.example/t-wzorcowy', 'profile_url'],
    ['www.forum-krypto.example/u/tomwzor', 'profile_url'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'crypto_address'],
    ['1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'crypto_address'],
    ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'crypto_address'],
    ['TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', 'crypto_address'],
    ['tomwzor.eth', 'ens_name'],
    ['Tomasz Wzorcowy', 'full_name'],
    ['Anna Maria Kowalska-Nowak', 'full_name'],
    ['Żaneta Źdźbło', 'full_name'],
    ['tomwzor', 'nick'],
    ['@tomwzor_tg', 'nick'],
    ['tomasz wzorcowy', 'nick'],
    ['krypto marek 99', 'nick'],
    ['  tomwzor  ', 'nick'],
  ];
  for (const [value, expected] of cases) assert.equal(detectIdentifierType(value), expected, value);
});

test('normalizacja wartości przed utworzeniem sprawy', () => {
  assert.deepEqual(normalizeIdentifier('nick', ' @tomwzor '), { type: 'nick', value: 'tomwzor' });
  assert.deepEqual(normalizeIdentifier('profile_url', 'kodhub.example/x'), { type: 'profile_url', value: 'https://kodhub.example/x' });
  assert.deepEqual(normalizeIdentifier('email', 'Tomasz@Poczta.Example'), { type: 'email', value: 'tomasz@poczta.example' });
  assert.deepEqual(normalizeIdentifier('full_name', 'Tomasz   Wzorcowy'), { type: 'full_name', value: 'Tomasz Wzorcowy' });
});

test('nazwa sprawy z identyfikatora', () => {
  assert.equal(suggestCaseName({ type: 'nick', value: 'tomwzor' }), 'tomwzor');
  assert.equal(suggestCaseName({ type: 'profile_url', value: 'https://kodhub.example/x/' }), 'kodhub.example/x');
  assert.equal(suggestCaseName({ type: 'crypto_address', value: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' }), 'Adres 0x5aAeb6…1BeAed');
});
