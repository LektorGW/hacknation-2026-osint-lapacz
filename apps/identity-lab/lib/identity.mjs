// Heuristic linkage of PUBLIC synthetic signals. Ground truth is used only by evaluateIdentity.
const GENERIC_HANDLES = new Set(['admin', 'user', 'test', 'konto', 'anon', 'anonymous', 'rowerzysta', 'jan', 'anna', 'marek', 'guest', 'gosc', 'nowy', 'uzytkownik']);
const PRIOR_LOG_ODDS = -4.0;
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase().trim();
const compact = value => normalize(value).replace(/[^a-z0-9]/g, '');
const tokens = value => normalize(value).split(/[^a-z0-9]+/).filter(token => token.length > 1);
const handleBase = value => compact(value).replace(/\d{1,4}$/, '');
const emailParts = value => {
  const email = normalize(value);
  const index = email.lastIndexOf('@');
  if (index < 1) return { email: '', local: '', domain: '', base: '' };
  const local = email.slice(0, index), domain = email.slice(index + 1);
  return { email, local, domain, base: compact(local.split('+')[0]) };
};
const round = (value, places = 4) => Number(value.toFixed(places));
const logistic = value => 1 / (1 + Math.exp(-value));
const intersection = (a, b) => [...a].filter(value => b.has(value));
const jaccard = (a, b) => a.size && b.size ? intersection(a, b).length / new Set([...a, ...b]).size : 0;

function buildContext(accounts) {
  const handles = new Map(), locations = new Map();
  for (const account of accounts) {
    const handle = compact(account.username);
    if (handle) handles.set(handle, (handles.get(handle) ?? 0) + 1);
    const location = normalize(account.location);
    if (location) locations.set(location, (locations.get(location) ?? 0) + 1);
  }
  return { handles, locations, size: accounts.length };
}

function contextFor(context) {
  if (Array.isArray(context)) return buildContext(context);
  if (Array.isArray(context?.accounts)) return buildContext(context.accounts);
  return context?.handles instanceof Map ? context : { handles: new Map(), locations: new Map(), size: 0 };
}

function nearString(a, b) {
  if (!a || !b || Math.min(a.length, b.length) < 5) return false;
  if (a === b) return true;
  // One insertion, deletion or substitution only; do not join short, generic handles by fuzzy match.
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

function mentionsHandle(bio, handle) {
  const raw = normalize(handle);
  if (compact(raw).length < 5 || GENERIC_HANDLES.has(compact(raw))) return false;
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9_.-])@?${escaped}(?:$|[^a-z0-9_.-]|[.](?=$|\\s))`, 'i').test(normalize(bio));
}

function contactEmails(bio) {
  return new Set(normalize(bio).match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) ?? []);
}

export function compareAccounts(a, b, context) {
  if (!a || !b) throw new TypeError('Do porównania potrzebne są dwa konta.');
  const ctx = contextFor(context);
  const evidence = [], caveats = ['Wynik jest heurystyką, a nie skalibrowanym prawdopodobieństwem ani dowodem tożsamości.'];
  let contact = 0, alias = 0, profile = 0, negative = 0;
  const add = (signal, label, weight, detail, group) => {
    evidence.push({ signal, label, weight: round(weight, 2), detail });
    if (group === 'contact') contact = Math.max(contact, weight);
    else if (group === 'alias') alias += weight;
    else if (group === 'profile') profile += weight;
    else negative += weight;
  };
  const ea = emailParts(a.email), eb = emailParts(b.email);
  if (ea.email && ea.email === eb.email) {
    add('email_exact', 'Identyczny adres e-mail', 6.4, ea.email, 'contact');
    caveats.push('Wspólny adres może należeć do rodziny, organizacji lub być skopiowany do fałszywego profilu.');
  } else if (ea.base.length >= 5 && ea.base === eb.base) {
    const sameDomain = ea.domain === eb.domain;
    add('email_local', sameDomain ? 'Wariant adresu e-mail' : 'Ta sama nazwa skrzynki', sameDomain ? 3.6 : 2.7,
      `${ea.email} / ${eb.email}; podobna nazwa skrzynki nie gwarantuje wspólnego właściciela.`, 'alias');
    if (ea.local.includes('+') || eb.local.includes('+')) caveats.push('Obsługa adresowania z plusem zależy od operatora; to tylko sygnał podobieństwa.');
  } else if (nearString(ea.base, eb.base) && ea.base.length >= 7 && ea.domain === eb.domain) {
    add('email_similar', 'Podobne nazwy skrzynek', 1.5, `${ea.email} / ${eb.email}`, 'alias');
  }
  const ba = contactEmails(a.bio), bb = contactEmails(b.bio);
  if ((ea.email && bb.has(ea.email)) || (eb.email && ba.has(eb.email))) {
    const referenced = ea.email && bb.has(ea.email) ? ea.email : eb.email;
    add('bio_contact', 'E-mail wskazany w opisie profilu', 6.0, referenced, 'contact');
    caveats.push('Opis profilu jest deklaracją autora i może zawierać cudze dane.');
  }
  const walletSet = value => new Set((value ?? []).filter(address => typeof address === 'string' && address.trim()));
  const sharedWallets = intersection(walletSet(a.walletAddresses), walletSet(b.walletAddresses));
  if (sharedWallets.length) {
    add('wallet', 'Wspólny publiczny adres portfela', 6.2, sharedWallets.join(', '), 'contact');
    caveats.push('Adres portfela bywa współdzielony; transakcja między adresami sama w sobie nie łączy tożsamości.');
  }
  const ha = compact(a.username), hb = compact(b.username);
  const generic = GENERIC_HANDLES.has(ha) || GENERIC_HANDLES.has(hb);
  const frequency = Math.max(ctx.handles.get(ha) ?? 1, ctx.handles.get(hb) ?? 1);
  if (ha && ha === hb) {
    const weight = generic ? 0.35 : frequency >= 7 ? 1.2 : frequency >= 4 ? 2.0 : 3.5;
    add('username_exact', 'Ta sama nazwa użytkownika', weight,
      `${a.username} / ${b.username}; ${ctx.size ? `${frequency} kont w badanym zbiorze` : 'brak informacji o częstości w zbiorze'}`, 'alias');
    if (generic || frequency >= 4) caveats.push('Popularny alias ma niewielką wartość identyfikacyjną i może należeć do wielu osób.');
  } else if (!generic && handleBase(ha).length >= 5 && handleBase(ha) === handleBase(hb)) {
    add('username_variant', 'Wariant tego samego aliasu', 2.4, `${a.username} / ${b.username}`, 'alias');
  } else if (!generic && nearString(ha, hb)) {
    add('username_similar', 'Podobna pisownia aliasu', 1.2, `${a.username} / ${b.username}`, 'alias');
  }
  const crossHandle = (ha.length >= 5 && !GENERIC_HANDLES.has(ha) && ha === eb.base)
    || (hb.length >= 5 && !GENERIC_HANDLES.has(hb) && hb === ea.base);
  if (crossHandle) add('handle_email', 'Alias odpowiada nazwie skrzynki', 2.5, 'Nazwa użytkownika jednego konta odpowiada nazwie skrzynki drugiego.', 'alias');
  if (mentionsHandle(a.bio, b.username) || mentionsHandle(b.bio, a.username)) {
    const rare = frequency < 4 && !generic;
    add('bio_alias', 'Opis wskazuje alias drugiego konta', rare ? 5.6 : 2.5, `${a.username} / ${b.username}`, rare ? 'contact' : 'alias');
    caveats.push('Wzmianka o aliasie może być odwołaniem do innej osoby lub podszywaniem się.');
  }
  const na = compact(a.displayName), nb = compact(b.displayName);
  if (na.length >= 5 && na === nb) add('display_name', 'Zgodna nazwa wyświetlana', 0.5, String(a.displayName), 'profile');
  else if (intersection(new Set(tokens(a.displayName)), new Set(tokens(b.displayName))).length >= 2) {
    add('name_tokens', 'Wspólne człony nazwy', 0.3, `${a.displayName} / ${b.displayName}`, 'profile');
  }
  const la = normalize(a.location), lb = normalize(b.location);
  if (la && la === lb) add('location', 'Wspólna lokalizacja', 0.35, String(a.location), 'profile');
  const interestOverlap = jaccard(new Set((a.interests ?? []).map(normalize)), new Set((b.interests ?? []).map(normalize)));
  if (interestOverlap >= 0.35) add('interests', 'Podobne zainteresowania', interestOverlap >= 0.7 ? 0.35 : 0.2, `${Math.round(interestOverlap * 100)}% wspólnych zainteresowań (Jaccard).`, 'profile');
  const hourOverlap = jaccard(new Set(a.activeHours ?? []), new Set(b.activeHours ?? []));
  if (hourOverlap >= 0.5) add('hours', 'Podobne godziny aktywności', 0.2, `${Math.round(hourOverlap * 100)}% wspólnych godzin.`, 'profile');
  if (ha === hb && na && nb && na !== nb && la && lb && la !== lb && !contact) {
    add('conflicting_profile', 'Rozbieżne dane profilu', -0.5, 'Alias jest wspólny, ale nazwa wyświetlana i lokalizacja są różne.', 'negative');
  }
  // Alias, local-part and contact references are often correlated. Caps avoid adding the same clue repeatedly.
  const effectiveAlias = Math.min(alias, 4.5);
  const effectiveProfile = Math.min(profile, 1.1);
  const contactSupport = contact ? Math.min(effectiveAlias, 0.8) : effectiveAlias;
  const score = PRIOR_LOG_ODDS + contact + contactSupport + effectiveProfile + negative;
  let probability = Math.min(0.985, logistic(score));
  if (!contact && effectiveAlias < 2.3) probability = Math.min(probability, 0.30);
  if (!contact && !alias) probability = Math.min(probability, 0.08);
  return {
    probability: round(probability), score: round(score), evidence,
    caveats: [...new Set(caveats)],
    model: 'public-signals-v1',
    effectiveEvidence: { contact: round(contact), alias: round(contactSupport), profile: round(effectiveProfile), negative: round(negative) },
  };
}

function queryMatch(query, account) {
  const q = normalize(query);
  if (normalize(account.id) === q) return { kind: 'account_id', confidence: 1 };
  if (normalize(account.email) === q) return { kind: 'email', confidence: 0.985 };
  if ((account.walletAddresses ?? []).some(address => normalize(address) === q)) return { kind: 'wallet', confidence: 0.97 };
  if (normalize(account.username).replace(/^@/, '') === q.replace(/^@/, '')) return { kind: 'username', confidence: 0.70 };
  if (normalize(account.displayName) === q) return { kind: 'display_name', confidence: 0.30 };
  const values = [account.username, account.displayName, account.email, account.id, ...(account.walletAddresses ?? [])];
  if (q.length >= 3 && values.some(value => normalize(value).includes(q))) return { kind: 'partial', confidence: 0.2 };
  return null;
}

export function resolveIdentity(query, accounts, { limit = 40 } = {}) {
  if (!Array.isArray(accounts)) throw new TypeError('Lista kont musi być tablicą.');
  const q = String(query ?? '').trim();
  if (q.length < 2 || q.length > 200) throw new RangeError('Podaj zapytanie o długości od 2 do 200 znaków.');
  const count = Math.min(200, Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 40));
  const ctx = buildContext(accounts);
  const queryHits = accounts.map(account => ({ account, match: queryMatch(q, account) })).filter(hit => hit.match);
  const exact = queryHits.filter(hit => hit.match.kind !== 'partial');
  // Exact contacts/IDs outrank broad alias searches. Each query anchor remains a separate hypothesis.
  const seeds = (exact.length ? exact : queryHits).sort((a, b) => b.match.confidence - a.match.confidence).slice(0, 30);
  const anchors = seeds.map(hit => hit.account.id);
  const caveats = [
    'Prawdopodobieństwa są wskaźnikami heurystycznymi i wymagają kalibracji na osobnym zbiorze.',
    'Wynik porównuje jawne sygnały kont; nie ustala prawdziwej tożsamości osoby.',
    'Kilka trafień tego samego zapytania to osobne hipotezy; nie zakłada się, że należą do jednej osoby.',
  ];
  if (!seeds.length) return { query: q, anchors, matches: [], caveats };
  if (seeds.some(seed => ['partial', 'display_name', 'username'].includes(seed.match.kind))) {
    caveats.push('Wyszukiwanie po nazwie lub fragmencie jest niejednoznaczne. Wybierz profil i wyszukaj jego identyfikator.');
  }
  if (exact.length > 30 || (!exact.length && queryHits.length > 30)) caveats.push('Ograniczono liczbę punktów startowych do 30; zawęź zapytanie.');
  const hitsById = new Map(queryHits.map(hit => [hit.account.id, hit.match]));
  const results = [];
  for (const account of accounts) {
    const direct = hitsById.get(account.id);
    let best = null, bestSeed = null;
    for (const seed of seeds) {
      if (seed.account.id === account.id) continue;
      const comparison = compareAccounts(seed.account, account, ctx);
      // Ambiguous search seeds cannot confer strong ownership certainty to their neighbors.
      const reliability = ['account_id', 'email', 'wallet'].includes(seed.match.kind) ? 1 : seed.match.kind === 'username' ? 0.82 : 0.55;
      const adjusted = comparison.probability * reliability;
      if (!best || adjusted > best.probability) { best = { ...comparison, probability: round(adjusted) }; bestSeed = seed; }
    }
    if (direct) {
      const probability = Math.max(direct.confidence, best?.probability ?? 0);
      results.push({ account, probability: round(probability), score: best?.score ?? 0,
        evidence: [{ signal: 'query_match', label: 'Trafienie zapytania', weight: 0, detail: `${q} (${direct.kind}); trafienie nie potwierdza wspólnej osoby.` }, ...(best?.evidence ?? [])],
        caveats: [...new Set([...(best?.caveats ?? []), 'Bezpośrednie trafienie oznacza zgodność zapytania z profilem, nie dowód własności konta.'])],
        queryMatch: true, matchType: direct.kind, ...(bestSeed ? { via: bestSeed.account.id } : {}) });
    } else if (best && best.probability >= 0.12 && best.evidence.some(item => item.weight >= 1.2)) {
      results.push({ account, ...best, queryMatch: false, matchType: 'linked', via: bestSeed.account.id });
    }
  }
  results.sort((a, b) => Number(b.queryMatch) - Number(a.queryMatch) || b.probability - a.probability || a.account.id.localeCompare(b.account.id));
  return { query: q, anchors, matches: results.slice(0, count), totalMatches: results.length, caveats,
    model: 'public-signals-v1', method: 'Bezpośrednie porównanie z punktami startowymi; bez propagowania pewności po grafie.' };
}

function seededRandom(seed = 67129) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
}

function reservoir(items, size, random) {
  const output = [];
  let seen = 0;
  for (const item of items) {
    seen++;
    if (output.length < size) output.push(item);
    else { const index = Math.floor(random() * seen); if (index < size) output[index] = item; }
  }
  return { items: output, total: seen };
}

export function evaluateIdentity(accounts, groundTruth, { threshold = 0.75, maxPairs = 20000 } = {}) {
  const cut = Number(threshold), budget = Math.trunc(Number(maxPairs));
  if (!Number.isFinite(cut) || cut < 0 || cut > 1) throw new RangeError('Próg musi być liczbą od 0 do 1.');
  if (!Number.isFinite(budget) || budget < 2 || budget > 200000) throw new RangeError('Liczba par musi mieścić się w zakresie 2–200000.');
  const truth = new Map((groundTruth?.accountLinks ?? []).map(link => [link.accountId, link.personId]));
  const known = accounts.filter(account => truth.has(account.id));
  const groups = new Map();
  known.forEach((account, index) => { const id = truth.get(account.id); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(index); });
  function* positivePairs() {
    for (const indices of groups.values()) for (let i = 0; i < indices.length; i++) for (let j = i + 1; j < indices.length; j++) yield [indices[i], indices[j]];
  }
  const random = seededRandom();
  const positive = reservoir(positivePairs(), Math.ceil(budget / 2), random);
  const allPairCount = known.length * (known.length - 1) / 2;
  const negativeTotal = allPairCount - positive.total;
  const negativeSize = Math.min(negativeTotal, budget - positive.items.length);
  const negative = [];
  if (negativeTotal <= negativeSize * 2) {
    function* negativePairs() {
      for (let i = 0; i < known.length; i++) for (let j = i + 1; j < known.length; j++) if (truth.get(known[i].id) !== truth.get(known[j].id)) yield [i, j];
    }
    negative.push(...reservoir(negativePairs(), negativeSize, random).items);
  } else {
    // Uniform rejection sample of distinct unordered cross-person pairs. No score-based selection.
    const seen = new Set();
    while (negative.length < negativeSize) {
      let i = Math.floor(random() * known.length), j = Math.floor(random() * known.length);
      if (i === j || truth.get(known[i].id) === truth.get(known[j].id)) continue;
      if (i > j) [i, j] = [j, i];
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key); negative.push([i, j]);
    }
  }
  const ctx = buildContext(known), confusion = { tp: 0, fp: 0, tn: 0, fn: 0 }, weightedConfusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const examples = { falsePositives: [], falseNegatives: [], truePositives: [] };
  function inspect(pairs, positiveLabel, population) {
    const weight = pairs.length ? population / pairs.length : 0;
    for (const [i, j] of pairs) {
      const result = compareAccounts(known[i], known[j], ctx), predicted = result.probability >= cut;
      const key = positiveLabel ? predicted ? 'tp' : 'fn' : predicted ? 'fp' : 'tn';
      confusion[key]++; weightedConfusion[key] += weight;
      const target = key === 'fp' ? examples.falsePositives : key === 'fn' ? examples.falseNegatives : key === 'tp' ? examples.truePositives : null;
      if (target && target.length < 8) target.push({ accountA: known[i].id, accountB: known[j].id, probability: result.probability, signals: result.evidence.map(item => item.signal) });
    }
  }
  inspect(positive.items, true, positive.total); inspect(negative, false, negativeTotal);
  const divide = (a, b) => b ? round(a / b) : null;
  const precision = divide(weightedConfusion.tp, weightedConfusion.tp + weightedConfusion.fp);
  const recall = divide(weightedConfusion.tp, weightedConfusion.tp + weightedConfusion.fn);
  const f1 = precision === null || recall === null ? null : precision + recall ? round(2 * precision * recall / (precision + recall)) : 0;
  // Additional hard-negative audit is reported separately and does not change unbiased sample estimates.
  const handleGroups = new Map(), walletGroups = new Map(), auditPairs = new Map();
  const addToGroup = (groups, key, index) => {
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  };
  known.forEach((account, index) => {
    addToGroup(handleGroups, compact(account.username), index);
    for (const wallet of new Set(account.walletAddresses ?? [])) {
      // Addresses are case-sensitive, just as in public pair scoring. Ignore empty placeholders.
      if (typeof wallet === 'string' && wallet.trim()) addToGroup(walletGroups, wallet, index);
    }
  });
  const collectAudit = (groups, reason) => {
    for (const group of groups.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const left = Math.min(group[i], group[j]), right = Math.max(group[i], group[j]);
      if (truth.get(known[left].id) === truth.get(known[right].id)) continue;
      const key = `${left}:${right}`;
      if (!auditPairs.has(key)) auditPairs.set(key, { left, right, reasons: new Set() });
      auditPairs.get(key).reasons.add(reason);
    }
  };
  collectAudit(handleGroups, 'username');
  collectAudit(walletGroups, 'sharedWallet');
  const bySignal = { username: { pairs: 0, falsePositives: 0 }, sharedWallet: { pairs: 0, falsePositives: 0 } };
  const hardNegatives = [];
  let hardFalsePositives = 0;
  for (const { left, right, reasons } of auditPairs.values()) {
    const result = compareAccounts(known[left], known[right], ctx), falsePositive = result.probability >= cut;
    if (falsePositive) hardFalsePositives++;
    for (const reason of reasons) { bySignal[reason].pairs++; if (falsePositive) bySignal[reason].falsePositives++; }
    hardNegatives.push({ accountA: known[left].id, accountB: known[right].id, probability: result.probability,
      falsePositive, reasons: [...reasons], signals: result.evidence.map(item => item.signal) });
  }
  // Put failures first so a small example limit cannot hide a high-scoring shared payment address.
  hardNegatives.sort((a, b) => Number(b.falsePositive) - Number(a.falsePositive) || b.probability - a.probability || a.accountA.localeCompare(b.accountA));
  return { threshold: cut, precision, recall, f1, confusion, weightedConfusion: Object.fromEntries(Object.entries(weightedConfusion).map(([key, value]) => [key, round(value, 2)])),
    pairsEvaluated: positive.items.length + negative.length, accountsEvaluated: known.length,
    truePositive: confusion.tp, falsePositive: confusion.fp, trueNegative: confusion.tn, falseNegative: confusion.fn,
    sample: { method: 'deterministyczna próba warstwowa par: ta sama osoba / różne osoby; metryki ważone odwrotnością prawdopodobieństwa doboru',
      positives: { sampled: positive.items.length, population: positive.total }, negatives: { sampled: negative.length, population: negativeTotal },
      populationPairs: allPairCount, unknownAccountsSkipped: accounts.length - known.length, seed: 67129 },
    hardNegativeAudit: { pairs: auditPairs.size, falsePositives: hardFalsePositives, bySignal, examples: hardNegatives.slice(0, 8),
      method: 'Osobny audyt różnych osób: ten sam niepusty alias lub publiczny adres portfela. Pary są deduplikowane; kategorie mogą się nakładać.',
      caveat: 'To kontrolowany audyt trudnych negatywów, nie próba reprezentatywna ani składnik głównych metryk.' }, examples,
    caveats: ['Metryki dotyczą wyłącznie syntetycznego zbioru i nie potwierdzają jakości na rzeczywistych danych.',
      'Precyzja i recall są oszacowaniami ważonymi; confusion zawiera surowe liczności próby.',
      'Mała próba może nie zawierać rzadkich fałszywych trafień. Wynik prawdopodobieństwa nie jest skalibrowany.',
      'Scenariusze bez wspólnych jawnych sygnałów mogą pozostać nierozpoznane.'] };
}
