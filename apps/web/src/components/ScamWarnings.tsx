// Ostrzeżenia o możliwym oszustwie: baner pod kafelkami podsumowania, odznaka przy adresie i blok w sekcji Adresy.
// Ton ostrożny: „adres MÓGŁ być wykorzystywany do oszustwa”; autorzy ostrzeżeń to poszkodowani lub świadkowie.
import type { Dossier, Network } from '@olcys/core';
import { fmtDateTime, shorten } from '../format.ts';
import { NETWORK_SHORT } from '../labels.ts';
import { ExternalLink } from './common.tsx';
import { useDossier } from './DossierContext.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Term } from './ui/Term.tsx';

export type ScamLevel = 'none' | 'reports' | 'strong';

interface ScamPublication {
  url: string;
  title?: string;
  service: string;
  author?: string;
  publishedAt?: string;
  quote: string;
  kind: 'warning' | 'giveaway';
  basis: 'rule' | 'model' | 'rule+model';
  impersonates?: string;
  origin: number;
}

interface ScamComponent {
  rule: string;
  weight: number;
  status: string;
  source: string;
  explanation: string;
}

interface ScamAddressWarning {
  address: string;
  network: string;
  level: ScamLevel;
  score: number;
  statement: string;
  independentSources: number;
  components: ScamComponent[];
  publications: ScamPublication[];
  listHits: { listLabel: string; comment: string; date?: string; retrievedAt: string; url: string; caveat: string }[];
  domainHits: { domain: string; listLabel: string; url: string }[];
  chainPattern?: { explanation: string };
  interpretation: string[];
  action: string;
  limitations: string[];
}

interface ScamWarnings {
  level: ScamLevel;
  statement: string;
  addresses: ScamAddressWarning[];
  poisoning: { address: string; lookalike: string; genuine: string; explanation: string }[];
  limitations: string[];
}

export const SCAM_ANCHOR = 'oszustwo';

/** Ostrzeżenia z teczki; brak pola (starsza usługa analizy) → `undefined`. */
export function scamWarningsOf(dossier: Dossier): ScamWarnings | undefined {
  return (dossier as Dossier & { scamWarnings?: ScamWarnings }).scamWarnings;
}

const tone = (level: ScamLevel) => (level === 'strong' ? 'confirmed' : 'possible');
const BASIS: Record<ScamPublication['basis'], string> = { rule: 'reguła tekstowa', model: 'odczyt modelu językowego', 'rule+model': 'reguła tekstowa i model' };

/** Baner pod kafelkami podsumowania — tylko gdy są zgłoszenia (czerwony: silne ostrzeżenie, bursztynowy: są zgłoszenia). */
export function ScamBanner() {
  const { dossier, tabHref } = useDossier();
  const warnings = scamWarningsOf(dossier);
  if (!warnings || warnings.level === 'none') return null;
  return (
    <div className={`mixer-banner is-${tone(warnings.level)}`} role="note" aria-label="Ostrzeżenie o możliwym oszustwie">
      <span className="mixer-banner-icon" aria-hidden="true">
        ⚠
      </span>
      <p className="mixer-banner-text">
        <strong>{warnings.statement}</strong>
        <span className="mixer-banner-note">
          {' '}
          Autorzy ostrzeżeń to poszkodowani lub świadkowie — nie właściciele adresu. <Term id="scam">Co to scam?</Term>
        </span>
      </p>
      <a className="mixer-banner-link" href={tabHref('adresy')}>
        Źródła <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}

/** Odznaka przy adresie (karta adresu). */
export function ScamChip({ address }: { address: string }) {
  const { dossier } = useDossier();
  const item = scamWarningsOf(dossier)?.addresses.find((entry) => entry.address === address && entry.level !== 'none');
  if (!item) return null;
  return (
    <span className="chip chip-warn-soft" title={item.statement}>
      ⚠ <Term id="scam">{item.level === 'strong' ? 'zgłoszenia oszustwa' : 'możliwe oszustwo'}</Term> ({item.independentSources} {item.independentSources === 1 ? 'źródło' : 'źródła'})
    </span>
  );
}

function AddressWarning({ item }: { item: ScamAddressWarning }) {
  return (
    <article className={`card mixer-block is-${tone(item.level)}`} aria-label={`Ostrzeżenie dla adresu ${item.address}`}>
      <header className="section-head">
        <div>
          <h4 className="mono" title={item.address}>
            {NETWORK_SHORT[item.network as Network] ?? item.network} {shorten(item.address, 10, 8)}
          </h4>
          <p className="prose">
            <strong>{item.statement}</strong>
          </p>
        </div>
        <span className={`status ${item.listHits.length > 0 ? 'status-fact' : 'status-inference'}`}>{item.level === 'strong' ? 'silne ostrzeżenie' : item.level === 'reports' ? 'są zgłoszenia' : 'poniżej progu'}</span>
      </header>
      {item.publications.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Publikacja</th>
                <th scope="col">Rodzaj</th>
                <th scope="col">Fragment przy adresie</th>
              </tr>
            </thead>
            <tbody>
              {item.publications.map((pub) => (
                <tr key={`${pub.url}-${pub.kind}`}>
                  <td>
                    <ExternalLink url={pub.url}>{pub.title ?? pub.service}</ExternalLink>
                    <span className="cell-note">
                      {pub.service}
                      {pub.author ? ` — „${pub.author}”` : ''}
                      {pub.publishedAt ? `, ${fmtDateTime(pub.publishedAt)}` : ''}
                    </span>
                  </td>
                  <td>
                    {pub.kind === 'warning' ? 'ostrzeżenie (poszkodowany lub świadek)' : <Term id="falszywe-rozdanie">obietnica „rozdania”</Term>}
                    <span className="cell-note">
                      {BASIS[pub.basis]}
                      {pub.impersonates ? `; nazwa „${pub.impersonates}” — możliwa ofiara podszywania się` : ''}
                    </span>
                  </td>
                  <td className="small">„{pub.quote}”</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {item.listHits.length > 0 && (
        <ul className="plain-list">
          {item.listHits.map((hit) => (
            <li key={hit.url + hit.comment}>
              <span className="status status-fact">zbiór ostrzeżeń</span> <ExternalLink url={hit.url}>{hit.listLabel}</ExternalLink>: „{hit.comment || 'bez opisu'}”{hit.date ? ` (wpis z ${hit.date})` : ''}, migawka z {hit.retrievedAt.slice(0, 10)} — fakt o liście.
            </li>
          ))}
        </ul>
      )}
      {item.domainHits.length > 0 && (
        <p className="small">
          <span className="status status-fact">lista phishingowa</span> W publikacji z adresem jest odnośnik do domeny z listy: {item.domainHits.map((hit) => hit.domain).join(', ')} ({item.domainHits[0]!.listLabel}).
        </p>
      )}
      {item.chainPattern && (
        <p className="small">
          <span className="status status-inference">hipoteza</span> {item.chainPattern.explanation}
        </p>
      )}
      <ul className="plain-list small">
        {item.interpretation.map((text) => (
          <li key={text}>{text}</li>
        ))}
        <li className="muted">{item.action}</li>
      </ul>
      <Disclosure title="Składniki i ograniczenia" meta={`wynik ${item.score}/100`}>
        <ul className="plain-list small">
          {item.components.map((component) => (
            <li key={component.rule}>
              <code>{component.rule}</code> (waga {component.weight}, {component.source}): {component.explanation}
            </li>
          ))}
          {item.limitations.map((text) => (
            <li key={text} className="muted">
              {text}
            </li>
          ))}
        </ul>
      </Disclosure>
    </article>
  );
}

/** Blok „Ostrzeżenia o możliwym oszustwie” w sekcji Adresy: publikacje ostrzegające (odnośniki), zbiory, wzorce, zatruwanie adresu. */
export function ScamBlock() {
  const { dossier } = useDossier();
  const warnings = scamWarningsOf(dossier);
  if (!warnings) return null;
  const flagged = warnings.addresses.filter((item) => item.level !== 'none');
  if (flagged.length === 0 && warnings.poisoning.length === 0) return null;
  return (
    <section id={SCAM_ANCHOR} aria-labelledby="oszustwo-tytul">
      <header className="section-head">
        <div>
          <h2 id="oszustwo-tytul">
            Ostrzeżenia o możliwym <Term id="scam">oszustwie</Term>
          </h2>
          <p className="muted small">{warnings.statement}</p>
        </div>
      </header>
      {flagged.map((item) => (
        <AddressWarning key={`${item.network}:${item.address}`} item={item} />
      ))}
      {warnings.poisoning.length > 0 && (
        <article className="card mixer-block is-possible" aria-label="Możliwe zatruwanie adresu">
          <h4>
            Możliwe <Term id="zatruwanie-adresu">zatruwanie adresu</Term> <span className="status status-inference">hipoteza — dotyczy kontrahentów</span>
          </h4>
          <ul className="plain-list small">
            {warnings.poisoning.map((item) => (
              <li key={`${item.address}-${item.lookalike}`}>
                Kontrahent <span className="mono">{shorten(item.lookalike, 8, 6)}</span> naśladuje <span className="mono">{shorten(item.genuine, 8, 6)}</span>. {item.explanation}
              </li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}
