// Łącznik Farcaster — na zapisanych przykładowych odpowiedziach (dane fikcyjne), bez internetu.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractAddresses } from '@olcys/core';
import type { IdentifierType, SourceDocument } from '@olcys/core';
import { createHttpClient } from '../src/http.ts';
import type { Fetcher } from '../src/http.ts';
import { createFarcasterConnector, parseAccountVerifications, parseFnameTransfer, parseHubVerifications, parsePrimaryAddress } from '../src/search/farcaster.ts';

const CUSTODY = '0x52908400098527886E0F7030069857D2E4169EE7';
const PRIMARY_ETH = '0x8617E340B3D01FA5F11F306F4090FD50E238070D';
const SECOND_ETH = '0xde709f2102306220921060314715629080e2fb77';
const PRIMARY_SOL = 'ExAqci8uUVKtqHqFW58fmwgMMY9PATfRGGyv6837j9Lx';
const HUB = 'http://127.0.0.1:3381';

type Routes = Record<string, { status?: number; body: object }>;

const ROUTES: Routes = {
  'https://fnames.farcaster.xyz/transfers/current?name=kryptojanek': { body: { transfer: { id: 9, timestamp: 1700000000, username: 'kryptojanek', owner: CUSTODY, from: 0, to: 4242 } } },
  'https://api.farcaster.xyz/fc/primary-address?fid=4242&protocol=ethereum': { body: { result: { address: { fid: 4242, protocol: 'ethereum', address: PRIMARY_ETH } } } },
  'https://api.farcaster.xyz/fc/primary-address?fid=4242&protocol=solana': { body: { result: { address: { fid: 4242, protocol: 'solana', address: PRIMARY_SOL } } } },
  'https://api.farcaster.xyz/fc/account-verifications?fid=4242&platform=x': { body: { result: { verifications: [{ fid: 4242, platform: 'x', platformId: '1', platformUsername: 'janek_x', verifiedAt: 1741629060 }] } } },
  'https://api.farcaster.xyz/fc/account-verifications?fid=4242&platform=github': { body: { result: { verifications: [{ fid: 4242, platform: 'github', platformId: '2', platformUsername: 'KryptoJanek', verifiedAt: 1741629060 }] } } },
};

function setup(routes: Routes, hubUrl?: string) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const route = routes[url];
    return new Response(JSON.stringify(route?.body ?? { errors: [{ message: 'nie ma' }] }), { status: route ? (route.status ?? 200) : 404, headers: { 'content-type': 'application/json' } });
  };
  const connector = createFarcasterConnector(createHttpClient({ fetcher, minIntervalMs: 0 }), hubUrl ? { hubUrl } : {});
  const logs: string[] = [];
  const search = (type: IdentifierType, value: string): Promise<SourceDocument[]> => connector.search({ type, value }, { log: (message) => void logs.push(message) });
  return { connector, calls, logs, search };
}

describe('Farcaster: rozbiór odpowiedzi', () => {
  test('rejestr nazw: nazwa wyrejestrowana (to = 0) i odpowiedź bez transferu nie dają konta', () => {
    assert.equal(parseFnameTransfer({ transfer: { username: 'x', owner: CUSTODY, to: 0 } }), null);
    assert.equal(parseFnameTransfer({}), null);
    assert.deepEqual(parseFnameTransfer({ transfer: { username: 'x', owner: 'zly', to: 5 } }), { fid: 5, username: 'x' });
  });

  test('adres główny musi mieć oczekiwany protokół i poprawny zapis', () => {
    assert.equal(parsePrimaryAddress({ result: { address: { protocol: 'ethereum', address: PRIMARY_ETH } } }, 'ethereum'), PRIMARY_ETH);
    assert.equal(parsePrimaryAddress({ result: { address: { protocol: 'solana', address: PRIMARY_ETH } } }, 'ethereum'), undefined);
    assert.equal(parsePrimaryAddress({ result: { address: { protocol: 'ethereum', address: '0x123' } } }, 'ethereum'), undefined);
    assert.equal(parsePrimaryAddress({ errors: [] }, 'solana'), undefined);
  });

  test('zweryfikowane konta: tylko wpisy tego fid z poprawną nazwą', () => {
    const json = { result: { verifications: [{ fid: 1, platform: 'X', platformUsername: '@janek' }, { fid: 2, platform: 'x', platformUsername: 'obcy' }, { fid: 1, platform: 'x', platformUsername: 'zła nazwa' }] } };
    assert.deepEqual(parseAccountVerifications(json, 1), [{ platform: 'x', username: 'janek' }]);
  });

  test('węzeł Snapchain: oba kształty wiadomości i bez powtórzeń', () => {
    const json = {
      messages: [
        { data: { type: 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS', fid: 1, verificationAddEthAddressBody: { address: SECOND_ETH, ethSignature: 'x' } } },
        { data: { fid: 1, verificationAddAddressBody: { address: SECOND_ETH.toUpperCase().replace('0X', '0x'), protocol: 'PROTOCOL_ETHEREUM' } } },
        { data: { fid: 1, verificationAddAddressBody: { address: PRIMARY_SOL, protocol: 'PROTOCOL_SOLANA' } } },
        { data: { fid: 1 } },
      ],
    };
    assert.deepEqual(
      parseHubVerifications(json).map((entry) => entry.protocol),
      ['ethereum', 'solana'],
    );
  });
});

describe('Farcaster: łącznik', () => {
  test('sam nick: konto znalezione po nazwie to „ten sam nick" i własny profil, z ostrzeżeniem; adresy są w treści', async () => {
    const routes = { ...ROUTES };
    delete routes['https://api.farcaster.xyz/fc/account-verifications?fid=4242&platform=github'];
    const { search, calls, logs } = setup(routes);
    const [document] = await search('nick', '@KryptoJanek');
    assert.ok(document);
    assert.equal(document.connectorId, 'live-farcaster');
    assert.equal(document.service, 'farcaster.xyz');
    assert.equal(document.url, 'https://farcaster.xyz/kryptojanek');
    assert.equal(document.category, 'own_profile');
    assert.equal(document.identityMatch, 'same_handle');
    assert.match(document.text, /^UWAGA: konto Farcaster @kryptojanek znalezione wyłącznie po nazwie/);
    assert.equal(document.discoveredIdentifiers, undefined);
    assert.ok(extractAddresses(document.text).some((found) => found.address.toLowerCase() === PRIMARY_ETH.toLowerCase()));
    assert.match(document.text, new RegExp(PRIMARY_SOL));
    assert.match(document.text, /wymaga własnego węzła Snapchain/);
    assert.equal(calls.length, 5);
    assert.ok(calls.every((url) => /^https:\/\/(fnames|api)\.farcaster\.xyz\//.test(url)));
    assert.match(logs.at(-1)!, /fid 4242, są zweryfikowane adresy \(same_handle\)/);
  });

  test('login równy zweryfikowanemu kontu GitHub: dowód kryptograficzny i potwierdzone powiązanie, konto X jako nowy identyfikator', async () => {
    const { search } = setup(ROUTES);
    const [document] = await search('login', 'kryptojanek');
    assert.equal(document!.category, 'cryptographic_proof');
    assert.equal(document!.identityMatch, 'verified_link');
    assert.match(document!.text, /zweryfikowane konto „github" o nazwie równej identyfikatorowi/);
    assert.deepEqual(document!.discoveredIdentifiers, [{ type: 'nick', value: 'janek_x' }]);
    assert.deepEqual(document!.profile, { handle: 'kryptojanek', urls: ['https://x.com/janek_x', 'https://github.com/KryptoJanek'] });
  });

  test('login nie jest potwierdzany kontem X o tej samej nazwie', async () => {
    const routes: Routes = {
      ...ROUTES,
      'https://api.farcaster.xyz/fc/account-verifications?fid=4242&platform=x': { body: { result: { verifications: [{ fid: 4242, platform: 'x', platformUsername: 'kryptojanek' }] } } },
      'https://api.farcaster.xyz/fc/account-verifications?fid=4242&platform=github': { body: { result: { verifications: [] } } },
    };
    const { search } = setup(routes);
    assert.equal((await search('login', 'kryptojanek'))[0]!.identityMatch, 'same_handle');
    assert.equal((await search('nick', 'kryptojanek'))[0]!.identityMatch, 'verified_link');
  });

  test('adres profilu podany przez analityka: dokładny identyfikator; obcy host jest pomijany', async () => {
    const { search, calls } = setup(ROUTES);
    const [document] = await search('profile_url', 'https://farcaster.xyz/kryptojanek');
    assert.equal(document!.identityMatch, 'exact_identifier');
    assert.equal(document!.category, 'cryptographic_proof');
    const before = calls.length;
    assert.deepEqual(await search('profile_url', 'https://example.org/kryptojanek'), []);
    assert.equal(calls.length, before);
  });

  test('brak konta, niepoprawna nazwa i nazwa ENS bez węzła: pusty wynik', async () => {
    const { search, calls, logs } = setup(ROUTES);
    assert.deepEqual(await search('nick', 'nieistnieje'), []);
    assert.match(logs.at(-1)!, /brak konta o tej nazwie/);
    const before = calls.length;
    assert.deepEqual(await search('nick', 'nazwa_z_podkreśleniem'), []);
    assert.deepEqual(await search('nick', 'za-dluga-nazwa-konta-farcaster'), []);
    assert.deepEqual(await search('ens_name', 'janek.eth'), []);
    assert.equal(calls.length, before);
  });

  test('odmowa źródła (429) kończy wyszukiwanie bez ponawiania', async () => {
    const { search, calls } = setup({ 'https://fnames.farcaster.xyz/transfers/current?name=kryptojanek': { status: 429, body: {} } });
    assert.deepEqual(await search('nick', 'kryptojanek'), []);
    assert.equal(calls.length, 1);
  });

  test('własny węzeł Snapchain: pełna lista zweryfikowanych adresów i nazwa ENS jako nazwa konta', async () => {
    const routes: Routes = {
      ...ROUTES,
      [`${HUB}/v1/userNameProofByName?name=janek.eth`]: { body: { timestamp: 1, name: 'janek.eth', owner: CUSTODY, fid: 4242, type: 'USERNAME_TYPE_ENS_L1' } },
      [`${HUB}/v1/verificationsByFid?fid=4242`]: {
        body: { messages: [{ data: { fid: 4242, verificationAddAddressBody: { address: PRIMARY_ETH, protocol: 'PROTOCOL_ETHEREUM' } } }, { data: { fid: 4242, verificationAddAddressBody: { address: SECOND_ETH, protocol: 'PROTOCOL_ETHEREUM' } } }] },
      },
    };
    const { connector, search } = setup(routes, `${HUB}/`);
    assert.match(connector.description, /Skonfigurowany własny węzeł Snapchain/);
    const [document] = await search('ens_name', 'Janek.eth');
    assert.ok(document);
    assert.equal(document.url, 'https://farcaster.xyz/janek.eth');
    assert.match(document.text, new RegExp(`Pozostałe zweryfikowane adresy \\(węzeł Snapchain\\):\\n- ethereum: ${SECOND_ETH}`));
    assert.doesNotMatch(document.text, /wymaga własnego węzła/);
    // Nazwa ENS nie jest ani nickiem, ani loginem — bez potwierdzenia przez zweryfikowane konto.
    assert.equal(document.identityMatch, 'same_handle');
  });
});
