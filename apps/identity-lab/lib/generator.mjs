import { createHash } from 'node:crypto';
import { SERVICES } from './services.mjs';

const SNAPSHOT = '2026-11-20T12:00:00.000Z';
const FIRST_NAMES = ['Mira', 'Tomasz', 'Alicja', 'Jan', 'Natalia', 'Piotr', 'Lena', 'Michał', 'Iga', 'Adam', 'Zofia', 'Filip', 'Julia', 'Kamil', 'Oliwia', 'Paweł', 'Anna', 'Robert', 'Ewa', 'Dawid', 'Monika', 'Artur', 'Klara', 'Jakub', 'Sara', 'Mateusz', 'Nina', 'Bartosz'];
const LAST_NAMES = ['Kowal', 'Brzeziński', 'Wierzbicka', 'Lis', 'Sikora', 'Wolski', 'Borkowska', 'Jabłoński', 'Król', 'Zieliński', 'Nowicka', 'Dąbrowski', 'Wiśniewska', 'Ostrowski', 'Czarnecka', 'Kaczmarek', 'Leśna', 'Maj', 'Borowska', 'Wróbel', 'Kalinowska', 'Zając', 'Domańska', 'Makowski'];
const LOCATIONS = ['Nowe Brzeziny', 'Stare Jeziorno', 'Zielone Wzgórza', 'Słoneczny Brzeg', 'Kamienny Potok', 'Dolina Bukowa', 'Górny Młyn', 'Leśna Przystań', 'Mała Polana', 'Północne Łąki', 'Nowy Widok', 'Bursztynowe Pole'];
const HANDLES = ['cichy_szlak', 'miedziany_lis', 'polarny_kadr', 'nocna_sowa', 'zielony_notatnik', 'kawa_i_kod', 'bursztynowy_brak', 'pianino_w_domu', 'wschodni_wiatr', 'papierowy_las', 'rudy_kompas', 'iskra_w_garazu', 'maly_horyzont', 'srebrny_potok', 'bialy_rower', 'ostatnia_tura', 'pstryk_i_juz', 'domowa_orbita', 'most_na_rzece', 'wspolny_stol'];
const COLORS = ['#286b7b', '#9c5372', '#576bb0', '#a57134', '#50805a', '#8c63a2', '#ae6048', '#547e90'];
const INTERESTS = ['rowery', 'fotografia', 'podróże', 'elektronika', 'motoryzacja', 'ogród', 'jedzenie', 'gry', 'technologia', 'dom', 'książki', 'muzyka', 'sport', 'natura', 'sztuka', 'majsterkowanie', 'rękodzieło'];
const GREETINGS = ['Spokojnie, krok po kroku.', 'Najpierw kawa, później pomysły.', 'Zbieram małe historie.', 'Dzielę się tym, co sprawdzone.', 'Lubię proste rozwiązania.', 'Małe rzeczy robią różnicę.'];
const LISTING_TITLES = {
  'market-allegro': ['Klawiatura mechaniczna po przeglądzie', 'Lampa biurkowa z regulacją', 'Zestaw precyzyjnych śrubokrętów', 'Głośnik przenośny z etui', 'Organizer warsztatowy 24 przegródki'],
  'market-olx': ['Rower trekkingowy po serwisie', 'Komoda drewniana, odbiór lokalny', 'Stolik kawowy w dobrym stanie', 'Fotel do czytania', 'Bagażnik rowerowy'],
  'market-vinted': ['Kurtka przeciwdeszczowa rozmiar M', 'Plecak miejski 18 litrów', 'Sweter wełniany granatowy', 'Buty trekkingowe rozmiar 40', 'Torba na ramię w kolorze oliwkowym'],
  'market-ebay': ['Analogowy aparat z futerałem', 'Kolekcja pocztówek z podróży', 'Obiektyw manualny 50 mm', 'Winyl z kolekcji domowej', 'Zabytkowy budzik mechaniczny'],
  'market-amazon': ['Notes w kropki, 160 stron', 'Zestaw kubków ceramicznych', 'Lampka do czytania', 'Półka na książki', 'Podstawka pod laptop'],
  'market-etsy': ['Ręcznie szkliwiona miska', 'Plakat z motywem leśnym', 'Zakładka tkana ręcznie', 'Lniany pokrowiec na książkę', 'Bransoletka z ceramiki'],
  'market-sprzedajemy': ['Zestaw narzędzi ogrodniczych', 'Drewniany regał do pracowni', 'Donice balkonowe, komplet', 'Wiertarka z walizką', 'Krzesła do renowacji'],
};
const FORUM_THREADS = {
  'forum-rower': ['Jak dobrać opony na leśne drogi?', 'Skrzypiący suport po deszczu', 'Pętla nad jeziorem — wspólna trasa'],
  'forum-foto': ['Fotografowanie mgły o świcie', 'Lekki statyw na pieszą wyprawę', 'Pierwsze próby z obiektywem manualnym'],
  'forum-elektronika': ['Zasilacz warsztatowy do domowego biurka', 'Jak rozpoznać zużyty kondensator?', 'Stacja lutownicza: ustawienia temperatury'],
  'forum-moto': ['Odgłosy zawieszenia na nierównej drodze', 'Przygotowanie auta do zimy', 'Skrzynka narzędziowa do garażu'],
  'forum-ogrod': ['Rośliny na zacieniony balkon', 'Kompostownik na małej działce', 'Kiedy przesadzać domowe rośliny?'],
  'forum-kuchnia': ['Chleb na zakwasie: drugi tydzień prób', 'Sezonowa zupa na chłodny wieczór', 'Jak przechowujecie domowe przetwory?'],
  'forum-gry': ['Planszówka dla czterech początkujących', 'Wieczór kooperacyjny bez pośpiechu', 'Organizacja pionków i kart'],
  'forum-it': ['Domowy serwer kopii zapasowych', 'Jak uporządkować pierwszy projekt?', 'Czytelne komunikaty błędów w małej aplikacji'],
  'forum-podroze': ['Weekend z plecakiem poza sezonem', 'Nocleg przy szlaku i dojazd koleją', 'Lekka lista rzeczy na trzy dni'],
  'forum-dom': ['Oświetlenie małej pracowni', 'Wyciszenie drzwi w mieszkaniu', 'Odnowienie starego drewnianego stołu'],
  'forum-ksiazki': ['Reportaż na jesienne wieczory', 'Którą książkę czytacie po raz drugi?', 'Domowa biblioteczka: jak ją porządkujecie?'],
  'forum-muzyka': ['Nagrywanie gitary w małym pokoju', 'Słuchawki do wieczornego ćwiczenia', 'Pierwszy występ na lokalnej scenie'],
  'forum-bieganie': ['Spokojny powrót do treningów', 'Trasa pięciu kilometrów bez świateł', 'Buty na mokre ścieżki jesienią'],
  'forum-lokalne': ['Sąsiedzka wymiana książek w sobotę', 'Warsztaty w domu kultury', 'Co zrobić z niepotrzebnym sprzętem?'],
  'forum-krypto': ['Jak działa reszta w transakcji UTXO?', 'Testowy portfel i tokeny LAB', 'Dwie gałęzie łańcucha w symulatorze'],
};

const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase().replace(/[^a-z0-9]/g, '');
const digest = value => createHash('sha256').update(String(value)).digest('hex');
// The selected Polish first names ending in -a use feminine adjectival surnames.
// Noun surnames such as Kowal, Sikora and Maj stay unchanged for both forms.
function surnameForFirstName(surname, firstName) {
  const feminine = firstName.endsWith('a');
  if (feminine) return surname.replace(/ski$/, 'ska').replace(/cki$/, 'cka').replace(/Leśny$/, 'Leśna');
  return surname.replace(/ska$/, 'ski').replace(/cka$/, 'cki').replace(/Leśna$/, 'Leśny');
}
function randomSource(seed) {
  let value = Number.parseInt(digest(seed).slice(0, 8), 16) >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let x = value;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function timestamp(daysAgo, hour = 12) {
  const date = new Date(SNAPSHOT);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(daysAgo === 0 ? Math.min(hour, 12) : hour, 0, 0, 0);
  return date.toISOString();
}

/** Generate a stable benchmark. The two returned objects must be stored separately. */
export function generateDataset({ seed = 67, people = 180 } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) throw new RangeError('Seed musi być liczbą całkowitą od 0 do 2147483647.');
  if (!Number.isSafeInteger(people) || people < 10 || people > 2000) throw new RangeError('Liczba osób musi być liczbą całkowitą od 10 do 2000.');
  const rng = randomSource(seed);
  const integer = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const pick = array => array[integer(0, array.length - 1)];
  const shuffle = array => {
    const output = [...array];
    for (let i = output.length - 1; i > 0; i--) { const j = integer(0, i); [output[i], output[j]] = [output[j], output[i]]; }
    return output;
  };
  const accounts = [], posts = [], listings = [], threads = [], truthPeople = [], accountLinks = [], scenarios = [];
  const accountByPerson = new Map();
  const usedNames = new Set();
  const roleCounts = { ordinary: 0, multi: 0, fake: 0 };
  const serviceAccounts = new Map(SERVICES.map(service => [service.id, []]));

  for (let personIndex = 0; personIndex < people; personIndex++) {
    const personId = `person-${String(personIndex + 1).padStart(4, '0')}`;
    const firstName = personIndex === 0 ? 'Mira' : pick(FIRST_NAMES);
    const lastName = personIndex === 0 ? 'Kowal' : surnameForFirstName(pick(LAST_NAMES), firstName);
    const fullName = `${firstName} ${lastName}`;
    const stem = `${normalize(firstName)}.${normalize(lastName)}`;
    const serial = personIndex === 0 ? '' : String(10 + personIndex);
    const emails = personIndex === 0
      ? ['mira.kowal@poczta.test', 'mira.k@skrzynka.test', 'mira.kowal+szlak@poczta.test', 'szlak.ciszy@inbox.test']
      : [`${stem}${serial}@poczta.test`, `${normalize(firstName)[0]}.${normalize(lastName)}${serial}@skrzynka.test`, `${stem}${serial}+kontakt@poczta.test`, `${normalize(pick(HANDLES))}${serial}@inbox.test`];
    const primaryAlias = personIndex === 0 ? 'szlak_ciszy' : `${pick(HANDLES)}${serial}`;
    const aliases = personIndex === 0
      ? ['szlak_ciszy', 'mira_k', 'mira.outdoors', 'm_kowal']
      : [primaryAlias, `${normalize(firstName)}_${normalize(lastName)}${serial}`, primaryAlias.replace(/_/g, '.'), `${normalize(firstName)[0]}_${normalize(lastName)}${serial}`];
    const location = personIndex === 0 ? 'Nowe Brzeziny' : pick(LOCATIONS);
    const interests = personIndex === 0 ? ['rowery', 'fotografia', 'podróże'] : shuffle(INTERESTS).slice(0, integer(2, 4));
    const activeStart = integer(6, 22);
    const hours = [activeStart, (activeStart + 1) % 24, (activeStart + 2) % 24];
    const phrase = personIndex === 0 ? 'Spokojnie, krok po kroku.' : pick(GREETINGS);
    const walletAddresses = [`lab1${digest(`${seed}/person/${personIndex}`).slice(0, 40)}`];
    const truthPerson = { id: personId, firstName, lastName, displayName: fullName, emails, aliases, location, interests, walletAddresses };
    truthPeople.push(truthPerson);
    accountByPerson.set(personId, []);

    let services = shuffle(SERVICES).slice(0, integer(3, 5));
    // Ensure every portal is populated even with the minimum ten people.
    const requiredService = SERVICES[personIndex % SERVICES.length];
    if (!services.some(service => service.id === requiredService.id)) services[0] = requiredService;
    const records = services.map((service, i) => ({ service, role: 'ordinary', variation: i }));
    if (personIndex === 0) {
      records.splice(0, records.length,
        { service: SERVICES[0], role: 'ordinary', variation: 0 },
        { service: SERVICES[1], role: 'ordinary', variation: 1 },
        { service: SERVICES[2], role: 'ordinary', variation: 2 },
        { service: SERVICES[5], role: 'ordinary', variation: 3 },
        { service: SERVICES[6], role: 'multi', variation: 4 },
        { service: SERVICES[12], role: 'multi', variation: 5 },
        { service: SERVICES[13], role: 'fake', variation: 6 },
        { service: SERVICES[26], role: 'fake', variation: 7 });
    } else {
      if (personIndex % 2 === 0) {
        for (let i = 0; i < integer(2, 3); i++) records.push({ service: pick(SERVICES), role: 'multi', variation: records.length });
      }
      if (personIndex % 4 === 0) {
        for (let i = 0; i < integer(1, 2); i++) records.push({ service: pick(SERVICES), role: 'fake', variation: records.length });
      }
    }
    // Keep the hard-negative nickname on two distinct portals for every seed.
    if (personIndex === 1) records[0].service = SERVICES[0];
    if (personIndex === 2) records[1].service = SERVICES[1];

    for (const { service, role, variation } of records) {
      const id = `acct-${String(accounts.length + 1).padStart(5, '0')}`;
      const independentFake = role === 'fake' && (personIndex !== 0 || variation === 7);
      const transparentFake = role === 'fake' && !independentFake;
      let username = independentFake ? `${pick(HANDLES)}_${integer(100, 9999)}` : aliases[variation % aliases.length];
      // Explicit hard negative: a common nickname shared by unrelated people on different portals.
      if (personIndex === 1 && variation === 0 || personIndex === 2 && variation === 1) username = 'rowerzysta';
      const nameKey = `${service.id}/${username.toLowerCase()}`;
      if (usedNames.has(nameKey)) username += `_${variation + 1}`;
      usedNames.add(`${service.id}/${username.toLowerCase()}`);
      let email = independentFake ? `${normalize(username)}@konto.test` : emails[(variation === 0 || variation === 4) ? 0 : variation % emails.length];
      if (personIndex === 0) email = [emails[0], emails[0], emails[2], emails[1], emails[3], emails[3], 'mgielny.kadr@konto.test', 'nocny.przechodzien@konto.test'][variation];
      // Keep the same two random draws as before so seed-based counts and IDs stay stable.
      const fakeFirstName = independentFake ? pick(FIRST_NAMES) : null;
      const shownName = independentFake ? `${fakeFirstName} ${surnameForFirstName(pick(LAST_NAMES), fakeFirstName)}` : variation % 3 === 1 ? `${firstName} ${lastName[0]}.` : fullName;
      const accountInterests = independentFake ? shuffle(INTERESTS).slice(0, 2) : shuffle([...interests, ...service.topics]).slice(0, 3).filter((value, i, list) => list.indexOf(value) === i);
      let bio = `${phrase} ${service.category === 'marketplace' ? 'Rzeczy, którym daję drugie życie.' : 'Rozmawiam, testuję i dzielę się doświadczeniem.'} Zainteresowania: ${accountInterests.join(', ')}.`;
      if (!independentFake && (variation === 2 || variation === 5)) bio += ` Kontakt: ${emails[0]}.`;
      if (personIndex === 0 && variation === 4) bio += ' Na Rowerowym Szlaku piszę jako mira_k.';
      if (transparentFake) bio = 'Zdjęcia o świcie, ścieżki nad jeziorem. Dawniej szlak_ciszy; kontakt: szlak.ciszy@inbox.test.';
      if (independentFake) bio = `${pick(GREETINGS)} W wolnym czasie: ${accountInterests.join(', ')}.`;
      const publicWallets = !independentFake && (personIndex % 6 === 0 && variation % 2 === 0 || service.id === 'forum-krypto') ? [...walletAddresses] : [];
      const account = {
        id, serviceId: service.id, username, displayName: shownName, email, bio,
        location: independentFake ? pick(LOCATIONS) : variation % 7 === 6 ? 'Zielone Wzgórza' : location,
        avatarColor: independentFake ? pick(COLORS) : COLORS[personIndex % COLORS.length],
        joinedAt: timestamp(integer(90, 730), integer(7, 21)),
        interests: accountInterests,
        activeHours: independentFake ? [integer(0, 5), integer(12, 16)] : variation % 4 === 3 ? hours.slice(1) : [...hours],
        walletAddresses: publicWallets,
        followers: service.category === 'social' ? integer(8, 3200) : 0,
        reputation: integer(1, 99),
      };
      accounts.push(account);
      serviceAccounts.get(service.id).push(account);
      accountLinks.push({ accountId: id, personId, role });
      accountByPerson.get(personId).push(id);
      roleCounts[role]++;
    }
  }

  // Small datasets still contain all 27 portals: add ordinary accounts to missing ones.
  const ordinarySourceIds = new Set(accountLinks.filter(link => link.role === 'ordinary').map(link => link.accountId));
  const coverageSources = accounts.filter(account => ordinarySourceIds.has(account.id) && account.username !== 'rowerzysta');
  for (const service of SERVICES) {
    if (serviceAccounts.get(service.id).length) continue;
    const source = coverageSources[(SERVICES.indexOf(service) * 3) % coverageSources.length];
    const sourceLink = accountLinks.find(link => link.accountId === source.id);
    const id = `acct-${String(accounts.length + 1).padStart(5, '0')}`;
    const clone = { ...source, interests: [...source.interests], activeHours: [...source.activeHours], walletAddresses: [...source.walletAddresses], id, serviceId: service.id, followers: 0, joinedAt: timestamp(120) };
    accounts.push(clone); serviceAccounts.get(service.id).push(clone);
    accountLinks.push({ accountId: id, personId: sourceLink.personId, role: 'ordinary' });
    accountByPerson.get(sourceLink.personId).push(id); roleCounts.ordinary++;
  }

  for (const account of accounts) {
    const service = SERVICES.find(item => item.id === account.serviceId);
    const link = accountLinks.find(item => item.accountId === account.id);
    const person = truthPeople.find(item => item.id === link.personId);
    if (service.category === 'social') {
      for (let i = 0; i < integer(2, 4); i++) {
        const topic = pick(account.interests.length ? account.interests : service.topics);
        const text = service.id === 'social-linkedin'
          ? `${pick(['Kończę niewielki projekt i zapisuję wnioski.', 'Wymiana doświadczeń pomaga bardziej niż gotowa recepta.', 'Dzisiaj z zespołem sprawdzaliśmy nowy sposób pracy.'])} Temat na ten tydzień: ${topic}. ${pick(GREETINGS)}`
          : `${pick(['Poranek na spokojnie.', 'Kolejny mały projekt za mną.', 'Dobrze czasem zwolnić.', 'Weekend zostawił kilka dobrych wspomnień.', 'Dzisiaj udało się wrócić do hobby.'])} ${topic}: ${pick(['ciągle odkrywam coś nowego', 'warto porozmawiać z innymi', 'mam już plan na kolejną próbę'])}. ${person.id === 'person-0001' && link.role !== 'fake' ? 'Spokojnie, krok po kroku.' : pick(GREETINGS)}`;
        posts.push({ id: `post-${String(posts.length + 1).padStart(5, '0')}`, accountId: account.id, serviceId: service.id, text, createdAt: timestamp(integer(0, 59), pick(account.activeHours)), likes: integer(0, 180), tags: [topic] });
      }
    } else if (service.category === 'marketplace') {
      for (let i = 0; i < integer(1, 3); i++) {
        const title = pick(LISTING_TITLES[service.id]);
        listings.push({
          id: `offer-${String(listings.length + 1).padStart(5, '0')}`, accountId: account.id, serviceId: service.id, title,
          description: `${title}. ${pick(['Stan dobry, widoczne drobne ślady używania.', 'Używane sporadycznie, kompletne i sprawne.', 'Po przeglądzie, gotowe do dalszego używania.'])} ${service.id === 'market-olx' ? `Odbiór osobisty: ${account.location}.` : 'Sposób odbioru do uzgodnienia w portalu testowym.'} ${pick(GREETINGS)}`,
          price: integer(15, 175) * 5, currency: 'PLN', createdAt: timestamp(integer(0, 35), pick(account.activeHours)), category: pick(service.topics),
          condition: pick(['używane — dobry stan', 'używane — bardzo dobry stan', 'nowe']), status: rng() < 0.12 ? 'sprzedane' : 'aktywne',
        });
      }
    } else {
      const members = serviceAccounts.get(service.id);
      for (let i = 0; i < integer(1, 2); i++) {
        const title = pick(FORUM_THREADS[service.id]);
        const createdDaysAgo = integer(3, 55);
        const replies = [];
        for (let j = 0; j < integer(1, 4); j++) {
          const respondent = pick(members);
          replies.push({ id: `reply-${threads.length + 1}-${j + 1}`, accountId: respondent.id, text: pick(['U mnie pomogło rozpisanie kolejnych kroków i sprawdzenie podstaw.', 'Mam podobne doświadczenia, ale wiele zależy od warunków.', 'Dziękuję za opis. Daj znać, jak wyszła kolejna próba.', 'Zacząłbym od prostszego wariantu. Sprawdził się w moim przypadku.', 'Dorzucę zdjęcia i dokładniejsze informacje w następnym wpisie.']), createdAt: timestamp(Math.max(0, createdDaysAgo - j - 1), pick(respondent.activeHours)) });
        }
        threads.push({ id: `thread-${String(threads.length + 1).padStart(5, '0')}`, accountId: account.id, serviceId: service.id, title,
          text: `${pick(['Cześć wszystkim! Zbieram doświadczenia przed kolejną próbą.', 'Wracam do tematu po kilku tygodniach.', 'Mam pytanie do osób, które już to sprawdzały.'])} ${title.replace(/\?$/, '').toLowerCase()} — jakie macie wskazówki? ${person.id === 'person-0001' && link.role !== 'fake' ? 'Spokojnie, krok po kroku.' : pick(GREETINGS)}`,
          createdAt: timestamp(createdDaysAgo, pick(account.activeHours)), replies, tags: service.topics.slice(0, 2) });
      }
    }
  }

  const demoLinks = accountLinks.filter(link => link.personId === 'person-0001');
  const commonAliasAccounts = accounts.filter(account => account.username === 'rowerzysta').map(account => account.id);
  scenarios.push(
    { id: 'alias-bridge', name: 'Jedna osoba, cztery skrzynki i kilka aliasów', query: 'mira.kowal@poczta.test', personIds: ['person-0001'], accountIds: demoLinks.filter(link => link.accountId !== demoLinks.at(-1).accountId).map(link => link.accountId), allAccountIds: demoLinks.map(link => link.accountId), expected: 'positive', description: 'Wspólny adres, wariant z plusem, kontakty w bio i aliasy pozwalają odnaleźć część kont. Ostatnie konto celowo ukrywa powiązanie.' },
    { id: 'shared-nickname', name: 'Ten sam popularny nick, różne osoby', query: 'rowerzysta', personIds: ['person-0002', 'person-0003'], accountIds: commonAliasAccounts, expected: 'negative', description: 'Sama zbieżność nazwy użytkownika nie jest dowodem wspólnego właściciela.' },
    { id: 'independent-fake', name: 'Fake konto bez dostatecznych śladów', query: 'nocny.przechodzien@konto.test', personIds: ['person-0001'], accountIds: [demoLinks.at(-1).accountId], expected: 'unresolved', description: 'Prawda wzorcowa zna właściciela, lecz publiczne atrybuty nie pozwalają go wiarygodnie ustalić.' },
    { id: 'shared-location', name: 'Sąsiedzi o podobnych zainteresowaniach', query: 'Nowe Brzeziny', personIds: truthPeople.filter(person => person.location === 'Nowe Brzeziny').map(person => person.id), accountIds: accounts.filter(account => account.location === 'Nowe Brzeziny').slice(0, 24).map(account => account.id), expected: 'ambiguous', description: 'Wspólna miejscowość i zainteresowania są słabymi sygnałami, które nie identyfikują człowieka.' },
  );
  const publicData = {
    meta: { seed, generatedAt: SNAPSHOT, people, schemaVersion: 1, synthetic: true, description: 'Wyłącznie fikcyjne dane lokalnego laboratorium. Nazwy i zbieżności są syntetyczne.', counts: { services: SERVICES.length, accounts: accounts.length, posts: posts.length, listings: listings.length, threads: threads.length, replies: threads.reduce((sum, thread) => sum + thread.replies.length, 0) } },
    services: SERVICES.map(service => ({ ...service, topics: [...service.topics] })), accounts, posts, listings, threads,
  };
  const groundTruth = { meta: { seed, generatedAt: SNAPSHOT, schemaVersion: 1, synthetic: true, roleCounts }, people: truthPeople, accountLinks, scenarios };
  return { publicData, groundTruth };
}
