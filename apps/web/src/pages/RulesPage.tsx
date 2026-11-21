import type { ReactNode } from 'react';
import type { ScoreRules } from '@olcys/core';
import { api } from '../api.ts';
import { ErrorBox, Loading } from '../components/common.tsx';
import { fmtDelta } from '../format.ts';
import { CATEGORY_LABEL, CLASS_LABEL, IDENTITY_LABEL } from '../labels.ts';
import { useAsync } from '../useAsync.ts';

type Row = { name: string; id: string; value: ReactNode };

function RuleTable({ caption, valueHeader, rows }: { caption: string; valueHeader: string; rows: Row[] }) {
  return (
    <div className="table-scroll">
      <table className="table rules-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Reguła</th>
            <th scope="col">Identyfikator</th>
            <th scope="col" className="num">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.name}</th>
              <td>
                <code className="mono rule-id">{row.id}</code>
              </td>
              <td className="num">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Wpisy słownika reguł posortowane malejąco po wartości. */
function sortedEntries<K extends string>(record: Record<K, number>): [K, number][] {
  return (Object.entries(record) as [K, number][]).sort(([, a], [, b]) => b - a);
}

function Rules({ rules }: { rules: ScoreRules }) {
  const tiers = [...rules.tiers].sort((a, b) => b.min - a.min);
  return (
    <>
      <section className="card">
        <h2>Jak powstaje Wskaźnik Pewności</h2>
        <ol className="steps">
          <li>
            Jeśli adres należy do klasy wykluczonej (np. giełda, smart kontrakt), wynik wynosi 0% i adresu nie
            przypisuje się podmiotowi.
          </li>
          <li>Każdy ślad jest wyceniany osobno: baza za rodzaj źródła plus korekta za sposób powiązania z podmiotem.</li>
          <li>Punktem wyjścia jest najmocniejszy ślad.</li>
          <li>
            Ten sam adres w drugim niezależnym źródle (inna usługa) daje premię; kolejne źródła — mniejszą, do limitu.
            Wiele wystąpień w jednej usłudze nie jest dodatkowym potwierdzeniem.
          </li>
          <li>Adres publikowany przez wiele niepowiązanych tożsamości dostaje karę.</li>
          <li>Wynik mieści się w zakresie 0–100% i jest zamieniany na poziom słowny według progów.</li>
        </ol>
        <p className="muted">
          Każdy krok jest zapisywany w księdze reguł na karcie adresu, więc wynik można odtworzyć ręcznie.
        </p>
      </section>

      <section className="card">
        <RuleTable
          caption="Baza — rodzaj źródła, w którym opublikowano adres"
          valueHeader="Punkty bazowe"
          rows={sortedEntries(rules.base).map(([key, value]) => ({
            name: CATEGORY_LABEL[key] ?? key,
            id: `base.${key}`,
            value: `${value} p.p.`,
          }))}
        />
      </section>

      <section className="card">
        <RuleTable
          caption="Korekty — sposób powiązania śladu z podmiotem"
          valueHeader="Korekta"
          rows={sortedEntries(rules.identityAdjustment).map(([key, value]) => ({
            name: IDENTITY_LABEL[key] ?? key,
            id: `identity.${key}`,
            value: fmtDelta(value),
          }))}
        />
      </section>

      <section className="card">
        <RuleTable
          caption="Premie — niezależne źródła"
          valueHeader="Premia"
          rows={[
            { name: 'Drugie niezależne źródło', id: 'synergy.second_source', value: fmtDelta(rules.synergyBonus) },
            {
              name: 'Każde kolejne niezależne źródło (ponad dwa)',
              id: 'synergy.extra_sources',
              value: `${fmtDelta(rules.extraSourceBonus)}, łącznie najwyżej ${fmtDelta(rules.maxExtraSourceBonus)}`,
            },
          ]}
        />
      </section>

      <section className="card">
        <RuleTable
          caption="Kary i wykluczenia"
          valueHeader="Skutek"
          rows={[
            {
              name: `Adres współdzielony: publikuje go co najmniej ${rules.sharedAddressThreshold} niepowiązanych tożsamości`,
              id: 'penalty.shared_address',
              value: fmtDelta(-rules.sharedAddressPenalty),
            },
            {
              name: `Klasa adresu wykluczona: ${rules.excludedClasses.map((item) => CLASS_LABEL[item] ?? item).join(', ')}`,
              id: 'exclusion.address_class',
              value: 'wynik 0%, adres odrzucony',
            },
          ]}
        />
      </section>

      <section className="card">
        <div className="table-scroll">
          <table className="table rules-table">
            <caption>Progi poziomów słownych</caption>
            <thead>
              <tr>
                <th scope="col">Poziom</th>
                <th scope="col" className="num">Zakres wyniku</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier, index) => (
                <tr key={tier.label}>
                  <th scope="row">{tier.label}</th>
                  <td className="num">
                    {tier.min}–{index === 0 ? 100 : tiers[index - 1]!.min - 1}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function RulesPage() {
  const rules = useAsync(() => api.getRules(), 'rules');
  return (
    <div className="page">
      <h1>Zasady punktacji</h1>
      <p className="lead">
        Wskaźnik Pewności liczą wyłącznie jawne reguły. Poniższe wartości są pobierane z konfiguracji usługi analizy.
      </p>
      {rules.loading && <Loading />}
      {rules.error && <ErrorBox message={rules.error} onRetry={rules.reload} />}
      {rules.data && <Rules rules={rules.data} />}
    </div>
  );
}
