import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { Identifier, IdentifierType } from '@olcys/core';
import { api, errorMessage } from '../api.ts';
import type { CaseSummary } from '../api.ts';
import { IDENTIFIER_LABEL, IDENTIFIER_TYPES } from '../labels.ts';

interface Row extends Identifier {
  key: number;
}

/** Formularz nowej sprawy: nazwa i dowolna liczba identyfikatorów (co najmniej jeden). */
export function CaseForm({ onCreated }: { onCreated: (created: CaseSummary) => void }) {
  const formId = useId();
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Row[]>([{ key: 0, type: 'full_name', value: '' }]);
  const [nextKey, setNextKey] = useState(1);
  const [problems, setProblems] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const updateRow = (key: number, change: Partial<Identifier>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  function addRow() {
    setRows((current) => [...current, { key: nextKey, type: 'nick', value: '' }]);
    setNextKey((value) => value + 1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const identifiers = rows
      .map(({ type, value }) => ({ type, value: value.trim() }))
      .filter((identifier) => identifier.value !== '');
    const found: string[] = [];
    if (name.trim() === '') found.push('Podaj nazwę sprawy.');
    if (identifiers.length === 0) found.push('Podaj co najmniej jeden identyfikator z wypełnioną wartością.');
    setProblems(found);
    if (found.length > 0) return;

    setSubmitting(true);
    try {
      onCreated(await api.createCase(name.trim(), identifiers));
    } catch (error) {
      setProblems([errorMessage(error)]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit} noValidate aria-labelledby={`${formId}-title`}>
      <h2 id={`${formId}-title`}>Nowa sprawa</h2>

      <label className="field" htmlFor={`${formId}-name`}>
        <span className="field-label">Nazwa sprawy</span>
        <input
          id={`${formId}-name`}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          required
        />
      </label>

      <fieldset className="identifiers">
        <legend>Identyfikatory podmiotu</legend>
        <p className="hint">Każdy identyfikator to osobny punkt startowy wyszukiwania w źródłach publicznych.</p>
        {rows.map((row, index) => (
          <div key={row.key} className="identifier-row">
            <label className="field">
              <span className="field-label">Typ {index + 1}</span>
              <select
                value={row.type}
                onChange={(event) => updateRow(row.key, { type: event.target.value as IdentifierType })}
              >
                {IDENTIFIER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {IDENTIFIER_LABEL[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-grow">
              <span className="field-label">Wartość {index + 1}</span>
              <input
                type="text"
                value={row.value}
                onChange={(event) => updateRow(row.key, { value: event.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="button"
              onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
              disabled={rows.length === 1}
              aria-label={`Usuń identyfikator ${index + 1}`}
            >
              Usuń
            </button>
          </div>
        ))}
        <button type="button" className="button" onClick={addRow}>
          + Dodaj identyfikator
        </button>
      </fieldset>

      {problems.length > 0 && (
        <div className="error-box" role="alert">
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <button type="submit" className="button button-primary" disabled={submitting}>
        {submitting ? 'Tworzenie…' : 'Utwórz sprawę'}
      </button>
    </form>
  );
}
