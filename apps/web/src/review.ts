// „Do potwierdzenia”: jedna kolejka wszystkich rozstrzygnięć czekających na analityka — zebrana z całej teczki.
// Czysta logika bez Reacta i DOM (poza opcjonalnym `sessionStorage`), testowana w `test/review.test.ts`.
// Każda pozycja niesie dokładnie te wywołania decyzji (cel + klucz), które wysyłają istniejące karty teczki —
// kolejka niczego nie wymyśla, tylko zbiera rozproszone pytania w jednym miejscu.
import type { DecisionTarget } from './api.ts';
import { activeDecisions, currentDecision } from './decisions.ts';
import type { DecisionRecord } from './decisions.ts';
import { fmtPln, shorten } from './format.ts';
import { explorerForTxid, identityStatus } from './identities.ts';
import type { DossierTab } from './router.ts';
import type { ScoreKind } from './ux.ts';

// ---------- Kształty ----------

export type ReviewKind = 'cashout' | 'person' | 'address' | 'identity' | 'operator' | 'organization' | 'public_figure' | 'scam_warning' | 'reply';

/** Kolejność ważności: najpierw pieniądze, potem osoba, adresy, tożsamości, operatorzy, organizacje, reszta. */
export const REVIEW_KIND_ORDER: readonly ReviewKind[] = ['cashout', 'person', 'address', 'identity', 'operator', 'organization', 'public_figure', 'scam_warning', 'reply'];

export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  cashout: 'Wypłaty',
  person: 'Osoba',
  address: 'Adresy',
  identity: 'Tożsamości',
  operator: 'Wspólny operator',
  organization: 'Organizacje',
  public_figure: 'Osoba publiczna',
  scam_warning: 'Ostrzeżenia',
  reply: 'Odpowiedzi usług',
};

/** Jedno wywołanie istniejącego API decyzji: `POST /api/cases/:id/decisions` z celem i kluczem. */
export interface DecisionCall {
  target: DecisionTarget;
  key: string;
}

export interface ReviewEvidence {
  label: string;
  url?: string;
}

export interface ReviewItem {
  /** Stały identyfikator pozycji: `rodzaj:klucz`. */
  id: string;
  kind: ReviewKind;
  /** Pytanie prostym językiem — tytuł karty. */
  title: string;
  /** Dlaczego to ważne — jedno zdanie. */
  why: string;
  /** Najważniejsze 2–3 ślady. */
  evidence: ReviewEvidence[];
  score?: { value: number; kind: ScoreKind; caption: string; reasons?: string[] };
  /** Kwota, której dotyczy rozstrzygnięcie (PLN) — do kolejności i podpisu. */
  valuePln?: number;
  /** Co zrobi potwierdzenie / odrzucenie. */
  confirmEffect: string;
  rejectEffect: string;
  /** Wywołania decyzji; puste = pozycja tylko do sprawdzenia (usługa nie zapisuje takiej decyzji). */
  confirm: DecisionCall[];
  reject: DecisionCall[];
  /** Notatka domyślna — ta sama, którą wysyłają karty teczki. */
  confirmNote: string;
  rejectNote: string;
  /** Potwierdzenie wymaga podstawy w notatce (dokument spoza blockchaina). */
  noteRequired?: boolean;
  /** Sekcja teczki ze szczegółami. */
  tab: DossierTab;
}

/** Obowiązująca decyzja — pozycja „Zdecydowane” z możliwością cofnięcia. */
export interface DecidedEntry {
  decisionId: string;
  target: string;
  key: string;
  decision: 'confirmed' | 'rejected';
  note?: string;
  decidedAt: string;
  /** Opis obiektu decyzji prostym językiem. */
  label: string;
  tab: DossierTab;
}

export interface ReviewQueue {
  pending: ReviewItem[];
  decided: DecidedEntry[];
}

// ---------- Pomocnicze ----------

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): Rec[] => (Array.isArray(value) ? value.filter(isRec) : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const short = (address: string) => shorten(address, 6, 4);
const lower = (value: string) => value.toLowerCase();
const uniqueBy = <T>(items: T[], keyOf: (item: T) => string) => [...new Map(items.map((item) => [keyOf(item), item] as const)).values()];
const keyOfAddress = (network: string, address: string) => `${network}:${address}`;

function httpUrl(value: unknown): string | undefined {
  const text = str(value);
  return text && /^https?:\/\//i.test(text) ? text : undefined;
}

/** Nazwa serwisu z adresu URL — podpis śladu, gdy usługa jej nie podaje. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function decisionsOf(dossier: Rec): DecisionRecord[] {
  return list(dossier.decisions).filter((item) => str(item.id) && str(item.target) && typeof item.key === 'string') as unknown as DecisionRecord[];
}

/**
 * Imię i nazwisko osoby głównej — do pytań w mianowniku („Czy Jan Kowalski…”). Nazwy sprawy nie używamy:
 * bywa nią adres albo nazwa giełdy, a pytanie „Czy KryptoGiełda jest właścicielem…” wprowadzałoby w błąd.
 */
function mainName(dossier: Rec): string | undefined {
  return str(list(dossier.persons)[0]?.fullName);
}

function profileUrl(dossier: Rec, id: string): string | undefined {
  return httpUrl(list(dossier.profiles).find((profile) => profile.id === id)?.url);
}

function profileLabel(id: string): string {
  const cut = id.indexOf('|');
  return cut < 0 ? (/^https?:/i.test(id) ? hostOf(id) : id) : `${id.slice(cut + 1)} (${id.slice(0, cut)})`;
}

function componentsReasons(indicator: unknown): string[] {
  return isRec(indicator) ? list(indicator.components).map((item) => str(item.explanation)).filter((item): item is string => item !== undefined).slice(0, 6) : [];
}

function componentsEvidence(indicator: unknown, findings: Rec[]): ReviewEvidence[] {
  if (!isRec(indicator)) return [];
  const result: ReviewEvidence[] = [];
  for (const component of list(indicator.components)) {
    for (const ref of list(component.evidence)) {
      const value = str(ref.value);
      if (!value) continue;
      if (ref.kind === 'url' && httpUrl(value)) result.push({ label: hostOf(value), url: value });
      else if (ref.kind === 'txid') result.push({ label: `transakcja ${short(value)}`, url: explorerForTxid(findings as never, value) });
      else if (ref.kind === 'attribute') result.push({ label: value.length > 40 ? `${value.slice(0, 39)}…` : value });
    }
  }
  return uniqueBy(result, (item) => item.url ?? item.label);
}

const top = (items: ReviewEvidence[], limit = 3) => uniqueBy(items, (item) => item.url ?? item.label).slice(0, limit);

// ---------- Zbieranie pozycji według rodzaju ----------

function cashOutItems(dossier: Rec, findings: Rec[]): ReviewItem[] {
  const indicators = isRec(dossier.indicators) ? dossier.indicators : {};
  const linked = new Set(findings.filter((finding) => !(isRec(finding.confidence) && finding.confidence.excluded)).map((finding) => lower(keyOfAddress(String(finding.network), String(finding.address)))));
  const items = list(indicators.cashOut)
    .filter((item) => item.origin !== 'web' && str(item.address) && str(item.network))
    .filter((item) => item.stage === 'service_interaction' || item.stage === 'cashout_signal')
    .filter((item) => item.status !== 'confirmed' && item.status !== 'rejected')
    .filter((item) => linked.has(lower(keyOfAddress(String(item.network), String(item.address)))))
    .map((item): ReviewItem => {
      const address = String(item.address);
      const key = keyOfAddress(String(item.network), address);
      const service = str(item.serviceName) ?? 'usługę wymiany';
      const valuePln = num(item.valuePln);
      const indicator = isRec(item.indicator) ? item.indicator : undefined;
      const txEvidence = strings(item.txids).map((txid) => ({ label: `transakcja ${short(txid)}`, url: explorerForTxid(findings as never, txid) }));
      return {
        id: `cashout:${key}`,
        kind: 'cashout',
        title: `Czy masz dokument wypłaty z adresu ${short(address)} przez ${service}${valuePln ? ` (${fmtPln(valuePln)})` : ''}?`,
        why: str(item.why) ?? 'Udokumentowana wypłata to najmocniejszy dowód spieniężenia — bez dokumentu zostaje oznaką z blockchaina.',
        evidence: top([...txEvidence, ...componentsEvidence(indicator, findings)]),
        ...(indicator && num(indicator.score) !== undefined ? { score: { value: num(indicator.score)!, kind: 'strength' as const, caption: 'siła oznak wypłaty', reasons: componentsReasons(indicator) } } : {}),
        ...(valuePln ? { valuePln } : {}),
        confirmEffect: 'Potwierdzenie podniesie ocenę do „udokumentowane wyjście do walut tradycyjnych” — w notatce podaj podstawę (np. pismo giełdy).',
        rejectEffect: 'Odrzucenie zapisze w rejestrze, że dokumentu nie ma — ocena wypłaty zostaje bez zmian.',
        confirm: [{ target: 'cashout', key }],
        reject: [{ target: 'cashout', key }],
        confirmNote: 'Wypłata udokumentowana poza blockchainem',
        rejectNote: 'Brak dokumentu wypłaty',
        noteRequired: true,
        tab: 'wskazniki',
      };
    });
  // Kilka ocen jednego adresu (różne usługi) to jedno rozstrzygnięcie — decyzja `cashout` dotyczy adresu.
  return uniqueBy(
    items.sort((a, b) => (a.valuePln ?? 0) - (b.valuePln ?? 0)),
    (item) => lower(item.id),
  );
}

function personItems(dossier: Rec, decisions: DecisionRecord[]): ReviewItem[] {
  const main = list(dossier.persons)[0];
  if (!main) return [];
  const status = str(main.status) ?? 'hypothesis';
  if (status !== 'hypothesis') return [];
  const profileIds = strings(main.profileIds);
  if (profileIds.length === 0) return [];
  // Osoba jest potwierdzona, gdy choć jedno jej konto potwierdzono; odrzucona — gdy odrzucono wszystkie.
  const states = profileIds.map((id) => currentDecision(decisions, 'profile', id)?.decision);
  if (states.includes('confirmed') || states.every((state) => state === 'rejected')) return [];
  const open = profileIds.filter((_, index) => states[index] === undefined);
  const name = str(main.fullName);
  const probability = num(main.probability);
  return [
    {
      id: `person:${str(main.id) ?? profileIds[0]}`,
      kind: 'person',
      title: name ? `Czy ${name} to osoba, której dotyczy sprawa?` : `Czy konta ${profileIds.slice(0, 2).map(profileLabel).join(' i ')} prowadzi osoba ze sprawy?`,
      why: `Na tym ustaleniu opiera się cała teczka: ${profileIds.length} ${profileIds.length === 1 ? 'konto' : 'kont(a)'} i przypisane im adresy liczą się do sum tej osoby.`,
      evidence: top(profileIds.map((id) => ({ label: profileLabel(id), url: profileUrl(dossier, id) }))),
      ...(probability !== undefined ? { score: { value: probability, kind: 'person' as const, caption: 'pewność ustalenia osoby', reasons: strings(main.reasons) } } : {}),
      confirmEffect: 'Potwierdzenie oznaczy konta osoby jako jej własne — ustalenie przestaje być hipotezą.',
      rejectEffect: 'Odrzucenie rozdzieli konta od sprawy — ich ślady i adresy przestaną się liczyć do wyniku.',
      confirm: open.map((key) => ({ target: 'profile' as const, key })),
      reject: open.map((key) => ({ target: 'profile' as const, key })),
      confirmNote: 'Ta sama osoba',
      rejectNote: 'Inna osoba',
      tab: 'osoba',
    },
  ];
}

function unconfirmedItems(dossier: Rec, owner: string | undefined): ReviewItem[] {
  return list(dossier.unconfirmedAddresses)
    .filter((item) => str(item.address) && str(item.network))
    .map((item): ReviewItem => {
      const address = String(item.address);
      const key = keyOfAddress(String(item.network), address);
      const chain = isRec(item.chain) ? item.chain : undefined;
      const cash = num(chain?.cashOutPlnTotal) ?? 0;
      const confirmWith = list(item.confirmWith)
        .filter((call) => (call.target === 'profile' || call.target === 'address') && typeof call.key === 'string')
        .map((call) => ({ target: call.target as DecisionTarget, key: String(call.key) }));
      return {
        id: `address:${key}`,
        kind: 'address',
        title: owner ? `Czy ${owner} jest właścicielem adresu ${short(address)}?` : `Czy adres ${short(address)} należy do osoby ze sprawy?`,
        why:
          cash > 0
            ? `Z adresu wyszły środki do usług na ${fmtPln(cash)} — nie liczą się do sprawy, dopóki własność jest niepotwierdzona.`
            : 'Adres jest w źródłach osoby, ale nie liczy się do sprawy, dopóki własność jest niepotwierdzona.',
        evidence: top(list(item.sources).map((source) => ({ label: `${str(source.service) ?? hostOf(String(source.url ?? ''))}${str(source.author) ? ` (${source.author})` : ''}`, url: httpUrl(source.url) }))),
        ...(num(item.personAddressProbability) !== undefined
          ? { score: { value: num(item.personAddressProbability)!, kind: 'joint' as const, caption: 'powiązanie z osobą ze sprawy', reasons: strings(item.reasons) } }
          : {}),
        ...(cash > 0 ? { valuePln: cash } : {}),
        confirmEffect: cash > 0 ? `Potwierdzenie doliczy adres do sum i dowodu spieniężenia (${fmtPln(cash)}).` : 'Potwierdzenie doliczy adres do sum i dowodu spieniężenia.',
        rejectEffect: 'Odrzucenie wykluczy adres ze sprawy — nie będzie już proponowany.',
        confirm: confirmWith.length > 0 ? confirmWith : [{ target: 'address', key }],
        reject: [{ target: 'address', key }],
        confirmNote: 'Potwierdzono własność adresu',
        rejectNote: 'To nie jest adres tej osoby',
        tab: 'adresy',
      };
    });
}

/** Próg „hipotezy”: adres przypisany, ale słabiej niż „prawdopodobnie” (poniżej 60 na 100). */
export const HYPOTHESIS_ADDRESS_MAX = 60;
export const HYPOTHESIS_ADDRESS_MIN = 20;

function weakAddressItems(dossier: Rec, findings: Rec[], owner: string | undefined, skip: Set<string>): ReviewItem[] {
  const main = list(dossier.persons)[0];
  const probabilityOf = (key: string) => num(list(main?.addresses).find((item) => item.key === key)?.probability);
  return findings
    .filter((finding) => str(finding.address) && str(finding.network))
    .filter((finding) => !(isRec(finding.confidence) && finding.confidence.excluded) && !finding.widelyCited && !finding.confirmedByReply)
    .flatMap((finding): ReviewItem[] => {
      const address = String(finding.address);
      const key = keyOfAddress(String(finding.network), address);
      if (skip.has(lower(key))) return [];
      const confidence = isRec(finding.confidence) ? finding.confidence : {};
      const value = num(finding.subjectProbability) ?? probabilityOf(key) ?? num(confidence.score);
      if (value === undefined || value >= HYPOTHESIS_ADDRESS_MAX || value < HYPOTHESIS_ADDRESS_MIN) return [];
      const evidence = list(finding.evidence).map((item) => ({ label: `${str(item.service) ?? 'źródło'}${str(item.author) ? ` (${item.author})` : ''}`, url: httpUrl(item.url) }));
      const ledger = list(confidence.ledger).map((entry) => str(entry.explanation)).filter((item): item is string => item !== undefined);
      return [
        {
          id: `address:${key}`,
          kind: 'address',
          title: owner ? `Czy ${owner} jest właścicielem adresu ${short(address)}?` : `Czy adres ${short(address)} należy do osoby ze sprawy?`,
          why: 'Adres liczy się do sprawy, ale powiązanie jest słabe — potwierdzenie albo odrzucenie usunie wątpliwość z sum.',
          evidence: top(evidence),
          score: { value, kind: 'joint', caption: 'powiązanie z osobą ze sprawy', reasons: ledger.slice(0, 6) },
          confirmEffect: 'Potwierdzenie przypisze adres osobie na stałe — wynik adresu przestaje być hipotezą.',
          rejectEffect: 'Odrzucenie wykluczy adres ze sprawy i z sum wypłat.',
          confirm: [{ target: 'address', key }],
          reject: [{ target: 'address', key }],
          confirmNote: 'Potwierdzono własność adresu',
          rejectNote: 'To nie jest adres tej osoby',
          tab: 'adresy',
        },
      ];
    });
}

function identityItems(dossier: Rec, findings: Rec[], owner: string | undefined): ReviewItem[] {
  return list(dossier.linkedIdentities)
    .filter((identity) => identityStatus({ status: identity.status as never, decision: identity.decision as never }) === 'hypothesis')
    .flatMap((identity): ReviewItem[] => {
      const calls = list(identity.mergeWith)
        .filter((call) => (call.target === 'profile' || call.target === 'address') && typeof call.key === 'string')
        .map((call) => ({ target: call.target as DecisionTarget, key: String(call.key) }));
      if (calls.length === 0) return [];
      const name = str(identity.displayName) ?? str(identity.id) ?? 'tożsamość';
      const years = isRec(identity.cashOutPlnByYear) ? Object.values(identity.cashOutPlnByYear).map(num).filter((item): item is number => item !== undefined) : [];
      const cash = years.reduce((total, value) => total + value, 0);
      const evidence = [
        ...list(identity.profiles).map((profile) => ({ label: `${str(profile.handle) ?? str(profile.id) ?? 'konto'} (${str(profile.service) ?? 'serwis'})`, url: httpUrl(profile.url) })),
        ...list(identity.reasons).flatMap((reason) =>
          list(reason.evidence).flatMap((ref) =>
            ref.kind === 'url' && httpUrl(ref.value) ? [{ label: hostOf(String(ref.value)), url: String(ref.value) }] : ref.kind === 'txid' && str(ref.value) ? [{ label: `transakcja ${short(String(ref.value))}`, url: explorerForTxid(findings as never, String(ref.value)) }] : [],
          ),
        ),
      ];
      return [
        {
          id: `identity:${str(identity.id) ?? name}`,
          kind: 'identity',
          title: owner ? `Czy „${name}” to ta sama osoba co ${owner}?` : `Czy „${name}” to ta sama osoba, której dotyczy sprawa?`,
          why: cash > 0 ? `Tożsamość ma wypłaty na ${fmtPln(cash)} — po scaleniu doliczą się do sprawy.` : str(list(identity.reasons)[0]?.text) ?? 'Ślady prowadzą do innego konta lub nazwiska — to hipoteza, dopóki jej nie rozstrzygniesz.',
          evidence: top(evidence),
          ...(num(identity.score) !== undefined ? { score: { value: num(identity.score)!, kind: 'strength' as const, caption: 'siła powiązania', reasons: strings(identity.path) } } : {}),
          ...(cash > 0 ? { valuePln: cash } : {}),
          confirmEffect: 'Potwierdzenie scali tożsamość z osobą główną — jej konta i adresy doliczą się do sprawy.',
          rejectEffect: 'Odrzucenie oznaczy powiązanie jako fałszywe — tożsamość zostanie na liście jako odrzucona.',
          confirm: calls,
          reject: calls,
          confirmNote: `Potwierdzono wspólnego operatora z „${name}”`,
          rejectNote: `Odrzucono hipotezę wspólnego operatora z „${name}”`,
          tab: 'tozsamosci',
        },
      ];
    });
}

const OPERATOR_OPEN = new Set(['hypothesis', 'auto_grouped', 'blocked']);
/** Słabsze hipotezy wspólnego operatora (poniżej progu) zostają w zakładce „Wskaźniki” — kolejka ich nie pokazuje. */
export const OPERATOR_MIN_SCORE = 30;

function operatorItems(dossier: Rec, findings: Rec[]): ReviewItem[] {
  const indicators = isRec(dossier.indicators) ? dossier.indicators : {};
  // Pary kont połączone automatycznie w osobie głównej rozstrzyga jedna pozycja „Osoba” — nie pytamy o każdą parę.
  const mainProfiles = new Set(strings(list(dossier.persons)[0]?.profileIds).map(lower));
  return list(indicators.commonOperator)
    .filter((item) => str(item.id) && OPERATOR_OPEN.has(String(item.status)) && !isRec(item.decision))
    .filter((item) => !(item.status === 'auto_grouped' && strings(item.accounts).length > 0 && strings(item.accounts).every((id) => mainProfiles.has(lower(id)))))
    .filter((item) => item.status === 'blocked' || (num(isRec(item.indicator) ? item.indicator.score : undefined) ?? 0) >= OPERATOR_MIN_SCORE)
    .map((item): ReviewItem => {
      const labels =
        strings(item.accountLabels).length === 2
          ? strings(item.accountLabels).map((label) => (label.includes('„') ? label : `„${label}”`))
          : strings(item.personas).length === 2
            ? strings(item.personas).map((name) => `„${name}”`)
            : strings(item.accounts).map((id) => `„${profileLabel(id)}”`);
      const [a = '„konto A”', b = '„konto B”'] = labels;
      const indicator = isRec(item.indicator) ? item.indicator : undefined;
      const accounts = strings(item.accounts).map((id) => ({ label: profileLabel(id), url: profileUrl(dossier, id) }));
      const why =
        item.status === 'blocked'
          ? 'Przesłanki są mocne, ale sprzeczność blokuje połączenie kont — tylko Ty możesz to rozstrzygnąć.'
          : item.status === 'auto_grouped'
            ? 'Narzędzie samo zaliczyło oba konta do jednej osoby — potwierdź albo rozdziel.'
            : 'Dwa konta mają wspólne cechy — połączenie zmieni, czyje ślady liczą się do osoby.';
      return {
        id: `operator:${item.id}`,
        kind: 'operator',
        title: `Czy konta ${a} i ${b} prowadzi ta sama osoba?`,
        why,
        evidence: top([...componentsEvidence(indicator, findings).filter((entry) => entry.url), ...accounts]),
        ...(indicator && num(indicator.score) !== undefined ? { score: { value: num(indicator.score)!, kind: 'strength' as const, caption: 'siła hipotezy', reasons: componentsReasons(indicator) } } : {}),
        confirmEffect: 'Potwierdzenie połączy oba konta w jedną osobę (hipoteza staje się ustaleniem analityka).',
        rejectEffect: 'Odrzucenie rozdzieli konta — narzędzie nie połączy ich ponownie.',
        confirm: [{ target: 'link', key: String(item.id) }],
        reject: [{ target: 'link', key: String(item.id) }],
        confirmNote: 'Potwierdzono wspólnego operatora',
        rejectNote: 'Odrzucono hipotezę wspólnego operatora',
        tab: 'wskazniki',
      };
    });
}

/** Organizacje: usługa nie zapisuje decyzji o przypisaniu — pozycja do sprawdzenia w karcie organizacji. */
function organizationItems(dossier: Rec): ReviewItem[] {
  return list(dossier.organizations)
    .filter((org) => str(org.name) && (str(org.status) ?? 'hypothesis') === 'hypothesis')
    .map((org): ReviewItem => {
      const addresses = strings(org.addresses);
      const role = str(org.role) ?? 'beneficjent zbiórki';
      const indicator = num(org.indicator);
      return {
        id: `organization:${org.name}`,
        kind: 'organization',
        title: addresses[0] ? `Czy adres ${short(addresses[0].split(':').pop() ?? addresses[0])} należy do organizacji „${org.name}” (${role})?` : `Czy organizacja „${org.name}” to ${role}?`,
        why: 'Pieniądze na adres organizacji to nie dochód osoby — błędne przypisanie zawyża albo zaniża sumy.',
        evidence: top([
          ...(isRec(org.officialSite) && httpUrl(org.officialSite.url) ? [{ label: 'oficjalna strona', url: String(org.officialSite.url) }] : []),
          ...list(org.evidence).map((item) => ({ label: `${str(item.service) ?? 'źródło'}${str(item.author) ? ` (${item.author})` : ''}`, url: httpUrl(item.url) })),
        ]),
        ...(indicator !== undefined ? { score: { value: indicator, kind: 'strength' as const, caption: 'siła przypisania', reasons: list(org.components).map((item) => str(item.explanation)).filter((item): item is string => item !== undefined) } } : {}),
        confirmEffect: 'Sprawdź kartę organizacji: oficjalną stronę i cytowania adresu.',
        rejectEffect: '',
        confirm: [],
        reject: [],
        confirmNote: '',
        rejectNote: '',
        tab: 'osoba',
      };
    });
}

/** Zgodność z osobą publiczną — pole opcjonalne nowszej usługi; kształt czytany ostrożnie. */
function publicFigureItems(dossier: Rec): ReviewItem[] {
  const raw = dossier.publicFigure;
  const entries = Array.isArray(raw) ? list(raw) : isRec(raw) ? [raw] : [];
  return entries
    .filter((entry) => !['confirmed', 'rejected'].includes(String(entry.status ?? '')) && !isRec(entry.decision))
    .map((entry, index): ReviewItem => {
      const name = str(entry.name) ?? str(entry.label) ?? str(entry.fullName) ?? 'osoba publiczna';
      const role = str(entry.role) ?? str(entry.description);
      const calls = list(entry.confirmWith)
        .filter((call) => typeof call.target === 'string' && typeof call.key === 'string')
        .map((call) => ({ target: call.target as DecisionTarget, key: String(call.key) }));
      const urls = [entry.url, entry.wikidata, entry.wikipedia, ...strings(entry.sources), ...list(entry.sources).map((source) => source.url)].map(httpUrl).filter((url): url is string => url !== undefined);
      const value = num(entry.score) ?? num(entry.indicator) ?? (isRec(entry.indicator) ? num(entry.indicator.score) : undefined) ?? num(entry.probability);
      return {
        id: `public_figure:${name}:${index}`,
        kind: 'public_figure',
        title: `Czy podmiot sprawy to osoba publiczna „${name}”${role ? ` (${role})` : ''}?`,
        why: 'Zbieżność z osobą publiczną bywa przypadkowa (imiennik, podszywanie się) — błędne przypisanie to poważny błąd w teczce.',
        evidence: top(urls.map((url) => ({ label: hostOf(url), url }))),
        ...(value !== undefined ? { score: { value, kind: 'strength' as const, caption: 'siła zgodności' } } : {}),
        confirmEffect: calls.length > 0 ? 'Potwierdzenie zapisze zgodność z osobą publiczną.' : 'Sprawdź źródła zgodności w podsumowaniu sprawy.',
        rejectEffect: calls.length > 0 ? 'Odrzucenie oznaczy zbieżność jako przypadkową.' : '',
        confirm: calls,
        reject: calls,
        confirmNote: `Potwierdzono zgodność z osobą publiczną „${name}”`,
        rejectNote: `Zbieżność z osobą publiczną „${name}” przypadkowa`,
        tab: 'podsumowanie',
      };
    });
}

/** Słabe ostrzeżenia o oszustwie — pole opcjonalne nowszej usługi; do sprawdzenia, bez decyzji. */
function scamWarningItems(dossier: Rec): ReviewItem[] {
  return list(dossier.scamWarnings)
    .filter((item) => {
      const strength = str(item.strength) ?? str(item.level);
      const value = num(item.score) ?? num(item.confidence);
      return item.weak === true || strength === 'weak' || strength === 'słabe' || (value !== undefined && value < 50);
    })
    .map((item, index): ReviewItem => {
      const url = httpUrl(item.url) ?? httpUrl(item.source);
      const address = str(item.address);
      return {
        id: `scam_warning:${url ?? index}`,
        kind: 'scam_warning',
        title: address ? `Czy ostrzeżenie o oszustwie dotyczy adresu ${short(address)}?` : 'Czy ostrzeżenie o oszustwie dotyczy tej sprawy?',
        why: str(item.text) ?? str(item.reason) ?? 'Słabe ostrzeżenie może zmienić ocenę adresu (np. ofiara podszywania się zamiast beneficjenta).',
        evidence: url ? [{ label: hostOf(url), url }] : [],
        ...(num(item.score) !== undefined ? { score: { value: num(item.score)!, kind: 'strength' as const, caption: 'siła ostrzeżenia' } } : {}),
        confirmEffect: 'Przeczytaj źródło ostrzeżenia w podsumowaniu sprawy.',
        rejectEffect: '',
        confirm: [],
        reject: [],
        confirmNote: '',
        rejectNote: '',
        tab: 'podsumowanie',
      };
    });
}

/** Odpowiedzi usług, które nie pasują do żadnego adresu sprawy — do sprawdzenia (literówka w adresie, inna sprawa). */
function replyItems(dossier: Rec): ReviewItem[] {
  return list(dossier.serviceReplies)
    .filter((reply) => reply.withdrawn !== true && isRec(reply.match) && reply.match.matched === false)
    .map((reply): ReviewItem => {
      const service = str(reply.serviceName) ?? 'usługa';
      const reference = str(reply.reference);
      return {
        id: `reply:${str(reply.id) ?? `${service}:${reference}`}`,
        kind: 'reply',
        title: `Do którego adresu odnosi się odpowiedź ${service}${reference ? ` (sygn. ${reference})` : ''}?`,
        why: isRec(reply.match) && str(reply.match.text) ? String(reply.match.text) : 'Odpowiedź nie pasuje do żadnego adresu sprawy, więc nic nie zmienia w wyniku.',
        evidence: [],
        confirmEffect: 'Sprawdź adresy w odpowiedzi — popraw ją albo wycofaj w karcie usługi.',
        rejectEffect: '',
        confirm: [],
        reject: [],
        confirmNote: '',
        rejectNote: '',
        tab: 'uslugi',
      };
    });
}

// ---------- Kolejka ----------

/** Pozycja czeka na decyzję, jeśli żadne z jej wywołań nie ma obowiązującej decyzji. */
function isOpen(item: ReviewItem, decisions: DecisionRecord[]): boolean {
  return [...item.confirm, ...item.reject].every((call) => !currentDecision(decisions, call.target, call.key));
}

/** Pozycja tylko do sprawdzenia: usługa nie zapisuje dla niej decyzji. */
export const isReviewOnly = (item: Pick<ReviewItem, 'confirm' | 'reject'>) => item.confirm.length === 0 && item.reject.length === 0;

function rank(a: ReviewItem, b: ReviewItem): number {
  return (
    REVIEW_KIND_ORDER.indexOf(a.kind) - REVIEW_KIND_ORDER.indexOf(b.kind) ||
    (b.valuePln ?? 0) - (a.valuePln ?? 0) ||
    (b.score?.value ?? 0) - (a.score?.value ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

/** Wszystkie rozstrzygnięcia czekające na analityka — od najważniejszego — oraz obowiązujące decyzje. */
export function collectReview(input: unknown): ReviewQueue {
  if (!isRec(input)) return { pending: [], decided: [] };
  const dossier = input;
  const decisions = decisionsOf(dossier);
  const findings = list(dossier.findings);
  const owner = mainName(dossier);
  const unconfirmed = unconfirmedItems(dossier, owner);
  const skip = new Set(unconfirmed.map((item) => lower(item.id.slice('address:'.length))));
  const all = [
    ...cashOutItems(dossier, findings),
    ...personItems(dossier, decisions),
    ...unconfirmed,
    ...weakAddressItems(dossier, findings, owner, skip),
    ...identityItems(dossier, findings, owner),
    ...operatorItems(dossier, findings),
    ...organizationItems(dossier),
    ...publicFigureItems(dossier),
    ...scamWarningItems(dossier),
    ...replyItems(dossier),
  ];
  const pending = uniqueBy(all, (item) => lower(item.id))
    .filter((item) => item.kind === 'person' || isOpen(item, decisions))
    .sort(rank);
  return { pending, decided: decidedEntries(dossier, decisions) };
}

export const pendingCount = (dossier: unknown): number => collectReview(dossier).pending.length;

/** Liczba pozycji według rodzaju — do filtrów. */
export function countByKind(items: ReviewItem[]): Partial<Record<ReviewKind, number>> {
  const counts: Partial<Record<ReviewKind, number>> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

// ---------- Zdecydowane ----------

const TARGET_TAB: Record<string, DossierTab> = { address: 'adresy', profile: 'profile', link: 'wskazniki', cashout: 'wskazniki', evidence: 'adresy' };

function decidedLabel(dossier: Rec, target: string, key: string): string {
  const address = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  switch (target) {
    case 'address':
      return `Adres ${short(address)} — własność`;
    case 'cashout':
      return `Wypłata z adresu ${short(address)} — dokument`;
    case 'profile':
      return `Konto ${profileLabel(key)}`;
    case 'link': {
      const hypothesis = list(isRec(dossier.indicators) ? dossier.indicators.commonOperator : undefined).find((item) => lower(String(item.id)) === lower(key));
      const names = strings(hypothesis?.personas).length === 2 ? strings(hypothesis?.personas) : key.split('<->').map(profileLabel);
      return `Wspólny operator: „${names[0] ?? '?'}” i „${names[1] ?? '?'}”`;
    }
    case 'evidence':
      return 'Ślad odczytany przez model językowy';
    default:
      return `${target}: ${key}`;
  }
}

function decidedEntries(dossier: Rec, decisions: DecisionRecord[]): DecidedEntry[] {
  return activeDecisions(decisions)
    .map((item) => ({
      decisionId: item.id,
      target: String(item.target),
      key: item.key,
      decision: item.decision,
      ...(item.note ? { note: item.note } : {}),
      decidedAt: item.decidedAt,
      label: decidedLabel(dossier, String(item.target), item.key),
      tab: TARGET_TAB[String(item.target)] ?? 'decyzje',
    }))
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
}

// ---------- Notatka i licznik na liście spraw ----------

/** Notatka wysyłana z decyzją: wpis analityka, a bez niego — ta sama co na kartach teczki. */
export function decisionNote(item: Pick<ReviewItem, 'confirmNote' | 'rejectNote'>, decision: 'confirmed' | 'rejected', typed: string): string | undefined {
  const own = typed.trim();
  return own || (decision === 'confirmed' ? item.confirmNote : item.rejectNote) || undefined;
}

const STORE_KEY = 'olcys:do-potwierdzenia';
const memory = new Map<string, number>();

function storage(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function readStore(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(STORE_KEY) ?? '{}');
    return isRec(parsed) ? (Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'number')) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * Zapamiętuje liczbę pozycji do potwierdzenia dla sprawy, której teczkę już wczytano.
 * Lista spraw pokazuje ją bez pobierania każdej teczki osobno.
 */
export function rememberPending(caseId: string, count: number): void {
  memory.set(caseId, count);
  try {
    storage()?.setItem(STORE_KEY, JSON.stringify({ ...readStore(), [caseId]: count }));
  } catch {
    // Pamięć przeglądarki niedostępna — wystarczy pamięć karty.
  }
}

/** Ostatnio policzona liczba pozycji do potwierdzenia; `undefined`, gdy teczki w tej karcie nie oglądano. */
export function knownPending(caseId: string): number | undefined {
  return memory.get(caseId) ?? readStore()[caseId];
}
