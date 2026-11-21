// Syntetyczne środowisko demo: fikcyjne serwisy WWW i fikcyjny eksplorator bloków.
// Serwer niczego nie wymyśla — renderuje dane z data/scenario.ts, dzięki czemu
// prezentacja jest powtarzalna i nie dotyka danych prawdziwych osób.

import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { validateAddress } from '@olcys/core';
import { scenario } from '../data/scenario.ts';
import { registerExchangeReply } from './exchange-reply.ts';
import type { Account, DocKind, Service, Snapshot, Thread } from '../data/scenario.ts';

/**
 * Faza scenariusza podmiany adresu: `before` pokazuje stan sprzed podmiany
 * (stary adres na stronie, brak późniejszych kopii w archiwum), `after` — stan
 * bieżący. Przełączenie między dwiema analizami pozwala pokazać ich porównanie.
 */
export type Phase = 'before' | 'after';

export interface SandboxOptions {
  phase?: Phase;
}

interface Doc {
  service: Service;
  path: string;
  kind: DocKind;
  title: string;
  author: string;
  publishedAt: string;
  html: string;
  /** Wątek, do którego należy element (post, komentarz, wiadomość). */
  thread?: Thread;
}

type MatchedBy = 'handle' | 'email' | 'name' | 'address';

const SERVICES: Record<Service, { brand: string; tagline: string; color: string }> = {
  gitpub: { brand: 'GitPub', tagline: 'Profile programistów i otwarty kod', color: '#24292f' },
  www: { brand: 'Strony osobiste', tagline: 'Katalog prywatnych stron WWW', color: '#5b4636' },
  targ: { brand: 'Targ', tagline: 'Ogłoszenia lokalne i oferty P2P', color: '#0a7d4f' },
  forum: { brand: 'Forum Kopaczy', tagline: 'Forum branżowe i listy dyskusyjne', color: '#1d4e89' },
  spolecznosc: { brand: 'Społeczność', tagline: 'Serwis społecznościowy', color: '#7b2d8b' },
  komunikator: { brand: 'Komunikator Gołąb', tagline: 'Publiczne kanały grupowe', color: '#0f6e84' },
};

const KIND_LABEL: Record<DocKind, string> = {
  profile: 'Profil',
  page: 'Strona',
  offer: 'Ogłoszenie',
  post: 'Wpis',
  mail: 'Wiadomość z listy',
  comment: 'Komentarz',
  message: 'Wiadomość',
};

// ---------- Narzędzia ----------

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const day = (iso: string) => iso.slice(0, 10);

/** Porównywanie fraz: bez wielkości liter, polskich znaków i wiodącego „@". */
function normalize(text: string): string {
  return text
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

const stamp = (iso: string) => iso.replace(/\D/g, '').slice(0, 14);

function accountOf(service: Service, handle: string): Account | undefined {
  return scenario.accounts.find((account) => account.service === service && account.handle === handle);
}

/** Publiczne dane konta autora w postaci zwracanej przez API (pola puste są pomijane). */
function profileOf(service: Service, handle: string) {
  const account = accountOf(service, handle);
  return {
    handle,
    ...(account?.name ? { displayName: account.name } : {}),
    ...(account?.email ? { emails: [account.email] } : {}),
    ...(account?.phone ? { phones: [account.phone] } : {}),
    ...(account?.location ? { location: account.location } : {}),
    ...(account?.createdAt ? { createdAt: account.createdAt } : {}),
  };
}

/** Lista najnowszych obejmuje wszystkie rodzaje dokumentów — także profile i strony osobiste (z danymi kontaktowymi autora). */
const RECENT_KINDS: DocKind[] = ['offer', 'post', 'mail', 'comment', 'message', 'profile', 'page'];

/**
 * Wyszukiwarka dopasowuje wyłącznie publiczne dane autora (login/nick, e-mail,
 * imię i nazwisko) albo adres kryptowalutowy w treści. Zwraca, po czym trafiła.
 */
function matchQuery(service: Service, author: string, html: string, query: string): MatchedBy | null {
  const q = normalize(query);
  if (!q) return null;
  const account = accountOf(service, author);
  if (normalize(author) === q) return 'handle';
  if (account?.email && normalize(account.email) === q) return 'email';
  if (account?.name && normalize(account.name) === q) return 'name';
  if (validateAddress(query.trim()) && html.toLowerCase().includes(query.trim().toLowerCase())) return 'address';
  return null;
}

function snippet(html: string, query: string): string {
  const text = plain(html);
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = Math.max(0, at - 80);
  const cut = text.slice(start, start + 200);
  return (start > 0 ? '…' : '') + cut + (start + 200 < text.length ? '…' : '');
}

// ---------- Eksplorator ----------

interface ExplorerTransfer {
  txid: string;
  time: string;
  direction: 'in' | 'out';
  counterparty: string;
  // Opis kontrahenta od razu w przelewie — oszczędza modułowi blockchain osobnych zapytań.
  counterpartyLabel?: string;
  counterpartyClass?: string;
  counterpartyKind?: string;
  asset: string;
  amount: number;
}

interface ExplorerAddress {
  address: string;
  network: string;
  isContract: boolean;
  label?: string;
  addressClass?: string;
  /** Rodzaj usługi wyjścia do walut tradycyjnych (P2P, bramka, karta, zamiana na stablecoiny). */
  kind?: string;
  transfers: ExplorerTransfer[];
}

/** Buduje widok „adres → transakcje" z jednej księgi, więc obie strony przelewu są spójne. */
function buildExplorer(): Map<string, ExplorerAddress> {
  const index = new Map<string, ExplorerAddress>();
  const labels = new Map(scenario.labeledAddresses.map((item) => [item.address, item]));

  const entry = (address: string): ExplorerAddress => {
    const key = address.toLowerCase();
    const existing = index.get(key);
    if (existing) return existing;
    const valid = validateAddress(address);
    if (!valid) throw new Error(`Scenariusz zawiera niepoprawny adres: ${address}`);
    const known = labels.get(address);
    const created: ExplorerAddress = {
      address,
      network: valid.network,
      isContract: known?.isContract ?? false,
      ...(known?.label ? { label: known.label } : {}),
      ...(known?.addressClass ? { addressClass: known.addressClass } : {}),
      ...(known?.kind ? { kind: known.kind } : {}),
      transfers: [],
    };
    index.set(key, created);
    return created;
  };

  // Opisujemy tylko kontrahentów z etykietą (giełdy, usługi, kontrakty); adresy prywatne zostają anonimowe.
  const describe = (party: ExplorerAddress) =>
    party.label
      ? {
          counterpartyLabel: party.label,
          ...(party.addressClass ? { counterpartyClass: party.addressClass } : {}),
          ...(party.kind ? { counterpartyKind: party.kind } : {}),
        }
      : {};

  for (const item of scenario.labeledAddresses) entry(item.address);
  for (const row of scenario.ledger) {
    const from = entry(row.from);
    const to = entry(row.to);
    const hash = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    const txid = from.network === 'ethereum' ? `0x${hash}` : hash;
    const common = { txid, time: row.time, asset: row.asset, amount: row.amount };
    from.transfers.push({ ...common, direction: 'out', counterparty: row.to, ...describe(to) });
    to.transfers.push({ ...common, direction: 'in', counterparty: row.from, ...describe(from) });
  }
  return index;
}

// ---------- Widoki HTML ----------

const STYLE = `
body{font-family:system-ui,Segoe UI,sans-serif;margin:0;background:#f4f5f7;color:#1c1e21;line-height:1.5}
.demo{background:#fff3cd;color:#664d03;font-size:.8rem;padding:.3rem 1rem;text-align:center}
header.serwis{color:#fff;padding:.8rem 1.5rem;display:flex;gap:1.5rem;align-items:baseline;flex-wrap:wrap}
header.serwis a{color:#fff;text-decoration:none}
header.serwis .marka{font-size:1.3rem;font-weight:700}
header.serwis form{margin-left:auto}
nav.globalna{background:#e9ebee;padding:.3rem 1.5rem;font-size:.85rem}
nav.globalna a{margin-right:1rem;color:#333}
main{max-width:860px;margin:1.5rem auto;padding:0 1rem}
article,.element,.karta{background:#fff;border:1px solid #d8dbe0;border-radius:6px;padding:1rem 1.25rem;margin-bottom:1rem}
.meta{color:#65676b;font-size:.85rem}
code{background:#eef0f3;padding:.1rem .3rem;border-radius:3px;word-break:break-all}
table{border-collapse:collapse;width:100%;background:#fff;font-size:.85rem}
td,th{border:1px solid #d8dbe0;padding:.35rem .5rem;text-align:left;word-break:break-all}
h1{font-size:1.4rem;margin:.2rem 0}h2{font-size:1.1rem}
`;

function layout(prefix: string, brand: string, tagline: string, color: string, title: string, body: string): string {
  const globalLinks = [
    ...Object.entries(SERVICES).map(([key, value]) => `<a href="/${key}">${esc(value.brand)}</a>`),
    '<a href="/archiwum">Archiwum Sieci</a>',
    '<a href="/explorer">BlokSkan</a>',
  ].join('');
  return `<!doctype html>
<html lang="pl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(brand)}</title><style>${STYLE}</style></head>
<body>
<div class="demo">Środowisko demonstracyjne OŁCyŚ — wszystkie osoby, serwisy i adresy są fikcyjne.</div>
<header class="serwis" style="background:${color}">
  <a class="marka" href="${prefix}">${esc(brand)}</a><span>${esc(tagline)}</span>
  <form action="${prefix}/szukaj" method="get"><input name="q" placeholder="Szukaj: nick, e-mail, nazwisko, adres" size="34"> <button>Szukaj</button></form>
</header>
<nav class="globalna">${globalLinks}</nav>
<main>
${body}
</main>
</body>
</html>`;
}

function serviceLayout(service: Service, title: string, body: string): string {
  const meta = SERVICES[service];
  return layout(`/${service}`, meta.brand, meta.tagline, meta.color, title, body);
}

/** Nagłówek autora; na profilach i stronach własnych pokazuje też ujawnione dane konta. */
function authorLine(doc: { service: Service; kind: DocKind; author: string; publishedAt: string }): string {
  const account = accountOf(doc.service, doc.author);
  const parts = [`Autor: <span class="autor">${esc(doc.author)}</span>`];
  if (doc.kind === 'profile' || doc.kind === 'page') {
    if (account?.name) parts.push(esc(account.name));
    if (account?.email) parts.push(`<a href="mailto:${esc(account.email)}">${esc(account.email)}</a>`);
    if (account?.location) parts.push(esc(account.location));
  }
  parts.push(`<time datetime="${doc.publishedAt}">${day(doc.publishedAt)}</time>`);
  return `<p class="meta">${parts.join(' · ')}</p>`;
}

/** Treść dokumentu trafia do jedynego na stronie elementu <article> — z niego czytają łączniki. */
function article(doc: Doc): string {
  return `<article data-kind="${doc.kind}">
<header><p class="meta">${KIND_LABEL[doc.kind]}</p><h1>${esc(doc.title)}</h1>${authorLine(doc)}</header>
<div class="tresc">${doc.html}</div>
</article>`;
}

function resultList(results: { url: string; title: string; author: string; publishedAt: string; snippet: string }[]): string {
  if (results.length === 0) return '<p>Brak wyników.</p>';
  return results
    .map(
      (hit) => `<div class="karta"><a href="${hit.url}"><strong>${esc(hit.title)}</strong></a>
<p class="meta">${esc(hit.author)} · ${day(hit.publishedAt)}</p><p>${esc(hit.snippet)}</p></div>`,
    )
    .join('\n');
}

// ---------- Aplikacja ----------

export function buildApp(options: SandboxOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const explorer = buildExplorer();
  let phase: Phase = options.phase ?? 'after';

  const visibleSnapshots = (): Snapshot[] =>
    scenario.snapshots.filter((snapshot) => phase === 'after' || !snapshot.afterChange);

  /** Wszystkie dokumenty serwisów w bieżącej fazie, w postaci płaskiej listy. */
  const allDocs = (): Doc[] => {
    const docs: Doc[] = scenario.pages.map((page) => {
      if (phase === 'after') return page;
      // Przed podmianą strona na żywo ma treść ostatniej kopii sprzed zmiany.
      const earlier = scenario.snapshots
        .filter((s) => s.service === page.service && s.path === page.path && !s.afterChange)
        .at(-1);
      return earlier ? { ...page, html: earlier.html, publishedAt: earlier.archivedAt } : page;
    });
    for (const thread of scenario.threads) {
      if (thread.opening) {
        docs.push({ ...thread.opening, service: thread.service, path: thread.path, title: thread.title, thread });
      }
      thread.items.forEach((item, i) => {
        docs.push({
          ...item,
          service: thread.service,
          path: `${thread.path}/${thread.itemSegment}/${i + 1}`,
          kind: thread.itemKind,
          title: `${thread.title} — ${KIND_LABEL[thread.itemKind].toLowerCase()} #${i + 1}`,
          thread,
        });
      });
    }
    return docs;
  };

  const search = (service: Service, query: string) =>
    allDocs()
      .filter((doc) => doc.service === service)
      .flatMap((doc) => {
        const matchedBy = matchQuery(service, doc.author, doc.html, query);
        if (!matchedBy) return [];
        return [
          {
            url: `/${service}${doc.path}`,
            title: doc.title,
            author: doc.author,
            publishedAt: doc.publishedAt,
            snippet: snippet(doc.html, query),
            kind: doc.kind,
            matchedBy,
            profile: profileOf(service, doc.author),
          },
        ];
      });

  /** Najnowsze publikacje serwisu (ogłoszenia, posty, komentarze, wiadomości), od najświeższych. */
  const recent = (service: Service, limit: number) =>
    allDocs()
      .filter((doc) => doc.service === service && RECENT_KINDS.includes(doc.kind))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, limit)
      .map((doc) => ({
        url: `/${service}${doc.path}`,
        title: doc.title,
        author: doc.author,
        publishedAt: doc.publishedAt,
        snippet: plain(doc.html).slice(0, 200),
        kind: doc.kind,
        profile: profileOf(service, doc.author),
      }));

  /**
   * Adres kopii wzorem Wayback Machine: `/archiwum/web/<czas>/<pełny URL oryginału>`.
   * Z takiego adresu da się odzyskać adres strony pierwotnej i zestawić kopię z wersją bieżącą.
   */
  const snapshotUrl = (snapshot: Snapshot, origin: string) =>
    `${origin}/archiwum/web/${stamp(snapshot.archivedAt)}/${origin}/${snapshot.service}${snapshot.path}`;

  const originOf = (request: { protocol: string; host: string }) => `${request.protocol}://${request.host}`;

  const searchArchive = (query: string, origin: string) =>
    visibleSnapshots().flatMap((snapshot) => {
      const matchedBy = matchQuery(snapshot.service, snapshot.author, snapshot.html, query);
      if (!matchedBy) return [];
      return [
        {
          url: snapshotUrl(snapshot, origin),
          title: `${snapshot.title} (kopia z ${day(snapshot.archivedAt)})`,
          author: snapshot.author,
          publishedAt: snapshot.archivedAt,
          snippet: snippet(snapshot.html, query),
          kind: snapshot.kind,
          matchedBy,
          profile: profileOf(snapshot.service, snapshot.author),
          archivedAt: snapshot.archivedAt,
          originalService: snapshot.service,
          originalUrl: `${origin}/${snapshot.service}${snapshot.path}`,
        },
      ];
    });

  const html = (reply: { type(value: string): unknown }, body: string) => {
    reply.type('text/html; charset=utf-8');
    return body;
  };

  // --- Strona główna i przełącznik fazy ---

  app.get('/', (_request, reply) => {
    const cards = Object.entries(SERVICES)
      .map(([key, meta]) => `<div class="karta"><a href="/${key}"><strong>${esc(meta.brand)}</strong></a> — ${esc(meta.tagline)}</div>`)
      .join('\n');
    return html(
      reply,
      layout('', 'Piaskownica OŁCyŚ', 'Fikcyjny internet do prezentacji', '#343a40', 'Start', `
<h1>Fikcyjne serwisy</h1>
${cards}
<div class="karta"><a href="/archiwum"><strong>Archiwum Sieci</strong></a> — archiwalne kopie stron</div>
<div class="karta"><a href="/explorer"><strong>BlokSkan</strong></a> — eksplorator bloków (Bitcoin, Ethereum, Tron)</div>
<p class="meta"><a href="/_demo">Sterowanie scenariuszem podmiany adresu</a> (bieżąca faza: ${phase})</p>`),
    );
  });

  app.get('/_demo', (_request, reply) =>
    html(
      reply,
      layout('', 'Piaskownica OŁCyŚ', 'Sterowanie scenariuszem', '#343a40', 'Scenariusz', `
<h1>Podmiana adresu na stronie /www/dsroka</h1>
<p>Bieżąca faza: <strong>${phase}</strong></p>
<p><a href="/_demo/faza/before">Ustaw „before"</a> — strona pokazuje stary adres, archiwum nie zna jeszcze nowej wersji.</p>
<p><a href="/_demo/faza/after">Ustaw „after"</a> — strona pokazuje nowy adres, stary pozostaje w archiwum.</p>
<p class="meta">Wykonaj analizę w fazie „before", przełącz na „after" i wykonaj ją ponownie, aby porównać wyniki.</p>`),
    ),
  );

  registerExchangeReply(app);

  app.get<{ Params: { phase: string } }>('/_demo/faza/:phase', (request, reply) => {
    if (request.params.phase !== 'before' && request.params.phase !== 'after') {
      return reply.code(400).send({ error: 'Dozwolone fazy: before, after' });
    }
    phase = request.params.phase;
    return reply.redirect('/_demo');
  });

  // --- Serwisy z treścią ---

  for (const service of Object.keys(SERVICES) as Service[]) {
    app.get(`/${service}`, (_request, reply) => {
      const docs = allDocs().filter((doc) => doc.service === service);
      const singles = docs
        .filter((doc) => !doc.thread)
        .map(
          (doc) => `<div class="karta"><a href="/${service}${doc.path}"><strong>${esc(doc.title)}</strong></a>
<p class="meta">${KIND_LABEL[doc.kind]} · ${esc(doc.author)} · ${day(doc.publishedAt)}</p></div>`,
        );
      const threads = scenario.threads
        .filter((thread) => thread.service === service)
        .map(
          (thread) => `<div class="karta"><a href="/${service}${thread.path}"><strong>${esc(thread.title)}</strong></a>
<p class="meta">${thread.items.length} × ${KIND_LABEL[thread.itemKind].toLowerCase()}</p></div>`,
        );
      return html(
        reply,
        serviceLayout(service, SERVICES[service].brand, `<h1>${esc(SERVICES[service].tagline)}</h1>\n${[...threads, ...singles].join('\n')}`),
      );
    });

    app.get<{ Querystring: { q?: string } }>(`/${service}/api/search`, (request) => search(service, request.query.q ?? ''));

    app.get<{ Querystring: { limit?: string } }>(`/${service}/api/recent`, (request) => {
      const limit = Number.parseInt(request.query.limit ?? '', 10);
      return recent(service, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20);
    });

    app.get<{ Querystring: { q?: string } }>(`/${service}/szukaj`, (request, reply) => {
      const query = request.query.q ?? '';
      return html(
        reply,
        serviceLayout(service, `Szukaj: ${query}`, `<h1>Wyniki dla „${esc(query)}"</h1>\n${resultList(search(service, query))}`),
      );
    });

    app.get<{ Params: { '*': string } }>(`/${service}/*`, (request, reply) => {
      const path = `/${request.params['*']}`.replace(/\/$/, '');
      const thread = scenario.threads.find((item) => item.service === service && item.path === path);
      const docs = allDocs().filter((doc) => doc.service === service);

      if (thread) {
        // Strona wątku: wpis otwierający (jeśli jest) to dokument, elementy mają własne adresy.
        const opening = docs.find((doc) => doc.path === path);
        const items = docs
          .filter((doc) => doc.thread === thread && doc.path !== path)
          .map(
            (doc) => `<div class="element">${authorLine(doc)}<div class="tresc">${doc.html}</div>
<p class="meta"><a href="/${service}${doc.path}">odnośnik bezpośredni</a></p></div>`,
          );
        const head = opening ? article(opening) : `<h1>${esc(thread.title)}</h1>`;
        return html(
          reply,
          serviceLayout(service, thread.title, `${head}\n<section class="elementy">\n${items.join('\n')}\n</section>`),
        );
      }

      const doc = docs.find((item) => item.path === path);
      if (!doc) {
        reply.code(404);
        return html(reply, serviceLayout(service, 'Nie znaleziono', '<h1>Nie znaleziono strony</h1>'));
      }
      const back = doc.thread
        ? `<p class="meta"><a href="/${service}${doc.thread.path}">← ${esc(doc.thread.title)}</a></p>`
        : '';
      return html(reply, serviceLayout(service, doc.title, `${back}\n${article(doc)}`));
    });
  }

  // --- Archiwum ---

  const archiveLayout = (title: string, body: string) =>
    layout('/archiwum', 'Archiwum Sieci', 'Archiwalne kopie stron', '#8a5a00', title, body);

  app.get('/archiwum', (request, reply) => {
    const rows = visibleSnapshots()
      .map(
        (snapshot) => `<div class="karta"><a href="${snapshotUrl(snapshot, originOf(request))}"><strong>${esc(snapshot.title)}</strong></a>
<p class="meta">Kopia z ${day(snapshot.archivedAt)} · oryginał: /${snapshot.service}${snapshot.path}</p></div>`,
      )
      .join('\n');
    return html(reply, archiveLayout('Archiwum', `<h1>Zapisane kopie stron</h1>\n${rows}`));
  });

  app.get<{ Querystring: { q?: string } }>('/archiwum/api/search', (request) =>
    searchArchive(request.query.q ?? '', originOf(request)),
  );

  app.get<{ Querystring: { q?: string } }>('/archiwum/szukaj', (request, reply) => {
    const query = request.query.q ?? '';
    return html(reply, archiveLayout(`Szukaj: ${query}`, `<h1>Wyniki dla „${esc(query)}"</h1>\n${resultList(searchArchive(query, originOf(request)))}`));
  });

  app.get<{ Params: { stamp: string; '*': string } }>('/archiwum/web/:stamp/*', (request, reply) => {
    // Oryginał może być podany pełnym adresem URL albo samą ścieżką.
    const original = request.params['*'].replace(/^https?:\/\/?[^/]+/, '').replace(/^\/*/, '/');
    const snapshot = visibleSnapshots().find(
      (item) => stamp(item.archivedAt) === request.params.stamp && `/${item.service}${item.path}` === original,
    );
    if (!snapshot) {
      reply.code(404);
      return html(reply, archiveLayout('Nie znaleziono', '<h1>Brak takiej kopii w archiwum</h1>'));
    }
    const doc: Doc = { ...snapshot, publishedAt: snapshot.archivedAt };
    return html(
      reply,
      archiveLayout(
        snapshot.title,
        `<p class="meta">Kopia strony <a href="/${snapshot.service}${snapshot.path}">/${snapshot.service}${snapshot.path}</a> zapisana <time datetime="${snapshot.archivedAt}">${snapshot.archivedAt}</time></p>\n${article(doc)}`,
      ),
    );
  });

  // --- Eksplorator bloków ---

  const explorerLayout = (title: string, body: string) =>
    layout('/explorer', 'BlokSkan', 'Eksplorator bloków: Bitcoin, Ethereum, Tron', '#12355b', title, body);

  app.get('/explorer', (_request, reply) => {
    const rows = [...explorer.values()]
      .filter((item) => item.label)
      .map((item) => `<tr><td><a href="/explorer/address/${item.address}">${item.address}</a></td><td>${item.network}</td><td>${esc(item.label!)}</td></tr>`)
      .join('\n');
    return html(reply, explorerLayout('Adresy', `<h1>Adresy z etykietą</h1>
<table><tr><th>Adres</th><th>Sieć</th><th>Etykieta</th></tr>${rows}</table>`));
  });

  app.get<{ Querystring: { q?: string } }>('/explorer/szukaj', (request, reply) =>
    reply.redirect(`/explorer/address/${encodeURIComponent((request.query.q ?? '').trim())}`),
  );

  app.get<{ Params: { address: string } }>('/explorer/api/address/:address', (request, reply) => {
    const found = explorer.get(request.params.address.toLowerCase());
    if (!found) return reply.code(404).send({ error: 'Nieznany adres' });
    return found;
  });

  app.get<{ Params: { address: string } }>('/explorer/address/:address', (request, reply) => {
    const found = explorer.get(request.params.address.toLowerCase());
    if (!found) {
      reply.code(404);
      return html(reply, explorerLayout('Nieznany adres', '<h1>Nieznany adres</h1><p>Brak transakcji dla podanego adresu.</p>'));
    }
    const rows = found.transfers
      .map(
        (transfer) => `<tr><td>${transfer.time.replace('T', ' ').replace('Z', '')}</td>
<td>${transfer.direction === 'in' ? 'wpływ' : 'wypływ'}</td>
<td><a href="/explorer/address/${transfer.counterparty}">${transfer.counterparty}</a>${transfer.counterpartyLabel ? `<br><span class="meta">${esc(transfer.counterpartyLabel)}</span>` : ''}</td>
<td>${transfer.amount} ${esc(transfer.asset)}</td><td>${transfer.txid.slice(0, 18)}…</td></tr>`,
      )
      .join('\n');
    return html(reply, explorerLayout(found.address, `<h1>Adres ${found.address}</h1>
<p class="meta">Sieć: ${found.network} · ${found.isContract ? 'smart kontrakt' : 'adres zwykły'}${found.label ? ` · Etykieta: <strong>${esc(found.label)}</strong>` : ''}</p>
<table><tr><th>Czas (UTC)</th><th>Kierunek</th><th>Kontrahent</th><th>Kwota</th><th>Transakcja</th></tr>${rows}</table>`));
  });

  return app;
}
