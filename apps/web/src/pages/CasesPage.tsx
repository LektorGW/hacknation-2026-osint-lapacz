import { api } from '../api.ts';
import type { CaseSummary } from '../api.ts';
import { CaseForm } from '../components/CaseForm.tsx';
import { ErrorBox, Loading, ScoreBadge } from '../components/common.tsx';
import { fmtDateTime } from '../format.ts';
import { href, navigate } from '../router.ts';
import { useAsync } from '../useAsync.ts';

function CaseTable({ cases }: { cases: CaseSummary[] }) {
  if (cases.length === 0) {
    return <p className="muted">Nie ma jeszcze żadnej sprawy. Utwórz pierwszą w formularzu obok.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Sprawa</th>
            <th scope="col">Utworzono</th>
            <th scope="col" className="num">Identyfikatory</th>
            <th scope="col" className="num">Analizy</th>
            <th scope="col" className="num">Najwyższy wynik (ostatnia analiza)</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((item) => {
            const last = item.runs[item.runs.length - 1];
            return (
              <tr key={item.id}>
                <th scope="row">
                  <a href={href.case(item.id)}>{item.name}</a>
                </th>
                <td>{fmtDateTime(item.createdAt)}</td>
                <td className="num">{item.query.identifiers.length}</td>
                <td className="num">{item.runs.length}</td>
                <td className="num">{last ? <ScoreBadge score={last.topScore} /> : <span className="muted">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CasesPage() {
  const cases = useAsync(() => api.listCases(), 'cases');

  return (
    <div className="page">
      <h1>Sprawy</h1>
      <div className="two-columns">
        <section className="card" aria-labelledby="lista-spraw">
          <h2 id="lista-spraw">Lista spraw</h2>
          {cases.loading && <Loading />}
          {cases.error && <ErrorBox message={cases.error} onRetry={cases.reload} />}
          {cases.data && <CaseTable cases={cases.data} />}
        </section>
        <CaseForm onCreated={(created) => navigate(href.case(created.id))} />
      </div>
    </div>
  );
}
