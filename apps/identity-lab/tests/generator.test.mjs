import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../lib/generator.mjs';
import { SERVICES } from '../lib/services.mjs';

test('catalog contains exactly 5 social, 7 marketplaces, 15 forums', () => {
  assert.equal(SERVICES.length, 27);
  assert.deepEqual(Object.fromEntries(['social', 'marketplace', 'forum'].map(category => [category, SERVICES.filter(service => service.category === category).length])), { social: 5, marketplace: 7, forum: 15 });
  assert.equal(new Set(SERVICES.map(service => service.slug)).size, 27);
  assert.equal(new Set(SERVICES.map(service => service.id)).size, 27);
  assert.ok(SERVICES.every(service => service.domain.endsWith('.test')));
});

test('fixed seed reproduces all public data and truth; alternate seed differs', () => {
  const options = { seed: 104, people: 12 };
  assert.deepEqual(generateDataset(options), generateDataset(options));
  assert.notDeepEqual(generateDataset(options).publicData.accounts, generateDataset({ ...options, seed: 105 }).publicData.accounts);
});

test('default dataset is rich, referentially sound and covers every service', () => {
  const { publicData: data, groundTruth } = generateDataset();
  assert.equal(groundTruth.people.length, 180);
  assert.ok(data.accounts.length >= 900 && data.accounts.length <= 1600, `accounts=${data.accounts.length}`);
  const accounts = new Map(data.accounts.map(account => [account.id, account]));
  const people = new Set(groundTruth.people.map(person => person.id));
  assert.equal(accounts.size, data.accounts.length);
  assert.equal(groundTruth.accountLinks.length, data.accounts.length);
  assert.ok(groundTruth.accountLinks.every(link => accounts.has(link.accountId) && people.has(link.personId)));
  assert.deepEqual(new Set(groundTruth.accountLinks.map(link => link.role)), new Set(['ordinary', 'multi', 'fake']));
  for (const service of SERVICES) {
    assert.ok(data.accounts.some(account => account.serviceId === service.id));
    const content = service.category === 'social' ? data.posts : service.category === 'marketplace' ? data.listings : data.threads;
    assert.ok(content.some(item => item.serviceId === service.id), service.id);
  }
  for (const item of [...data.posts, ...data.listings, ...data.threads]) {
    assert.equal(accounts.get(item.accountId).serviceId, item.serviceId);
    assert.ok(item.createdAt <= data.meta.generatedAt);
    for (const reply of item.replies ?? []) assert.equal(accounts.get(reply.accountId).serviceId, item.serviceId);
  }
  assert.ok(data.listings.every(item => Number.isSafeInteger(item.price) && item.price > 0 && item.currency === 'PLN'));
  assert.equal(new Set(data.accounts.map(account => `${account.serviceId}/${account.username.toLowerCase()}`)).size, data.accounts.length);
});

test('public data never exposes hidden identity mappings or real-domain emails', () => {
  const { publicData: data } = generateDataset({ people: 20 });
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      assert.ok(!['personId', 'personaId', 'role', 'accountLinks', 'groundTruth'].includes(key), `truth field ${key}`);
      walk(item);
    }
  };
  walk(data);
  for (const account of data.accounts) {
    assert.ok(account.email.endsWith('.test'));
    assert.ok(account.activeHours.every(hour => Number.isInteger(hour) && hour >= 0 && hour < 24));
    assert.ok(account.walletAddresses.every(address => /^lab1[a-f0-9]{40}$/.test(address)));
    assert.ok(account.joinedAt < data.meta.generatedAt);
  }
  const emails = JSON.stringify(data).match(/[a-z0-9._+%-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  assert.ok(emails.length > 50);
  assert.ok(emails.every(email => email.endsWith('.test')));
});

test('benchmark has discoverable aliases, deliberate hard negatives and hidden fakes', () => {
  const { publicData: data, groundTruth: truth } = generateDataset({ people: 15 });
  const demo = truth.scenarios.find(scenario => scenario.id === 'alias-bridge');
  const demoAccounts = data.accounts.filter(account => demo.allAccountIds.includes(account.id));
  assert.equal(demoAccounts.length, 8);
  assert.equal(new Set(demoAccounts.map(account => account.email)).size, 6);
  assert.ok(demoAccounts.some(account => account.bio.includes('mira.kowal@poczta.test')));
  const collision = truth.scenarios.find(scenario => scenario.id === 'shared-nickname');
  assert.equal(collision.accountIds.length, 2);
  assert.equal(new Set(truth.accountLinks.filter(link => collision.accountIds.includes(link.accountId)).map(link => link.personId)).size, 2);
  const unresolved = truth.scenarios.find(scenario => scenario.id === 'independent-fake');
  const fake = data.accounts.find(account => account.id === unresolved.accountIds[0]);
  assert.equal(fake.email, 'nocny.przechodzien@konto.test');
  assert.ok(!fake.bio.includes('mira') && !fake.bio.includes('szlak_ciszy'));
});

test('minimum size still populates every portal and invalid options are rejected', () => {
  const { publicData: data } = generateDataset({ seed: 0, people: 10 });
  assert.equal(new Set(data.accounts.map(account => account.serviceId)).size, 27);
  for (const people of [0, 9, 2001, 2.5, '180']) assert.throws(() => generateDataset({ people }), RangeError);
  for (const seed of [-1, NaN, 2147483648, '67']) assert.throws(() => generateDataset({ seed }), RangeError);
});

test('hard-negative nickname remains exactly two different people across seeds and small sizes', () => {
  for (const seed of [0, 7, 14, 35, 49, 69, 81, 99]) {
    const { publicData: data, groundTruth: truth } = generateDataset({ seed, people: 10 });
    const collision = truth.scenarios.find(scenario => scenario.id === 'shared-nickname');
    assert.equal(collision.accountIds.length, 2, `seed=${seed}`);
    assert.equal(new Set(data.accounts.filter(account => collision.accountIds.includes(account.id)).map(account => account.serviceId)).size, 2);
    assert.equal(new Set(truth.accountLinks.filter(link => collision.accountIds.includes(link.accountId)).map(link => link.personId)).size, 2);
  }
});

test('Polish adjectival surname forms match generated first names, including fake identities', () => {
  const { publicData: data, groundTruth: truth } = generateDataset();
  const names = [...truth.people.map(person => person.displayName), ...data.accounts.map(account => account.displayName)];
  for (const fullName of names) {
    const [firstName, surname] = fullName.split(' ');
    if (surname.endsWith('.')) continue;
    if (firstName.endsWith('a')) {
      assert.ok(!/(ski|cki)$/.test(surname) && surname !== 'Leśny', fullName);
    } else {
      assert.ok(!/(ska|cka)$/.test(surname) && surname !== 'Leśna', fullName);
    }
  }
  assert.equal(truth.people[0].displayName, 'Mira Kowal');
  assert.equal(data.accounts[0].email, 'mira.kowal@poczta.test');
  assert.deepEqual(data.meta.counts, { services: 27, accounts: 992, posts: 505, listings: 477, threads: 863, replies: 1974 });
});
