// Dwie rzeczy, których analityk nie może się domyślać:
// 1. adresy niepotwierdzone — znalezione, ale nieprzypisane podmiotowi (profil innego kandydata,
//    słaba podstawa); nie znikają, tylko czekają na decyzję analityka;
// 2. wyjaśnienia — dlaczego nie ma adresów albo dowodu spieniężenia i co można zrobić dalej.

import type { Finding, Identifier, Network, PersonCandidate, ProfileCard } from '@olcys/core';
import { plural, shortAddress } from './format.ts';
import { addressKey, sightingKey } from './intel.ts';
import { PRIORITY_RULES } from './priority.ts';
import { CONTRACTS_LINK_ID, buildServiceLinks, resolveService, serviceFromName } from './services.ts';
import type { ExternalServiceMatcher } from './services.ts';
import type { ProfileNode } from './entity.ts';

type ExplainedFinding = Finding & {
  subjectProbability?: number;
  excludedEvidence?: Finding['evidence'];
  widelyCited?: boolean;
  chainSkipped?: boolean;
  decision?: 'confirmed' | 'rejected';
};

/** Adres znaleziony w analizie, ale nieprzypisany podmiotowi — do potwierdzenia przez analityka. */
export interface UnconfirmedAddress {
  address: string;
  network: Network;
  /** Gdzie adres znaleziono. */
  sources: { url: string; service: string; author?: string; profileId?: string; personId?: string }[];
  /** Dlaczego nie jest przypisany podmiotowi. */
  reasons: string[];
  /** Łączne prawdopodobieństwo (0–100), że adres należy do osoby ze sprawy. */
  personAddressProbability: number;
  /** Skrót aktywności w blockchainie; `null`, gdy łańcucha nie analizowano. */
  chain: {
    transfers: number;
    totalReceived: number;
    totalSent: number;
    asset: string;
    /** Rozpoznane usługi, z którymi adres miał przelewy. */
    services: string[];
    cashOutPlnTotal: number;
    /** Liczba udokumentowanych ścieżek środków do usług. */
    trails: number;
  } | null;
  /** Decyzje analityka („confirmed”), które przypiszą adres podmiotowi i przeliczą teczkę. */
  confirmWith: { target: 'profile' | 'address'; key: string }[];
}

export interface UnconfirmedInput {
  findings: ExplainedFinding[];
  linkedKeys: Set<string>;
  persons: PersonCandidate[];
  nodes: ProfileNode[];
  personOfProfile: Map<string, string>;
  matcher?: ExternalServiceMatcher;
}

export function buildUnconfirmedAddresses(input: UnconfirmedInput): UnconfirmedAddress[] {
  const nodeOfDoc = new Map(input.nodes.flatMap((node) => node.sightings.map((item) => [sightingKey(item), node] as const)));
  const result: UnconfirmedAddress[] = [];
  for (const finding of input.findings) {
    const key = addressKey(finding);
    // Adresy pośredników, powszechnie cytowane i odrzucone przez analityka nie czekają na potwierdzenie.
    if (input.linkedKeys.has(key) || finding.confidence.excluded || finding.widelyCited || finding.decision === 'rejected') continue;
    const foreign = (finding.excludedEvidence ?? []).filter((item) => nodeOfDoc.get(sightingKey(item))?.card.decision !== 'rejected');
    const weak = finding.evidence.length > 0 && finding.confidence.score < PRIORITY_RULES.linkedMinScore;
    if (foreign.length === 0 && !weak) continue;

    const reasons: string[] = [];
    const confirmWith: UnconfirmedAddress['confirmWith'] = [];
    let probability = finding.subjectProbability ?? 0;
    const sources: UnconfirmedAddress['sources'] = [];
    for (const item of [...finding.evidence, ...foreign]) {
      const node = nodeOfDoc.get(sightingKey(item));
      const personId = node ? input.personOfProfile.get(node.card.id) : undefined;
      sources.push({ url: item.url, service: item.service, ...(item.author ? { author: item.author } : {}), ...(node ? { profileId: node.card.id } : {}), ...(personId ? { personId } : {}) });
    }
    for (const item of foreign) {
      const node = nodeOfDoc.get(sightingKey(item));
      if (!node) continue;
      const person = input.persons.find((candidate) => candidate.profileIds.includes(node.card.id));
      const share = person?.addresses.find((entry) => entry.key === key)?.probability ?? 0;
      const viaPerson = Math.round(((person?.probability ?? 0) * share) / 100);
      probability = Math.max(probability, viaPerson);
      reasons.push(
        `Adres pochodzi z profilu ${node.card.service}${node.card.handle ? ` („${node.card.handle}”)` : ''}, którego nie potwierdzono jako należącego do podmiotu ` +
          `(prawdopodobieństwo ${person?.probability ?? 0}%): ${node.base.reasons.join(' ') || 'brak wiązania z pozostałymi profilami.'}`,
      );
      if (!confirmWith.some((entry) => entry.key === node.card.id)) confirmWith.push({ target: 'profile', key: node.card.id });
    }
    if (weak) {
      reasons.push(`Wskaźnik Pewności adresu to ${finding.confidence.score}% — poniżej progu ${PRIORITY_RULES.linkedMinScore}% dla adresów powiązanych (${finding.confidence.tier}).`);
    }
    confirmWith.push({ target: 'address', key });

    const chain = finding.chain;
    result.push({
      address: finding.address,
      network: finding.network,
      sources,
      reasons,
      personAddressProbability: probability,
      chain: chain
        ? {
            transfers: chain.transfers.length,
            totalReceived: chain.profile.totalReceived,
            totalSent: chain.profile.totalSent,
            asset: chain.profile.nativeAsset,
            services: buildServiceLinks({ subjectFindings: [finding], publishedServiceFindings: [], mentionSources: [], accountNames: [], matcher: input.matcher })
              .filter((link) => link.id !== CONTRACTS_LINK_ID)
              .map((link) => link.name),
            cashOutPlnTotal: Math.round(Object.values(chain.cashOutPlnByYear).reduce((sum, value) => sum + value, 0) * 100) / 100,
            trails: chain.trails?.length ?? 0,
          }
        : null,
      confirmWith,
    });
  }
  return result.sort((a, b) => b.personAddressProbability - a.personAddressProbability || (b.chain?.transfers ?? 0) - (a.chain?.transfers ?? 0));
}

export type ExplanationKind = 'seized' | 'service_name' | 'no_addresses' | 'only_unconfirmed' | 'widely_cited' | 'chain_skipped' | 'source_errors' | 'partial' | 'no_cash_out';

/** Wyjaśnienie braku wyniku wraz z tym, co analityk może zrobić. */
export interface Explanation {
  kind: ExplanationKind;
  text: string;
  suggestions: string[];
  /** Tylko `service_name`: publicznie oznaczone adresy tej usługi ze zbioru etykiet (pusta lista, gdy zbiór ich nie ma). */
  addresses?: { address: string; network: string; label: string }[];
}

/** Publiczna etykieta adresu ze zbioru etykiet modułu danych blockchain. */
export interface ServiceLabel {
  address: string;
  network: string;
  label: string;
  /** Klasa adresu ze zbioru etykiet (giełda, kontrakt…), jeśli zbiór ją podaje. */
  addressClass?: string;
}

export interface ExplainInput {
  identifiers: Identifier[];
  findings: ExplainedFinding[];
  linked: Finding[];
  unconfirmed: UnconfirmedAddress[];
  /** Liczba ustaleń dowodu spieniężenia dla adresów potwierdzonych. */
  confirmedProofs: number;
  cashOutPlnTotal: number;
  profiles: ProfileCard[];
  connectorCount: number;
  deep: boolean;
  partial: boolean;
  serviceLabels?: ServiceLabel[];
  matcher?: ExternalServiceMatcher;
  /** Liczba przelewów na adresy organów państwa (zajęcia środków). */
  seizures?: number;
  /** Źródła i dostawcy danych, którzy nie odpowiedzieli podczas analizy. */
  sourceErrors?: { connectorId?: string; providerId?: string; stage: string; count: number; addresses?: string[] }[];
}

const MAX_SERVICE_ADDRESSES = 20;
const MORE_IDENTIFIERS = 'Podaj dodatkowy identyfikator podmiotu: e-mail, adres profilu, znany adres portfela albo nazwę ENS.';
const sources = (count: number) => `${count} ${plural(count, 'źródło', 'źródła', 'źródeł')}`;
const profilesText = (count: number) => `${count} ${plural(count, 'profil', 'profile', 'profili')}`;

/** Wyjaśnienia w kolejności ważności — pierwsze nadaje się na pierwsze zdanie kluczowych ustaleń. */
export function buildExplanations(input: ExplainInput): Explanation[] {
  const result: Explanation[] = [];
  const deepHint = input.deep ? [] : ['Uruchom analizę w trybie głębokim — przeszukuje dodatkowo kilkaset forów.'];

  // Zapytanie wygląda na nazwę giełdy lub serwisu, a nie osoby.
  for (const identifier of input.identifiers) {
    if (!['nick', 'login', 'full_name'].includes(identifier.type)) continue;
    const service = serviceFromName(identifier.value, input.matcher);
    if (!service) continue;
    const addresses = (input.serviceLabels ?? [])
      .filter((item) => resolveService(item.label, 'other', input.matcher).name === service.name)
      .slice(0, MAX_SERVICE_ADDRESSES);
    result.push({
      kind: 'service_name',
      text:
        `„${identifier.value}” to nazwa giełdy lub serwisu (${service.name}), a nie osoby. Adresy giełd nie są publikowane na profilach — narzędzie rozpoznaje je po publicznych etykietach` +
        `${addresses.length > 0 ? `; zbiór etykiet zawiera ${addresses.length} ${plural(addresses.length, 'oznaczony adres', 'oznaczone adresy', 'oznaczonych adresów')} tej usługi` : '; zbiór etykiet nie zawiera adresów tej usługi'}.`,
      suggestions: [
        'Jeśli badasz osobę — podaj jej identyfikator (nick, e-mail, adres profilu), a nie nazwę serwisu.',
        'Jeśli badasz przepływy do tej usługi — podaj adres portfela osoby; przelewy do usługi pojawią się w dowodzie spieniężenia.',
      ],
      addresses,
    });
    break;
  }

  const widely = input.findings.filter((finding) => finding.widelyCited);
  if (input.findings.length === 0) {
    result.push({
      kind: 'no_addresses',
      text:
        `Przeszukano ${sources(input.connectorCount)} i znaleziono ${profilesText(input.profiles.length)}, ale w ich treści nie ma żadnego adresu kryptowalutowego — ` +
        'dlatego nie ma czego analizować w blockchainie.',
      suggestions: [MORE_IDENTIFIERS, ...deepHint],
    });
  } else if (input.linked.length === 0 && input.unconfirmed.length > 0) {
    const [first] = input.unconfirmed;
    result.push({
      kind: 'only_unconfirmed',
      text:
        `Znaleziono ${input.unconfirmed.length} ${plural(input.unconfirmed.length, 'adres', 'adresy', 'adresów')}, ale żadnego nie potwierdzono jako należącego do podmiotu ` +
        `(najbliższy: ${shortAddress(first!.address)}, prawdopodobieństwo ${first!.personAddressProbability}%). Analiza blockchain tych adresów jest w sekcji „Adresy do potwierdzenia”.`,
      suggestions: ['Potwierdź profil lub adres decyzją analityka — teczka przeliczy się z tym adresem jako adresem podmiotu.', MORE_IDENTIFIERS, ...deepHint],
    });
  } else if (input.linked.length === 0 && widely.length === 0) {
    result.push({
      kind: 'no_addresses',
      text:
        `Przeszukano ${sources(input.connectorCount)}; ${input.findings.length} ${plural(input.findings.length, 'znaleziony adres należy', 'znalezione adresy należą', 'znalezionych adresów należy')} ` +
        'do pośredników (giełdy, kontrakty) albo został odrzucony — żaden nie jest adresem podmiotu.',
      suggestions: [MORE_IDENTIFIERS, ...deepHint],
    });
  }
  if (widely.length > 0) {
    result.push({
      kind: 'widely_cited',
      text: `Adres ${shortAddress(widely[0]!.address)} wymienia ${widely[0]!.unrelatedPublishers} niepowiązanych autorów — na podstawie publikacji nie da się wskazać właściciela.`,
      suggestions: ['Właściciela może wskazać tylko mocna podstawa: adres na własnym profilu, dowód kryptograficzny albo dane usługi, do której trafiły środki.'],
    });
  }
  const skipped = input.linked.filter((finding) => (finding as ExplainedFinding).chainSkipped || !finding.chain);
  if (skipped.length > 0) {
    result.push({
      kind: 'chain_skipped',
      text: `Dla ${skipped.length} ${plural(skipped.length, 'adresu powiązanego', 'adresów powiązanych', 'adresów powiązanych')} nie ma danych z blockchaina (limit adresów, limit czasu albo brak odpowiedzi dostawcy danych).`,
      suggestions: ['Uruchom analizę ponownie albo załóż osobną sprawę dla samego adresu — dostanie pełną historię.'],
    });
  }
  const failed = input.sourceErrors ?? [];
  if (failed.length > 0) {
    const names = [...new Set(failed.map((item) => item.connectorId ?? item.providerId ?? item.stage))];
    const withoutChain = new Set(failed.flatMap((item) => item.addresses ?? [])).size;
    result.push({
      kind: 'source_errors',
      text:
        `Część źródeł nie odpowiedziała (${names.join(', ')}): wynik jest częściowy; brakujących danych nie uzupełniano.` +
        (withoutChain > 0
          ? ` Dla ${withoutChain} ${plural(withoutChain, 'adresu', 'adresów', 'adresów')} nie ma danych z blockchaina — to brak danych, a nie brak aktywności.`
          : ''),
      suggestions: ['Uruchom analizę ponownie, gdy źródło będzie dostępne; lista błędów jest w polu „sourceErrors” i w dzienniku analizy.'],
    });
  }
  if (input.partial) {
    result.push({
      kind: 'partial',
      text: 'Analiza została przerwana limitem czasu — wynik jest częściowy: części źródeł albo adresów nie sprawdzono.',
      suggestions: ['Uruchom analizę ponownie; szczegóły pominiętych kroków są w dzienniku analizy.'],
    });
  }
  const analysed = input.linked.filter((finding) => finding.chain);
  if ((input.seizures ?? 0) > 0 && input.confirmedProofs === 0 && input.cashOutPlnTotal === 0) {
    result.push({
      kind: 'seized',
      text:
        'Nie ma dowodu spieniężenia, bo środki nie trafiły do giełdy ani innej usługi wymiany — zostały przekazane na adres organu państwa (zajęcie). ' +
        'Szczegóły są w sekcji o zajęciu i pochodzeniu środków.',
      suggestions: ['Sprawdź źródło etykiety adresu organu państwa i dokumenty postępowania, którego dotyczy zajęcie.', 'Pochodzenie środków (skąd przyszły na adres) jest w tej samej sekcji.'],
    });
  } else if (analysed.length > 0 && input.confirmedProofs === 0 && input.cashOutPlnTotal === 0) {
    const transfers = analysed.reduce((sum, finding) => sum + (finding.chain?.transfers.length ?? 0), 0);
    result.push({
      kind: 'no_cash_out',
      text:
        `${analysed.length} ${plural(analysed.length, 'adres powiązany ma', 'adresy powiązane mają', 'adresów powiązanych ma')} łącznie ${transfers} ${plural(transfers, 'pobrany przelew', 'pobrane przelewy', 'pobranych przelewów')}, ` +
        'ale żaden wypływ nie trafił do adresu oznaczonego jako giełda, serwis wymiany, bramka płatnicza lub karta — dlatego nie ma dowodu spieniężenia.',
      suggestions: [
        'Środki mogły przejść przez adresy pośrednie bez publicznej etykiety — tryb głęboki śledzi dłuższe ścieżki.',
        'Sprawdź kontrahentów bez etykiety w sekcji przepływów; etykiety analityka można dopisać w zbiorze etykiet.',
      ],
    });
  }
  return result;
}
