// Wskaźnik C, część Web2: oznaki wyjścia do walut tradycyjnych w PUBLIKACJACH KONT PODMIOTU.
//
// Czego szukamy (zadanie KAS „Fiat Cash-Out”): ofert sprzedaży kryptowalut za PLN lub gotówkę, spotkań
// z wypłatą gotówki, rozliczeń przelewem lub BLIK-iem, kart zasilanych kryptowalutami, nazwanych usług
// wyjścia do fiat (giełdy i kantory z wypłatą w walucie tradycyjnej, bitomaty, platformy P2P) i bramek płatniczych.
//
// Zasady:
//   • liczą się wyłącznie publikacje kont PRZYPISANYCH PODMIOTOWI — wzmianki innych autorów pomijamy;
//   • kopie tej samej treści (przedruk, kopia archiwalna, ta sama oferta w kilku serwisach) liczą się raz;
//   • deklaracja w publikacji podnosi ocenę najwyżej do szczebla „potencjalny sygnał wypłaty” — ostatni
//     szczebel („udokumentowane wyjście”) daje WYŁĄCZNIE odpowiedź usługi przyjęta przez analityka;
//   • nazwę usługi porównujemy z migawkami rejestrów (RDWW — IAS Katowice, MiCA — ESMA): tylko nazwy, bez adresów.

import { combineComponents, provenanceGroups } from '@olcys/core';
import type { CashOutAssessment, CashOutConfirmation, ComponentDraft, Evidence, EvidenceRef, OfframpKind, ServiceLink } from '@olcys/core';
import { OFFRAMP_KIND_LABEL, foldText, matchOfframps, offrampFor } from '@olcys/chain';
import type { OfframpService } from '@olcys/chain';
import { loadRegistrySnapshots, registryCoreName } from '@olcys/sources';
import type { RegistryData } from '@olcys/sources';
import { plural } from './format.ts';
import { sightingKey } from './intel.ts';
import type { Sighting } from './intel.ts';
import { serviceIdOf } from './services.ts';

export type FiatWebRule = 'p2p_offer_pln' | 'cash_meeting' | 'bank_or_blik' | 'crypto_card' | 'named_offramp' | 'payment_gateway';

/** Jedna oznaka w jednej publikacji. */
export interface FiatSignalHit {
  rule: FiatWebRule;
  /** Zdanie publikacji, w którym jest oznaka (najwyżej 300 znaków). */
  excerpt: string;
  /** Usługa nazwana w zdaniu (karta, giełda, bramka, platforma P2P). */
  service?: string;
  offrampKind?: OfframpKind;
}

/** Publikacja konta podmiotu z oznakami wyjścia do fiat. */
export interface FiatPublication {
  url: string;
  /** Serwis publikacji (np. `targ`, `forum`). */
  service: string;
  title?: string;
  publishedAt?: string;
  /** Skrót treści (SHA-256), jeśli znany — identyczna treść to jedno pochodzenie. */
  contentHash?: string;
  hits: FiatSignalHit[];
}

/** Jawne reguły części Web2 — wagi wchodzą do `CASH_OUT_RULES.weights.web`. */
export const FIAT_WEB_RULES = {
  weights: {
    /** Oferta sprzedaży kryptowaluty za PLN / gotówkę albo wymiany na PLN. */
    p2p_offer_pln: 45,
    /** Spotkanie, odbiór osobisty, gotówka do ręki — w kontekście kryptowalut. */
    cash_meeting: 40,
    /** Rozliczenie przelewem na rachunek albo BLIK-iem — w kontekście kryptowalut. */
    bank_or_blik: 35,
    /** Deklarowane korzystanie z karty zasilanej kryptowalutami. */
    crypto_card: 35,
    /** Nazwana usługa wyjścia do fiat: giełda lub kantor z wypłatą w walucie tradycyjnej, bitomat, platforma P2P. */
    named_offramp: 25,
    /** Bramka płatnicza (rozliczenie sprzedawcy w walucie tradycyjnej). */
    payment_gateway: 25,
  } as Record<FiatWebRule, number>,
  /** Reguły, które same podnoszą ocenę do szczebla „potencjalny sygnał wypłaty” (deklaracja wymiany na walutę tradycyjną). */
  signalRules: ['p2p_offer_pln', 'cash_meeting', 'bank_or_blik', 'crypto_card'] as FiatWebRule[],
  /** Najdłuższy cytat przy oznace. */
  maxExcerpt: 300,
  /** Najwięcej zdań zapisanych dla jednej reguły w jednej publikacji. */
  maxHitsPerRule: 3,
} as const;

export const FIAT_WEB_RULE_LABEL: Record<FiatWebRule, string> = {
  p2p_offer_pln: 'oferta sprzedaży kryptowaluty za PLN lub gotówkę',
  cash_meeting: 'spotkanie i wypłata gotówki do ręki',
  bank_or_blik: 'rozliczenie przelewem na rachunek albo BLIK-iem',
  crypto_card: 'karta zasilana kryptowalutami',
  named_offramp: 'nazwana usługa wyjścia do waluty tradycyjnej',
  payment_gateway: 'bramka płatnicza',
};

const WEB_SOURCE = 'publikacje kont podmiotu (Web2)';

// ---------- Wykrywanie w tekście ----------
// Wzorce działają na tekście „złożonym” (`foldText`: małe litery, bez polskich znaków), więc „gotówkę” = „gotowke”.

const W = (body: string) => `(?<![a-z0-9])(?:${body})(?![a-z0-9])`;
const CRYPTO =
  'btc|bitcoin\\w*|bitkoin\\w*|eth|ethereum|ether|usdt|usdc|tether\\w*|krypto\\w*|crypto\\w*|kryptowalut\\w*|trx|ltc|litecoin\\w*|xmr|monero|stablecoin\\w*|bnb|doge\\w*';
const FIAT = 'pln|zl|zlot\\w*|zlotow\\w*|gotowk\\w*|cash|euro|eur|fiat\\w*|kurs dnia';
const SELL = 'sprzeda\\w*|sprzedam|wymian\\w*|wymieni\\w*|wymienia\\w*|zamian\\w*|zamieni\\w*|spieniez\\w*|wyplac\\w*|wyplat\\w*|cash ?out|off-?ramp|oddam|oddaje|uplynni\\w*';
const CRYPTO_RE = new RegExp(W(CRYPTO));
// Kupno kryptowaluty za gotówkę to wejście do kryptowalut, nie wyjście do fiat.
const BUY_RE = new RegExp(W('kupi\\w*|kupuj\\w*|kupie|skup\\w*'));
const FIAT_RE = new RegExp(W(FIAT));
// Czasownik sprzedaży tuż przed kryptowalutą (bez przecinka po drodze): „sprzedam USDT”, „wymiana BTC”.
const SELL_CRYPTO_RE = new RegExp(`${W(SELL)}[^,;]{0,30}?${W(CRYPTO)}`);
// Kryptowaluta „za” albo „na” walutę tradycyjną: „USDT za gotówkę”, „BTC na PLN”.
const CRYPTO_FOR_FIAT_RE = new RegExp(`${W(CRYPTO)}\\s+(?:za|na)\\s+(?:[a-z0-9]+\\s+){0,2}?${W(FIAT)}`);
const CASH_MEETING_RE = new RegExp(
  W('gotowk\\w*|do reki|odbior osobist\\w*|odbiore osobiscie|osobiscie|spotkani\\w*|spotkam\\w*|umowie sie|umawiam sie|na miejscu|face to face|f2f|cash in hand|w galerii'),
);
const BANK_RE = new RegExp(
  W('blik\\w*|przelew\\w* na konto|przelew\\w* bankow\\w*|przelewem|na (?:moje |twoje )?konto(?: bankowe)?|na rachunek|wyplat\\w* na konto|wyplac\\w* na konto|sepa|iban'),
);
// Ostrzeżenie, zaprzeczenie albo cytat cudzej oferty — zdanie nie jest deklaracją podmiotu.
const NEGATION_RE = new RegExp(
  `${W('nie')} (?:sprzeda\\w*|kupuj\\w*|wymieni\\w*|wymieniam|przyjmuj\\w*|oferuj\\w*|handluj\\w*|wyplac\\w*)|${W('oszust\\w*|scam\\w*|naciagacz\\w*|ostrzega\\w*|ostrzezeni\\w*')}|uwaga na`,
);

/** Zdania tekstu z położeniem; kropka bez spacji po niej (np. „crypto.com”, „0.5”) nie kończy zdania. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length > 0);
}

const cut = (text: string) => (text.length > FIAT_WEB_RULES.maxExcerpt ? `${text.slice(0, FIAT_WEB_RULES.maxExcerpt - 1)}…` : text);

/**
 * Oznaki wyjścia do walut tradycyjnych w treści JEDNEJ publikacji. Wywołujący odpowiada za to, by treść
 * pochodziła z konta przypisanego podmiotowi (analiza wywołuje to tylko dla dokumentów z rolą `subject`).
 */
export function detectFiatSignals(text: string): FiatSignalHit[] {
  const all = sentences(text);
  const folded = all.map(foldText);
  const declared = folded.map((item) => !NEGATION_RE.test(item));
  const offerAt = folded.map(
    (item, index) =>
      declared[index]! && FIAT_RE.test(item) && (SELL_CRYPTO_RE.test(item) || (CRYPTO_FOR_FIAT_RE.test(item) && !BUY_RE.test(item))),
  );
  // Publikacja z ofertą sprzedaży kryptowaluty — wtedy „spotkanie” i „BLIK” w innym zdaniu dotyczą tej oferty.
  const offerInDoc = offerAt.some(Boolean);
  const hits: FiatSignalHit[] = [];
  const seen = new Set<string>();
  // Każda oznaka z każdego zdania (najwyżej kilka na regułę) — pełniejszy zbiór zdań pozwala rozpoznać kopię tej samej oferty.
  const add = (hit: FiatSignalHit) => {
    const key = `${hit.rule}|${hit.service ?? ''}`;
    if (seen.has(`${key}|${hit.excerpt}`)) return;
    // Nazwana usługa — raz na publikację; oznaka bez usługi — najwyżej kilka zdań.
    if (hit.service ? seen.has(key) : hits.filter((item) => item.rule === hit.rule).length >= FIAT_WEB_RULES.maxHitsPerRule) return;
    seen.add(key);
    seen.add(`${key}|${hit.excerpt}`);
    hits.push(hit);
  };

  all.forEach((sentence, index) => {
    if (!declared[index]) return;
    const item = folded[index]!;
    const offramps = matchOfframps(sentence);
    const crypto = CRYPTO_RE.test(item);
    // Kontekst kryptowalut: token w zdaniu, nazwana usługa wyjścia do fiat albo oferta sprzedaży w tej publikacji.
    const context = crypto || offerInDoc || offramps.some((match) => !match.service.cryptoContext);
    const excerpt = cut(sentence);
    if (offerAt[index]) add({ rule: 'p2p_offer_pln', excerpt });
    // Gotówka przy kupnie kryptowaluty (bez sprzedaży) to wejście, nie wyjście.
    if (context && CASH_MEETING_RE.test(item) && !(BUY_RE.test(item) && !offerAt[index])) add({ rule: 'cash_meeting', excerpt });
    if (context && BANK_RE.test(item)) add({ rule: 'bank_or_blik', excerpt });
    for (const match of offramps) {
      if (match.service.cryptoContext && !crypto) continue;
      const rule: FiatWebRule =
        match.service.kind === 'crypto_card_issuer' ? 'crypto_card' : match.service.kind === 'payment_gateway' ? 'payment_gateway' : 'named_offramp';
      add({ rule, excerpt, service: match.service.name, offrampKind: match.service.kind });
    }
  });
  return hits;
}

// ---------- Rejestry: tylko nazwy ----------

let registryCache: RegistryData | undefined;
const registryData = (registry: RegistryData | null | undefined): RegistryData | undefined =>
  registry === null ? undefined : (registry ?? (registryCache ??= loadRegistrySnapshots()));

/** Wpisy usługi w migawkach rejestrów (RDWW, MiCA) — dopasowanie po dokładnej nazwie z listy usług. */
export function registryNotes(service: OfframpService, registry?: RegistryData | null): string[] {
  const data = registryData(registry);
  if (!data || !service.registry) return [];
  const notes: string[] = [];
  for (const name of service.registry.rdww ?? []) {
    const entry = data.rdww?.wpisy.find((item) => registryCoreName(item.nazwa) === registryCoreName(name));
    if (entry) {
      notes.push(
        `wpis w Rejestrze działalności w zakresie walut wirtualnych (RDWW): ${entry.nazwa}, nr ${entry.numer} z ${entry.dataWpisu}` +
          `${entry.wykreslony ? ' — WPIS WYKREŚLONY' : ''} (migawka IAS Katowice, stan na ${data.rdww!.stanNa})`,
      );
    }
  }
  for (const name of service.registry.casp ?? []) {
    const entry = data.casp?.wpisy.find((item) => registryCoreName(item.nazwa) === registryCoreName(name));
    if (entry) {
      notes.push(
        `zezwolenie MiCA (rejestr CASP, ESMA): ${entry.nazwa}${entry.nazwaHandlowa ? ` („${entry.nazwaHandlowa}”)` : ''}, organ: ${entry.organ} (${entry.kraj})` +
          `${entry.dataZezwolenia ? `, od ${entry.dataZezwolenia}` : ''}${(entry.kraje ?? '').split('|').includes('PL') ? ', usługi zgłoszone także w Polsce' : ''} (migawka z ${data.casp!.pobrano.slice(0, 10)})`,
      );
    }
  }
  return notes;
}

/** Rodzaj usługi wyjścia do fiat i jej wpisy w rejestrach — po nazwie usługi lub etykiecie adresu. */
export function offrampInfo(name: string | undefined, registry?: RegistryData | null): CashOutAssessment['offramp'] | undefined {
  const service = offrampFor(name);
  if (!service) return undefined;
  return { kind: service.kind, label: OFFRAMP_KIND_LABEL[service.kind], registry: registryNotes(service, registry) };
}

// ---------- „Co potwierdzi wypłatę” ----------

/** Identyfikator usługi w teczce dla nazwy z listy usług wyjścia do fiat („Binance Card” → „binance”). */
export const linkIdOf = (name: string): string => serviceIdOf(name.replace(/\s*\([^)]*\)$/, '') || name);

/** Usługi do zapytania z gotowymi wskazówkami z powiązań teczki (gdy usługa jest wśród nich). */
export function confirmationServices(names: string[], links: ServiceLink[] | undefined): CashOutConfirmation['services'] {
  const result: CashOutConfirmation['services'] = [];
  for (const name of names) {
    if (name.includes('(ogólnie)')) continue;
    const id = linkIdOf(name);
    if (result.some((item) => item.serviceId === id)) continue;
    const link = links?.find((item) => item.id === id);
    result.push({ name: link?.name ?? name, serviceId: id, requestHints: link?.requestHints ?? [] });
  }
  return result;
}

// ---------- Publikacje podmiotu z teczki ----------

/**
 * Publikacje kont PRZYPISANYCH PODMIOTOWI (profile kandydata głównego) z oznakami wyjścia do fiat. Oznaki wykryto
 * w analizie z pełnej treści; starsze analizy ich nie mają — wtedy szukamy w cytatach przy adresach z tych samych dokumentów.
 */
export function fiatPublicationsOf(nodes: { sightings: Sighting[] }[], findings: { evidence: { url: string; service: string; excerpt: string; contentHash?: string }[] }[]): FiatPublication[] {
  const result: FiatPublication[] = [];
  const seen = new Set<string>();
  for (const sighting of nodes.flatMap((node) => node.sightings)) {
    if (seen.has(sighting.url)) continue;
    seen.add(sighting.url);
    const sameDoc = findings.flatMap((finding) => finding.evidence.filter((item) => sightingKey(item) === sightingKey(sighting)));
    const hits = sighting.fiatSignals ?? detectFiatSignals(sameDoc.map((item) => item.excerpt).join('\n'));
    if (hits.length === 0) continue;
    result.push({
      url: sighting.url,
      service: sighting.service,
      ...(sighting.title ? { title: sighting.title } : {}),
      ...(sighting.publishedAt ? { publishedAt: sighting.publishedAt } : {}),
      ...(sameDoc[0]?.contentHash ? { contentHash: sameDoc[0].contentHash } : {}),
      hits,
    });
  }
  return result;
}

// ---------- Ocena z publikacji ----------

export interface WebCashOutInput {
  /** Publikacje kont PRZYPISANYCH PODMIOTOWI (kandydat główny) — inne nie są brane pod uwagę. */
  publications: FiatPublication[];
  serviceLinks?: ServiceLink[];
  /** Migawki rejestrów; brak — wczytane z pakietu źródeł; `null` — bez sprawdzania. */
  registry?: RegistryData | null;
  /** Etykieta w identyfikatorze oceny (np. identyfikator sprawy). */
  key?: string;
}

const WEB_LIMITATIONS = [
  'Deklaracja w publikacji nie dowodzi, że do wymiany doszło: pokazuje gotowość albo sposób rozliczania. Wypłatę potwierdza wyłącznie usługa (dane KYC i historia wypłat) albo bank prowadzący rachunek.',
  'Oceniono wyłącznie publikacje kont przypisanych podmiotowi; wzmianki i cytaty innych autorów pominięto. Konto mogło zostać przejęte albo podszyte — przypisanie konta ocenia osobno wskaźnik pewności osoby.',
  'Kopie tej samej treści (ta sama oferta w kilku serwisach, kopia archiwalna, przedruk) liczą się jako jedno pochodzenie.',
];

/** Grupy pochodzenia publikacji: zależne są kopie tej samej treści i kopie archiwalne tej samej strony — NIE sam wspólny serwis. */
function publicationGroups(publications: FiatPublication[]): Map<string, number> {
  const evidence: Evidence[] = publications.map((item) => ({
    id: item.url,
    category: 'forum_post',
    // Serwis = adres publikacji: wspólny serwis nie łączy tu publikacji (to i tak ten sam autor), łączy treść i kopia.
    service: item.url,
    url: item.url,
    capturedAt: '',
    identityMatch: 'same_handle',
    excerpt: [...new Set(item.hits.map((hit) => hit.excerpt))].join(' '),
    ...(item.contentHash ? { contentHash: item.contentHash } : {}),
  }));
  const groupOf = new Map<string, number>();
  provenanceGroups(evidence).forEach((group, index) => group.evidenceIds.forEach((id) => groupOf.set(id, index)));
  return groupOf;
}

/**
 * Jedna ocena wskaźnika C z publikacji kont podmiotu (`origin: 'web'`). `undefined`, gdy publikacje nie mają oznak.
 * Szczebel najwyżej „potencjalny sygnał wypłaty”; status zawsze `hypothesis`.
 */
export function buildWebCashOutAssessment(input: WebCashOutInput): CashOutAssessment | undefined {
  // Ten sam adres publikacji raz (dokument widziany przez dwa łączniki).
  const byUrl = new Map<string, FiatPublication>();
  for (const item of input.publications) if (item.hits.length > 0 && !byUrl.has(item.url)) byUrl.set(item.url, item);
  const publications = [...byUrl.values()];
  if (publications.length === 0) return undefined;
  const groupOf = publicationGroups(publications);

  const components: ComponentDraft[] = [];
  const named = new Map<string, { kind?: OfframpKind; urls: Set<string> }>();
  for (const rule of Object.keys(FIAT_WEB_RULES.weights) as FiatWebRule[]) {
    const withRule = publications.filter((item) => item.hits.some((hit) => hit.rule === rule));
    if (withRule.length === 0) continue;
    const groups = [...new Set(withRule.map((item) => groupOf.get(item.url)!))].sort((a, b) => a - b);
    const hits = withRule.flatMap((item) => item.hits.filter((hit) => hit.rule === rule).map((hit) => ({ ...hit, url: item.url })));
    const services = [...new Set(hits.map((hit) => hit.service).filter((value): value is string => !!value))];
    for (const hit of hits) {
      if (!hit.service) continue;
      const entry = named.get(hit.service) ?? { kind: hit.offrampKind, urls: new Set<string>() };
      entry.urls.add(hit.url);
      named.set(hit.service, entry);
    }
    const registry = services.flatMap((name) => {
      const service = offrampFor(name);
      return service ? registryNotes(service, input.registry).map((note) => `${name}: ${note}`) : [];
    });
    const quote = hits[0]!.excerpt;
    const copies = withRule.length - groups.length;
    const evidence: EvidenceRef[] = [
      ...withRule.map((item) => ({ kind: 'url' as const, value: item.url })),
      ...services.map((name) => {
        const service = offrampFor(name);
        return { kind: 'attribute' as const, value: `${name} — ${service ? OFFRAMP_KIND_LABEL[service.kind] : 'usługa'}` };
      }),
      ...registry.map((value) => ({ kind: 'attribute' as const, value })),
    ];
    components.push({
      rule: `cashout.web.${rule}`,
      weight: FIAT_WEB_RULES.weights[rule],
      direction: 'supports',
      source: WEB_SOURCE,
      // Ten sam zbiór publikacji to jedno pochodzenie: kilka oznak z jednej oferty nie sumuje się.
      originKey: `web:${groups.join(',')}`,
      evidence,
      explanation:
        `${FIAT_WEB_RULE_LABEL[rule][0]!.toUpperCase()}${FIAT_WEB_RULE_LABEL[rule].slice(1)} — ${withRule.length} ${plural(withRule.length, 'publikacja', 'publikacje', 'publikacji')} konta podmiotu` +
        `${copies > 0 ? ` (w tym ${copies} ${plural(copies, 'kopia', 'kopie', 'kopii')} tej samej treści — ${groups.length} ${plural(groups.length, 'niezależne pochodzenie', 'niezależne pochodzenia', 'niezależnych pochodzeń')})` : ''}` +
        `${services.length > 0 ? `; usługi: ${services.join(', ')}` : ''}. Cytat: „${quote}”.` +
        (registry.length > 0 ? ` Rejestry publiczne (zgodność nazwy, nie tożsamości podmiotu): ${registry.join('; ')}.` : ''),
      limitations:
        rule === 'payment_gateway'
          ? ['Bramka rozlicza sprzedawcę w walucie tradycyjnej — dotyczy podmiotu tylko wtedy, gdy to on przyjmuje płatności; płacący kryptowalutą nie wypłaca środków.']
          : rule === 'named_offramp'
            ? ['Sama nazwa usługi w publikacji to wzmianka; nie wiadomo, czy podmiot ma tam konto ani czy wypłacał środki.']
            : ['Deklaracja w publikacji — bez danych o faktycznie zawartych transakcjach.'],
    });
  }

  const stage = components.some((item) => FIAT_WEB_RULES.signalRules.some((rule) => item.rule === `cashout.web.${rule}`)) ? 'cashout_signal' : 'service_interaction';
  const services = [...named.keys()];
  const confirmServices = confirmationServices(services, input.serviceLinks);
  const offer = components.some((item) => /p2p_offer_pln|cash_meeting|bank_or_blik/.test(item.rule));
  const found = components.map((item) => FIAT_WEB_RULE_LABEL[item.rule.replace('cashout.web.', '') as FiatWebRule]);
  const sources = [...new Set(publications.map((item) => item.service))];
  const indicator = combineComponents('cash_out', components, { limitations: WEB_LIMITATIONS });
  return {
    id: `cashout:web:${input.key ?? 'podmiot'}`,
    address: '',
    network: 'web',
    stage,
    txids: [],
    indicator,
    status: 'hypothesis',
    origin: 'web',
    statement:
      `${stage === 'cashout_signal' ? 'Potencjalny sygnał wypłaty' : 'Interakcja z usługą wymiany (deklarowana)'} w publikacjach kont podmiotu: ${found.join('; ')} ` +
      `(${publications.length} ${plural(publications.length, 'publikacja', 'publikacje', 'publikacji')} w serwisach: ${sources.join(', ')}). ` +
      'To deklaracje w treściach publicznych, nie transakcje — ocena nie przekracza szczebla „potencjalny sygnał wypłaty”; wypłatę potwierdza tylko usługa albo bank.',
    why:
      stage === 'cashout_signal'
        ? `Podmiot sam opisuje zamianę kryptowalut na walutę tradycyjną (${found.filter((_, index) => FIAT_WEB_RULES.signalRules.some((rule) => components[index]!.rule === `cashout.web.${rule}`)).join('; ')}) — to deklarowany sposób wyjścia do fiat.`
        : 'Podmiot wymienia w swoich publikacjach usługi, w których zamienia się kryptowaluty na pieniądze — to wskazówka, gdzie szukać konta, a nie oznaka samej wypłaty.',
    confirm: {
      text:
        (confirmServices.length > 0
          ? `Zapytanie do ${confirmServices.map((item) => item.name).join(', ')} o konto powiązane z danymi podmiotu (nazwy kont, e-mail, telefon z publikacji), historię sprzedaży i wypłat na rachunek. `
          : '') +
        (offer
          ? 'Przy ofertach rozliczanych przelewem lub BLIK-iem: zapytanie do banku prowadzącego rachunek albo operatora płatności (numer telefonu lub rachunku z publikacji) o wpływy od kontrahentów — w trybie i na podstawie właściwych przepisów. '
          : '') +
        'Odpowiedź wprowadza analityk w zakładce odpowiedzi usług; dopiero ona może dać szczebel „udokumentowane wyjście”.',
      services: confirmServices,
    },
    publications: publications.map((item) => ({ url: item.url, service: item.service, ...(item.title ? { title: item.title } : {}), ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}) })),
  };
}

/**
 * Usługi nazwane w publikacjach podmiotu — do powiązania z oceną z blockchaina dla tej samej usługi
 * (`identyfikator usługi` → adresy publikacji, klucz pochodzenia i to, czy publikacja mówi o wymianie na fiat).
 */
export function webServiceRefs(publications: FiatPublication[]): Map<string, { name: string; urls: string[]; originKey: string; fiatContext: boolean; excerpt: string }> {
  const refs = new Map<string, { name: string; urls: string[]; originKey: string; fiatContext: boolean; excerpt: string }>();
  const groupOf = publicationGroups(publications.filter((item) => item.hits.length > 0));
  for (const publication of publications) {
    const fiat = publication.hits.some((hit) => FIAT_WEB_RULES.signalRules.includes(hit.rule));
    for (const hit of publication.hits) {
      if (!hit.service || hit.service.includes('(ogólnie)')) continue;
      const id = linkIdOf(hit.service);
      const ref = refs.get(id) ?? { name: hit.service, urls: [], originKey: '', fiatContext: false, excerpt: hit.excerpt };
      if (!ref.urls.includes(publication.url)) ref.urls.push(publication.url);
      ref.fiatContext ||= fiat;
      refs.set(id, ref);
    }
  }
  for (const ref of refs.values()) ref.originKey = `web:${[...new Set(ref.urls.map((url) => groupOf.get(url) ?? -1))].sort((a, b) => a - b).join(',')}`;
  return refs;
}
