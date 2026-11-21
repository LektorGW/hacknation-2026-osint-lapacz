// „Bezpieczeństwo i retencja”: stan zabezpieczeń usługi (token, szyfrowanie migawki, retencja, archiwa),
// podgląd retencji (co zostałoby usunięte i dlaczego) oraz dziennik audytu.
import { useState } from 'react';
import { api } from '../api.ts';
import { getToken, setToken } from '../auth.ts';
import { CASE_STATUS_LABEL } from '../components/CaseLifecycle.tsx';
import { Crumbs, EmptyState, ErrorBox, Skeleton } from '../components/common.tsx';
import { fmtDateTime } from '../format.ts';
import { href } from '../router.ts';
import { useAsync } from '../useAsync.ts';
import '../lifecycle.css';

/** Czytelne nazwy czynności z dziennika audytu. */
const ACTION_LABEL: Record<string, string> = {
  'sprawa.zamknieta': 'zamknięcie sprawy',
  'sprawa.przywrocona': 'przywrócenie sprawy',
  'sprawa.zarchiwizowana': 'archiwum sprawy',
  'sprawa.usunieta': 'usunięcie sprawy',
  'sprawa.usunieta-retencja': 'usunięcie sprawy (retencja)',
  'sprawa.usuniecie-odmowa': 'odmowa usunięcia (powiązania)',
  'archiwum.pobrane': 'pobranie archiwum',
  'decyzja.dodana': 'decyzja analityka',
  'decyzja.wycofana': 'wycofanie decyzji',
  'odpowiedz-uslugi.dodana': 'odpowiedź usługi',
  'odpowiedz-uslugi.wycofana': 'wycofanie odpowiedzi usługi',
  'siec.rozwinieta': 'rozwinięcie sieci',
  'siec.rozwiniecie-wycofane': 'wycofanie rozwinięcia sieci',
  'eksport.pobrany': 'pobranie eksportu',
  'raport.pobrany': 'pobranie raportu',
  'material-zapytania.pobrany': 'pobranie materiału do zapytania',
};

function OnOff({ on, yes, no }: { on: boolean; yes: string; no: string }) {
  return <dd className={on ? 'security-on' : 'security-off'}>{on ? `✓ ${yes}` : no}</dd>;
}

export function SecurityPage() {
  const status = useAsync(() => api.getSecurityStatus(), 'security-status');
  const retention = useAsync(() => api.getRetentionPreview(), 'retention-preview');
  const audit = useAsync(() => api.listAudit(), 'audit-log');
  const [hasToken, setHasToken] = useState(() => getToken() !== null);

  const unavailable = status.data === null;
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Pulpit', href: href.dashboard() }, { label: 'Bezpieczeństwo i retencja' }]} />
      <h1>Bezpieczeństwo i retencja</h1>
      <p className="muted">
        Stan zabezpieczeń usługi analizy, reguły usuwania zamkniętych spraw i dziennik audytu. Konfiguracja wyłącznie zmiennymi środowiskowymi usługi
        (opis w docs/BEZPIECZENSTWO.md) — tu tylko podgląd.
      </p>

      <section className="card" aria-labelledby="zabezpieczenia">
        <h2 id="zabezpieczenia">Zabezpieczenia</h2>
        {status.error && <ErrorBox message={status.error} onRetry={status.reload} />}
        {!status.data && status.loading && <Skeleton blocks={1} />}
        {unavailable && <p className="notice">Ta wersja usługi analizy nie podaje stanu zabezpieczeń.</p>}
        {status.data && (
          <dl className="security-grid">
            <div>
              <dt>Token API (OLCYS_API_TOKEN)</dt>
              <OnOff on={status.data.tokenRequired} yes="wymagany" no="wyłączony — dostęp bez logowania" />
            </div>
            <div>
              <dt>Szyfrowanie migawki bazy (OLCYS_SNAPSHOT_KEY)</dt>
              <OnOff on={status.data.snapshotEncrypted} yes="AES-256-GCM" no="wyłączone" />
            </div>
            <div>
              <dt>Retencja zamkniętych spraw</dt>
              <OnOff on={status.data.retention.enabled} yes={`po ${status.data.retention.days} dniach`} no="wyłączona — nic nie jest usuwane automatycznie" />
            </div>
            <div>
              <dt>Archiwa na serwerze (OLCYS_ARCHIVE_DIR)</dt>
              <OnOff on={status.data.archiveStoredOnServer} yes="zapisywane" no="nie — w bazie tylko skrót SHA-256" />
            </div>
            <div>
              <dt>Limit kosztownych żądań</dt>
              <dd>{status.data.rateLimitPerMinute ? `${status.data.rateLimitPerMinute} / min na adres IP` : 'wyłączony'}</dd>
            </div>
            <div>
              <dt>Dozwolone adresy interfejsu (CORS)</dt>
              <dd className="audit-details">{status.data.corsOrigins.join(', ') || '—'}</dd>
            </div>
          </dl>
        )}
        {status.data?.tokenRequired && hasToken && (
          <p>
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                setToken(null);
                setHasToken(false);
              }}
            >
              Wyloguj (usuń token z tej karty)
            </button>
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="retencja">
        <h2 id="retencja">Retencja — podgląd</h2>
        <p className="muted small">
          Zadanie retencji usuwa sprawę wyłącznie, gdy jest zarchiwizowana (archiwum po zamknięciu), zamknięta dłużej niż próg i niepowiązana z żadną otwartą
          sprawą. Sprawy bez archiwum nigdy nie są usuwane automatycznie. Podgląd niczego nie zmienia.
        </p>
        {retention.error && <ErrorBox message={retention.error} onRetry={retention.reload} />}
        {retention.data === null && <p className="notice">Ta wersja usługi analizy nie ma podglądu retencji.</p>}
        {retention.data && retention.data.items.length === 0 && <EmptyState title="Brak zamkniętych spraw">Retencja dotyczy wyłącznie spraw zamkniętych i zarchiwizowanych.</EmptyState>}
        {retention.data && retention.data.items.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Sprawa</th>
                  <th scope="col">Stan</th>
                  <th scope="col">Zamknięta</th>
                  <th scope="col">Decyzja</th>
                  <th scope="col">Powody</th>
                </tr>
              </thead>
              <tbody>
                {retention.data.items.map((item) => (
                  <tr key={item.caseId}>
                    <th scope="row">
                      <a href={href.case(item.caseId)}>{item.caseName}</a>
                    </th>
                    <td>{CASE_STATUS_LABEL[item.status]}</td>
                    <td>{item.closedAt ? `${fmtDateTime(item.closedAt)}${item.ageDays !== undefined ? ` (${item.ageDays} dni)` : ''}` : '—'}</td>
                    <td>{item.eligible ? <strong className="case-dialog-error">zostanie usunięta</strong> : 'zostaje'}</td>
                    <td>
                      <ul className="reasons">
                        {item.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="audyt">
        <h2 id="audyt">Dziennik audytu</h2>
        <p className="muted small">Tylko dopisywanie; bez danych osobowych — identyfikatory techniczne, rodzaje czynności i liczby. Najnowsze na górze.</p>
        {audit.error && <ErrorBox message={audit.error} onRetry={audit.reload} />}
        {audit.data === null && <p className="notice">Ta wersja usługi analizy nie prowadzi dziennika audytu.</p>}
        {audit.data && audit.data.length === 0 && <p className="muted">Dziennik jest pusty.</p>}
        {audit.data && audit.data.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Czas</th>
                  <th scope="col">Czynność</th>
                  <th scope="col">Kto</th>
                  <th scope="col">Sprawa</th>
                  <th scope="col">Szczegóły</th>
                </tr>
              </thead>
              <tbody>
                {[...audit.data].reverse().map((entry, index) => (
                  <tr key={entry.seq ?? index}>
                    <td>{fmtDateTime(entry.at)}</td>
                    <td>{ACTION_LABEL[entry.action] ?? entry.action}</td>
                    <td>{entry.actor}</td>
                    <td className="audit-details">{entry.caseId ? <a href={href.case(entry.caseId)}>{entry.caseId.slice(0, 8)}…</a> : '—'}</td>
                    <td className="audit-details">
                      {entry.target ? `${entry.target.slice(0, 24)} ` : ''}
                      {Object.keys(entry.details).length > 0 ? JSON.stringify(entry.details) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
