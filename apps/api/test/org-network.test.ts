import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORG_NETWORK_LIMITS, buildOrganizationNetwork, krsNumbersIn } from '../src/org-network.ts';

type Routes = Record<string, unknown>;

/** Atrapa `fetch`: odpowiedź po fragmencie adresu (pierwsze dopasowanie); brak dopasowania = 404. */
function fakeFetch(routes: Routes, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((fragment) => url.includes(fragment));
    if (!key) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const item = (id: string) => ({ mainsnak: { datavalue: { value: { 'entity-type': 'item', id } } } });
const text = (value: string) => ({ mainsnak: { datavalue: { value } } });
const withStart = (claim: object, time: string) => ({ ...claim, qualifiers: { P580: [{ datavalue: { value: { time } } }] } });
const entity = (id: string, label: string, claims: Record<string, unknown[]>) => ({ id, labels: { en: { language: 'en', value: label } }, claims });
const HUMAN = { P31: [item('Q5')] };

const TOR_Q1 = entity('Q1', 'The Tor Project, Inc', {
  P856: [text('https://www.torproject.org')],
  P112: [item('Q2')],
  P169: [withStart(item('Q3'), '+2018-01-01T00:00:00Z')],
  P749: [item('Q4')],
});

const TOR_ROUTES: Routes = {
  'wbsearchentities&search=The%20Tor%20Project': { search: [{ id: 'Q1' }, { id: 'Q9' }] },
  'ids=Q1|Q9&': {
    entities: {
      Q1: TOR_Q1,
      Q9: entity('Q9', 'Tor Project', { P856: [text('https://inny-tor.example')] }),
    },
  },
  'ids=Q1&': {
    entities: {
      Q1: entity('Q1', 'The Tor Project, Inc', {
        P856: [text('https://www.torproject.org')],
        P112: [item('Q2')],
        P169: [withStart(item('Q3'), '+2018-01-01T00:00:00Z')],
        P749: [item('Q4')],
      }),
    },
  },
  'ids=Q2|Q3|Q4&': {
    entities: {
      Q2: entity('Q2', 'Jan Założyciel', { ...HUMAN, P2037: [text('jan-zal')] }),
      Q3: entity('Q3', 'Ewa Dyrektor', HUMAN),
      Q4: entity('Q4', 'Fundacja Nadrzędna', { P31: [item('Q43229')], P856: [text('https://nadrzedna.example')] }),
    },
  },
  'nonprofits/api/v2/search.json': { organizations: [{ ein: 208096820, strein: '20-8096820', name: 'Tor Project Inc', city: 'Winchester', state: 'NH' }] },
};

test('sieć organizacji: Wikidata po domenie oficjalnej strony — osoby w rolach, jednostka dominująca, ProPublica tylko jako wpis kandydujący', async () => {
  const calls: string[] = [];
  const network = await buildOrganizationNetwork({
    seeds: [{ name: 'The Tor Project', domain: 'torproject.org', addresses: ['bitcoin:bc1qtt04zfgjxg7lpqhk9vk8hnmnwf88ucwww5arsd'], origin: 'beneficjent' }],
    fetch: fakeFetch(TOR_ROUTES, calls),
    now: () => new Date('2026-11-21T10:00:00.000Z'),
    lookupProfile: async (identifier) => [{ url: `https://github.com/${identifier.value}`, service: 'github.com', title: identifier.value }],
  });
  const tor = network.organizations.find((org) => org.seed)!;
  assert.equal(tor.name, 'The Tor Project, Inc');
  assert.equal(tor.match, 'domain');
  assert.equal(tor.identifiers.wikidata, 'Q1');
  assert.equal(tor.identifiers.website, 'torproject.org');
  assert.ok(!network.organizations.some((org) => org.identifiers.wikidata === 'Q9'), 'podobna nazwa z inną domeną nie jest scalana ani dodawana');
  assert.deepEqual(
    network.persons.map((person) => [person.name, person.role, person.from ?? null]),
    [
      ['Jan Założyciel', 'założyciel', null],
      ['Ewa Dyrektor', 'dyrektor generalny (CEO)', '2018-01-01'],
    ],
  );
  assert.ok(network.persons.every((person) => person.relation === 'osoba odpowiedzialna za organizację (rola w rejestrze)'));
  assert.ok(network.persons.every((person) => person.source.registry === 'Wikidata' && person.source.retrievedAt === '2026-11-21T10:00:00.000Z'));
  assert.deepEqual(network.persons[0]!.publicProfiles, [{ url: 'https://github.com/jan-zal', service: 'github.com', title: 'jan-zal' }]);
  const parent = network.relations.find((relation) => relation.kind === 'parent')!;
  assert.equal(parent.status, 'source_fact');
  assert.equal(network.organizations.find((org) => org.id === parent.from)!.name, 'Fundacja Nadrzędna');
  assert.equal(tor.weakCandidates?.[0]?.registry, 'ProPublica');
  assert.match(tor.weakCandidates![0]!.note, /zgodna tylko nazwą/);
  assert.ok(network.personLinks.some((link) => link.kind === 'same_organization'));
  assert.ok(network.stops.some((stop) => stop.reason === 'depth_limit' && /tylko tryb głęboki/.test(stop.detail)));
  assert.ok(network.notes.some((note) => /NIE jest właścicielem adresu/.test(note)));
  assert.ok(calls.every((url) => /wikidata\.org|propublica\.org/.test(url)));
});

test('sieć organizacji: zgodna tylko nazwa — słabe dopasowanie, bez osób i bez scalania', async () => {
  const network = await buildOrganizationNetwork({
    seeds: [{ name: 'Fundacja Beta', addresses: [], origin: 'test' }],
    fetch: fakeFetch({
      'wbsearchentities&search=Fundacja%20Beta': { search: [{ id: 'Q7' }] },
      'ids=Q7&': { entities: { Q7: entity('Q7', 'Fundacja Beta', { P856: [text('https://beta.example')], P169: [item('Q70')] }) } },
    }),
  });
  assert.equal(network.organizations.length, 1);
  assert.equal(network.organizations[0]!.match, 'name_only');
  assert.match(network.organizations[0]!.matchNote, /słabe dopasowanie/);
  assert.equal(network.persons.length, 0);
});

const member = (imie: string, nazwisko: string, funkcja?: string) => ({ imiona: { imie }, nazwisko: { nazwiskoICzlon: nazwisko }, identyfikator: { pesel: '5**********' }, ...(funkcja ? { funkcjaWOrganie: funkcja } : {}) });

test('sieć organizacji: KRS — zarząd, rada nadzorcza i prokurenci zamaskowani jak w rejestrze, bez numerów PESEL; limit osób', async () => {
  const board = Array.from({ length: 12 }, (_, index) => member(`I${'*'.repeat(5)}`, `N${index}${'*'.repeat(4)}`, index === 0 ? 'PREZES ZARZĄDU' : 'WICEPREZES ZARZĄDU'));
  const network = await buildOrganizationNetwork({
    seeds: [{ name: 'KRS 0000028860', krs: '0000028860', addresses: [], origin: 'wpis KRS' }],
    fetch: fakeFetch({
      'OdpisAktualny/0000028860?rejestr=P': {
        odpis: {
          dane: {
            dzial1: { danePodmiotu: { nazwa: 'ORLEN SPÓŁKA AKCYJNA', identyfikatory: { nip: '7740001454', regon: '61018820100000' } }, siedzibaIAdres: { adresStronyInternetowej: 'WWW.ORLEN.PL' } },
            dzial2: {
              reprezentacja: { nazwaOrganu: 'ZARZĄD', sklad: board },
              organNadzoru: [{ nazwa: 'RADA NADZORCZA', sklad: [member('E**', 'G*******'), member('K***', 'Ł****')] }],
              prokurenci: [
                { ...member('R****', 'W*********'), rodzajProkury: 'PROKURA ODDZIAŁOWA ŁĄCZNA, DO DZIAŁANIA Z PROKURENTEM JAN KOWALSKI (PESEL: 82072702620)' },
                { ...member('P****', 'K******'), rodzajProkury: 'PROKURA ŁĄCZNA' },
              ],
            },
          },
        },
      },
      'wbsearchentities&search=ORLEN': { search: [{ id: 'Q8' }] },
      'ids=Q8&': { entities: { Q8: entity('Q8', 'Orlen', { P856: [text('https://www.orlen.pl')], P355: [item('Q10')] }) } },
      'ids=Q10&': { entities: { Q10: entity('Q10', 'Orlen Spółka Zależna', { P31: [item('Q4830453')] }) } },
    }),
  });
  const orlen = network.organizations[0]!;
  assert.equal(orlen.name, 'ORLEN SPÓŁKA AKCYJNA');
  assert.equal(orlen.match, 'identifier');
  assert.deepEqual([orlen.identifiers.krs, orlen.identifiers.nip, orlen.identifiers.website, orlen.identifiers.wikidata], ['0000028860', '7740001454', 'orlen.pl', 'Q8']);
  assert.equal(network.organizations.filter((org) => org.seed).length, 1, 'wpis Wikidata z tą samą domeną scalony z podmiotem z KRS');
  assert.equal(network.persons.length, ORG_NETWORK_LIMITS.maxPersons);
  assert.equal(network.persons[0]!.role, 'prezes zarządu');
  assert.ok(network.persons.every((person) => person.masked));
  assert.ok(network.stops.some((stop) => stop.reason === 'query_limit' && /Limit 15 osób/.test(stop.detail)));
  assert.doesNotMatch(JSON.stringify(network), /82072702620|KOWALSKI/);
  assert.ok(network.relations.some((relation) => relation.kind === 'subsidiary' && relation.from === orlen.id));
  assert.deepEqual(krsNumbersIn('Fundacja X, KRS 0000012345, NIP 123'), ['0000012345']);
});

test('sieć organizacji: tryb głęboki — inne podmioty tej samej osoby w rejestrze, wspólny członek zarządu (obliczenie)', async () => {
  const network = await buildOrganizationNetwork({
    seeds: [{ name: 'The Tor Project', domain: 'torproject.org', addresses: [], origin: 'test' }],
    deep: true,
    fetch: fakeFetch({
      ...TOR_ROUTES,
      'query.wikidata.org/sparql': { results: { bindings: [{ org: { value: 'http://www.wikidata.org/entity/Q50' }, orgLabel: { value: 'Inna Fundacja' }, prop: { value: 'http://www.wikidata.org/prop/direct/P3320' } }] } },
    }),
  });
  const other = network.organizations.find((org) => org.name === 'Inna Fundacja')!;
  assert.ok(other);
  assert.ok(network.relations.some((relation) => relation.kind === 'other_role_of_officer' && relation.to === other.id && /inne podmioty tej osoby/.test(relation.label)));
  assert.ok(network.relations.some((relation) => relation.kind === 'shared_officer' && relation.status === 'computed'));
  assert.ok(network.personLinks.some((link) => link.kind === 'shared_organizations' || link.organizations.length > 0));
});
