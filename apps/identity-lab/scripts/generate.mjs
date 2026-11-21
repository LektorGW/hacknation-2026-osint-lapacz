import { buildLab, persistLab } from '../lib/storage.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('=')));
const seed = Number(args.seed ?? 67);
const people = Number(args.people ?? 180);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647 || !Number.isSafeInteger(people) || people < 30 || people > 1000) {
  console.error('Użycie: npm run generate -- --seed=67 --people=180 (30..1000 osób, seed 0..2147483647)');
  process.exit(1);
}
const lab = buildLab({seed, people});
persistLab(lab);
console.log(JSON.stringify({seed, people, services:lab.publicData.services.length, accounts:lab.publicData.accounts.length, posts:lab.publicData.posts.length, listings:lab.publicData.listings.length, threads:lab.publicData.threads.length}, null, 2));
