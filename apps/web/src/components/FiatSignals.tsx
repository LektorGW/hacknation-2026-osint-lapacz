// Wskaźnik C: oznaki wypłaty na PLN pogrupowane według źródła — „W publikacjach” (Web2, konta podmiotu)
// i „W blockchainie” (wzorce przelewów). Liczby wynikają wprost z tabel składników ocen.
import type { ReactNode } from 'react';
import type { CashOutAssessment } from '@olcys/core';
import { ExternalLink } from './common.tsx';
import { Term } from './ui/Term.tsx';
import '../fiat-signals.css';

/** Reguły publikacji (Web2) — opis po polsku. */
const WEB_RULES: Record<string, string> = {
  'cashout.web.p2p_offer_pln': 'oferta sprzedaży kryptowaluty za PLN lub gotówkę',
  'cashout.web.cash_meeting': 'spotkanie i gotówka do ręki',
  'cashout.web.bank_or_blik': 'przelew na rachunek albo BLIK',
  'cashout.web.crypto_card': 'karta krypto',
  'cashout.web.named_offramp': 'nazwana usługa wyjścia do fiat',
  'cashout.web.payment_gateway': 'bramka płatnicza',
};

/** Reguły blockchain, które są oznaką wypłaty (a nie samą interakcją z usługą). */
const CHAIN_RULES: Record<string, string> = {
  'cashout.documented_service_reply': 'wypłata potwierdzona odpowiedzią usługi',
  'cashout.documented_offchain': 'wypłata potwierdzona dokumentem przyjętym przez analityka',
  'cashout.stablecoin_conversion_large': 'wymiana znacznej wartości na stablecoin i wpłata',
  'cashout.stablecoin_swap': 'zamiana na stablecoin przed wpłatą',
  'cashout.deposit_address_inferred': 'indywidualny adres wpłat w usłudze',
  'cashout.trail_documented': 'ścieżka środków do usługi',
  'cashout.repeated_offramp': 'regularne wpłaty przez wiele miesięcy',
  'cashout.repeated_deposits': 'powtarzalne wpłaty',
  'cashout.deposit_then_quiet': 'adres zamilkł po wpłacie',
  'cashout.crypto_card_topup': 'doładowanie karty krypto',
  'cashout.round_amounts_pln': 'kwoty okrągłe w PLN (słaba przesłanka)',
};

export interface FiatSignalRow {
  rule: string;
  label: string;
  /** W ilu ocenach (usługach / adresach) albo publikacjach wystąpiła oznaka. */
  count: number;
  urls: string[];
}

export interface FiatSignalSummary {
  web: FiatSignalRow[];
  chain: FiatSignalRow[];
  /** Liczba różnych oznak w obu grupach. */
  total: number;
  /** Liczba publikacji kont podmiotu z oznakami. */
  publications: number;
}

/** Oznaki wypłaty na PLN z ocen wskaźnika C; czytane obronnie — starsze teczki nie mają `origin`. */
export function fiatSignalSummary(cashOut: CashOutAssessment[] | undefined): FiatSignalSummary {
  const web = new Map<string, FiatSignalRow>();
  const chain = new Map<string, FiatSignalRow>();
  let publications = 0;
  for (const item of cashOut ?? []) {
    if (item.origin === 'web') publications += item.publications?.length ?? 0;
    for (const component of item.indicator?.components ?? []) {
      if (component.direction === 'contradicts') continue;
      const isWeb = item.origin === 'web' && component.rule in WEB_RULES;
      const isChain = item.origin !== 'web' && component.rule in CHAIN_RULES;
      if (!isWeb && !isChain) continue;
      const target = isWeb ? web : chain;
      const urls = (component.evidence ?? []).filter((ref) => ref.kind === 'url').map((ref) => ref.value);
      const row = target.get(component.rule) ?? { rule: component.rule, label: (isWeb ? WEB_RULES : CHAIN_RULES)[component.rule]!, count: 0, urls: [] };
      row.count += isWeb ? Math.max(1, urls.length) : 1;
      for (const url of urls) if (!row.urls.includes(url)) row.urls.push(url);
      target.set(component.rule, row);
    }
  }
  return { web: [...web.values()], chain: [...chain.values()], total: web.size + chain.size, publications };
}

function PublicationIcon() {
  return (
    <svg className="fiat-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" />
    </svg>
  );
}

function ChainIcon() {
  return (
    <svg className="fiat-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
    </svg>
  );
}

function Group({ title, icon, rows, empty, unit }: { title: string; icon: ReactNode; rows: FiatSignalRow[]; empty: string; unit: (count: number) => string }) {
  return (
    <section className="fiat-group" aria-label={`${title}: ${rows.length}`}>
      <h4 className="fiat-group-title">
        {icon} {title} <span className="fiat-count tabular">{rows.length}</span>
      </h4>
      {rows.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="fiat-rows">
          {rows.map((row) => (
            <li key={row.rule}>
              <span>{row.label}</span> <span className="muted small tabular">· {unit(row.count)}</span>
              {row.urls.length > 0 && (
                <span className="fiat-urls">
                  {row.urls.slice(0, 3).map((url) => (
                    <ExternalLink key={url} url={url} />
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const plural = (count: number, one: string, few: string, many: string) =>
  count === 1 ? one : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? few : many;

/** Przy ocenie wskaźnika C: „Dlaczego to oznaka wypłaty”, „Co potwierdzi wypłatę” (z gotowymi wskazówkami do zapytania), rodzaj usługi i publikacje. */
export function CashOutGuidance({ item }: { item: CashOutAssessment }) {
  if (!item.why && !item.confirm && !item.offramp && !(item.publications ?? []).length) return null;
  const hints = (item.confirm?.services ?? []).filter((service) => service.requestHints.length > 0);
  return (
    <dl className="cashout-guidance">
      {item.why && (
        <>
          <dt>Dlaczego to oznaka wypłaty</dt>
          <dd>{item.why}</dd>
        </>
      )}
      {item.confirm && (
        <>
          <dt>Co potwierdzi wypłatę</dt>
          <dd>
            {item.confirm.text}
            {hints.length > 0 && (
              <details>
                <summary>Dane do zapytania ({hints.map((service) => service.name).join(', ')})</summary>
                {hints.map((service) => (
                  <ul key={service.name} className="plain-list tight">
                    {service.requestHints.map((hint) => (
                      <li key={hint}>{hint}</li>
                    ))}
                  </ul>
                ))}
              </details>
            )}
          </dd>
        </>
      )}
      {item.offramp && (
        <>
          <dt>
            Rodzaj usługi (<Term id="off-ramp">off-ramp</Term>)
          </dt>
          <dd>
            {item.offramp.label}
            {item.offramp.registry.length > 0 ? (
              <ul className="plain-list tight">
                {item.offramp.registry.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : (
              <span className="muted small"> · w migawkach rejestrów (RDWW, MiCA) nie dopasowano wpisu o tej nazwie</span>
            )}
          </dd>
        </>
      )}
      {(item.publications ?? []).length > 0 && (
        <>
          <dt>Publikacje kont podmiotu</dt>
          <dd>
            <ul className="plain-list tight">
              {item.publications!.map((publication) => (
                <li key={publication.url}>
                  <ExternalLink url={publication.url}>{publication.title || publication.url}</ExternalLink> <span className="muted small">· {publication.service}</span>
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}

/** Karta „Oznaki wypłaty na PLN” nad listą ocen wskaźnika C. */
export function FiatSignalGroups({ cashOut }: { cashOut: CashOutAssessment[] | undefined }) {
  const summary = fiatSignalSummary(cashOut);
  return (
    <div className="fiat-groups" role="group" aria-label="Oznaki wypłaty na PLN według źródła">
      <p className="fiat-groups-head">
        <Term id="off-ramp">Oznaki wypłaty na PLN</Term>: <strong className="tabular">{summary.total}</strong>
        <span className="muted small"> — z publikacji ani z blockchaina nie da się dojść do „udokumentowanego wyjścia”; potwierdza je tylko odpowiedź usługi.</span>
      </p>
      <div className="fiat-groups-grid">
        <Group
          title="W publikacjach"
          icon={<PublicationIcon />}
          rows={summary.web}
          empty="Brak oznak w publikacjach kont podmiotu (wzmianki innych autorów się nie liczą)."
          unit={(count) => `${count} ${plural(count, 'publikacja', 'publikacje', 'publikacji')}`}
        />
        <Group
          title="W blockchainie"
          icon={<ChainIcon />}
          rows={summary.chain}
          empty="Brak wzorców wypłaty w przelewach (sama interakcja z usługą nie jest tu liczona)."
          unit={(count) => `${count} ${plural(count, 'ocena', 'oceny', 'ocen')}`}
        />
      </div>
    </div>
  );
}
