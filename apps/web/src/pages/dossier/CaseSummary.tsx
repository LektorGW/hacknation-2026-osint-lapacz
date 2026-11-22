// „Podsumowanie sprawy”: odpowiedź w jednym spojrzeniu (kto, ile adresów, dokąd trafiły pieniądze, co dalej)
// oraz kluczowe ustalenia w trzech grupach: fakty, obliczenia, wnioski.
import { useState } from 'react';
import type { Finding, PersonCandidate } from '@olcys/core';
import { jointProbability } from '../../dossier.ts';
import { fmtPln, fmtPlnCompact, shorten, sum } from '../../format.ts';
import { NETWORK_SHORT } from '../../labels.ts';
import { moneyDestinations, moneyServicesView, proofSummary } from '../../proof.ts';
import type { FullDossier } from '../../proof.ts';
import { isExternalDocumentText } from '../../service-reply.ts';
import type { ServiceReplyRef } from '../../service-reply.ts';
import { identityStatus } from '../../identities.ts';
import { withGraphLayer } from '../../router.ts';
import type { DossierTab } from '../../router.ts';
import { edgeLayer } from '../../graph/investigation.ts';
import { GraphView } from '../../graph/GraphView.tsx';
import { FINDING_GROUPS, countText, groupKeyFindings, noPersonReason, searchInput, splitLead, summarySentence } from '../../ux.ts';
import { isAddressCase } from '../../components/AddressSummary.tsx';
import { useDossier } from '../../components/DossierContext.tsx';
import { ServiceChips } from '../../components/ServiceCards.tsx';
import { fiatSignalSummary } from '../../components/FiatSignals.tsx';
import { Disclosure } from '../../components/ui/Disclosure.tsx';
import { Hint } from '../../components/ui/Hint.tsx';
import { Score } from '../../components/ui/Score.tsx';
import { Term } from '../../components/ui/Term.tsx';
import { OrganizationTile, PublicFigureLine } from '../../components/OrganizationCards.tsx';
import { leadOrganization } from '../../organizations.ts';
import { BusinessHeroLine } from '../../components/BusinessActivity.tsx';
import { SwirlIcon } from '../../components/MixerExposure.tsx';
import { mixerBadgeText, mixerExposureOf } from '../../mixers.ts';
import { RiskIndicator } from '../../components/Warnings.tsx';

const replyRef = (person: PersonCandidate | undefined): ServiceReplyRef | undefined =>
  (person as (PersonCandidate & { confirmedByReply?: ServiceReplyRef }) | undefined)?.confirmedByReply;

const totalPln = (dossier: FullDossier) =>
  (dossier.totals as { cashOutPlnTotal?: number }).cashOutPlnTotal ?? sum(Object.values(dossier.totals.cashOutPlnByYear));

/** Status ustalenia osoby słowami — hipoteza nigdy nie wygląda na potwierdzenie. */
function PersonStatus({ person }: { person: PersonCandidate }) {
  if (replyRef(person)) {
    return (
      <span className="status status-external">
        potwierdzone odpowiedzią usługi · <Term id="odpowiedz-uslugi">dokument spoza OSINT</Term>
      </span>
    );
  }
  if (person.status === 'confirmed') return <span className="status status-ok">potwierdzone przez analityka</span>;
  return (
    <span className="status status-inference">
      <Term id="hipoteza">hipoteza</Term> — wymaga potwierdzenia
    </span>
  );
}

interface Action {
  label: string;
  tab?: DossierTab;
  anchor?: string;
}

/** 1–3 następne kroki w kolejności ważności. */
function nextActions(dossier: FullDossier, linked: Finding[]): Action[] {
  const actions: Action[] = [];
  const unconfirmed = dossier.unconfirmedAddresses ?? [];
  const proofs = dossier.cashOutProof ?? [];
  const hypotheses = (dossier.linkedIdentities ?? []).filter((identity) => identityStatus(identity) === 'hypothesis');
  const explanations = dossier.explanations ?? [];
  if (dossier.partial) actions.push({ label: 'Ponów analizę — wynik jest częściowy', tab: 'analizy' });
  if (unconfirmed.length > 0) actions.push({ label: `Potwierdź ${countText(unconfirmed.length, 'adres', 'adresy', 'adresów')}`, tab: 'adresy' });
  if (proofs.length > 0) actions.push({ label: 'Zobacz drogę pieniędzy krok po kroku', tab: 'dowod' });
  if (dossier.serviceLinks.length > 0) actions.push({ label: 'Przygotuj zapytanie do giełdy', tab: 'uslugi' });
  if (hypotheses.length > 0) actions.push({ label: `Sprawdź ${countText(hypotheses.length, 'powiązaną tożsamość', 'powiązane tożsamości', 'powiązanych tożsamości')}`, tab: 'tozsamosci' });
  if (linked.length > 0 && proofs.length === 0) actions.push({ label: 'Przejrzyj adresy i ślady w źródłach', tab: 'adresy' });
  if (explanations.length > 0 && actions.length < 3) actions.push({ label: 'Czego brakuje i co można zrobić', anchor: 'czego-brakuje' });
  return actions.slice(0, 3);
}

/**
 * „Most” między kafelkami podsumowania: klikalne połączenie, które otwiera graf w jednej warstwie —
 * osoba ↔ adresy to ślady z otwartych źródeł (OSINT), adresy ↔ wyjścia to przepływy w blockchainie.
 */
/** Wysokość łuku mostu nad pomostem w punkcie `x` (łuk paraboliczny między przyczółkami). */
const archY = (x: number) => {
  const t = (x - 14) / 132;
  return 50 - 46 * 4 * t * (1 - t);
};
const HANGERS = [34, 54, 80, 106, 126];

/** Rysunek mostu łukowego: przyczółki, łuk, wieszaki, pomost i rzeka; przy zaznaczeniu po pomoście jadą „dane”. */
function BridgeDrawing() {
  return (
    <svg className="bridge-svg" viewBox="0 0 160 84" aria-hidden="true" focusable="false">
      <path className="bridge-water" d="M0 72 q10 -5 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" />
      <path className="bridge-water bridge-water-2" d="M6 79 q10 -4 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" />
      <path className="bridge-arch-fill" d={`M14 50 Q80 ${50 - 92} 146 50 Z`} />
      {HANGERS.map((x) => (
        <line key={x} className="bridge-hanger" x1={x} x2={x} y1={archY(x)} y2={50} />
      ))}
      <path className="bridge-arch" d={`M14 50 Q80 ${50 - 92} 146 50`} />
      <rect className="bridge-pier" x="6" y="44" width="14" height="26" rx="2" />
      <rect className="bridge-pier" x="140" y="44" width="14" height="26" rx="2" />
      <rect className="bridge-deck" x="2" y="49" width="156" height="7" rx="3.5" />
      <circle className="bridge-car bridge-car-1" cx="10" cy="52.5" r="2.4" />
      <circle className="bridge-car bridge-car-2" cx="10" cy="52.5" r="2.4" />
      <circle className="bridge-car bridge-car-3" cx="10" cy="52.5" r="2.4" />
    </svg>
  );
}

/**
 * „Most” między kafelkami podsumowania — przełącznik grafu pod kafelkami:
 * osoba ↔ adresy to ślady z otwartych źródeł (OSINT), adresy ↔ wyjścia to przepływy w blockchainie.
 * Zaznaczenie obu mostów pokazuje jeden, połączony graf obu warstw.
 */
function Bridge({ title, detail, empty, kind, active, onToggle, badge }: { title: string; detail: string; empty: boolean; kind: 'osint' | 'chain'; active: boolean; onToggle: () => void; badge?: { text: string; tone: string } }) {
  return (
    <button
      type="button"
      className={`bridge bridge-${kind} ${empty ? 'is-empty' : ''} ${active ? 'is-active' : ''}`}
      aria-pressed={active}
      onClick={onToggle}
      title={active ? `${title}: ukryj na grafie` : `${title}: pokaż na grafie (zaznacz oba mosty, aby połączyć grafy)`}
    >
      <BridgeDrawing />
      <span className="bridge-title">{title}</span>
      <span className="bridge-detail">{detail}</span>
      {badge && (
        <span className={`mixer-badge is-${badge.tone}`}>
          <SwirlIcon /> {badge.text}
        </span>
      )}
      <span className="bridge-cta">{active ? '✓ na grafie poniżej' : 'pokaż na grafie'}</span>
    </button>
  );
}

const HERO_GRAPH_TITLE = {
  identity: 'Graf: ślady OSINT — osoba, konta, publikacje i adresy',
  chain: 'Graf: śledzenie w blockchainie — adresy, przepływy i usługi',
  both: 'Graf połączony: ślady OSINT i przepływy w blockchainie',
} as const;

function jumpTo(anchor: string) {
  const element = document.getElementById(anchor);
  element?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

export function CaseHero() {
  const { dossier, tabHref } = useDossier();
  const person = dossier.persons[0];
  const addressCase = isAddressCase(dossier);
  const linked = dossier.findings
    .filter((finding) => !finding.confidence.excluded)
    .map((finding) => ({ finding, joint: jointProbability(dossier, finding) }))
    .sort((a, b) => (b.joint ?? b.finding.confidence.score) - (a.joint ?? a.finding.confidence.score));
  const rejected = dossier.findings.length - linked.length;
  const unconfirmed = dossier.unconfirmedAddresses ?? [];
  const money = totalPln(dossier);
  const proofs = proofSummary(dossier.cashOutProof ?? []);
  // Usługi na kaflu: przelewy do usług PLUS usługi z dowodów spieniężenia (np. kantor P2P na końcu ścieżki).
  const destinations = moneyDestinations(dossier.serviceLinks, dossier.cashOutProof);
  const serviceNames = destinations.map((item) => item.name);
  const fiatSignals = dossier.indicators ? fiatSignalSummary(dossier.indicators.cashOut).total : 0;
  const servicesView = moneyServicesView({
    destinations: destinations.length,
    serviceLinks: dossier.serviceLinks.length,
    money,
    proofs: (dossier.cashOutProof ?? []).length,
    fiatSignals,
  });
  const strongest = linked[0];
  const actions = nextActions(
    dossier,
    linked.map((item) => item.finding),
  );
  const name = person?.fullName ?? person?.nameVariants[0];
  // Zdanie i wyróżniony kafel zależą od tego, co analityk wpisał: adres krypto czy daną o osobie.
  const input = searchInput(dossier.subject.identifiers);
  const addressInput = input.kind === 'address';
  const reason = noPersonReason({
    widelyCited: (dossier.explanations ?? []).some((item) => item.kind === 'widely_cited'),
    mentionDocuments: sum((dossier.mentions ?? []).map((item) => item.documents)),
  });
  const sentence = summarySentence({
    person: name,
    addressCase,
    ...(addressInput ? { inputAddress: shorten(input.items[0]!.value, 6, 4), noPersonReason: reason } : {}),
    linked: linked.length,
    unconfirmed: unconfirmed.length,
    services: serviceNames,
    totalPln: money,
  });
  // Kafel „Badany adres” zostaje tylko dla spraw z adresem dopisanym obok danej o osobie.
  const addressTile = addressCase && !addressInput;
  // Mosty: ile śladów OSINT łączy osobę z adresami i ile przepływów w blockchainie prowadzi od adresów do wyjść.
  const sources = new Set(dossier.findings.flatMap((finding) => finding.evidence.map((item) => item.url))).size;
  const accounts = dossier.profiles.length;
  const chainEdges = dossier.graph.edges.filter((edge) => edgeLayer(edge) === 'chain').length;
  const mixers = mixerExposureOf(dossier);
  const graphHref = tabHref('graf');
  const [shown, setShown] = useState<{ osint: boolean; chain: boolean }>({ osint: false, chain: false });
  const heroLayer = shown.osint && shown.chain ? 'both' : shown.osint ? 'identity' : shown.chain ? 'chain' : undefined;
  const osintDetail =
    sources + accounts > 0 ? `${countText(accounts, 'konto', 'konta', 'kont')} · ${countText(sources, 'źródło', 'źródła', 'źródeł')}` : 'brak śladów w źródłach';
  const chainDetail = chainEdges > 0 ? countText(chainEdges, 'przepływ', 'przepływy', 'przepływów') : 'brak przepływów do usług';
  const inputTag = (
    <span className="input-tag" title="To jest wejście wyszukiwania — dana wpisana przez analityka">
      wejście
    </span>
  );

  return (
    <section className="case-hero" aria-labelledby="podsumowanie-tytul" data-tour="summary">
      <header className="case-hero-head">
        <div>
          <p className="eyebrow">Podsumowanie sprawy</p>
          <h2 id="podsumowanie-tytul" className="case-hero-sentence">
            {sentence}
          </h2>
        </div>
        <div className="case-hero-priority">
          <Score value={dossier.totals.priority} kind="priority" reasons={dossier.totals.priorityReasons} caption="priorytet sprawy" />
          <RiskIndicator />
        </div>
      </header>

      {dossier.summary && (
        <Disclosure title="Przeczytaj streszczenie ustaleń" meta="napisał model językowy" className="case-hero-ai">
          <p className="prose">{dossier.summary.text}</p>
          <p className="muted small">
            Streszczenie wygenerowane z ustaleń poniżej · {dossier.summary.model} · wersja polecenia {dossier.summary.promptVersion}. To nie jest nowe ustalenie.
          </p>
        </Disclosure>
      )}

      <div className="answers">
        <article className={`answer ${!addressInput && input.items.length > 0 ? 'is-input' : ''}`}>
          <h3 className="answer-label">
            {addressTile ? 'Badany adres' : 'Kto to prawdopodobnie jest'}
            {!addressInput && input.items.length > 0 && inputTag}
          </h3>
          {addressTile ? (
            <>
              <p className="answer-value mono-value">{shorten(dossier.findings[0]?.address ?? dossier.subject.name, 10, 8)}</p>
              <span className="status status-fact">sprawa dotyczy samego adresu — właściciela nie ustalano</span>
            </>
          ) : person ? (
            <>
              <p className="answer-value">{name ?? 'Imienia i nazwiska nie ustalono'}</p>
              <PersonStatus person={person} />
              <Score value={person.probability} kind="person" reasons={person.reasons} caption="pewność, że to osoba ze sprawy" />
              {person.nameVariants.length > 0 && name !== person.nameVariants[0] && <p className="muted small">występuje też jako: {person.nameVariants.slice(0, 3).join(', ')}</p>}
              <PublicFigureLine />
            </>
          ) : leadOrganization(dossier) ? (
            <OrganizationTile org={leadOrganization(dossier)!} />
          ) : (
            <>
              <p className="answer-value answer-empty">Nie ustalono osoby</p>
              <p className="muted small">
                {addressInput ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.` : 'W źródłach nie znaleziono profili, które dałoby się połączyć w osobę.'}
              </p>
              <PublicFigureLine />
            </>
          )}
          <a className="answer-link" href={tabHref('osoba')}>
            {addressTile || (addressInput && !person) ? 'Szczegóły adresu' : 'Osoba i konta'} <span aria-hidden="true">→</span>
          </a>
        </article>

        <Bridge
          kind="osint"
          title="Ślady OSINT"
          detail={osintDetail}
          empty={sources + accounts === 0}
          active={shown.osint}
          onToggle={() => setShown((current) => ({ ...current, osint: !current.osint }))}
        />

        <article className={`answer ${addressInput ? 'is-input' : ''}`}>
          <h3 className="answer-label">
            <Term id="adres-krypto">Adresy krypto</Term>
            {addressInput && inputTag}
          </h3>
          <p className="answer-value">
            <span className="answer-number">{linked.length}</span> {linked.length === 1 ? 'powiązany' : 'powiązane'}
          </p>
          {strongest && (
            <Score
              value={strongest.joint ?? strongest.finding.confidence.score}
              kind={strongest.joint !== undefined ? 'joint' : 'publication'}
              ledger={strongest.finding.confidence.ledger}
              caption={`najmocniejszy: ${NETWORK_SHORT[strongest.finding.network] ?? strongest.finding.network} ${shorten(strongest.finding.address, 6, 4)}`}
              extra={
                strongest.joint !== undefined ? (
                  <p className="score-pop-sub-text">
                    Kroki powyżej dotyczą publikacji adresu (Wskaźnik Pewności {strongest.finding.confidence.score}). Powiązanie z osobą uwzględnia też pewność ustalenia osoby.
                  </p>
                ) : undefined
              }
            />
          )}
          <ul className="answer-facts">
            {unconfirmed.length > 0 && (
              <li className="is-inference">
                {countText(unconfirmed.length, 'adres', 'adresy', 'adresów')} <Term id="adres-do-potwierdzenia">do potwierdzenia</Term>
              </li>
            )}
            {rejected > 0 && <li className="is-rejected">{countText(rejected, 'adres odrzucony', 'adresy odrzucone', 'adresów odrzuconych')}</li>}
            {linked.length === 0 && unconfirmed.length === 0 && <li>nie znaleziono adresów</li>}
          </ul>
          <a className="answer-link" href={tabHref('adresy')}>
            Adresy i ślady <span aria-hidden="true">→</span>
          </a>
        </article>

        <Bridge
          kind="chain"
          title="Śledzenie w blockchainie"
          detail={chainDetail}
          empty={chainEdges === 0}
          active={shown.chain}
          onToggle={() => setShown((current) => ({ ...current, chain: !current.chain }))}
          {...(mixers ? { badge: { text: mixerBadgeText(mixers), tone: mixers.level } } : {})}
        />

        <article className="answer">
          <h3 className="answer-label">Dokąd trafiły pieniądze</h3>
          <p className="answer-value">
            {money > 0 ? (
              <>
                <span className="answer-number tabular">ok. {fmtPln(money)}</span>
                <span className="muted small answer-unit">
                  {' '}
                  <Term id="wycena">szacunek</Term>
                </span>
              </>
            ) : (
              <span className="answer-empty">brak oznak wypłat</span>
            )}
          </p>
          {servicesView === 'list' ? (
            <ul className="answer-services">
              {destinations.slice(0, 3).map((item) => (
                <li
                  key={item.name}
                  className={item.inferred ? 'is-inferred' : undefined}
                  title={item.source === 'proof' ? 'usługa na końcu ścieżki z dowodu spieniężenia' : item.inferred ? 'powiązanie wyłącznie z wnioskowania' : undefined}
                >
                  <span className="answer-service-name">{item.name}</span>
                  <span className="answer-service-amount tabular">
                    {item.pln !== undefined
                      ? fmtPlnCompact(item.pln)
                      : item.source === 'proof'
                        ? countText(item.transfers, 'ścieżka', 'ścieżki', 'ścieżek')
                        : countText(item.transfers, 'przelew', 'przelewy', 'przelewów')}
                  </span>
                </li>
              ))}
              {destinations.length > 3 && (
                <li className="answer-services-more">
                  <a href={tabHref('uslugi')}>+ {countText(destinations.length - 3, 'inna usługa', 'inne usługi', 'innych usług')}</a>
                </li>
              )}
            </ul>
          ) : servicesView === 'chips' ? (
            <ServiceChips />
          ) : servicesView === 'unnamed' ? (
            <p className="muted small">Nazwy usługi nie ustalono — szczegóły w sekcji Pieniądze.</p>
          ) : (
            <p className="muted">Nie stwierdzono powiązań z giełdami ani portfelami.</p>
          )}
          {dossier.indicators && (
            <p className="answer-fiat small">
              <Term id="off-ramp">oznaki wypłaty na PLN</Term>: <strong className="tabular">{fiatSignals}</strong>
            </p>
          )}
          {proofs.strongest && (
            <Score
              value={proofs.strongest.combinedConfidence}
              kind="proof"
              reasons={proofs.strongest.components}
              caption={
                <>
                  najmocniejszy <Term id="dowod-spienienia">dowód spieniężenia</Term>
                </>
              }
            />
          )}
          <a className="answer-link" href={tabHref('dowod')}>
            Pieniądze <span aria-hidden="true">→</span>
          </a>
        </article>
      </div>


      <BusinessHeroLine />

      {heroLayer ? (
        <section className={`hero-graph hero-graph-${heroLayer}`} aria-label={HERO_GRAPH_TITLE[heroLayer]}>
          <header className="hero-graph-head">
            <h3>{HERO_GRAPH_TITLE[heroLayer]}</h3>
            <div className="hero-graph-actions">
              {heroLayer !== 'both' && (
                <button type="button" className="button" onClick={() => setShown({ osint: true, chain: true })}>
                  Połącz oba grafy
                </button>
              )}
              <a className="button" href={heroLayer === 'both' ? graphHref : withGraphLayer(graphHref, heroLayer === 'identity' ? 'osint' : 'blockchain')}>
                Otwórz w sekcji Graf
              </a>
              <button type="button" className="button" onClick={() => setShown({ osint: false, chain: false })} aria-label="Ukryj graf">
                Ukryj
              </button>
            </div>
          </header>
          <GraphView layer={heroLayer} embedded />
        </section>
      ) : (
        <p className="hero-graph-tip muted small">Kliknij most, aby zobaczyć jego część grafu. Zaznacz oba mosty, aby połączyć grafy w jeden.</p>
      )}

      {actions.length > 0 && (
        <div className="next-actions" data-tour="actions">
          <p className="next-actions-label">Co dalej?</p>
          <div className="next-actions-row">
            {actions.map((action, index) =>
              action.tab ? (
                <a key={action.label} className={`button ${index === 0 ? 'button-primary' : ''}`} href={tabHref(action.tab)}>
                  {action.label}
                </a>
              ) : (
                <button key={action.label} type="button" className={`button ${index === 0 ? 'button-primary' : ''}`} onClick={() => jumpTo(action.anchor!)}>
                  {action.label}
                </button>
              ),
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Jedno ustalenie: zwięzła linia, dopowiedzenie po rozwinięciu. */
function FindingLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { lead, rest, joined } = splitLead(text);
  return (
    <li className="kf-item">
      <span className="kf-text">
        {lead}
        {rest && !open && joined && '…'}
        {rest && open && <span className={joined ? undefined : 'kf-rest'}> {rest}</span>}
      </span>
      {rest && (
        <button type="button" className="kf-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'mniej' : 'więcej'}
        </button>
      )}
    </li>
  );
}

const GROUP_TERM: Record<string, 'fakt-zrodlowy' | 'wynik-obliczen' | 'wniosek-do-weryfikacji' | 'odpowiedz-uslugi'> = {
  fact: 'fakt-zrodlowy',
  calc: 'wynik-obliczen',
  inference: 'wniosek-do-weryfikacji',
  external: 'odpowiedz-uslugi',
};

export function KeyFindings() {
  const { dossier } = useDossier();
  const groups = groupKeyFindings(dossier.keyFindings, isExternalDocumentText);
  if (dossier.keyFindings.length === 0) return null;
  return (
    <section className="kf card" aria-labelledby="ustalenia-tytul" data-tour="findings">
      <header className="kf-head">
        <h2 id="ustalenia-tytul">Kluczowe ustalenia</h2>
        <p className="muted small">Każde w jednej linii. „więcej” rozwija szczegóły.</p>
      </header>
      <div className="kf-groups">
        {FINDING_GROUPS.filter((group) => groups[group.id].length > 0).map((group) => (
          <section key={group.id} className={`kf-group kf-${group.id}`} aria-labelledby={`kf-${group.id}`}>
            <h3 id={`kf-${group.id}`} className="kf-group-title">
              <span className="kf-dot" aria-hidden="true" />
              {group.title}
              <span className="kf-group-sub">
                <Term id={GROUP_TERM[group.id]!}>{group.subtitle}</Term>
              </span>
            </h3>
            <ul className="kf-list">
              {groups[group.id].map((text) => (
                <FindingLine key={text} text={text} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

export function SummaryHint() {
  return (
    <Hint id="teczka-podsumowanie" title="Jak czytać teczkę">
      U góry odpowiedź w skrócie, niżej ustalenia podzielone na fakty, obliczenia i wnioski. Słowa podkreślone kropkami można kliknąć — pokażą wyjaśnienie.
    </Hint>
  );
}
