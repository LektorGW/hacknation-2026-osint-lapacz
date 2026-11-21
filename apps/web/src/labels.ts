// Polskie nazwy wartości słownikowych z kontraktów `@olcys/core`.
import type {
  AddressClass,
  CashOutKind,
  CashOutStage,
  ClaimStatus,
  Decision,
  GraphEdge,
  GraphNodeKind,
  IdentifierType,
  IdentityMatch,
  Network,
  RelationKind,
  ServiceKind,
  ServiceLinkBasis,
  SourceCategory,
  TimelineEvent,
} from '@olcys/core';

export const IDENTIFIER_LABEL: Record<IdentifierType, string> = {
  full_name: 'Imię i nazwisko',
  nick: 'Nick',
  login: 'Login',
  email: 'E-mail',
  messenger_id: 'Identyfikator komunikatora',
  profile_url: 'Adres profilu lub strony (URL)',
  ens_name: 'Nazwa ENS',
  crypto_address: 'Adres krypto',
};

export const IDENTIFIER_TYPES = Object.keys(IDENTIFIER_LABEL) as IdentifierType[];

export const NETWORK_LABEL: Record<Network, string> = {
  bitcoin: 'Bitcoin',
  'bitcoin-testnet': 'Bitcoin (testnet)',
  ethereum: 'Ethereum',
  tron: 'Tron',
  lab: 'Sieć laboratoryjna (testowa)',
};

export const NETWORK_SHORT: Record<Network, string> = {
  bitcoin: 'BTC',
  'bitcoin-testnet': 'tBTC',
  ethereum: 'ETH',
  tron: 'TRON',
  lab: 'LAB',
};

export const CLASS_LABEL: Record<AddressClass, string> = {
  private: 'adres prywatny',
  unknown: 'adres bez etykiety',
  exchange: 'giełda lub portfel powierniczy',
  smart_contract: 'smart kontrakt',
  charity: 'adres zbiórki',
  mixer: 'mikser',
  institutional: 'adres instytucjonalny',
};

export const CATEGORY_LABEL: Record<SourceCategory, string> = {
  cryptographic_proof: 'Dowód kryptograficzny',
  own_profile: 'Własny profil podmiotu',
  sale_offer: 'Ogłoszenie sprzedaży / oferta P2P',
  settlement_message: 'Wiadomość w kontekście rozliczenia',
  forum_post: 'Wypowiedź na forum',
  mass_comment: 'Masowy komentarz',
};

/** Rodzaj źródła jednym, dwoma słowami — nagłówek śladu na karcie adresu. */
export const CATEGORY_SHORT: Record<SourceCategory, string> = {
  cryptographic_proof: 'dowód kryptograficzny',
  own_profile: 'własny profil',
  sale_offer: 'ogłoszenie',
  settlement_message: 'wiadomość o rozliczeniu',
  forum_post: 'wpis na forum',
  mass_comment: 'masowy komentarz',
};

export const IDENTITY_LABEL: Record<IdentityMatch, string> = {
  verified_link: 'Tożsamość profilu potwierdzona',
  exact_identifier: 'Unikalny lub potwierdzony identyfikator',
  same_handle: 'Zgodny tylko nick',
  common_handle: 'Zgodny tylko pospolity nick',
  linked_profile: 'Profil odnaleziony pośrednio',
  name_only: 'Zgodne tylko imię i nazwisko',
};

/** Opis poziomów oceny tożsamości profilu — ekran zasad punktacji. */
export const IDENTITY_DESCRIPTION: Record<IdentityMatch, string> = {
  verified_link:
    'Wzajemne odnośniki między profilami albo dowód kryptograficzny; także profil potwierdzony decyzją analityka.',
  exact_identifier:
    'Profil odnaleziony po unikalnym identyfikatorze (e-mail, adres profilu) albo po nicku potwierdzonym drugim identyfikatorem w treści profilu.',
  linked_profile: 'Profil wskazany przez inny, potwierdzony profil podmiotu (odnośnik jednostronny).',
  same_handle: 'Ten sam nick w serwisie, bez żadnego innego potwierdzenia, że to ta sama osoba.',
  common_handle: 'Zgodny nick jest pospolity — różne osoby często używają takiego samego.',
  name_only: 'Zgodne tylko imię i nazwisko — możliwa zbieżność nazwisk (imiennik).',
};

export const CASH_OUT_LABEL: Record<CashOutKind, string> = {
  exchange_deposit: 'Wpłata na giełdę',
  p2p_service: 'Serwis wymiany P2P',
  payment_gateway: 'Bramka płatnicza',
  crypto_card: 'Karta kryptowalutowa',
  stablecoin_swap: 'Zamiana na stablecoin',
};

export const CASH_OUT_KINDS = Object.keys(CASH_OUT_LABEL) as CashOutKind[];

export const STATUS_LABEL: Record<string, string> = {
  running: 'w toku',
  completed: 'zakończona',
  failed: 'nieudana',
};

export const NODE_KIND_LABEL: Record<GraphNodeKind, string> = {
  subject: 'Podmiot',
  operator: 'Hipoteza wspólnego operatora',
  persona: 'Persona (deklarowana tożsamość)',
  identifier: 'Identyfikator',
  profile: 'Konto w serwisie',
  address: 'Adres krypto',
  service: 'Serwis / kontrahent',
  source: 'Źródło dowodowe',
  person: 'Osoba powiązana',
  organization: 'Organizacja (beneficjent zbiórki / podmiot z rejestru)',
};

export const NODE_KIND_PLURAL: Record<GraphNodeKind, string> = {
  subject: 'Podmiot',
  operator: 'Hipotezy operatora',
  persona: 'Persony',
  identifier: 'Identyfikatory',
  profile: 'Konta',
  address: 'Adresy',
  service: 'Serwisy i kontrahenci',
  source: 'Źródła',
  person: 'Osoby powiązane',
  organization: 'Organizacje',
};

export const EDGE_KIND_LABEL: Record<GraphEdge['kind'], string> = {
  has_identifier: 'identyfikator podmiotu',
  found_profile: 'profil odnaleziony po identyfikatorze',
  links_to: 'odnośnik między profilami',
  publishes: 'publikacja adresu',
  transfer: 'przelew',
  cash_out: 'możliwa wypłata',
  related: 'powiązanie z inną osobą',
  operates: 'hipoteza: operator obsługuje konto',
  declares: 'konto deklaruje personę',
  documented_by: 'udokumentowane w źródle',
  same_operator: 'hipoteza wspólnego operatora kont',
  beneficiary_of: 'adres zbiórki organizacji (hipoteza)',
  holds_role: 'pełni funkcję w organizacji (rejestr) — nie właściciel adresu',
  org_relation: 'relacja między organizacjami (rejestr)',
};

/** Status twierdzenia: skąd wiemy to, co pokazujemy. Kolejność = kolejność w legendzie i filtrach. */
export const CLAIM_STATUSES: ClaimStatus[] = ['source_fact', 'computed', 'hypothesis', 'confirmed', 'rejected'];

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  source_fact: 'fakt źródłowy',
  computed: 'wynik obliczeń',
  hypothesis: 'hipoteza',
  confirmed: 'potwierdzone przez analityka',
  rejected: 'odrzucone',
};

/** Znaczenie statusu prostym językiem — panel boczny grafu i legenda. */
export const CLAIM_STATUS_MEANING: Record<ClaimStatus, string> = {
  source_fact: 'Informacja wprost ze źródła: publikacja, rekord albo transakcja w blockchainie. Można ją sprawdzić pod podanym adresem.',
  computed: 'Wynik obliczeń narzędzia na faktach (sumy, wyceny, ścieżka środków wprost z transakcji). Każdy krok da się odtworzyć.',
  hypothesis: 'Przypuszczenie narzędzia oparte na przesłankach. Nie jest ustaleniem — wymaga weryfikacji i decyzji analityka.',
  confirmed: 'Hipoteza przyjęta decyzją analityka. Odpowiedzialność za potwierdzenie spoczywa na analityku; decyzję można wycofać.',
  rejected: 'Powiązanie odrzucone decyzją analityka albo wykluczone sprzecznością. Pozostaje widoczne wyłącznie dla przejrzystości.',
};

/** Stała uwaga przy każdej liczbie wskaźnika. */
export const ORDINAL_NOTE = 'Wskaźnik porządkowy 0–100 z jawnych reguł eksperckich — nie jest skalibrowanym prawdopodobieństwem.';

export const INDEPENDENCE_LABEL: Record<string, string> = {
  independent: 'niezależny',
  dependent: 'zależny — nie doliczono',
  single: 'jedyny składnik',
  not_applicable: 'nie dotyczy',
};

export const HYPOTHESIS_STATUS_LABEL: Record<string, string> = {
  hypothesis: 'hipoteza',
  auto_grouped: 'hipoteza — konta zgrupowane automatycznie',
  blocked: 'hipoteza zablokowana kontrdowodem',
  confirmed: 'potwierdzone przez analityka',
  rejected: 'odrzucone',
  source_fact: 'fakt źródłowy',
  computed: 'wynik obliczeń',
};

export const TIMELINE_KIND_LABEL: Record<TimelineEvent['kind'], string> = {
  publication: 'Publikacja',
  transfer_in: 'Wpływ',
  transfer_out: 'Wypływ',
  cash_out: 'Możliwa wypłata',
  address_replaced: 'Podmiana adresu',
  account_created: 'Założenie konta',
};

export const TIMELINE_KINDS = Object.keys(TIMELINE_KIND_LABEL) as TimelineEvent['kind'][];

export const RELATION_LABEL: Record<RelationKind, string> = {
  shared_address: 'Wspólny adres',
  transacted: 'Bezpośredni przelew',
  common_counterparty: 'Wspólny kontrahent',
  shared_attribute: 'Wspólna cecha profili',
};

export const DECISION_LABEL: Record<Decision, string> = {
  confirmed: 'potwierdzono',
  rejected: 'odrzucono',
};

export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = {
  exchange: 'Giełda',
  p2p: 'Serwis P2P',
  payment_gateway: 'Bramka płatnicza',
  crypto_card: 'Karta kryptowalutowa',
  wallet: 'Portfel',
  defi: 'Protokół DeFi',
  mixer: 'Mikser',
  other: 'Inna usługa',
};

export const BASIS_LABEL: Record<ServiceLinkBasis, string> = {
  transfer_out: 'przelew wychodzący',
  transfer_in: 'przelew przychodzący',
  deposit_address: 'adres wpłat — wnioskowanie',
  web_mention: 'wzmianka',
  account_link: 'konto lub odnośnik polecający',
};

const lookup = (table: Record<string, string>, key: string | undefined) => (key ? table[key] : undefined);

/** Czytelna nazwa reguły z księgi; nieznany identyfikator pokazujemy bez zmian. */
export function ruleLabel(rule: string): string {
  const [group, key] = rule.split('.');
  if (group === 'base') return `Baza: ${lookup(CATEGORY_LABEL, key) ?? rule}`;
  if (group === 'identity') return `Korekta tożsamości: ${lookup(IDENTITY_LABEL, key) ?? rule}`;
  if (rule === 'synergy.second_source') return 'Premia: drugie niezależne źródło';
  if (rule === 'synergy.extra_sources') return 'Premia: kolejne niezależne źródła';
  if (rule === 'penalty.shared_address') return 'Kara: adres współdzielony';
  if (rule === 'exclusion.address_class') return 'Wykluczenie: klasa adresu';
  if (rule === 'ai.ownership') return 'Model językowy: odczyt, czyj jest adres';
  if (group === 'ai') return `Model językowy: ${key}`;
  if (rule === 'penalty.widely_cited') return 'Adres powszechnie cytowany';
  if (rule === 'exclusion.analyst_decision' || rule === 'decision.address_rejected') return 'Wykluczenie: decyzja analityka';
  return rule;
}

/** Drabina dowodowa wyjścia do walut tradycyjnych — każdy następny szczebel wymaga więcej niż poprzedni. */
export const CASH_OUT_STAGES: CashOutStage[] = ['onchain_transfer', 'service_interaction', 'cashout_signal', 'documented_fiat_exit'];

export const CASH_OUT_STAGE_TEXT: Record<CashOutStage, { label: string; meaning: string }> = {
  onchain_transfer: { label: 'Transakcja w blockchainie', meaning: 'Przelew na adres bez etykiety usługi — sam w sobie nie świadczy o wymianie.' },
  service_interaction: { label: 'Interakcja z usługą wymiany', meaning: 'Przelew na adres publicznie oznaczony jako giełda, serwis P2P, bramka albo karta.' },
  cashout_signal: { label: 'Potencjalny sygnał wypłaty', meaning: 'Wzorzec typowy dla wypłaty: adres wpłat giełdy, zamiana na stablecoin i wpłata, powtarzalne wpłaty.' },
  documented_fiat_exit: { label: 'Udokumentowane wyjście do walut tradycyjnych', meaning: 'Potwierdzenie spoza blockchaina: odpowiedź usługi albo decyzja analityka z podstawą.' },
};

/** Stałe ograniczenie wskaźnika C. */
export const CASH_OUT_LIMITATION =
  'Wypłatę na rachunek bankowy może potwierdzić wyłącznie usługa (giełda, operator płatności). Dane blockchain pokazują najwyżej, że środki do niej dotarły.';
