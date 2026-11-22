// Łączniki rejestrów pakietów: npm, PyPI, crates.io. Autorzy pakietów publikują w metadanych odnośniki
// „funding” / „Donate” i README z adresami portfeli na datki — to ich własna publikacja (`own_profile`).
// Adresy kryptowalutowe znajduje w treści dokumentu wspólny ekstraktor.
//
// Podstawa (sprawdzone 22.11.2026, wiersze w docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 12):
//   • npm Open Source Terms (https://docs.npmjs.com/policies/open-source-terms) — „You may replicate data from the
//     Public Registry using the Public APIs per this Agreement.”; zakaz automatyzacji dotyczy strony WWW („You will not
//     automate access to, use, or monitor the Website, such as with a web crawler”); pkt 4 Acceptable Use: „You will not
//     copy or share any personally identifiable information of any other person without their specific permission.”
//     → łącznik NIE kopiuje adresów e-mail ani imion autorów i opiekunów, tylko nazwy kont npm i metadane pakietu.
//   • PyPI Terms of Service (https://policies.python.org/pypi.org/Terms-of-Service/) — API Terms: zakazane jest
//     „excessive usage” i pobieranie danych „for spamming purposes … including for the purposes of selling PyPI users'
//     personal information”; https://docs.pypi.org/api/ — „Set your consumer's User-Agent header to uniquely identify
//     your requests. Adding your contact information to this value would be helpful as well.” robots.txt PyPI zawiera
//     „Disallow: /pypi/*/json” (roboty indeksujące) — opieramy się na tym, że JSON API jest udokumentowane dla programów.
//     Strona użytkownika (pypi.org/user/<nazwa>/) to HTML, nie API — nie jest używana.
//   • crates.io Data Access Policy (https://crates.io/data-access) — „you are welcome to use the crates.io API provided
//     you abide by the following limits: A maximum of 1 request per second, and A user-agent header that identifies your
//     application.” — odstęp 1 s, User-Agent z kontaktem z OLCYS_CONTACT.

import type { Identifier, ProfileAttributes, SourceConnector, SourceDocument } from '@olcys/core';
import { findEmails, htmlToText } from './html.ts';
import { parseJson, USER_AGENT } from './http.ts';
import type { HttpClient } from './http.ts';
import { cleanHandle, dedupeIdentifiers, discoveredField, parseHttpUrl, profileUrlIdentifier, serviceOf } from './identity.ts';

const MAX_README_CHARS = 20_000;

/** User-Agent z kontaktem operatora (OLCYS_CONTACT) — wymaganie crates.io i prośba PyPI. */
export function contactUserAgent(contact?: string): string {
  const value = (contact ?? process.env.OLCYS_CONTACT ?? '').trim();
  return value ? `OLCyS-research/0.1 (${value})` : USER_AGENT;
}

/** Adres repozytorium z metadanych pakietu (git+https://…, github:user/repo) jako zwykły adres https. */
export function repositoryUrl(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' ? (value as { url?: unknown }).url : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url = raw.trim();
  const shorthand = /^(github|gitlab|bitbucket):([\w.-]+\/[\w.-]+)$/i.exec(url) ?? /^([\w.-]+\/[\w.-]+)$/.exec(url);
  if (shorthand) {
    const host = shorthand.length === 3 ? { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[shorthand[1]!.toLowerCase()] : 'github.com';
    url = `https://${host}/${shorthand.at(-1)}`;
  }
  url = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Pole `funding` z package.json: napis, obiekt {type, url} albo lista — jako wiersze tekstu. */
export function fundingEntries(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(fundingEntries);
  if (value && typeof value === 'object') {
    const { type, url } = value as { type?: unknown; url?: unknown };
    if (typeof url === 'string' && url.trim()) return [`${typeof type === 'string' && type ? `${type}: ` : ''}${url.trim()}`];
  }
  return [];
}

const linkIdentifiers = (urls: (string | null | undefined)[], ownHosts: string[]): Identifier[] =>
  dedupeIdentifiers(
    urls.map((url) => (url ? profileUrlIdentifier(url) : null)).filter((item): item is Identifier => Boolean(item)),
    undefined,
    ownHosts,
  );

// ---------- npm ----------

const NPM_REGISTRY = 'https://registry.npmjs.org';
const NPM_SERVICE = 'npmjs.com';
const NPM_LABEL = 'npm';
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const NPM_USER = /^[a-z0-9][a-z0-9._-]{0,213}$/i;
const NPM_MANIFESTS = 3;

interface NpmSearchResult {
  objects?: { package?: { name?: string; description?: string; date?: string; links?: { npm?: string; homepage?: string; repository?: string }; maintainers?: { username?: string }[]; publisher?: { username?: string } } }[];
}

interface NpmManifest {
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  repository?: unknown;
  funding?: unknown;
  readme?: string;
  maintainers?: { name?: string }[];
  _npmUser?: { name?: string };
}

/** Czego szukać w npm: konta (opiekun pakietów) albo pakietu o podanej nazwie. */
export function npmTarget(identifier: Identifier): { user: string } | { pkg: string } | null {
  if (identifier.type === 'profile_url') {
    const url = parseHttpUrl(identifier.value);
    if (!url || serviceOf(url) !== NPM_SERVICE) return null;
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (parts[0] === 'package' && parts[1]) {
      const pkg = parts[1].startsWith('@') && parts[2] ? `${parts[1]}/${parts[2]}` : parts[1];
      return NPM_PACKAGE.test(pkg) && pkg.length <= 214 ? { pkg } : null;
    }
    if (parts[0]?.startsWith('~')) {
      const user = parts[0].slice(1);
      return NPM_USER.test(user) ? { user } : null;
    }
    return null;
  }
  const user = cleanHandle(identifier.value);
  return NPM_USER.test(user) ? { user } : null;
}

function npmDocument(manifest: NpmManifest, identifier: Identifier, byPackage: boolean, connectorId: string): SourceDocument | null {
  if (!manifest.name) return null;
  const maintainers = [...new Set((manifest.maintainers ?? []).map((item) => item?.name?.trim()).filter((name): name is string => Boolean(name)))];
  const funding = fundingEntries(manifest.funding);
  const repository = repositoryUrl(manifest.repository);
  const readme = typeof manifest.readme === 'string' && manifest.readme.trim() && !/^ERROR: No README/i.test(manifest.readme) ? manifest.readme.slice(0, MAX_README_CHARS) : '';
  const author = byPackage ? (manifest._npmUser?.name ?? maintainers[0]) : cleanHandle(identifier.value);
  const discovered: Identifier[] = [
    ...linkIdentifiers([repository, manifest.homepage, ...funding.map((entry) => entry.replace(/^[^:]+: (?=https?:)/, ''))], [NPM_SERVICE, 'registry.npmjs.org']),
    // Nazwy kont opiekunów (nie e-maile) — tylko gdy pakiet wskazano wprost; przy wyszukaniu po koncie to sam podmiot.
    ...(byPackage ? maintainers.map((value): Identifier => ({ type: 'nick', value })) : []),
  ];
  const profile: ProfileAttributes = { handle: author ?? manifest.name, ...(repository || manifest.homepage ? { urls: [repository, manifest.homepage].filter((url): url is string => Boolean(url)) } : {}) };
  return {
    connectorId,
    service: NPM_SERVICE,
    url: `https://www.npmjs.com/package/${manifest.name}`,
    title: `Pakiet npm ${manifest.name}${manifest.version ? ` ${manifest.version}` : ''}`,
    text: [
      `Pakiet npm: ${manifest.name}${manifest.version ? ` (wersja ${manifest.version})` : ''}`,
      manifest.description && `Opis: ${manifest.description}`,
      maintainers.length > 0 && `Opiekunowie (konta npm): ${maintainers.join(', ')}`,
      funding.length > 0 ? `Finansowanie (pole „funding”):\n${funding.map((entry) => `- ${entry}`).join('\n')}` : 'Finansowanie (pole „funding”): brak',
      repository && `Repozytorium: ${repository}`,
      manifest.homepage && `Strona: ${manifest.homepage}`,
      readme && `README:\n${readme}`,
    ]
      .filter(Boolean)
      .join('\n'),
    fetchedAt: new Date().toISOString(),
    ...(author ? { author } : {}),
    category: 'own_profile',
    identityMatch: 'exact_identifier',
    matchedIdentifier: identifier,
    profile,
    ...discoveredField(dedupeIdentifiers(discovered, identifier)),
  };
}

export function createNpmConnector(http: HttpClient): SourceConnector {
  const id = 'live-npm';
  return {
    id,
    service: NPM_SERVICE,
    label: NPM_LABEL,
    description:
      'Publiczne API rejestru npm (registry.npmjs.org): dla nazwy konta — pakiety, których konto jest opiekunem (/-/v1/search?text=maintainer:<konto>), ' +
      `i metadane najwyżej ${NPM_MANIFESTS} z nich; dla adresu npmjs.com/package/<pakiet> — metadane tego pakietu (/<pakiet>/latest). ` +
      'Odczytywane: opis, pole „funding”, repozytorium, strona, README, nazwy kont opiekunów. Adresów e-mail i imion autorów nie kopiujemy ' +
      '(regulamin npm, pkt 4 Acceptable Use). Pakiet trafia do wyniku tylko wtedy, gdy podane konto jest jego opiekunem. Najwyżej 4 żądania na identyfikator.',
    accepts: ['login', 'nick', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const target = npmTarget(identifier);
      if (!target) return [];
      const session = http.session(context, { label: NPM_LABEL });
      const manifest = async (name: string) => {
        const response = await session.get(`${NPM_REGISTRY}/${name.replace('/', '%2F')}/latest`, { headers: { Accept: 'application/json' }, quietMissing: true });
        return response ? parseJson<NpmManifest>(response.text) : null;
      };

      if ('pkg' in target) {
        const found = await manifest(target.pkg);
        const document = found ? npmDocument(found, identifier, true, id) : null;
        if (!document && !session.refused) context.log(`${NPM_LABEL}: brak pakietu „${target.pkg}".`);
        return document ? [document] : [];
      }

      const response = await session.get(`${NPM_REGISTRY}/-/v1/search?text=${encodeURIComponent(`maintainer:${target.user}`)}&size=20`, { headers: { Accept: 'application/json' } });
      const result = response ? parseJson<NpmSearchResult>(response.text) : null;
      const user = target.user.toLowerCase();
      // Wyszukiwarka bywa przybliżona — zostają wyłącznie pakiety, których opiekunem jest dokładnie to konto.
      const packages = (result?.objects ?? [])
        .map((item) => item.package)
        .filter((pkg): pkg is NonNullable<typeof pkg> => Boolean(pkg?.name && (pkg.maintainers ?? []).some((maintainer) => maintainer?.username?.toLowerCase() === user)));
      if (packages.length === 0) {
        if (!session.refused) context.log(`${NPM_LABEL}: konto „${target.user}" nie jest opiekunem żadnego pakietu (albo nie istnieje).`);
        return [];
      }
      const documents: SourceDocument[] = [
        {
          connectorId: id,
          service: NPM_SERVICE,
          url: `https://www.npmjs.com/~${target.user}`,
          title: `Pakiety npm konta ${target.user}`,
          text: [`Pakiety npm, których opiekunem jest konto ${target.user}:`, ...packages.map((pkg) => `- ${pkg.name}: ${pkg.description?.trim() || '(bez opisu)'}`)].join('\n'),
          fetchedAt: new Date().toISOString(),
          author: target.user,
          category: 'own_profile',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: { handle: target.user },
        },
      ];
      for (const pkg of packages.slice(0, NPM_MANIFESTS)) {
        const found = await manifest(pkg.name!);
        if (!found) {
          if (session.refused) break;
          continue;
        }
        const document = npmDocument(found, identifier, false, id);
        if (document) documents.push({ ...document, ...(pkg.date ? { publishedAt: pkg.date } : {}) });
      }
      context.log(`${NPM_LABEL}: „${target.user}" — pakietów: ${packages.length}, dokumentów: ${documents.length} (zapytań: ${session.used}).`);
      return documents;
    },
  };
}

// ---------- PyPI ----------

const PYPI = 'https://pypi.org';
const PYPI_SERVICE = 'pypi.org';
const PYPI_LABEL = 'PyPI';
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const FUNDING_KEY = /fund|donat|sponsor|support|tip|patreon|liberapay|open ?collective|ko-?fi|wesprzyj|wsparcie/i;

interface PypiProject {
  info?: {
    name?: string;
    version?: string;
    summary?: string | null;
    description?: string | null;
    author?: string | null;
    author_email?: string | null;
    maintainer?: string | null;
    maintainer_email?: string | null;
    home_page?: string | null;
    project_urls?: Record<string, string> | null;
  };
  urls?: { upload_time_iso_8601?: string }[];
}

export function pypiProjectName(identifier: Identifier): string | null {
  if (identifier.type !== 'profile_url') return null;
  const url = parseHttpUrl(identifier.value);
  if (!url || serviceOf(url) !== PYPI_SERVICE) return null;
  const [kind, name] = url.pathname.split('/').filter(Boolean);
  return kind === 'project' && name && PYPI_NAME.test(decodeURIComponent(name)) ? decodeURIComponent(name) : null;
}

export interface ContactConfig {
  /** Kontakt operatora do nagłówka User-Agent; domyślnie OLCYS_CONTACT. */
  contact?: string;
}

export function createPypiConnector(http: HttpClient, config: ContactConfig = {}): SourceConnector {
  const id = 'live-pypi';
  const userAgent = contactUserAgent(config.contact);
  return {
    id,
    service: PYPI_SERVICE,
    label: PYPI_LABEL,
    description:
      'Udokumentowane JSON API PyPI (pypi.org/pypi/<projekt>/json) dla adresu pypi.org/project/<projekt>: opis, odnośniki projektu ' +
      '(w tym „Funding” / „Donate”), autor i opiekun z adresem e-mail podanym w metadanych, README. Strony użytkowników PyPI (HTML) ' +
      'nie są odpytywane — pakiet musi być wskazany adresem, np. odkrytym w innym profilu. Jedno żądanie na identyfikator.',
    accepts: ['profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const name = pypiProjectName(identifier);
      if (!name) return [];
      const session = http.session(context, { label: PYPI_LABEL, limit: 1 });
      // Odpowiedź z listą wszystkich wydań bywa duża — limit 4 MB, żeby JSON nie został ucięty.
      const response = await session.get(`${PYPI}/pypi/${encodeURIComponent(name)}/json`, { headers: { Accept: 'application/json', 'User-Agent': userAgent }, quietMissing: true, maxBytes: 4_194_304 });
      const project = response ? parseJson<PypiProject>(response.text) : null;
      const info = project?.info;
      if (!info?.name) {
        if (!session.refused) context.log(`${PYPI_LABEL}: brak projektu „${name}".`);
        return [];
      }
      const projectUrls = Object.entries(info.project_urls ?? {}).filter(([, url]) => typeof url === 'string' && url.trim());
      const fundingUrls = projectUrls.filter(([label]) => FUNDING_KEY.test(label));
      const emails = [...new Set(findEmails(`${info.author_email ?? ''} ${info.maintainer_email ?? ''}`))];
      const readme = info.description?.trim() ? info.description.slice(0, MAX_README_CHARS) : '';
      const uploaded = (project?.urls ?? []).map((file) => file.upload_time_iso_8601).filter((time): time is string => Boolean(time)).sort().at(-1);
      const people = [info.author, info.maintainer].map((item) => item?.trim()).filter((item): item is string => Boolean(item));
      const discovered: Identifier[] = [
        ...emails.map((value): Identifier => ({ type: 'email', value })),
        ...linkIdentifiers([info.home_page, ...projectUrls.map(([, url]) => url)], [PYPI_SERVICE]),
      ];
      const document: SourceDocument = {
        connectorId: id,
        service: PYPI_SERVICE,
        url: `${PYPI}/project/${info.name}/`,
        title: `Projekt PyPI ${info.name}${info.version ? ` ${info.version}` : ''}`,
        text: [
          `Projekt PyPI: ${info.name}${info.version ? ` (wersja ${info.version})` : ''}`,
          info.summary && `Opis: ${info.summary}`,
          info.author && `Autor: ${info.author}`,
          info.maintainer && `Opiekun: ${info.maintainer}`,
          emails.length > 0 && `E-mail w metadanych: ${emails.join(', ')}`,
          fundingUrls.length > 0 ? `Finansowanie:\n${fundingUrls.map(([label, url]) => `- ${label}: ${url}`).join('\n')}` : 'Finansowanie: brak odnośnika',
          projectUrls.length > 0 && `Odnośniki projektu:\n${projectUrls.map(([label, url]) => `- ${label}: ${url}`).join('\n')}`,
          info.home_page && `Strona: ${info.home_page}`,
          readme && `README:\n${readme}`,
        ]
          .filter(Boolean)
          .join('\n'),
        fetchedAt: new Date().toISOString(),
        ...(uploaded ? { publishedAt: uploaded } : {}),
        ...(people[0] ? { author: people[0] } : {}),
        category: 'own_profile',
        identityMatch: 'exact_identifier',
        matchedIdentifier: identifier,
        profile: { handle: info.name, ...(people[0] ? { displayName: people[0] } : {}), ...(emails.length > 0 ? { emails } : {}) },
        ...discoveredField(dedupeIdentifiers(discovered, identifier, [PYPI_SERVICE])),
      };
      context.log(`${PYPI_LABEL}: „${name}" — odnośników finansowania: ${fundingUrls.length}.`);
      return [document];
    },
  };
}

// ---------- crates.io ----------

const CRATES = 'https://crates.io';
const CRATES_SERVICE = 'crates.io';
const CRATES_LABEL = 'crates.io';
const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Loginy crates.io to loginy GitHub. */
const CRATES_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** crates.io: „A maximum of 1 request per second”. */
const CRATES_INTERVAL_MS = 1000;

interface CrateInfo {
  name?: string;
  description?: string | null;
  homepage?: string | null;
  repository?: string | null;
  documentation?: string | null;
  updated_at?: string;
  max_version?: string;
  default_version?: string;
  newest_version?: string;
}

interface CrateOwner {
  login?: string;
  name?: string | null;
  kind?: string;
  url?: string | null;
}

export function cratesTarget(identifier: Identifier): { user: string } | { crate: string } | null {
  if (identifier.type === 'profile_url') {
    const url = parseHttpUrl(identifier.value);
    if (!url || serviceOf(url) !== CRATES_SERVICE) return null;
    const [kind, value] = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (kind === 'crates' && value && CRATE_NAME.test(value)) return { crate: value };
    if (kind === 'users' && value && CRATES_LOGIN.test(value)) return { user: value };
    return null;
  }
  const user = cleanHandle(identifier.value);
  return CRATES_LOGIN.test(user) ? { user } : null;
}

export function createCratesConnector(http: HttpClient, config: ContactConfig = {}): SourceConnector {
  const id = 'live-crates';
  const userAgent = contactUserAgent(config.contact);
  return {
    id,
    service: CRATES_SERVICE,
    label: CRATES_LABEL,
    description:
      'API crates.io (rejestr pakietów Rust): dla nazwy konta (login GitHub) — profil i lista jego skrzynek z opisami, stroną i repozytorium ' +
      '(/api/v1/users/<login>, /api/v1/crates?user_id=); dla adresu crates.io/crates/<nazwa> — metadane, właściciele i README skrzynki. ' +
      'Odstęp 1 s i User-Agent z kontaktem (OLCYS_CONTACT) zgodnie z zasadami crates.io. Najwyżej 3 żądania na identyfikator.',
    accepts: ['login', 'nick', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const target = cratesTarget(identifier);
      if (!target) return [];
      const session = http.session(context, { label: CRATES_LABEL, limit: 3 });
      const get = (path: string, accept = 'application/json') =>
        session.get(`${CRATES}/api/v1${path}`, { headers: { Accept: accept, 'User-Agent': userAgent }, quietMissing: true, minIntervalMs: CRATES_INTERVAL_MS, maxBytes: 2_097_152 });

      if ('user' in target) {
        const userResponse = await get(`/users/${encodeURIComponent(target.user)}`);
        const user = userResponse ? parseJson<{ user?: { id?: number; login?: string; name?: string | null; url?: string | null; avatar?: string | null } }>(userResponse.text)?.user : null;
        if (!user?.id || user.login?.toLowerCase() !== target.user.toLowerCase()) {
          if (!session.refused) context.log(`${CRATES_LABEL}: brak użytkownika „${target.user}".`);
          return [];
        }
        const listResponse = await get(`/crates?user_id=${user.id}&per_page=20`);
        const crates = (listResponse ? parseJson<{ crates?: CrateInfo[] }>(listResponse.text)?.crates : null) ?? [];
        const newest = crates.map((crate) => crate.updated_at).filter((time): time is string => Boolean(time)).sort().at(-1);
        const document: SourceDocument = {
          connectorId: id,
          service: CRATES_SERVICE,
          url: `${CRATES}/users/${user.login}`,
          title: `Skrzynki crates.io użytkownika ${user.login}`,
          text: [
            `Użytkownik crates.io: ${user.login}${user.name ? ` (${user.name})` : ''}`,
            user.url && `Konto GitHub: ${user.url}`,
            crates.length > 0 ? `Skrzynki, których jest właścicielem:\n${crates.map((crate) => `- ${crate.name}: ${crate.description?.trim() || '(bez opisu)'}${crate.homepage ? ` — strona: ${crate.homepage}` : ''}${crate.repository ? ` — repozytorium: ${crate.repository}` : ''}`).join('\n')}` : 'Skrzynki: brak',
          ]
            .filter(Boolean)
            .join('\n'),
          fetchedAt: new Date().toISOString(),
          ...(newest ? { publishedAt: newest } : {}),
          author: user.login!,
          category: 'own_profile',
          // Lista pochodzi z filtra po identyfikatorze właściciela — każda skrzynka należy do tego konta.
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: { handle: user.login!, ...(user.name ? { displayName: user.name } : {}), ...(user.avatar ? { avatarUrl: user.avatar } : {}), ...(user.url ? { urls: [user.url] } : {}) },
          ...discoveredField(dedupeIdentifiers(linkIdentifiers([user.url], [CRATES_SERVICE]), identifier)),
        };
        context.log(`${CRATES_LABEL}: „${target.user}" — skrzynek: ${crates.length} (zapytań: ${session.used}).`);
        return [document];
      }

      const crateResponse = await get(`/crates/${encodeURIComponent(target.crate)}`);
      const crate = crateResponse ? parseJson<{ crate?: CrateInfo }>(crateResponse.text)?.crate : null;
      if (!crate?.name) {
        if (!session.refused) context.log(`${CRATES_LABEL}: brak skrzynki „${target.crate}".`);
        return [];
      }
      const ownersResponse = await get(`/crates/${encodeURIComponent(crate.name)}/owners`);
      const owners = ((ownersResponse ? parseJson<{ users?: CrateOwner[] }>(ownersResponse.text)?.users : null) ?? []).filter((owner) => owner?.login);
      const version = crate.default_version ?? crate.max_version ?? crate.newest_version;
      const readmeResponse = version ? await get(`/crates/${encodeURIComponent(crate.name)}/${encodeURIComponent(version)}/readme`, 'text/html') : null;
      const readme = readmeResponse?.text.trim() ? htmlToText(readmeResponse.text).slice(0, MAX_README_CHARS) : '';
      const people = owners.filter((owner) => owner.kind !== 'team');
      const document: SourceDocument = {
        connectorId: id,
        service: CRATES_SERVICE,
        url: `${CRATES}/crates/${crate.name}`,
        title: `Skrzynka crates.io ${crate.name}${version ? ` ${version}` : ''}`,
        text: [
          `Skrzynka crates.io: ${crate.name}${version ? ` (wersja ${version})` : ''}`,
          crate.description && `Opis: ${crate.description.trim()}`,
          owners.length > 0 && `Właściciele: ${owners.map((owner) => `${owner.login}${owner.kind === 'team' ? ' (zespół)' : ''}`).join(', ')}`,
          crate.repository && `Repozytorium: ${crate.repository}`,
          crate.homepage && `Strona: ${crate.homepage}`,
          readme && `README:\n${readme}`,
        ]
          .filter(Boolean)
          .join('\n'),
        fetchedAt: new Date().toISOString(),
        ...(crate.updated_at ? { publishedAt: crate.updated_at } : {}),
        ...(people[0]?.login ? { author: people[0].login } : {}),
        category: 'own_profile',
        identityMatch: 'exact_identifier',
        matchedIdentifier: identifier,
        profile: { handle: people[0]?.login ?? crate.name, ...(people[0]?.name ? { displayName: people[0].name } : {}) },
        ...discoveredField(
          dedupeIdentifiers(
            [...people.map((owner): Identifier => ({ type: 'login', value: owner.login! })), ...linkIdentifiers([crate.repository, crate.homepage, ...people.map((owner) => owner.url)], [CRATES_SERVICE])],
            identifier,
          ),
        ),
      };
      context.log(`${CRATES_LABEL}: „${crate.name}" — właścicieli: ${owners.length} (zapytań: ${session.used}).`);
      return [document];
    },
  };
}
