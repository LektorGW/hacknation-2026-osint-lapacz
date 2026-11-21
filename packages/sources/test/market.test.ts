// „Rynek P2P" w piaskownicy: atrybuty profili, typowanie (discover) i powiązania
// między osobami. Serwer piaskownicy działa lokalnie na losowym porcie.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { extractAddresses } from '@olcys/core';
import type { DiscoveringConnector, IdentifierType, SourceConnector, SourceDocument } from '@olcys/core';
import { buildApp } from '../../../apps/sandbox/src/app.ts';
import { ADDR, MARKET_ADDR, accounts } from '../../../apps/sandbox/data/scenario.ts';
import { createConnectors } from '../src/index.ts';

const app = buildApp();
let sandboxUrl = '';
let connectors: SourceConnector[] = [];
const context = { log: () => undefined };

before(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  sandboxUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  connectors = createConnectors({ sandboxUrl });
});

after(async () => {
  await app.close();
});

const byId = (id: string) => connectors.find((connector) => connector.id === id) as SourceConnector;
const search = (id: string, type: IdentifierType, value: string) => byId(id).search({ type, value }, context);
const canDiscover = (connector: SourceConnector): connector is DiscoveringConnector => 'discover' in connector;
const addressesOf = (document: SourceDocument) => extractAddresses(document.text).map((found) => found.address);

async function explorer(address: string) {
  const response = await fetch(`${sandboxUrl}/explorer/api/address/${address}`);
  return { status: response.status, body: (await response.json()) as { label?: string; addressClass?: string; transfers: { direction: string; counterparty: string }[] } };
}

describe('atrybuty profilu w dokumentach piaskownicy', () => {
  test('dane konta z serwisu oraz e-mail i telefon podane w treści', async () => {
    const [gitpub] = await search('sandbox-gitpub', 'login', 'kwrzosek_dev');
    assert.equal(gitpub!.profile!.handle, 'kwrzosek_dev');
    assert.equal(gitpub!.profile!.displayName, 'Kacper Wrzosek');
    assert.deepEqual(gitpub!.profile!.emails, ['kacper.wrzosek@poczta.example']);
    assert.match(gitpub!.profile!.bio ?? '', /Programista systemów wbudowanych/);

    const [offer] = await search('sandbox-targ', 'nick', 'kwrzosek_dev');
    assert.deepEqual(offer!.profile!.phones, ['500000201']);

    const [social] = await search('sandbox-spolecznosc', 'email', 'm.zielonka@skrzynka.example');
    assert.deepEqual(social!.profile!.emails, ['m.zielonka@skrzynka.example']);
    assert.ok(social!.profile!.urls!.some((url) => url.endsWith('/gitpub/zielonka_codes')));

    const [trader] = await search('sandbox-targ', 'nick', 'igor_baran');
    assert.deepEqual(trader!.profile, {
      handle: 'igor_baran',
      displayName: 'Igor Baran',
      emails: ['igor.baran@handel.example'],
      phones: ['500000811'],
      location: 'Lublin',
      createdAt: '2023-11-02T09:00:00Z',
    });
  });

  test('wspólny telefon i wspólny e-mail łączą dwa profile w różnych serwisach', async () => {
    const [lena] = await search('sandbox-targ', 'nick', 'lena_kurek');
    const kolekcje = await search('sandbox-spolecznosc', 'nick', 'kurek_kolekcje');
    const shop = kolekcje.find((document) => document.url.endsWith('/u/kurek_kolekcje'))!;
    assert.deepEqual(lena!.profile!.phones, ['500000825']);
    assert.deepEqual(shop.profile!.phones, ['500000825']);
    assert.deepEqual(addressesOf(lena!), [MARKET_ADDR.lenaTron]);
    assert.deepEqual(addressesOf(shop), [MARKET_ADDR.kolekcjeTron]);

    const [marcel] = await search('sandbox-targ', 'email', 'marcel@zych-mineraly.example');
    const forum = await search('sandbox-forum', 'email', 'marcel@zych-mineraly.example');
    assert.equal(marcel!.author, 'marcel_zych');
    assert.equal(forum[0]!.author, 'mz_mineraly');
    assert.deepEqual(marcel!.profile!.emails, forum[0]!.profile!.emails);
    assert.deepEqual(addressesOf(marcel!), addressesOf(forum[0]!));
  });
});

describe('rozdzielanie osób po atrybutach profilu', () => {
  test('główna osoba: ta sama miejscowość i telefon na dwóch–trzech profilach', async () => {
    const [gitpub] = await search('sandbox-gitpub', 'login', 'kwrzosek_dev');
    const [targ] = await search('sandbox-targ', 'login', 'kwrzosek_dev');
    assert.equal(gitpub!.profile!.location, 'Bydgoszcz');
    assert.equal(targ!.profile!.location, 'Bydgoszcz');
    assert.deepEqual(targ!.profile!.phones, ['500000201']);

    const [offer] = await search('sandbox-targ', 'nick', 'igor_baran');
    const social = (await search('sandbox-spolecznosc', 'nick', 'igor_baran')).find((document) => document.url.endsWith('/u/igor_baran'))!;
    for (const document of [offer!, social]) {
      assert.equal(document.profile!.displayName, 'Igor Baran');
      assert.equal(document.profile!.location, 'Lublin');
      assert.deepEqual(document.profile!.emails, ['igor.baran@handel.example']);
      assert.deepEqual(document.profile!.phones, ['500000811']);
    }
  });

  test('imiennik: to samo imię i nazwisko, inna miejscowość i inny e-mail', async () => {
    const documents = [
      ...(await search('sandbox-gitpub', 'full_name', 'Kacper Wrzosek')),
      ...(await search('sandbox-spolecznosc', 'full_name', 'Kacper Wrzosek')),
    ];
    const programmer = documents.find((document) => document.author === 'kwrzosek_dev')!;
    const angler = documents.find((document) => document.author === 'wrzosek_ryby')!;
    assert.equal(programmer.profile!.displayName, angler.profile!.displayName);
    assert.equal(programmer.profile!.location, 'Bydgoszcz');
    assert.equal(angler.profile!.location, 'Olsztyn');
    assert.deepEqual(angler.profile!.emails, ['wrzosek.ryby@jeziora.example']);
    assert.notDeepEqual(programmer.profile!.emails, angler.profile!.emails);
    // Dokument dopasowany po samym nazwisku nie podsuwa dalszych tropów.
    assert.equal(angler.identityMatch, 'name_only');
    assert.equal(angler.discoveredIdentifiers, undefined);
  });

  test('pospolity nick „marek88": dwie różne osoby w dwóch serwisach', async () => {
    const [targ] = await search('sandbox-targ', 'nick', 'marek88');
    const [forum] = await search('sandbox-forum', 'nick', 'marek88');
    assert.equal(targ!.profile!.displayName, 'Marek Sikora');
    assert.equal(forum!.profile!.displayName, 'Marek Wrona');
    assert.equal(targ!.profile!.location, 'Poznań');
    assert.equal(forum!.profile!.location, 'Suwałki');
    assert.deepEqual(targ!.profile!.emails, ['marek.sikora@skup.example']);
    assert.deepEqual(forum!.profile!.emails, ['m.wrona@suwalki-net.example']);
    assert.deepEqual(addressesOf(targ!), [MARKET_ADDR.marekBtc]);
    assert.deepEqual(addressesOf(forum!), [MARKET_ADDR.marekTron]);
    // Łącznik niczego nie przesądza: oba trafienia to „ten sam nick"; rozdziela je analiza po atrybutach.
    assert.equal(targ!.identityMatch, 'exact_identifier');
    assert.equal(forum!.identityMatch, 'exact_identifier');
  });
});

describe('typowanie (discover) w piaskownicy', () => {
  test('metodę discover mają targ, forum, społeczność i komunikator', () => {
    assert.deepEqual(
      connectors.filter(canDiscover).map((connector) => connector.id),
      ['sandbox-targ', 'sandbox-forum', 'sandbox-spolecznosc', 'sandbox-komunikator'],
    );
  });

  test('targ: najnowsze ogłoszenia od najświeższych, z autorem, profilem i adresem', async () => {
    const targ = byId('sandbox-targ') as DiscoveringConnector;
    const documents = await targ.discover(context, 5);
    assert.equal(documents.length, 5);
    assert.deepEqual(
      documents.map((document) => document.author),
      ['tomasz_lis_p2p', 'wiktor_noga', 'igor_baran', 'nat_wilk', 'darek_mroz'],
    );
    const dates = documents.map((document) => document.publishedAt!);
    assert.deepEqual(dates, [...dates].sort().reverse());
    for (const document of documents) {
      assert.equal(document.category, 'sale_offer');
      assert.equal(document.service, 'targ.sandbox');
      assert.equal(document.identityMatch, 'exact_identifier');
      assert.deepEqual(document.matchedIdentifier, { type: 'nick', value: document.author });
      assert.equal(document.profile!.handle, document.author);
      assert.equal(document.profile!.phones!.length, 1);
      assert.equal(addressesOf(document).length, 1);
    }
    assert.deepEqual(addressesOf(documents[0]!), [MARKET_ADDR.lisTron]);
  });

  test('pełna lista targu obejmuje kilkanaście osób; pozostałe serwisy zwracają swoje rodzaje publikacji', async () => {
    const all = await (byId('sandbox-targ') as DiscoveringConnector).discover(context, 50);
    assert.equal(all.length, 19);
    assert.equal(new Set(all.map((document) => document.author)).size, 19);
    assert.equal(all.filter((document) => addressesOf(document).length > 0).length, 17);

    const forum = await (byId('sandbox-forum') as DiscoveringConnector).discover(context, 3);
    assert.deepEqual(forum.map((document) => document.author), ['marek88', 'nocny_gornik', 'mz_mineraly']);
    assert.deepEqual(addressesOf(forum[2]!), [MARKET_ADDR.marcelBtc]);
    assert.equal(forum[2]!.category, 'forum_post');

    const chat = await (byId('sandbox-komunikator') as DiscoveringConnector).discover(context, 4);
    assert.ok(chat.every((document) => document.category === 'settlement_message'));
    assert.ok(chat.some((document) => document.author === 'tomasz_lis_p2p' && addressesOf(document).includes(MARKET_ADDR.lisTron)));

    const social = await (byId('sandbox-spolecznosc') as DiscoveringConnector).discover(context, 2);
    assert.deepEqual(social.map((document) => document.author), ['kurek_kolekcje', 'darek_mroz']);
  });
});

describe('powiązania w danych blockchain piaskownicy', () => {
  test('pary handlujące ze sobą: adres kontrahenta jest opublikowany na jego profilu', async () => {
    const pairs: [string, string, string, string][] = [
      [MARKET_ADDR.igorBtc, MARKET_ADDR.darekBtc, 'sandbox-spolecznosc', 'darek_mroz'],
      [MARKET_ADDR.wilkTron, MARKET_ADDR.sowaTron, 'sandbox-spolecznosc', 'kinga.sowa'],
      [MARKET_ADDR.gajdaEth, MARKET_ADDR.dudekEth, 'sandbox-gitpub', 'rdudek3d'],
    ];
    for (const [first, second, connectorId, handle] of pairs) {
      const { body } = await explorer(first);
      const directions = body.transfers.filter((transfer) => transfer.counterparty === second).map((transfer) => transfer.direction);
      assert.deepEqual(directions.sort(), ['in', 'out'], `${first} ↔ ${second}`);
      const documents = await search(connectorId, 'nick', handle);
      assert.ok(documents.some((document) => document.category === 'own_profile' && addressesOf(document).includes(second)), handle);
    }
  });

  test('wspólny pośrednik bez etykiety, adres bez ruchu i osoba bez wypłat', async () => {
    const mid = await explorer(MARKET_ADDR.midBtc);
    assert.equal(mid.body.label, undefined);
    assert.equal(mid.body.addressClass, undefined);
    assert.deepEqual(
      mid.body.transfers.map((transfer) => `${transfer.direction}:${transfer.counterparty}`).sort(),
      [`in:${MARKET_ADDR.pietrzakBtc}`, `out:${MARKET_ADDR.sylwiaBtc}`],
    );

    const idle = await explorer(MARKET_ADDR.olekBtc);
    assert.equal(idle.status, 200);
    assert.deepEqual(idle.body.transfers, []);

    const saver = await explorer(MARKET_ADDR.sylwiaBtc);
    assert.ok(saver.body.transfers.length > 0 && saver.body.transfers.every((transfer) => transfer.direction === 'in'));
  });

  test('scenariusze a–h bez zmian: adresy części podstawowej nie występują w części rynkowej', async () => {
    const market = new Set<string>(Object.values(MARKET_ADDR));
    for (const address of [ADDR.kacperBtc, ADDR.kacperEth, ADDR.dominikNewBtc, ADDR.martaEth, ADDR.hubertTron, ADDR.giveawayTron]) {
      assert.ok(!market.has(address));
      const { body } = await explorer(address);
      assert.ok(body.transfers.every((transfer) => !market.has(transfer.counterparty)), address);
    }
    // Żaden nick z części rynkowej nie powtarza nicka osób a–h.
    const base = ['kwrzosek_dev', 'bkruk_trader', 'wrzosek_ryby', 'oli_stepniak', 'dsroka', 'marta.zielonka', 'zielonka_codes', 'zielonka-labs', 'hubi_serwis', 'zosia_mielcarz'];
    for (const handle of base) assert.equal(accounts.filter((account) => account.handle === handle).length <= 3, true);
  });
});
