import { WALLET_POST_REASONS, WALLET_POST_TEXTS } from './wallet-post-texts.mjs';

export const WALLET_POST_SET = 'wallet-posts-200-v1';
export const WALLET_POST_TAG = '#PortfelLAB';
export { WALLET_POST_REASONS };

/** Add an idempotent, additive cohort to an existing snapshot; never reset its chain. */
export function addWalletDisclosurePosts(lab) {
  const { publicData: data, groundTruth: truth, chain } = lab;
  const services = data.services.filter(service => service.category !== 'marketplace');
  if (services.length !== 20 || chain.wallets.length < 30) throw new Error('Przykłady wymagają 20 portali społecznościowych/forów i 30 portfeli LAB.');
  const links = new Map(truth.accountLinks.map(link => [link.accountId, link]));
  // buildLab maps these first 29 people to wallets 0..28; wallet 29 is the intermediary.
  const walletByPerson = new Map(truth.people.slice(0, 29).map((person, index) => [person.id, chain.wallets[index]]));
  const protectedIds = new Set(truth.scenarios.filter(scenario => scenario.id === 'independent-fake').flatMap(scenario => scenario.accountIds));
  const examples = [], additions = [], annotations = [];

  for (const [serviceIndex, service] of services.entries()) {
    const templates = WALLET_POST_TEXTS[service.id];
    if (templates?.length !== WALLET_POST_REASONS.length) throw new Error(`Brak pełnego zestawu treści: ${service.id}.`);
    const candidates = data.accounts.filter(account => {
      const link = links.get(account.id);
      return account.serviceId === service.id && !protectedIds.has(account.id) && walletByPerson.has(link?.personId) && link.role !== 'fake';
    });
    const ordinary = candidates.filter(account => links.get(account.id).role === 'ordinary');
    const authors = ordinary.length ? ordinary : candidates;
    if (!authors.length) throw new Error(`Brak autora z własnym portfelem LAB w ${service.name}. Wybierz większy zbiór lub inny seed.`);

    for (const [reasonIndex, reason] of WALLET_POST_REASONS.entries()) {
      const author = authors[(reasonIndex + serviceIndex * 3) % authors.length];
      const authorPersonId = links.get(author.id).personId;
      const shared = reason.id === 'fundraiser';
      const wallet = shared ? chain.wallets[29] : walletByPerson.get(authorPersonId);
      const serial = String(examples.length + 1).padStart(3, '0');
      const type = service.category === 'social' ? 'post' : 'thread';
      const id = `wallet-${type}-${serial}`;
      const date = new Date(data.meta.generatedAt);
      date.setUTCDate(date.getUTCDate() - 1 - (reasonIndex % 5));
      date.setUTCHours(8 + (serviceIndex % 10), reasonIndex * 5, 0, 0);
      // A newly public post cannot predate its author's account.
      const createdAt = new Date(Math.max(date.getTime(), new Date(author.joinedAt).getTime())).toISOString();
      if (new Date(createdAt).getTime() > new Date(data.meta.generatedAt).getTime()) throw new Error(`Nieprawidłowa data konta ${author.id}.`);
      const text = `${templates[reasonIndex].replaceAll('{address}', wallet.address)} ${WALLET_POST_TAG}`;
      const title = Array.from(templates[reasonIndex].replaceAll('{address}', 'portfel LAB').split(/[.!?]/u)[0]).slice(0, 110).join('');
      const item = { id, accountId: author.id, serviceId: service.id, text, createdAt, tags: ['krypto', 'portfel-lab'], fixtureSet: WALLET_POST_SET };
      if (type === 'post') item.likes = (serviceIndex * 17 + reasonIndex * 7) % 91;
      else Object.assign(item, { title, replies: [] });
      additions.push({ type, item, author, address: wallet.address });
      examples.push({ id, serviceId: service.id, serviceName: service.name, serviceSlug: service.slug, type, accountId: author.id, username: author.username, reasonId: reason.id, reason: reason.label, address: wallet.address, addressUse: shared ? 'shared-fundraiser' : 'own', createdAt, ...(type === 'thread' ? { title } : {}), text });
      annotations.push({ contentId: id, reasonId: reason.id, authorPersonId, address: wallet.address, walletOwnerPersonId: shared ? null : authorPersonId, addressUse: shared ? 'shared-fundraiser' : 'own' });
    }
  }

  // Commit after all authors, dates and templates have passed preflight.
  data.posts = data.posts.filter(item => item.fixtureSet !== WALLET_POST_SET);
  data.threads = data.threads.filter(item => item.fixtureSet !== WALLET_POST_SET);
  for (const { type, item, author, address } of additions) {
    (type === 'post' ? data.posts : data.threads).push(item);
    // This field records a PUBLIC reference, not verified ownership; fundraisers are shared.
    if (!author.walletAddresses.includes(address)) author.walletAddresses.push(address);
  }
  data.meta.counts.posts = data.posts.length;
  data.meta.counts.threads = data.threads.length;
  data.meta.counts.replies = data.threads.reduce((sum, thread) => sum + thread.replies.length, 0);
  data.meta.walletPostExamples = { fixtureSet: WALLET_POST_SET, total: examples.length, posts: 50, threads: 150, tag: WALLET_POST_TAG };
  // Motivation and actual ownership are benchmark labels, outside the public export.
  truth.walletPostExamples = { fixtureSet: WALLET_POST_SET, reasons: WALLET_POST_REASONS.map(reason => ({ ...reason })), examples: annotations };
  const accountsById = new Map(data.accounts.map(account => [account.id, account]));
  for (const person of truth.people) {
    person.walletAddresses = [...new Set(truth.accountLinks.filter(link => link.personId === person.id).flatMap(link => accountsById.get(link.accountId)?.walletAddresses ?? []))];
  }
  return examples;
}
