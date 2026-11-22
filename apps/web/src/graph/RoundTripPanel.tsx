// „Szukaj dalej” w panelu bocznym adresu: obieg środków (ping-pong) — parametry, postęp, lista obiegów
// z przyciskiem „Pokaż na grafie” (podświetlenie ścieżki obiegu) i powodami zatrzymania.
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { Disclosure } from '../components/ui/Disclosure.tsx';
import { fmtAmount, fmtDateTime, fmtPln, shorten } from '../format.ts';
import type { ExpansionRecord, NetworkNode, NetworkView } from './network.ts';
import { INTERMEDIARY_LABEL, PATTERN_CHIP, RETURN_ROLE_LABEL, ROUNDTRIP_CHOICES, cycleSummary, progressText, roundTripReports } from './roundtrip.ts';
import type { RoundTripCycle, RoundTripProgress, RoundTripReport } from './roundtrip.ts';
import './network.css';

interface RoundTripPanelProps {
  node: NetworkNode;
  caseId: string;
  network: NetworkView | null;
  label: (id: string) => string;
  onExpanded: (record: ExpansionRecord) => void;
  onShowCycle: (cycle: RoundTripCycle) => void;
}

/** Czy węzeł jest adresem kryptowalutowym (tylko dla adresów szukamy obiegu). */
export const isAddressNode = (node: NetworkNode): boolean => node.kind === 'address' || node.id.startsWith('id:crypto_address:');

export function RoundTripPanel({ node, caseId, network, label, onExpanded, onShowCycle }: RoundTripPanelProps) {
  const [maxHops, setMaxHops] = useState<number>(ROUNDTRIP_CHOICES.defaults.maxHops);
  const [budget, setBudget] = useState<number>(ROUNDTRIP_CHOICES.defaults.budget);
  const [windowDays, setWindowDays] = useState<number>(ROUNDTRIP_CHOICES.defaults.windowDays);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RoundTripProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ record: ExpansionRecord; report: RoundTripReport } | null>(null);
  const inNetwork = network?.graph.nodes.some((item) => item.id === node.id) ?? false;

  useEffect(() => {
    setFresh(null);
    setError(null);
    setProgress(null);
  }, [node.id]);

  // Postęp z usługi co sekundę, dopóki trwa wyszukiwanie.
  useEffect(() => {
    if (!busy) return;
    let alive = true;
    const tick = async () => {
      try {
        const value = await api.getNetworkProgress?.(caseId);
        if (alive && value?.roundtrip && value.roundtrip.nodeId === node.id) setProgress(value.roundtrip);
      } catch {
        // Starsza usługa albo tryb demonstracyjny — bez licznika postępu, zostaje sam wskaźnik pracy.
      }
    };
    const timer = window.setInterval(() => void tick(), 1000);
    void tick();
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [busy, caseId, node.id]);

  if (!network || !inNetwork || !isAddressNode(node)) return null;
  const saved = roundTripReports(network, node.id)[0] ?? null;
  const shown = fresh && !network.expansions.find((item) => item.id === fresh.record.id)?.withdrawnAt ? fresh : saved;

  async function search() {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const response = await api.expandNetwork(caseId, { nodeId: node.id, relations: ['roundtrip'], depth: 1, force: true, roundtrip: { maxHops, budget, windowDays } });
      const report = response.expansion.results.roundtrip;
      if (report) setFresh({ record: response.expansion, report });
      else setError('Usługa nie zwróciła wyniku obiegu środków (starsza wersja albo tryb demonstracyjny).');
      onExpanded(response.expansion);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  const select = (value: number, set: (value: number) => void, options: readonly number[], unit: (value: number) => string) => (
    <select value={value} disabled={busy} onChange={(event) => set(Number(event.target.value))}>
      {options.map((option) => (
        <option key={option} value={option}>
          {unit(option)}
        </option>
      ))}
    </select>
  );

  return (
    <section className="expand-panel roundtrip-panel" aria-label="Obieg środków (ping-pong)">
      <h4>Obieg środków (ping-pong)</h4>
      <p className="muted small">
        Szuka wypływów, które wracają na ten adres, inny adres tego samego portfela albo inny adres sprawy — bezpośrednio (A→B→A) albo przez adresy pośrednie.
        Śledzi tylko największe kwoty; historii giełd i mikserów nie pobiera.
      </p>
      <div className="expand-actions">
        <label>
          Do {select(maxHops, setMaxHops, ROUNDTRIP_CHOICES.maxHops, (value) => `${value} przelewów`)}
        </label>
        <label>
          Budżet {select(budget, setBudget, ROUNDTRIP_CHOICES.budget, (value) => `${value} adresów`)}
        </label>
        <label>
          Okno {select(windowDays, setWindowDays, ROUNDTRIP_CHOICES.windowDays, (value) => `${value} dni`)}
        </label>
        <button type="button" className="button button-small button-primary" disabled={busy} onClick={search}>
          {busy ? 'Szukanie…' : 'Szukaj dalej'}
        </button>
      </div>
      {busy && (
        <p className="status-box" role="status">
          <span className="spinner" aria-hidden="true" /> Szukanie obiegu środków: {progressText(progress)}
        </p>
      )}
      {error && <p className="notice notice-inline">{error}</p>}
      {shown && <RoundTripResult report={shown.report} record={shown.record} label={label} onShowCycle={onShowCycle} />}
    </section>
  );
}

function RoundTripResult({ report, record, label, onShowCycle }: { report: RoundTripReport; record: ExpansionRecord; label: (id: string) => string; onShowCycle: (cycle: RoundTripCycle) => void }) {
  return (
    <div className="expand-result roundtrip-result" role="status">
      <p>
        <strong>{report.cycles.length === 0 ? 'Nie znaleziono obiegu środków' : `Znalezione obiegi: ${report.cycles.length}`}</strong> · pobrane adresy {report.stats.addressesFetched}/
        {report.params.budget} · najdalszy krok {report.stats.deepestHop} · do {report.params.maxHops} przelewów, okno {report.params.windowDays} dni ·{' '}
        <span className="muted small">{fmtDateTime(record.startedAt)}</span>
      </p>
      <p className="muted small">{report.caveat}</p>
      {report.cycles.length > 0 && (
        <ol className="roundtrip-list">
          {report.cycles.map((cycle) => (
            <li key={cycle.id}>
              <p>
                <span className={`chip ${PATTERN_CHIP[cycle.pattern]}`}>{cycle.label}</span> <span className="chip chip-warn" title="Kroki są faktami; że to te same środki — hipoteza.">hipoteza</span>
              </p>
              <p className="small">{cycleSummary(cycle)}</p>
              <p className="muted small">
                Powrót {RETURN_ROLE_LABEL[cycle.returnsTo.role]} · adresy pośrednie:{' '}
                {cycle.intermediaries.map((item) => `${shorten(item.address)} (${INTERMEDIARY_LABEL[item.class]}${item.label ? `: ${item.label}` : ''})`).join(', ')}
              </p>
              <p className="muted small">{cycle.note}</p>
              <div className="expand-actions">
                <button type="button" className="button button-small" onClick={() => onShowCycle(cycle)}>
                  Pokaż na grafie
                </button>
              </div>
              <Disclosure title="Kroki obiegu" meta={cycle.hopCount}>
                <ol className="plain-list roundtrip-hops">
                  {cycle.hops.map((hop, index) => (
                    <li key={`${hop.txid}-${index}`}>
                      <strong>{index + 1}.</strong> {label(cycle.nodeIds[index] ?? hop.from)} → {label(cycle.nodeIds[index + 1] ?? hop.to)} · {fmtAmount(hop.amount, hop.asset)}
                      {hop.valuePln !== undefined && <span title={hop.valuation}> (ok. {fmtPln(hop.valuePln)})</span>} · {fmtDateTime(hop.time)} ·{' '}
                      {hop.explorerUrl ? (
                        <a href={hop.explorerUrl} target="_blank" rel="noreferrer">
                          tx {shorten(hop.txid, 10, 6)}
                        </a>
                      ) : (
                        <code>tx {shorten(hop.txid, 10, 6)}</code>
                      )}
                    </li>
                  ))}
                </ol>
              </Disclosure>
            </li>
          ))}
        </ol>
      )}
      {report.stops.length > 0 && (
        <Disclosure title="Powody zatrzymania" meta={report.stops.length}>
          <ul className="plain-list">
            {report.stops.map((stop) => (
              <li key={stop.reason}>
                {stop.detail}
                {stop.count > 1 ? ` (${stop.count})` : ''}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      <p className="muted small">Wynik zapisano w historii rozwinięć sprawy; można go wycofać.</p>
    </div>
  );
}
