import fs from 'node:fs';
import path from 'node:path';
import { loadLab, persistLab } from '../lib/storage.mjs';
import { addWalletDisclosurePosts, WALLET_POST_REASONS } from '../lib/wallet-posts.mjs';

const apply = process.argv.includes('--apply');
if (apply) {
  // The running server holds state in memory and could overwrite an offline import.
  const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT || 8787)}/api/status`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
  if (response) throw new Error('Przed importem zatrzymaj lokalny serwer (Stop-Lab.ps1 lub Ctrl+C). Jego aktywny stan nie może być edytowany z pliku.');
}
const lab = structuredClone(loadLab());
const examples = addWalletDisclosurePosts(lab);
const directory = path.resolve('artifacts');
fs.mkdirSync(directory, { recursive: true });
const jsonlPath = path.join(directory, 'wallet-posts-200.jsonl');
const textPath = path.join(directory, 'wallet-posts-200.txt');
const header = [
  '200 SYNTETYCZNYCH POSTÓW UJAWNIAJĄCYCH ADRESY PORTFELI',
  'Identity Lab — wyłącznie lokalne serwisy i testowe adresy lab1.',
  '20 serwisów × 10 motywacji = 200 przykładów (50 wpisów + 150 wątków).',
  'Adresy dotyczą lokalnego blockchaina LAB. Żadne treści nie są publikowane w prawdziwych serwisach.',
  'Wspólny adres zbiórki jest adresem pośrednika, nie dowodem właścicielstwa autora.',
  'Oznaczenia motywacji i właścicieli są etykietami scenariusza, nie wynikami modelu.',
  'Filtr treści w portalu: #PortfelLAB.',
  '',
  'MOTYWACJE (po 20 przykładów):',
  ...WALLET_POST_REASONS.map((reason, index) => `${index + 1}. ${reason.label}`),
  '',
];
const blocks = examples.map((example, index) => [
  `${String(index + 1).padStart(3, '0')}/200 | ${example.serviceName} | ${example.reason}`,
  `Autor: @${example.username} (${example.accountId}) | ${example.type === 'post' ? 'wpis' : 'wątek'}`,
  `Portal: http://127.0.0.1:8787/s/${example.serviceSlug}`,
  `Profil: http://127.0.0.1:8787/s/${example.serviceSlug}/profile/${example.accountId}`,
  `Adres: ${example.address} | ${example.addressUse === 'own' ? 'własny adres autora' : 'wspólny adres zbiórki pośrednika'}`,
  ...(example.title ? [`Tytuł: ${example.title}`] : []),
  example.text,
].join('\n'));
fs.writeFileSync(jsonlPath, examples.map(example => JSON.stringify(example)).join('\n') + '\n', 'utf8');
fs.writeFileSync(textPath, header.join('\n') + blocks.join('\n\n' + '─'.repeat(70) + '\n\n') + '\n', 'utf8');
if (apply) persistLab(lab);
console.log(JSON.stringify({ applied: apply, examples: examples.length, services: new Set(examples.map(example => example.serviceId)).size, reasons: WALLET_POST_REASONS.length, posts: 50, threads: 150, files: [textPath, jsonlPath] }, null, 2));
