import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAccounts, resolveIdentity, evaluateIdentity } from '../lib/identity.mjs';

const account = (id, fields = {}) => ({ id, serviceId: 'test', username: `alias_${id}`, displayName: `Osoba ${id}`, email: `${id}@poczta.test`, bio: '', location: '', interests: [], activeHours: [], walletAddresses: [], ...fields });

test('exact email is strong evidence, but never certainty', () => {
  const result = compareAccounts(account('a', { email: 'mira@poczta.test' }), account('b', { email: 'mira@poczta.test' }));
  assert.ok(result.probability > 0.90 && result.probability < 1);
  assert.ok(result.evidence.some(item => item.signal === 'email_exact'));
  assert.ok(result.caveats.some(text => text.includes('Wspólny adres')));
});

test('matching name and weak behavioral clues do not identify a person', () => {
  const fields = { displayName: 'Jan Nowak', location: 'Miasto Testowe', interests: ['rower', 'sport'], activeHours: [18, 19, 20] };
  const result = compareAccounts(account('alpha', fields), account('beta', fields));
  assert.ok(result.probability < 0.10);
});

test('generic shared handles are downweighted and observed rarity matters', () => {
  const a = account('a', { username: 'rowerzysta' }), b = account('b', { username: 'rowerzysta' });
  assert.ok(compareAccounts(a, b).probability < 0.10);
  const rare = [account('c', { username: 'szlak_ciszy' }), account('d', { username: 'szlak.ciszy' })];
  const shared = [...rare, ...Array.from({ length: 9 }, (_, i) => account(`n${i}`, { username: 'szlak_ciszy' }))];
  assert.ok(compareAccounts(...rare, rare).probability > compareAccounts(...rare, shared).probability);
});

test('same mail variants and aliases are capped as correlated evidence', () => {
  const a = account('a', { username: 'mirakowal', email: 'mira.kowal@poczta.test' });
  const b = account('b', { username: 'mira_kowal', email: 'mira.kowal+market@poczta.test' });
  const result = compareAccounts(a, b);
  assert.ok(result.probability < 0.85);
  assert.ok(result.effectiveEvidence.alias <= 4.5);
});

test('public biography contacts and explicit alias references link distinct aliases', () => {
  const a = account('a', { username: 'szlak_ciszy', email: 'mira.kowal@poczta.test' });
  const b = account('b', { username: 'mira.outdoors', bio: 'Kontakt mira.kowal@poczta.test, zdjęcia także jako @szlak_ciszy.' });
  const result = compareAccounts(a, b);
  assert.ok(result.probability > 0.88);
  assert.ok(result.evidence.some(item => item.signal === 'bio_alias'));
});

test('biography matching respects exact contact and alias boundaries', () => {
  const a = account('a', { username: 'szlak_ciszy', email: 'mira@poczta.test' });
  const b = account('b', { bio: 'Kontakt zamira@poczta.test. Profil @szlak_ciszy_fake.' });
  const result = compareAccounts(a, b);
  assert.ok(!result.evidence.some(item => ['bio_contact', 'bio_alias'].includes(item.signal)));
});

test('hidden truth and ID prefixes never influence pair scoring', () => {
  const a = account('random1'), b = account('random2');
  const original = compareAccounts(a, b);
  const modified = compareAccounts({ ...a, id: 'person1_a', personId: 'p1', role: 'fake' }, { ...b, id: 'person1_b', personId: 'p1', role: 'multi' });
  assert.deepEqual(modified, original);
});

test('blockchain transfers without shared public addresses do not link accounts', () => {
  const a = account('a', { walletAddresses: ['lab1aaa'] }), b = account('b', { walletAddresses: ['lab1bbb'] });
  assert.ok(compareAccounts(a, b).probability < 0.1);
  assert.ok(compareAccounts(a, { ...b, walletAddresses: ['lab1aaa'] }).probability > 0.89);
});

test('query supports IDs, e-mails, wallets and partial names with lower certainty', () => {
  const accounts = [account('a', { email: 'mira@poczta.test' }), account('b', { email: 'mira@poczta.test' }), account('c')];
  const result = resolveIdentity('mira@poczta.test', accounts);
  assert.deepEqual(result.anchors, ['a', 'b']);
  assert.equal(result.matches.length, 2);
  assert.throws(() => resolveIdentity('a', accounts), /2 do 200/);
  const identified = resolveIdentity('acct-1', [account('acct-1'), account('acct-2')]);
  assert.equal(identified.matches[0].probability, 1);
  const wallets = resolveIdentity('lab1abc123', [account('wallet-1', { walletAddresses: ['lab1abc123'] })]);
  assert.equal(wallets.matches[0].matchType, 'wallet');
});

test('ambiguous aliases do not propagate certainty and bounds are enforced', () => {
  const accounts = [account('acct-a', { username: 'rowerzysta' }), account('acct-b', { username: 'rowerzysta' }), account('acct-c')];
  const result = resolveIdentity('rowerzysta', accounts);
  assert.equal(result.anchors.length, 2);
  assert.ok(result.matches.every(match => match.probability <= 0.70));
  assert.throws(() => resolveIdentity('a', accounts), /2 do 200/);
  assert.throws(() => resolveIdentity('x'.repeat(201), accounts), /2 do 200/);
  assert.equal(resolveIdentity('missing', accounts).matches.length, 0);
  assert.equal(resolveIdentity('acct', accounts, { limit: 1 }).matches.length, 1);
});

test('evaluation samples positives and negatives reproducibly and reports hard negatives separately', () => {
  const accounts = [account('a', { email: 'shared@poczta.test' }), account('b', { email: 'shared@poczta.test' }), account('c', { username: 'rowerzysta' }), account('d', { username: 'rowerzysta' })];
  const truth = { accountLinks: [{ accountId: 'a', personId: 'p1' }, { accountId: 'b', personId: 'p1' }, { accountId: 'c', personId: 'p2' }, { accountId: 'd', personId: 'p3' }] };
  const result = evaluateIdentity(accounts, truth);
  assert.equal(result.sample.positives.population, 1);
  assert.equal(result.sample.negatives.population, 5);
  assert.equal(result.confusion.tp, 1);
  assert.equal(result.confusion.fp, 0);
  assert.equal(result.precision, 1);
  assert.equal(result.recall, 1);
  assert.equal(result.hardNegativeAudit.pairs, 1);
  assert.deepEqual(result, evaluateIdentity(accounts, truth));
  assert.throws(() => evaluateIdentity(accounts, truth, { threshold: 2 }), /Próg/);
});

test('empty benchmark is defined without fabricated perfect metrics', () => {
  const result = evaluateIdentity([], { accountLinks: [] });
  assert.equal(result.pairsEvaluated, 0);
  assert.equal(result.precision, null);
  assert.equal(result.recall, null);
});

test('hard-negative audit exposes shared payment wallets across people without changing sampling', () => {
  const accounts = [
    account('alice-main', { username: 'alice_main', walletAddresses: ['lab1intermediary', 'lab1other', 'lab1intermediary'] }),
    account('alice-alt', { username: 'alice_other', walletAddresses: ['lab1intermediary'] }),
    account('bob-main', { username: 'bob_main', walletAddresses: ['lab1intermediary', 'lab1other'] }),
    account('carol', { walletAddresses: ['', ' '] }),
    account('david', { walletAddresses: ['', ' '] }),
  ];
  const groundTruth = { accountLinks: accounts.map((entry, index) => ({ accountId: entry.id, personId: index < 2 ? 'alice' : `person-${index}` })) };
  const result = evaluateIdentity(accounts, groundTruth);
  assert.equal(result.hardNegativeAudit.pairs, 2, 'unique cross-person pairs, not one count per shared address');
  assert.equal(result.hardNegativeAudit.falsePositives, 2);
  assert.deepEqual(result.hardNegativeAudit.bySignal.sharedWallet, { pairs: 2, falsePositives: 2 });
  assert.equal(result.hardNegativeAudit.bySignal.username.pairs, 0);
  assert.ok(result.hardNegativeAudit.examples.every(pair => pair.falsePositive && pair.reasons.includes('sharedWallet') && pair.signals.includes('wallet')));
  assert.equal(result.sample.positives.population, 1);
  assert.equal(result.sample.negatives.population, 9);
  assert.equal(result.pairsEvaluated, 10, 'audit comparisons are kept outside the sampled pair count');
  assert.equal(result.confusion.fp, 2, 'main sample has its own correct counts when exhaustive');
});

test('hard-negative aggregate deduplicates pairs shared by alias and wallet audits', () => {
  const accounts = [account('one', { username: 'rowerzysta', walletAddresses: ['lab1shared'] }), account('two', { username: 'rowerzysta', walletAddresses: ['lab1shared'] })];
  const result = evaluateIdentity(accounts, { accountLinks: [{ accountId: 'one', personId: 'p1' }, { accountId: 'two', personId: 'p2' }] });
  assert.equal(result.hardNegativeAudit.pairs, 1);
  assert.equal(result.hardNegativeAudit.falsePositives, 1);
  assert.equal(result.hardNegativeAudit.bySignal.username.pairs, 1);
  assert.equal(result.hardNegativeAudit.bySignal.sharedWallet.pairs, 1);
  assert.deepEqual(result.hardNegativeAudit.examples[0].reasons, ['username', 'sharedWallet']);
});
