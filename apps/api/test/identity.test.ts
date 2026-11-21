import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Identifier, SourceDocument } from '@olcys/core';
import { assessIdentity, assessLinkedProfile, isCommonHandle } from '../src/identity.ts';

const nick: Identifier = { type: 'nick', value: 'krypto_janek' };
const email: Identifier = { type: 'email', value: 'jan.kowalski@poczta.example' };
const fullName: Identifier = { type: 'full_name', value: 'Jan Kowalski' };

const doc = (over: Partial<SourceDocument>): SourceDocument => ({
  connectorId: 'test',
  service: 'serwis.example',
  url: 'https://serwis.example/profil',
  title: 'Profil',
  text: 'Opis profilu bez danych kontaktowych.',
  fetchedAt: '2026-11-21T10:00:00.000Z',
  category: 'own_profile',
  identityMatch: 'exact_identifier',
  matchedIdentifier: nick,
  ...over,
});

test('sam nick nie potwierdza, że profil należy do podmiotu', () => {
  const result = assessIdentity(doc({}), [nick, email]);
  assert.equal(result.match, 'same_handle');
});

test('pospolity nick jest oceniany słabiej', () => {
  assert.equal(isCommonHandle('tomek'), true);
  assert.equal(isCommonHandle('Tomek_92'), true);
  assert.equal(isCommonHandle('krypto_janek'), false);
  const common: Identifier = { type: 'nick', value: 'tomek' };
  assert.equal(assessIdentity(doc({ matchedIdentifier: common }), [common]).match, 'common_handle');
});

test('drugi identyfikator podmiotu w treści profilu potwierdza tożsamość', () => {
  const result = assessIdentity(doc({ text: 'Kontakt: Jan.Kowalski@poczta.example' }), [nick, email]);
  assert.equal(result.match, 'exact_identifier');
  assert.match(result.reasons[0]!, /e-mail/);
});

test('profil odnaleziony po e-mailu jest dopasowaniem unikalnym', () => {
  assert.equal(assessIdentity(doc({ matchedIdentifier: email }), [email]).match, 'exact_identifier');
});

test('samo imię i nazwisko to możliwa zbieżność; nick w treści ją rozstrzyga', () => {
  const byName = doc({ matchedIdentifier: fullName, identityMatch: 'name_only' });
  assert.equal(assessIdentity(byName, [fullName, nick]).match, 'name_only');
  const withNick = doc({ matchedIdentifier: fullName, identityMatch: 'name_only', text: 'Znajdziesz mnie jako krypto_janek' });
  assert.equal(assessIdentity(withNick, [fullName, nick]).match, 'exact_identifier');
});

test('profil wskazany przez inny profil: odnośnik zwrotny potwierdza tożsamość', () => {
  const linked = doc({ matchedIdentifier: { type: 'login', value: 'jkowalski-dev' } });
  assert.equal(assessLinkedProfile(linked, [nick], 'linked_profile').match, 'linked_profile');
  const mutual = doc({
    matchedIdentifier: { type: 'login', value: 'jkowalski-dev' },
    discoveredIdentifiers: [{ type: 'nick', value: '@Krypto_Janek' }],
  });
  assert.equal(assessLinkedProfile(mutual, [nick], 'linked_profile').match, 'verified_link');
  assert.equal(assessLinkedProfile(mutual, [nick], 'name_only').match, 'name_only');
});

test('potwierdzenie tożsamości przez samo źródło nie jest osłabiane', () => {
  assert.equal(assessIdentity(doc({ identityMatch: 'verified_link' }), [nick]).match, 'verified_link');
});
