import fs from 'node:fs';
import path from 'node:path';
import { generateDataset } from './generator.mjs';
import { createBlockchain, validateBlockchain } from './blockchain.mjs';

export const DATA_DIR = path.resolve(process.env.LAB_DATA_DIR || 'data');
export function saveJson(name, value, directory = DATA_DIR) {
  fs.mkdirSync(directory, {recursive: true});
  const destination = path.join(directory, name);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, destination);
}
export function buildLab({seed = 67, people = 180} = {}) {
  const {publicData, groundTruth} = generateDataset({seed, people});
  const chain = createBlockchain({seed, walletCount: 30, difficulty: 2});
  // Convert abstract addresses into registered LAB addresses for a subset of people.
  const personIndex = new Map(groundTruth.people.map((person, i) => [person.id, i]));
  const accountsById = new Map(publicData.accounts.map(account => [account.id, account]));
  for (const link of groundTruth.accountLinks) {
    const account = accountsById.get(link.accountId);
    if (!account) continue;
    const i = personIndex.get(link.personId);
    account.walletAddresses = i < 29 && account.walletAddresses.length ? [chain.wallets[i].address] : [];
  }
  // The shared payment intermediary intentionally produces an ownership trap.
  const sharedAccounts = [5,11].map(i => groundTruth.accountLinks.find(link => link.personId === groundTruth.people[i]?.id && link.role === 'ordinary')).filter(Boolean);
  for (const link of sharedAccounts) accountsById.get(link.accountId).walletAddresses.push(chain.wallets[29].address);
  chain.wallets[29].label = 'Portfel pośrednika LAB';
  groundTruth.scenarios.push({id:'shared-payment-address',name:'Wspólny adres pośrednika, różne osoby',query:chain.wallets[29].address,personIds:sharedAccounts.map(l=>l.personId),accountIds:sharedAccounts.map(l=>l.accountId),expected:'ambiguous',description:'Dwie niezależne osoby podają adres wspólnego pośrednika płatności. Wspólny portfel może dać fałszywe dopasowanie.'});
  for (const person of groundTruth.people) {
    person.walletAddresses = [...new Set(groundTruth.accountLinks.filter(link => link.personId === person.id).flatMap(link => accountsById.get(link.accountId)?.walletAddresses || []))];
  }
  return {publicData, groundTruth, chain};
}
export function persistLab(lab, directory = DATA_DIR) {
  saveJson('public.json', lab.publicData, directory);
  saveJson('ground-truth.json', lab.groundTruth, directory);
  saveJson('blockchain-private.json', lab.chain, directory);
  // This single atomic snapshot is authoritative; separate files are exports.
  saveJson('lab-state.json', lab, directory);
}
export function loadLab(directory = DATA_DIR) {
  const snapshot = path.join(directory, 'lab-state.json');
  if (fs.existsSync(snapshot)) return JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  const names = ['public.json', 'ground-truth.json', 'blockchain-private.json'];
  if (names.every(name => fs.existsSync(path.join(directory, name)))) {
    const [publicData, groundTruth, chain] = names.map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
    if (publicData.meta.seed !== groundTruth.meta.seed || chain.seed !== publicData.meta.seed || !validateBlockchain(chain).valid) throw new Error('Niespójny lokalny zestaw plików. Odtwórz go poleceniem npm run generate.');
    return {publicData, groundTruth, chain};
  }
  const lab = buildLab();
  persistLab(lab, directory);
  return lab;
}
