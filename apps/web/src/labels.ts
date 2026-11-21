// Polskie nazwy wartości słownikowych z kontraktów `@olcys/core`.
import type {
  AddressClass,
  CashOutKind,
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
  identifier: 'Identyfikator',
  profile: 'Profil w serwisie',
  address: 'Adres krypto',
  service: 'Serwis / kontrahent',
  person: 'Osoba powiązana',
};

export const NODE_KIND_PLURAL: Record<GraphNodeKind, string> = {
  subject: 'Podmiot',
  identifier: 'Identyfikatory',
  profile: 'Profile',
  address: 'Adresy',
  service: 'Serwisy i kontrahenci',
  person: 'Osoby powiązane',
};

export const EDGE_KIND_LABEL: Record<GraphEdge['kind'], string> = {
  has_identifier: 'identyfikator podmiotu',
  found_profile: 'profil odnaleziony po identyfikatorze',
  links_to: 'odnośnik między profilami',
  publishes: 'publikacja adresu',
  transfer: 'przelew',
  cash_out: 'możliwa wypłata',
  related: 'powiązanie z inną osobą',
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
