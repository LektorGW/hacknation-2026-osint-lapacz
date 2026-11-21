// Łącznik Farcaster — otwarty protokół społecznościowy, w którym konto (fid) dowodzi kontroli nad
// adresami portfeli podpisem kryptograficznym. Używamy wyłącznie punktów końcowych opisanych
// w oficjalnej dokumentacji (docs.farcaster.xyz) jako dostępne bez uwierzytelnienia:
//   • rejestr nazw   fnames.farcaster.xyz/transfers/current?name=<nazwa>   → fid i adres powierniczy,
//   • adres główny   api.farcaster.xyz/fc/primary-address?fid=&protocol=   → zweryfikowany adres ETH / SOL,
//   • konta          api.farcaster.xyz/fc/account-verifications?fid=       → zweryfikowane konto X / GitHub.
// Opcjonalnie (FARCASTER_HUB_URL) własny węzeł Snapchain: pełna lista zweryfikowanych adresów
// z podpisami oraz nazwy ENS używane jako nazwa konta. Wyszukiwanie odwrotne (adres → konto)
// wymaga w API klienta uwierzytelnienia, więc go nie ma.

import type { Identifier, IdentityMatch, SourceCategory, SourceConnector, SourceDocument } from '@olcys/core';
import { parseJson } from '../http.ts';
import type { HttpClient, HttpSession } from '../http.ts';
import { cleanHandle, dedupeIdentifiers, discoveredField, handleFromIdentifier, sameHandle } from '../identity.ts';

export const FARCASTER_ID = 'live-farcaster';
const SERVICE = 'farcaster.xyz';
const LABEL = 'Farcaster';
const FNAMES = 'https://fnames.farcaster.xyz';
const CLIENT_API = 'https://api.farcaster.xyz';
const PROFILE_HOSTS = ['farcaster.xyz', 'warpcast.com'];
const MAX_REQUESTS = 7;

/** Nazwy z rejestru fnames: małe litery, cyfry i łącznik, do 16 znaków. */
const FNAME = /^[a-z0-9][a-z0-9-]{0,15}$/;
const ENS_NAME = /^(?:[a-z0-9_-]+\.)+eth$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface FarcasterOptions {
  /** Adres własnego węzła Snapchain (HTTP API, np. `http://127.0.0.1:3381`); bez niego łącznik używa tylko API publicznego. */
  hubUrl?: string;
}

export interface FarcasterAccount {
  fid: number;
  username: string;
  /** Adres powierniczy (custody) konta z rejestru nazw. */
  custody?: string;
  primaryEthereum?: string;
  primarySolana?: string;
  /** Wszystkie zweryfikowane adresy z węzła Snapchain (gdy skonfigurowany). */
  verified: { address: string; protocol: 'ethereum' | 'solana' }[];
  accounts: { platform: string; username: string }[];
}

const asObject = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' ? (value as Record<string, unknown>) : null);
const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Rejestr nazw: `{ transfer: { username, owner, to } }`; `to` równe 0 oznacza nazwę wyrejestrowaną. */
export function parseFnameTransfer(json: unknown): { fid: number; username: string; custody?: string } | null {
  const transfer = asObject(asObject(json)?.transfer);
  if (!transfer) return null;
  const fid = Number(transfer.to);
  const username = asText(transfer.username);
  if (!Number.isInteger(fid) || fid <= 0 || !username) return null;
  const owner = asText(transfer.owner);
  return { fid, username, ...(EVM_ADDRESS.test(owner) ? { custody: owner } : {}) };
}

/** Adres główny: `{ result: { address: { fid, protocol, address } } }`. */
export function parsePrimaryAddress(json: unknown, protocol: 'ethereum' | 'solana'): string | undefined {
  const entry = asObject(asObject(asObject(json)?.result)?.address);
  const address = asText(entry?.address);
  if (asText(entry?.protocol) !== protocol) return undefined;
  return (protocol === 'ethereum' ? EVM_ADDRESS : SOLANA_ADDRESS).test(address) ? address : undefined;
}

/** Zweryfikowane konta: `{ result: { verifications: [{ fid, platform, platformUsername }] } }`. */
export function parseAccountVerifications(json: unknown, fid: number): { platform: string; username: string }[] {
  const list = asObject(asObject(json)?.result)?.verifications;
  if (!Array.isArray(list)) return [];
  const found: { platform: string; username: string }[] = [];
  for (const item of list) {
    const entry = asObject(item);
    const platform = asText(entry?.platform).toLowerCase();
    const username = cleanHandle(asText(entry?.platformUsername));
    if (entry && Number(entry.fid) === fid && platform && /^[A-Za-z0-9_.-]{1,40}$/.test(username)) found.push({ platform, username });
  }
  return found;
}

/** Węzeł Snapchain, `verificationsByFid`: wiadomości z adresem i podpisem właściciela adresu. */
export function parseHubVerifications(json: unknown): { address: string; protocol: 'ethereum' | 'solana' }[] {
  const messages = asObject(json)?.messages;
  if (!Array.isArray(messages)) return [];
  const found = new Map<string, { address: string; protocol: 'ethereum' | 'solana' }>();
  for (const message of messages) {
    const data = asObject(asObject(message)?.data);
    const body = asObject(data?.verificationAddAddressBody) ?? asObject(data?.verificationAddEthAddressBody);
    const address = asText(body?.address);
    if (EVM_ADDRESS.test(address)) found.set(address.toLowerCase(), { address, protocol: 'ethereum' });
    else if (SOLANA_ADDRESS.test(address)) found.set(address, { address, protocol: 'solana' });
  }
  return [...found.values()];
}

/** Węzeł Snapchain, `userNameProofByName`: `{ name, owner, fid, type }`. */
export function parseUsernameProof(json: unknown): { fid: number; username: string; custody?: string } | null {
  const proof = asObject(json);
  const fid = Number(proof?.fid);
  const username = asText(proof?.name);
  if (!proof || !Number.isInteger(fid) || fid <= 0 || !username) return null;
  const owner = asText(proof.owner);
  return { fid, username, ...(EVM_ADDRESS.test(owner) ? { custody: owner } : {}) };
}

/** Która zweryfikowana nazwa konta (X, GitHub) jest równa identyfikatorowi podanemu przez analityka. */
function confirmedBy(account: FarcasterAccount, identifier: Identifier): string | null {
  if (identifier.type !== 'nick' && identifier.type !== 'login') return null;
  const match = account.accounts.find((entry) => sameHandle(entry.username, identifier.value) && (identifier.type === 'nick' || entry.platform === 'github'));
  return match ? match.platform : null;
}

const accountUrl = (entry: { platform: string; username: string }): string | null =>
  entry.platform === 'x' ? `https://x.com/${entry.username}` : entry.platform === 'github' ? `https://github.com/${entry.username}` : null;

function describe(account: FarcasterAccount, heading: string, hub: boolean): string {
  const extra = account.verified.filter((entry) => entry.address !== account.primaryEthereum && entry.address !== account.primarySolana);
  return [
    heading,
    `Konto Farcaster: @${account.username} (fid ${account.fid})`,
    account.primaryEthereum
      ? `Adres główny Ethereum (zweryfikowany w protokole podpisem właściciela adresu): ${account.primaryEthereum}`
      : 'Adres główny Ethereum: brak',
    account.primarySolana ? `Adres główny Solana (zweryfikowany w protokole podpisem właściciela adresu): ${account.primarySolana}` : 'Adres główny Solana: brak',
    extra.length > 0 && `Pozostałe zweryfikowane adresy (węzeł Snapchain):\n${extra.map((entry) => `- ${entry.protocol}: ${entry.address}`).join('\n')}`,
    !hub && 'Pełna lista zweryfikowanych adresów wymaga własnego węzła Snapchain (FARCASTER_HUB_URL) — tu tylko adresy główne.',
    account.custody && `Adres właściciela nazwy zapisany w rejestrze nazw przy jej rejestracji lub przeniesieniu (zwykle portfel techniczny aplikacji, nie portfel płatniczy): ${account.custody}`,
    account.accounts.length > 0
      ? `Konta zweryfikowane przez klienta Farcaster:\n${account.accounts.map((entry) => `- ${entry.platform}: ${entry.username}`).join('\n')}`
      : 'Konta zweryfikowane (X, GitHub): brak',
  ]
    .filter(Boolean)
    .join('\n');
}

export function createFarcasterConnector(http: HttpClient, options: FarcasterOptions = {}): SourceConnector {
  const hub = options.hubUrl?.trim().replace(/\/+$/, '') || undefined;
  const headers = { Accept: 'application/json' };

  async function lookupName(name: string, session: HttpSession): Promise<{ fid: number; username: string; custody?: string } | null> {
    if (FNAME.test(name)) {
      const response = await session.get(`${FNAMES}/transfers/current?name=${encodeURIComponent(name)}`, { headers, quietMissing: true });
      return response ? parseFnameTransfer(parseJson(response.text)) : null;
    }
    // Nazwa ENS jako nazwa konta jest dowodzona tylko w węźle (username proof).
    if (hub && ENS_NAME.test(name)) {
      const response = await session.get(`${hub}/v1/userNameProofByName?name=${encodeURIComponent(name)}`, { headers, quietMissing: true });
      return response ? parseUsernameProof(parseJson(response.text)) : null;
    }
    return null;
  }

  return {
    id: FARCASTER_ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Farcaster (otwarty protokół społecznościowy), wyłącznie udokumentowane publiczne API bez uwierzytelnienia: nick lub login → nazwa konta ' +
      'w rejestrze fnames.farcaster.xyz (dokładna nazwa, do 16 znaków) → fid → adres główny Ethereum i Solana (api.farcaster.xyz/fc/primary-address) ' +
      'oraz zweryfikowane konta X i GitHub (api.farcaster.xyz/fc/account-verifications). Adresy są zweryfikowane w protokole podpisem właściciela adresu. ' +
      'Sama zgodność nazwy to „ten sam nick"; powiązanie jest potwierdzone, gdy zweryfikowane konto X/GitHub ma nazwę równą identyfikatorowi albo analityk ' +
      'podał adres profilu farcaster.xyz/<nazwa>. ' +
      (hub
        ? 'Skonfigurowany własny węzeł Snapchain: pełna lista zweryfikowanych adresów i nazwy ENS jako nazwa konta. '
        : 'Bez własnego węzła Snapchain (FARCASTER_HUB_URL) tylko adresy główne; nazwy ENS jako nazwa konta są pomijane. ') +
      `Brak wyszukiwania odwrotnego po adresie (wymaga uwierzytelnienia). Najwyżej ${MAX_REQUESTS} żądań na identyfikator.`,
    accepts: ['nick', 'login', 'ens_name', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const handle = handleFromIdentifier(identifier, PROFILE_HOSTS);
      const name = handle?.toLowerCase() ?? '';
      if (!name || !(FNAME.test(name) || ENS_NAME.test(name))) return [];
      if (identifier.type === 'ens_name' && !hub) return [];

      const session = http.session(context, { label: LABEL, limit: MAX_REQUESTS });
      const found = await lookupName(name, session);
      if (!found) {
        if (!session.refused) context.log(`${LABEL}: „${name}" — brak konta o tej nazwie.`);
        return [];
      }

      const account: FarcasterAccount = { ...found, verified: [], accounts: [] };
      for (const protocol of ['ethereum', 'solana'] as const) {
        const response = await session.get(`${CLIENT_API}/fc/primary-address?fid=${found.fid}&protocol=${protocol}`, { headers, quietMissing: true });
        const address = response ? parsePrimaryAddress(parseJson(response.text), protocol) : undefined;
        if (address && protocol === 'ethereum') account.primaryEthereum = address;
        if (address && protocol === 'solana') account.primarySolana = address;
      }
      for (const platform of ['x', 'github']) {
        const response = await session.get(`${CLIENT_API}/fc/account-verifications?fid=${found.fid}&platform=${platform}`, { headers, quietMissing: true });
        if (response) account.accounts.push(...parseAccountVerifications(parseJson(response.text), found.fid));
      }
      if (hub) {
        const response = await session.get(`${hub}/v1/verificationsByFid?fid=${found.fid}`, { headers, quietMissing: true });
        if (response) account.verified = parseHubVerifications(parseJson(response.text));
      }

      const hasAddress = Boolean(account.primaryEthereum || account.primarySolana || account.verified.length > 0);
      const confirmation = confirmedBy(account, identifier);
      let category: SourceCategory = 'cryptographic_proof';
      let identityMatch: IdentityMatch;
      let heading: string;
      if (identifier.type === 'profile_url') {
        identityMatch = 'exact_identifier';
        heading = 'Konto Farcaster wskazane adresem profilu; adresy portfeli są zweryfikowane w protokole podpisem właściciela adresu.';
      } else if (confirmation) {
        identityMatch = 'verified_link';
        heading = `Konto Farcaster @${account.username} ma zweryfikowane konto „${confirmation}" o nazwie równej identyfikatorowi „${identifier.value}"; adresy portfeli są zweryfikowane w protokole podpisem właściciela adresu.`;
      } else {
        // Sama zgodność nazwy: dowód dotyczy związku konto–adres, nie związku podmiot–konto.
        category = 'own_profile';
        identityMatch = 'same_handle';
        heading = `UWAGA: konto Farcaster @${account.username} znalezione wyłącznie po nazwie równej identyfikatorowi „${identifier.value}" — właścicielem może być inna osoba. Adresy są zweryfikowane dla tego konta, nie dla podmiotu.`;
      }

      const urls = account.accounts.map(accountUrl).filter((url): url is string => url !== null);
      const discovered: Identifier[] =
        identityMatch === 'same_handle'
          ? []
          : account.accounts.map((entry): Identifier => ({ type: entry.platform === 'github' ? 'login' : 'nick', value: entry.username }));

      const document: SourceDocument = {
        connectorId: FARCASTER_ID,
        service: SERVICE,
        url: `https://farcaster.xyz/${account.username}`,
        title: `Farcaster: @${account.username}`,
        text: describe(account, heading, Boolean(hub)),
        fetchedAt: new Date().toISOString(),
        author: account.username,
        category,
        identityMatch,
        matchedIdentifier: identifier,
        profile: { handle: account.username, ...(urls.length > 0 ? { urls } : {}) },
        ...discoveredField(
          dedupeIdentifiers(
            discovered.filter((item) => !sameHandle(item.value, identifier.value)),
            identifier,
          ),
        ),
      };
      context.log(`${LABEL}: „${name}" → fid ${account.fid}, ${hasAddress ? 'są zweryfikowane adresy' : 'brak zweryfikowanych adresów'} (${identityMatch}).`);
      return [document];
    },
  };
}
