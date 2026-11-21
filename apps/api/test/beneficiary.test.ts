import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import { renderReportHtml } from '../src/report.ts';
import { attributeBeneficiary, beneficiaryKey, charityClass, collectBeneficiaryMentions, extractBeneficiaryMentions, registrableDomain } from '../src/beneficiary.ts';
import type { BeneficiaryDocument } from '../src/beneficiary.ts';
import { buildAddressNetwork, PRIVACY_NOTE } from '../src/network.ts';
import { BTC_A, BTC_B, BTC_C, BTC_D, chainWith, dossierOf, fakeConnector, transfer } from './helpers.ts';

const TOR = 'bc1qtt04zfgjxg7lpqhk9vk8hnmnwf88ucwww5arsd';

const fdroid = (author: string, repo: string): BeneficiaryDocument => ({
  url: `https://github.com/${author}/${repo}/blob/abc/fdroid/repo/index.xml`,
  service: 'github.com',
  author,
  text:
    `Plik index.xml w repozytorium ${author}/${repo}: <application id="org.other"><name>Inna</name><author>Ktoś Inny</author><donate>https://inny.example.net/</donate></application>` +
    `<application id="org.torproject.android"><name>Orbot</name><summary>Tor dla Androida</summary><author>The Tor Project</author><email>frontdesk@torproject.org</email>` +
    `<donate>https://donate.torproject.org/</donate><bitcoin>${TOR}</bitcoin><litecoin>MTQBNhAP58vpWKsns4ZFUDoh5NK7XECVrs</litecoin></application>`,
});

const tailsPo = (lang: string, author = 'fork-tails'): BeneficiaryDocument => ({
  url: `https://github.com/${author}/tails/blob/abc/wiki/src/donate.${lang}.po`,
  service: 'github.com',
  author,
  text: `Plik wiki/src/donate.${lang}.po w repozytorium ${author}/tails: #~ msgid "Bitcoin" #~ msgstr "Bitcoin" #~ msgid "" #~ "<a href=\\"bitcoin:${TOR}\\">[[!img bitcoin.png]]</a>" #~ msgstr "<strong>${TOR}</strong>"`,
});

const electrum = (author = 'fork-tails'): BeneficiaryDocument => ({
  url: `https://github.com/${author}/tails/blob/abc/config/usr/local/bin/electrum`,
  service: 'github.com',
  author,
  text: `Plik electrum w repozytorium ${author}/tails: ), "bitcoin:${TOR}", "Donation to Tor", … ), "bitcoin:${TOR}", "Donation to Tor"`,
});

test('beneficjent: metadane F-Droid (XML) — nazwa z pola autora, domena zbiórki i e-mail, bez pól sąsiedniej aplikacji', () => {
  const { mentions, warnings } = extractBeneficiaryMentions(fdroid('guardianproject', 'fdroid-repo'), TOR);
  assert.equal(warnings.length, 0);
  assert.equal(mentions.length, 1);
  const [mention] = mentions;
  assert.equal(mention!.name, 'The Tor Project');
  assert.equal(mention!.key, 'tor');
  assert.equal(mention!.domain, 'torproject.org');
  assert.equal(mention!.donationUrl, 'https://donate.torproject.org/');
  assert.deepEqual([...mention!.signals].sort(), ['donation_domain', 'email_domain', 'named_in_context', 'structured_metadata']);
  assert.equal(registrableDomain('donate.torproject.org'), 'torproject.org');
  assert.equal(beneficiaryKey('torproject'), beneficiaryKey('The Tor Project'));
});

test('beneficjent: fraza „Donation to X” obok adresu i polskie „wpłaty na rzecz …”', () => {
  const [mention] = extractBeneficiaryMentions(electrum(), TOR).mentions;
  assert.equal(mention!.name, 'Tor');
  assert.deepEqual(mention!.signals, ['named_in_context']);
  assert.equal(mention!.role, 'donation');
  const polish = extractBeneficiaryMentions({ url: 'https://forum.example/w/1', service: 'forum.example', author: 'ola', text: `Wpłaty na rzecz Fundacji Panoptykon: ${BTC_B} — dziękujemy!` }, BTC_B).mentions[0];
  assert.equal(polish!.name, 'Fundacji Panoptykon');
  // Zaimek albo waluta to nie beneficjent.
  assert.equal(extractBeneficiaryMentions({ url: 'https://x.example/1', service: 'x.example', author: 'a', text: `Support me! Donate to Bitcoin ${BTC_B}` }, BTC_B).mentions.length, 0);
});

test('beneficjent: tłumaczenia .po jednego repozytorium to JEDNO pochodzenie; drugie niezależne pochodzenie daje przypisanie', () => {
  const onlyTails = collectBeneficiaryMentions([tailsPo('de'), tailsPo('fr'), tailsPo('pl'), electrum()], TOR);
  const single = attributeBeneficiary({ address: TOR, network: 'bitcoin', ...onlyTails })!;
  assert.equal(single.origins, 1);
  assert.equal(single.attributed, false);
  assert.match(single.reason!, /1 pochodzenie/);

  const both = collectBeneficiaryMentions([tailsPo('de'), tailsPo('fr'), electrum(), fdroid('guardianproject', 'fdroid-repo'), fdroid('guardianproject', 'binary_transparency_log')], TOR);
  const attribution = attributeBeneficiary({ address: TOR, network: 'bitcoin', ...both })!;
  assert.equal(attribution.attributed, true);
  assert.equal(attribution.name, 'The Tor Project');
  assert.equal(attribution.domain, 'torproject.org');
  assert.equal(attribution.origins, 2, 'fork-tails i guardianproject — dwa pliki guardianproject to jedno pochodzenie');
  assert.equal(attribution.role, 'beneficjent zbiórki');
  const rules = attribution.components.map((item) => item.rule);
  assert.deepEqual(rules, ['beneficiary.named_in_context', 'beneficiary.structured_metadata', 'beneficiary.donation_domain', 'beneficiary.independent_origins']);
  assert.equal(attribution.score, 25 + 15 + 15 + 10);
  assert.ok(attribution.limitations.some((item) => /nie są jego właścicielami/.test(item)));

  const confirmed = attributeBeneficiary({ address: TOR, network: 'bitcoin', ...both, officialSite: { url: 'https://donate.torproject.org/', publishesAddress: true, checkedAt: '2026-11-21T10:00:00.000Z', note: 'ok' } })!;
  assert.equal(confirmed.score, 90);
  assert.equal(confirmed.status, 'hypothesis');
  assert.ok(confirmed.components.some((item) => item.rule === 'beneficiary.official_site' && /Potwierdzone na stronie organizacji/.test(item.explanation)));
});

test('beneficjent: dwie konkurencyjne nazwy z niezależnych pochodzeń — brak przypisania i jawna kara', () => {
  const docs: BeneficiaryDocument[] = [
    { url: 'https://a.example/1', service: 'a.example', author: 'anna', text: `Donate to Fundacja Alfa: ${BTC_B}` },
    { url: 'https://b.example/1', service: 'b.example', author: 'bartek', text: `Donations to Fundacja Alfa — ${BTC_B}` },
    { url: 'https://c.example/1', service: 'c.example', author: 'cezary', text: `${BTC_B} — donations to Beta Foundation` },
  ];
  const attribution = attributeBeneficiary({ address: BTC_B, network: 'bitcoin', ...collectBeneficiaryMentions(docs, BTC_B) })!;
  assert.equal(attribution.attributed, false);
  assert.deepEqual(attribution.competing.map((item) => item.name), ['Beta Foundation']);
  assert.ok(attribution.components.some((item) => item.rule === 'beneficiary.competing_names' && item.delta < 0));
  assert.match(attribution.reason!, /Konkurencyjne nazwy/);
});

test('beneficjent: ostrzeżenie przed oszustwem — nazwa ofiary podszywania się nie zostaje beneficjentem', () => {
  const docs: BeneficiaryDocument[] = [
    { url: 'https://scam.example/1', service: 'scam.example', author: 'straznik', text: `SCAM ALERT: fake donations to UNICEF are collected on ${BTC_B} — it is not UNICEF.` },
    { url: 'https://ostrzezenia.example/2', service: 'ostrzezenia.example', author: 'redakcja', text: `Oszuści podszywają się pod zbiórkę na rzecz UNICEF: ${BTC_B}` },
  ];
  const found = collectBeneficiaryMentions(docs, BTC_B);
  assert.equal(found.mentions.length, 0);
  assert.equal(found.warnings.length, 2);
  const attribution = attributeBeneficiary({ address: BTC_B, network: 'bitcoin', ...found })!;
  assert.equal(attribution.attributed, false);
  assert.ok(attribution.components.some((item) => item.rule === 'beneficiary.scam_warning'));
  // Ostrzeżenie blokuje przypisanie także przy prawdziwych wskazaniach z innych pochodzeń.
  const mixed = attributeBeneficiary({
    address: BTC_B,
    network: 'bitcoin',
    ...collectBeneficiaryMentions([...docs, { url: 'https://u.example/1', service: 'u.example', author: 'u1', text: `Donate to UNICEF Polska: ${BTC_B}` }, { url: 'https://v.example/1', service: 'v.example', author: 'v1', text: `Donate to UNICEF Polska ${BTC_B}` }], BTC_B),
  })!;
  assert.equal(mixed.attributed, false);
});

test('beneficjent: nazwa wyglądająca na osobę (bez cech organizacji i bez domeny) nie jest przypisywana', () => {
  const docs: BeneficiaryDocument[] = [
    { url: 'https://a.example/1', service: 'a.example', author: 'a1', text: `Donate to John Smith: ${BTC_B}` },
    { url: 'https://b.example/1', service: 'b.example', author: 'b1', text: `Support John Smith ${BTC_B}` },
  ];
  const attribution = attributeBeneficiary({ address: BTC_B, network: 'bitcoin', ...collectBeneficiaryMentions(docs, BTC_B) })!;
  assert.equal(attribution.attributed, false);
  assert.match(attribution.reason!, /nie wskazuje osób/);
});

test('klasa adresu: zbiórka organizacji wyklucza przypisanie osobie, adres analityka zostaje przedmiotem sprawy', () => {
  const both = collectBeneficiaryMentions([electrum(), fdroid('guardianproject', 'fdroid-repo')], TOR);
  const attribution = attributeBeneficiary({ address: TOR, network: 'bitcoin', ...both })!;
  assert.equal(charityClass('private', attribution, false), 'charity');
  assert.equal(charityClass('exchange', attribution, false), 'exchange');
  assert.equal(charityClass('private', attribution, true), 'private');
  assert.equal(charityClass('unknown', { ...attribution, attributed: false }, false), 'unknown');
});

// ---------- Teczka: kształt sprawy adresu zbiórki Tor ----------

const KRAKEN = '3NhhcSqaZRhLvtbozEpa6WT1YizW396TQH';
const BINANCE = '1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s';

function torCase() {
  // 12 niepowiązanych autorów cytujących adres (wyszukiwarka kodu), w tym metadane F-Droid i pliki Tails.
  const citing = [
    fdroid('guardianproject', 'fdroid-repo'),
    fdroid('guardianproject', 'binary_transparency_log'),
    tailsPo('de'),
    tailsPo('fr'),
    electrum(),
    ...Array.from({ length: 10 }, (_, index) => ({ url: `https://github.com/autor${index}/notatki/blob/x/README.txt`, service: 'github.com', author: `autor${index}`, text: `lista adresów: ${TOR}` })),
  ];
  const search = fakeConnector('github-search', 'github.com', ['crypto_address'], (identifier) =>
    identifier.value === TOR ? citing.map((doc) => ({ url: doc.url, text: doc.text, author: doc.author, category: 'forum_post' as const, identityMatch: 'same_handle' as const })) : [],
  );
  const www = fakeConnector('live-www', 'torproject.org', ['profile_url'], (identifier) =>
    identifier.value.startsWith('https://donate.torproject.org') ? [{ url: identifier.value, text: `Tor: powered by you\nBitcoin [adres z pola: ${TOR}]`, author: 'torproject.org' }] : [],
  );
  const transfers = [
    // 7 wpłat z giełdy (etykieta usługi) — giełda zna nadawców.
    ...Array.from({ length: 7 }, (_, index) => transfer(100 + index, { direction: 'in', counterparty: BINANCE, counterpartyClass: 'exchange', counterpartyLabel: 'Binance', time: `2025-0${(index % 9) + 1}-02T10:00:00.000Z`, amount: 0.01 })),
    // Wpłaty darczyńców bez etykiety.
    ...[BTC_A, BTC_C, BTC_D, BTC_A].map((counterparty, index) => transfer(200 + index, { direction: 'in', counterparty, time: `2025-02-1${index}T10:00:00.000Z`, amount: 0.05 * (index + 1) })),
    // 24 przelewy wychodzące do Kraken.
    ...Array.from({ length: 24 }, (_, index) => transfer(300 + index, { direction: 'out', counterparty: KRAKEN, counterpartyClass: 'exchange', counterpartyLabel: 'Kraken.com', time: `2026-0${(index % 9) + 1}-05T10:00:00.000Z`, amount: 0.1 })),
  ];
  return { search, www, provider: chainWith({ [TOR]: { transfers } }) };
}

test('teczka: adres zbiórki Tor — organizacja nazwana, 0% dla osoby, strona organizacji sprawdzona, siatka adresu zbiorczo', async () => {
  const { search, www, provider } = torCase();
  const query = { identifiers: [{ type: 'crypto_address' as const, value: TOR }] };
  const result = await runAnalysis({ query, connectors: [search, www], chainProviders: [provider], registries: false });
  const beneficiary = result.intel.beneficiaries?.[0];
  assert.ok(beneficiary?.attributed, beneficiary?.reason);
  assert.equal(beneficiary!.officialSite?.publishesAddress, true);
  assert.equal(www.calls.length, 1, 'jedna strona organizacji, bez podążania za odnośnikami');

  const dossier = dossierOf(result, query);
  assert.equal(dossier.persons.length, 0, 'organizacja nie jest kandydatem na osobę');
  const [org] = dossier.organizations;
  assert.equal(org!.name, 'The Tor Project');
  assert.equal(org!.status, 'hypothesis');
  assert.ok(org!.components.some((item) => item.rule === 'beneficiary.official_site'));
  assert.match(org!.statement, /potwierdzone na stronie organizacji https:\/\/donate\.torproject\.org/);
  const finding = dossier.findings.find((item) => item.address === TOR)!;
  assert.equal(finding.subjectProbability, 0);
  assert.ok(finding.annotations?.some((note) => /Wskaźnik Pewności dla osoby: 0% — znany adres zbiórki/.test(note)));
  assert.ok(dossier.keyFindings.some((item) => /organizacji „The Tor Project”/.test(item.text)));
  const noOwner = dossier.explanations.find((item) => item.kind === 'no_owner');
  assert.match(noOwner!.text, /The Tor Project/);
  // Graf: węzeł organizacji z krawędzią-hipotezą od adresu; żadnych osób dla wpłacających.
  const orgNode = dossier.graph.nodes.find((node) => node.kind === 'organization');
  assert.equal(orgNode?.label, 'The Tor Project');
  const edge = dossier.graph.edges.find((item) => item.kind === 'beneficiary_of');
  assert.equal(edge?.status, 'hypothesis');
  assert.equal(edge?.from, `addr:bitcoin:${TOR}`);
  assert.equal(dossier.graph.nodes.filter((node) => node.kind === 'person').length, 0);

  const [network] = dossier.addressNetwork;
  assert.equal(network!.incoming.transfers, 11);
  assert.equal(network!.incoming.counterparties, 4);
  assert.equal(network!.outgoing.transfers, 24);
  assert.equal(network!.privacyNote, PRIVACY_NOTE);
  assert.ok(network!.statements.some((line) => /7 wpłat z Binance .* Binance zna nadawców/.test(line)), network!.statements.join('\n'));
  assert.ok(network!.statements.some((line) => /24 przelewy do Kraken .* zna właściciela konta/.test(line)), network!.statements.join('\n'));
  assert.ok(network!.statements[0]!.includes('darczyńców na zbiórkę organizacji „The Tor Project”'));
});

test('siatka adresu: największy nadawca, udział usług i adresy tego samego portfela bez tworzenia osób', () => {
  const finding = {
    address: TOR,
    network: 'bitcoin' as const,
    checksumVerified: true,
    evidence: [],
    unrelatedPublishers: 0,
    confidence: { score: 0, tier: 'wykluczone', excluded: false, ledger: [], nextSteps: [] },
    chain: {
      profile: { address: TOR, network: 'bitcoin' as const, addressClass: 'private' as const, classificationSource: 'atrapa', isContract: false, txCount: 100, totalReceived: 1, totalSent: 1, balance: 0, nativeAsset: 'BTC' },
      transfers: [
        transfer(1, { direction: 'in', counterparty: BTC_A, time: '2025-01-01T00:00:00.000Z', amount: 0.5 }),
        transfer(2, { direction: 'in', counterparty: BTC_C, time: '2025-01-02T00:00:00.000Z', amount: 0.1 }),
        transfer(3, { direction: 'in', counterparty: BINANCE, counterpartyClass: 'exchange', counterpartyLabel: 'Binance', time: '2025-01-03T00:00:00.000Z', amount: 0.4 }),
      ],
      cashOuts: [],
      cashOutPlnByYear: {},
      limitations: ['Tryb pełnej historii: pobrano 3 z 100 transakcji adresu.'],
    },
  };
  const network = buildAddressNetwork({
    finding,
    serviceLinks: [],
    relatedAddresses: [{ address: BTC_D, kind: 'same_wallet', strength: 75, txids: ['f'.repeat(64)] }],
    checkedCounterparties: [`bitcoin:${BTC_A}`],
    maxCounterparties: 25,
  })!;
  assert.equal(network.incoming.top[0]!.address, BTC_A);
  assert.equal(network.incoming.top[0]!.checkedInPublications, true);
  assert.equal(network.incoming.serviceShare, 0.4);
  assert.equal(network.incoming.inquiryPoints[0]!.service, 'Binance');
  assert.equal(network.cluster.sameWallet, 1);
  assert.deepEqual(network.coverage, { fetched: 3, total: 100, note: 'Tryb pełnej historii: pobrano 3 z 100 transakcji adresu.' });
  assert.ok(network.statements.some((line) => /dolnym oszacowaniem/.test(line)));
  assert.ok(network.statements.some((line) => /limit 25/.test(line)));
});

test('teczka: sieć organizacji z rejestrów — osoby w rolach (nie właściciele adresu), węzły i krawędzie w grafie', async () => {
  const { search, www, provider } = torCase();
  const query = { identifiers: [{ type: 'crypto_address' as const, value: TOR }] };
  const routes: Record<string, unknown> = {
    'wbsearchentities&search=The%20Tor%20Project': { search: [{ id: 'Q1' }] },
    'ids=Q1&': {
      entities: {
        Q1: { id: 'Q1', labels: { en: { value: 'The Tor Project, Inc' } }, claims: { P856: [{ mainsnak: { datavalue: { value: 'https://www.torproject.org' } } }], P112: [{ mainsnak: { datavalue: { value: { id: 'Q2' } } } }] } },
      },
    },
    'ids=Q2&': { entities: { Q2: { id: 'Q2', labels: { en: { value: 'Jan Założyciel' } }, claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q5' } } } }] } } } },
  };
  const fetchStub = (async (input: string | URL | Request) => {
    const key = Object.keys(routes).find((fragment) => String(input).includes(fragment));
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: key ? 200 : 404 });
  }) as typeof fetch;
  const result = await runAnalysis({ query, connectors: [search, www], chainProviders: [provider], registries: { fetch: fetchStub } });
  const dossier = dossierOf(result, query);
  const network = dossier.organizationNetwork!;
  assert.equal(network.persons[0]!.name, 'Jan Założyciel');
  assert.equal(network.persons[0]!.relation, 'osoba odpowiedzialna za organizację (rola w rejestrze)');
  assert.equal(dossier.organizations[0]!.registryId, 'org:wikidata:Q1');
  assert.equal(dossier.persons.length, 0, 'osoba w roli nie jest kandydatem na właściciela adresu');
  const role = dossier.graph.edges.find((edge) => edge.kind === 'holds_role')!;
  assert.equal(role.status, 'source_fact');
  assert.equal(role.to, 'org:wikidata:Q1');
  assert.match(role.explanation!, /nie właściciel adresu/);
  assert.ok(dossier.graph.edges.some((edge) => edge.kind === 'beneficiary_of' && edge.to === 'org:wikidata:Q1' && edge.status === 'hypothesis'));
  assert.ok(dossier.keyFindings.some((item) => /Rejestry publiczne: „The Tor Project, Inc”/.test(item.text)));
  // Raport: sekcje organizacji, siatki adresu i rejestrów publicznych.
  const html = renderReportHtml(
    { id: 'sprawa-1', name: 'Sprawa testowa', createdAt: '2026-11-21T08:00:00.000Z', query, runs: [] },
    { id: 'run-test', caseId: 'sprawa-1', startedAt: '2026-11-21T09:00:00.000Z', status: 'completed', query, connectors: [], findings: result.findings, log: [] },
    dossier,
    [],
    { connectors: [], rules: DEFAULT_RULES, version: 'test', generatedAt: '2026-11-21T10:00:00.000Z' },
  );
  assert.match(html, /Czyj to adres — organizacja/);
  assert.match(html, /Siatka adresu/);
  assert.match(html, /Organizacje i osoby odpowiedzialne \(rejestry publiczne\)/);
  assert.match(html, /Jan Założyciel/);
});

test('beneficjent: metadane YAML F-Droid i lista „znanych adresów” z odnośnikami różnych organizacji (niejednoznaczna)', () => {
  const yaml = extractBeneficiaryMentions(
    { url: 'https://github.com/f-droid/fdroiddata/blob/x/metadata/org.torproject.vpn.yml', service: 'github.com', author: 'f-droid', text: `AuthorName: The Tor Project Changelog: https://gitlab.torproject.org/x Donate: https://donate.torproject.org/ Bitcoin: ${TOR} AutoName: Tor VPN` },
    TOR,
  ).mentions[0]!;
  assert.equal(yaml.name, 'The Tor Project');
  assert.ok(yaml.signals.includes('structured_metadata') && yaml.signals.includes('donation_domain'));
  const list = extractBeneficiaryMentions(
    { url: 'https://github.com/x/notes/blob/y/known-addresses/index', service: 'github.com', author: 'x', text: `☰ BTC ☰ → https://www.sens.org/donate[SENS research foundation] ${TOR} ☰ BTC ☰ → https://donate.torproject.org/cryptocurrency[Tor Project]` },
    TOR,
  );
  assert.equal(list.mentions.length, 0, 'odnośniki do dwóch różnych organizacji przy adresie — kontekst niejednoznaczny');
});
