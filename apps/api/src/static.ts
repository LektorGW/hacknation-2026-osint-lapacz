// Tryb produkcyjny jednym procesem: API podaje też zbudowany interfejs (apps/web/dist) na tym samym porcie.
// Bez dodatkowych zależności — tylko pliki statyczne i powrót do index.html dla ścieżek aplikacji (SPA).
//
// Włączenie: OLCYS_SERVE_WEB=1 albo NODE_ENV=production i istniejący katalog z index.html.
// OLCYS_SERVE_WEB=0 wyłącza zawsze. Katalog: OLCYS_WEB_DIR (domyślnie apps/web/dist).

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const truthy = (value: string | undefined) => ['1', 'true', 'yes', 'tak'].includes((value ?? '').trim().toLowerCase());
const falsy = (value: string | undefined) => ['0', 'false', 'no', 'nie'].includes((value ?? '').trim().toLowerCase());

/** Katalog interfejsu i decyzja, czy go podawać. */
export function webServingConfig(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; dir: string; reason: string } {
  const dir = resolve(env.OLCYS_WEB_DIR?.trim() || DEFAULT_WEB_DIR);
  const built = existsSync(join(dir, 'index.html'));
  if (falsy(env.OLCYS_SERVE_WEB)) return { enabled: false, dir, reason: 'OLCYS_SERVE_WEB=0' };
  if (truthy(env.OLCYS_SERVE_WEB)) {
    return built ? { enabled: true, dir, reason: 'OLCYS_SERVE_WEB=1' } : { enabled: false, dir, reason: `brak ${join(dir, 'index.html')} — uruchom „pnpm build”` };
  }
  if (env.NODE_ENV === 'production' && built) return { enabled: true, dir, reason: 'NODE_ENV=production' };
  return { enabled: false, dir, reason: 'tryb deweloperski (interfejs podaje Vite)' };
}

/**
 * Rejestruje trasę `GET /*` podającą interfejs. Trasy `/api/...` mają pierwszeństwo (dokładniejsze dopasowanie),
 * a nieznana ścieżka `/api/...` dalej zwraca 404 w formacie JSON.
 */
export async function registerStaticWeb(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = webServingConfig(env);
  if (!config.enabled) {
    if (truthy(env.OLCYS_SERVE_WEB)) app.log.warn(`Interfejs nie będzie podawany: ${config.reason}.`);
    return;
  }
  const root = config.dir;
  const indexFile = join(root, 'index.html');
  app.log.info(`Interfejs podawany z ${root} (${config.reason}).`);

  app.get('/*', async (request, reply) => {
    const rawPath = request.url.split('?')[0] ?? '/';
    if (rawPath === '/api' || rawPath.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Nie znaleziono zasobu.' });
    }
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return reply.code(400).send({ error: 'Nieprawidłowa ścieżka.' });
    }
    if (path.includes('\0')) return reply.code(400).send({ error: 'Nieprawidłowa ścieżka.' });

    // Ścieżka musi pozostać wewnątrz katalogu interfejsu (bez „..”).
    const candidate = resolve(root, `.${path}`);
    const inside = candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
    let file: string | null = null;
    if (inside && candidate !== root) {
      try {
        if (statSync(candidate).isFile()) file = candidate;
      } catch {
        file = null;
      }
    }
    if (!file) {
      // Brak pliku z rozszerzeniem (np. /assets/stary-skrot.js) to 404; ścieżki aplikacji dostają index.html.
      if (extname(path) && path !== '/index.html') return reply.code(404).send({ error: 'Nie znaleziono zasobu.' });
      file = indexFile;
    }

    const stat = statSync(file);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const hashed = file.startsWith(join(root, 'assets') + sep);
    reply
      .header('Content-Type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
      .header('X-Content-Type-Options', 'nosniff')
      .header('ETag', etag)
      .header('Last-Modified', stat.mtime.toUTCString())
      // Pliki z /assets mają skrót treści w nazwie — mogą być trzymane długo; reszta (index.html) zawsze sprawdzana.
      .header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.header('Content-Length', stat.size);
    if (request.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(file));
  });
}
