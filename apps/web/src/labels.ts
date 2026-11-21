// Polskie nazwy wartości słownikowych z kontraktów `@olcys/core`.
import type {
  AddressClass,
  CashOutKind,
  IdentifierType,
  IdentityMatch,
  Network,
  SourceCategory,
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

export const CASH_OUT_LABEL: Record<CashOutKind, string> = {
  exchange_deposit: 'Wpłata na giełdę',
  p2p_service: 'Serwis wymiany P2P',
  payment_gateway: 'Bramka płatnicza',
  crypto_card: 'Karta kryptowalutowa',
  stablecoin_swap: 'Zamiana na stablecoin',
};

export const STATUS_LABEL: Record<string, string> = {
  running: 'w toku',
  completed: 'zakończona',
  failed: 'nieudana',
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
  return rule;
}
