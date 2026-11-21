import type { ReactNode } from 'react';
import type { LedgerEntry, ScoreRules } from '@olcys/core';
import { api } from '../api.ts';
import { Crumbs, ErrorBox, Loading } from '../components/common.tsx';
import { Disclosure } from '../components/ui/Disclosure.tsx';
import { Score, ScoreSteps } from '../components/ui/Score.tsx';
import { Term } from '../components/ui/Term.tsx';
import { IDENTITY_SCORE } from '../dossier.ts';
import { href } from '../router.ts';
import { fmtDelta, scoreLevel } from '../format.ts';
import { CATEGORY_LABEL, CLASS_LABEL, IDENTITY_DESCRIPTION, IDENTITY_LABEL } from '../labels.ts';
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

/** Przykład krok po kroku z bieżących wartości reguł: własny profil, zgodny tylko nick, drugie niezależne źródło. */
function exampleLedger(rules: ScoreRules): LedgerEntry[] {
  const steps: { rule: string; delta: number; explanation: string }[] = [
    { rule: 'base.own_profile', delta: rules.base.own_profile ?? 0, explanation: 'Adres opublikowany na profilu, który wygląda na własny profil osoby.' },
    { rule: 'identity.same_handle', delta: rules.identityAdjustment.same_handle ?? 0, explanation: 'Profil łączy z osobą tylko ten sam nick — bez drugiego potwierdzenia.' },
    { rule: 'synergy.second_source', delta: rules.synergyBonus, explanation: 'Ten sam adres w drugim, niezależnym serwisie (np. ogłoszenie).' },
  ];
  let running = 0;
  return steps.map((step) => {
    running = Math.max(0, Math.min(100, running + step.delta));
    return { ...step, running } as LedgerEntry;
  });
}

/** Skala poziomów jako pasek: od najsłabszego do najmocniejszego, z progami. */
function TierScale({ rules }: { rules: ScoreRules }) {
  const tiers = [...rules.tiers].sort((a, b) => a.min - b.min);
  return (
    <ol className="tier-scale" aria-label="Skala poziomów Wskaźnika Pewności">
      {tiers.map((tier, index) => {
        const max = index === tiers.length - 1 ? 100 : tiers[index + 1]!.min - 1;
        return (
          <li key={tier.label} className={`level-${scoreLevel(tier.min)}`} style={{ flexGrow: Math.max(1, max - tier.min + 1) }}>
            <span className="tier-bar" aria-hidden="true" />
            <strong>{tier.label}</strong>
            <span className="muted small tabular">
              {tier.min}–{max}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Rules({ rules }: { rules: ScoreRules }) {
  const tiers = [...rules.tiers].sort((a, b) => b.min - a.min);
  const example = exampleLedger(rules);
  return (
    <>
      <section className="card rules-visual">
        <h2>
          Jak powstaje <Term id="wskaznik-pewnosci">Wskaźnik Pewności</Term> — przykład
        </h2>
        <p className="muted prose">Każda przesłanka dodaje albo odejmuje punkty. Wynik po ostatnim kroku to wskaźnik adresu (0–100).</p>
        <div className="rules-example">
          <ScoreSteps ledger={example} />
          <div className="rules-example-result">
            <Score value={example.at(-1)?.running ?? 0} kind="publication" ledger={example} caption="wynik przykładu" size="lg" />
          </div>
        </div>
        <h3>Skala poziomów</h3>
        <TierScale rules={rules} />
      </section>

      <Disclosure title="Pełne zasady obliczania — krok po kroku" meta="6 kroków" defaultOpen>
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
      </Disclosure>

      <Disclosure title="Wszystkie wartości reguł (tabele)" meta="baza, korekty, premie, kary, progi">
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
      </Disclosure>
    </>
  );
}

/** Poziomy oceny, czy profil należy do badanego podmiotu, wraz z korektą Wskaźnika Pewności. */
function IdentityLevels({ rules }: { rules: ScoreRules }) {
  const levels = sortedEntries(IDENTITY_SCORE);
  return (
    <section className="card">
      <div className="table-scroll">
        <table className="table rules-table">
          <caption>Ocena tożsamości profilu — czy profil należy do badanego podmiotu</caption>
          <thead>
            <tr>
              <th scope="col">Poziom</th>
              <th scope="col">Kiedy</th>
              <th scope="col" className="num">Pewność tożsamości</th>
              <th scope="col" className="num">Korekta wyniku adresu</th>
            </tr>
          </thead>
          <tbody>
            {levels.map(([level, score]) => (
              <tr key={level}>
                <th scope="row">
                  {IDENTITY_LABEL[level]} <code className="mono rule-id">{level}</code>
                </th>
                <td>{IDENTITY_DESCRIPTION[level]}</td>
                <td className="num">{score}%</td>
                <td className="num">{fmtDelta(rules.identityAdjustment[level] ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Pewność tożsamości pokazuje interfejs na kartach profili; gdy teczkę dostarcza usługa analizy, obowiązują wartości przez nią podane.
      </p>
    </section>
  );
}

const SECTION_TITLE: Record<string, string> = {
  priority: 'Jak powstaje priorytet sprawy',
  persons: 'Jak profile są łączone w osoby i skąd bierze się prawdopodobieństwo',
  services: 'Jak powstaje siła powiązania z usługą',
  relations: 'Jak oceniane są powiązania z innymi osobami',
  signals: 'Sygnały monitoringu: związek z Polską i sygnały do sprawdzenia',
  ai: 'Model językowy: co wolno mu zmienić',
  proof: 'Jak powstaje łączna pewność dowodu spieniężenia',
  analysis: 'Tryby analizy i limity',
  aliases: 'Powiązane tożsamości: kiedy powstaje hipoteza wspólnego operatora',
  pivot: 'Rozszerzanie poszukiwań: każdy profil jako punkt wyjścia',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asText = (value: unknown) => (typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''));

/** Jedna sekcja zasad: teksty jako akapity, słowniki wartości jako tabele. Treść tylko jako tekst. */
function RuleSection({ title, data }: { title: string; data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  const texts = entries.filter(([, value]) => typeof value === 'string');
  const scalars = entries.filter(([, value]) => typeof value === 'number' || typeof value === 'boolean');
  const groups = entries.filter(([, value]) => typeof value === 'object' && value !== null);
  return (
    <Disclosure title={title} className="rule-section">
      {texts.map(([key, value]) => (
        <p key={key} className={key === 'formula' ? 'mono formula' : undefined}>
          {asText(value)}
        </p>
      ))}
      <div className="rule-groups">
        {[...(scalars.length > 0 ? [['parametry', Object.fromEntries(scalars)] as [string, unknown]] : []), ...groups].map(([key, value]) => (
          <table key={key} className="table table-dense rules-table">
            <caption>
              <code className="mono">{key}</code>
            </caption>
            <tbody>
              {(isRecord(value) ? Object.entries(value) : (value as unknown[]).map((item, index): [string, unknown] => [String(index + 1), item])).map(
                ([name, item]) => (
                  <tr key={name}>
                    <th scope="row">
                      <code className="mono">{name}</code>
                    </th>
                    <td className={typeof item === 'number' ? 'num' : undefined}>{asText(item)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        ))}
      </div>
    </Disclosure>
  );
}

/** Zasady priorytetu, łączenia osób i powiązań z usługami — tak, jak podaje je usługa analizy. */
function PriorityRules({ data }: { data: unknown }) {
  if (!isRecord(data)) return null;
  const sections = Object.entries(data).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
  const flat = Object.fromEntries(Object.entries(data).filter(([, value]) => !isRecord(value)));
  return (
    <>
      {Object.keys(flat).length > 0 && <RuleSection title={SECTION_TITLE.priority!} data={flat} />}
      {sections.map(([key, value]) => (
        <RuleSection key={key} title={SECTION_TITLE[key] ?? key} data={value} />
      ))}
    </>
  );
}

export function RulesPage() {
  const rules = useAsync(() => api.getRules(), 'rules');
  const priority = useAsync(() => api.getPriorityRules(), 'priority-rules');
  const ai = useAsync(() => api.getAi(), 'ai');
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Pulpit', href: href.dashboard() }, { label: 'Zasady punktacji' }]} />
      <h1>Zasady punktacji</h1>
      <p className="lead">
        Wskaźnik Pewności liczą wyłącznie jawne reguły. Poniższe wartości są pobierane z konfiguracji usługi analizy.
      </p>
      {rules.loading && <Loading />}
      {rules.error && <ErrorBox message={rules.error} onRetry={rules.reload} />}
      {rules.data && (
        <>
          <Rules rules={rules.data} />
          <IdentityLevels rules={rules.data} />
        </>
      )}
      {ai.data && (
        <section className="card">
          <h2>Model językowy</h2>
          <p>
            Stan: <strong>{ai.data.enabled ? `włączony — ${ai.data.model ?? 'model nieznany'}${ai.data.provider ? ` (${ai.data.provider})` : ''}` : 'wyłączony'}</strong>
          </p>
          <p>{ai.data.description}</p>
          <p className="muted">
            Model niczego nie rozstrzyga: jego odczyty są sugestiami przy śladach, każdy wpływ na wynik jest zapisany w księdze reguł i można go cofnąć.
          </p>
          {ai.data.usage && (
            <dl className="meta">
              {Object.entries(ai.data.usage).map(([key, value]) => (
                <div key={key}>
                  <dt>
                    <code className="mono">{key}</code>
                  </dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}
      {priority.data !== undefined && (
        <section className="card rule-sections">
          <h2>Pozostałe zasady</h2>
          <p className="muted small">Priorytet sprawy, łączenie profili w osoby, siła powiązań z usługami i inne — tak, jak podaje je usługa analizy.</p>
          <PriorityRules data={priority.data} />
        </section>
      )}
    </div>
  );
}
