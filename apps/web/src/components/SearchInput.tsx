// Wejście wyszukiwania w teczce: to, co wpisał analityk, z ikoną rodzaju identyfikatora.
import type { IdentifierType } from '@olcys/core';
import { shorten } from '../format.ts';
import { IDENTIFIER_LABEL, NETWORK_SHORT } from '../labels.ts';
import type { FullDossier } from '../proof.ts';
import { searchInput } from '../ux.ts';
import { Term } from './ui/Term.tsx';

/** Kształty ikon rodzajów identyfikatora (obrys 24×24). */
const ICON: Record<string, string> = {
  crypto_address: 'M12 2.5 20.5 7.3v9.4L12 21.5l-8.5-4.8V7.3z',
  ens_name: 'M12 2.5 20.5 7.3v9.4L12 21.5l-8.5-4.8V7.3z',
  email: 'M3.5 6h17v12h-17zM3.5 6.5 12 13l8.5-6.5',
  profile_url: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  full_name: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  nick: 'M5 9h15M4 15h15M10 3.5 8 20.5M16 3.5l-2 17',
  login: 'M5 9h15M4 15h15M10 3.5 8 20.5M16 3.5l-2 17',
  messenger_id: 'M4 5h16v11H9l-5 4z',
};

export function IdentifierIcon({ type }: { type: IdentifierType | string }) {
  return (
    <svg className="id-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICON[type] ?? ICON.nick} />
    </svg>
  );
}

/** Opis rodzaju wejścia, np. „adres BTC” (sieć z wyników analizy) albo „e-mail”. */
function typeText(dossier: FullDossier, type: string, value: string): string {
  if (type === 'crypto_address') {
    const network = dossier.findings.find((finding) => finding.address.toLowerCase() === value.trim().toLowerCase())?.network;
    return network ? `adres ${NETWORK_SHORT[network] ?? network}` : 'adres krypto';
  }
  return (IDENTIFIER_LABEL[type as IdentifierType] ?? type).toLowerCase();
}

/** Znaczek „Szukano: …” na górze teczki — wejście wyszukiwania nie myli się z tym, co program odkrył. */
export function SearchInputChip({ dossier }: { dossier: FullDossier }) {
  const { items } = searchInput(dossier.subject.identifiers);
  if (items.length === 0) return null;
  return (
    <p className="search-input">
      <span className="search-input-label">
        <Term id="wejscie">Szukano</Term>:
      </span>
      {items.map((item) => (
        <span key={`${item.type}:${item.value}`} className="search-input-chip" title={`${IDENTIFIER_LABEL[item.type as IdentifierType] ?? item.type}: ${item.value}`}>
          <IdentifierIcon type={item.type} />
          <span className="search-input-type">{typeText(dossier, item.type, item.value)}</span>
          <strong className={item.type === 'crypto_address' ? 'mono-value' : undefined}>{item.type === 'crypto_address' ? shorten(item.value, 6, 4) : item.value}</strong>
        </span>
      ))}
    </p>
  );
}
