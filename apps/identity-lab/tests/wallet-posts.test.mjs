import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLab } from '../lib/storage.mjs';
import { addWalletDisclosurePosts, WALLET_POST_SET, WALLET_POST_REASONS } from '../lib/wallet-posts.mjs';
import { createLabServer } from '../server.mjs';

test('200 unique disclosures cover 20 real LAB portals and all 10 reasons evenly', () => {
  const lab = buildLab();
  const before = structuredClone(lab);
  const rows = addWalletDisclosurePosts(lab);
  assert.equal(rows.length, 200);
  assert.equal(new Set(rows.map(row => row.text)).size, 200);
  assert.equal(new Set(rows.map(row => row.id)).size, 200);
  assert.equal(rows.filter(row => row.type === 'post').length, 50);
  assert.equal(rows.filter(row => row.type === 'thread').length, 150);
  for (const service of lab.publicData.services.filter(service => service.category !== 'marketplace')) assert.equal(rows.filter(row => row.serviceId === service.id).length, 10);
  for (const reason of WALLET_POST_REASONS) assert.equal(rows.filter(row => row.reasonId === reason.id).length, 20);
  const addresses = new Set(lab.chain.wallets.map(wallet => wallet.address));
  for (const row of rows) {
    const author = lab.publicData.accounts.find(account => account.id === row.accountId);
    assert.equal(author.serviceId, row.serviceId);
    assert.ok(author.walletAddresses.includes(row.address));
    assert.ok(addresses.has(row.address));
    assert.ok(row.text.includes(row.address));
    assert.ok(row.text.includes('#PortfelLAB'));
    assert.doesNotMatch(row.text, /\{address\}/);
    assert.ok(row.createdAt >= author.joinedAt && row.createdAt <= lab.publicData.meta.generatedAt);
  }
  assert.equal(lab.publicData.posts.length, before.publicData.posts.length + 50);
  assert.equal(lab.publicData.threads.length, before.publicData.threads.length + 150);
  assert.deepEqual(lab.chain, before.chain);
  assert.deepEqual(lab.publicData.listings, before.publicData.listings);
  assert.deepEqual(lab.publicData.accounts.find(account => account.id === 'acct-00008'), before.publicData.accounts.find(account => account.id === 'acct-00008'));
  assert.deepEqual(lab.groundTruth.accountLinks, before.groundTruth.accountLinks);
  assert.deepEqual(lab.publicData.posts.filter(post => post.fixtureSet !== WALLET_POST_SET), before.publicData.posts);
  assert.deepEqual(lab.publicData.threads.filter(thread => thread.fixtureSet !== WALLET_POST_SET), before.publicData.threads);
});

test('import is deterministic and idempotent; own-address and shared-address labels are accurate', () => {
  const lab = buildLab();
  const rows = addWalletDisclosurePosts(lab);
  const snapshot = structuredClone(lab);
  assert.deepEqual(addWalletDisclosurePosts(lab), rows);
  assert.deepEqual(lab, snapshot);
  const links = new Map(lab.groundTruth.accountLinks.map(link => [link.accountId, link]));
  for (const annotation of lab.groundTruth.walletPostExamples.examples) {
    const row = rows.find(item => item.id === annotation.contentId);
    if (annotation.reasonId === 'fundraiser') {
      assert.equal(row.address, lab.chain.wallets[29].address);
      assert.equal(annotation.walletOwnerPersonId, null);
      assert.equal(row.addressUse, 'shared-fundraiser');
    } else {
      const ownerIndex = lab.groundTruth.people.findIndex(person => person.id === links.get(row.accountId).personId);
      assert.equal(row.address, lab.chain.wallets[ownerIndex].address);
      assert.equal(annotation.walletOwnerPersonId, links.get(row.accountId).personId);
    }
  }
  assert.doesNotMatch(JSON.stringify(lab.publicData), /"(?:personId|authorPersonId|walletOwnerPersonId|reasonId|privateKey|accountLinks|role)"/);
});

test('preflight failure does not partially change the snapshot', () => {
  const lab = buildLab();
  lab.publicData.accounts = lab.publicData.accounts.filter(account => account.serviceId !== 'forum-krypto');
  const before = structuredClone(lab);
  assert.throws(() => addWalletDisclosurePosts(lab), /Brak autora/);
  assert.deepEqual(lab, before);
});

test('portal and profile APIs expose all examples while keeping annotations private', async () => {
  const lab = buildLab();
  const examples = addWalletDisclosurePosts(lab);
  const { server } = createLabServer({ lab, persist: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const service of lab.publicData.services.filter(service => service.category !== 'marketplace')) {
      const response = await fetch(`${base}/api/portal/${service.slug}`);
      assert.equal(response.status, 200);
      const portal = await response.json();
      assert.equal([...portal.posts, ...portal.threads].filter(item => item.fixtureSet === WALLET_POST_SET).length, 10);
      assert.doesNotMatch(JSON.stringify(portal), /"(?:reasonId|walletOwnerPersonId|authorPersonId)"/);
    }
    const row = examples[0];
    const profile = await (await fetch(`${base}/api/accounts/${row.accountId}`)).json();
    assert.ok(profile.posts.some(post => post.id === row.id));
    const truth = await (await fetch(`${base}/api/ground-truth`)).json();
    assert.equal(truth.walletPostExamples.examples.length, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
