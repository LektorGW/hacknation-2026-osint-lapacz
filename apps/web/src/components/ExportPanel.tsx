// Menu „Eksport danych”: jeden wiersz na plik z opisem prostym językiem i przyciskiem pobrania.
// Z usługą analizy pliki składa serwer (zwykłe łącza do pobrania); w trybie demo — przeglądarka,
// tym samym builderem (export.ts), z teczki przykładowej przekazanej w `demoDossier`.
import { useState } from 'react';
import { EXPORT_FILES, EXPORT_NOTICE, demoExportFile, exportUrl, isExportDossier } from '../export.ts';
import type { ExportFileName } from '../export.ts';
import '../export.css';

export interface ExportPanelProps {
  caseId: string;
  /** Teczka trybu demo — gdy jest podana, pliki powstają w przeglądarce (bez pakietu ZIP). */
  demoDossier?: unknown;
}

function saveFile(fileName: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportPanel({ caseId, demoDossier }: ExportPanelProps) {
  const demo = demoDossier !== undefined;
  const dossier = demo && isExportDossier(demoDossier) ? demoDossier : null;
  const [error, setError] = useState<string | null>(null);

  const downloadDemo = (name: ExportFileName) => {
    if (!dossier) return;
    try {
      const file = demoExportFile(dossier, name, new Date().toISOString());
      if (file) saveFile(file.fileName, file.content, file.type);
      setError(null);
    } catch (failure) {
      setError(`Nie udało się przygotować pliku: ${failure instanceof Error ? failure.message : 'nieznany błąd'}.`);
    }
  };

  return (
    <section className="export-panel" aria-labelledby="export-panel-title">
      <h3 id="export-panel-title" className="export-title">
        Eksport danych
      </h3>
      <p className="hint export-notice">{EXPORT_NOTICE}</p>
      <p className="hint">
        Tabele CSV otwierają się w Excelu dwuklikiem (separator „;”, polskie znaki, przecinek dziesiętny).
        {demo ? ' Tryb demo: pliki powstają w przeglądarce z danych przykładowych i mają w nazwie „DEMO”.' : ''}
      </p>
      {demo && !dossier ? <p className="error-box">Teczka trybu demo nie jest jeszcze gotowa — eksport będzie dostępny po jej wczytaniu.</p> : null}
      <ul className="export-list">
        {EXPORT_FILES.map((file) => {
          const unavailable = demo && (file.name === 'pakiet.zip' || !dossier);
          return (
            <li key={file.name} className="export-row">
              <div className="export-text">
                <span className="export-name">
                  {file.title} <code>{file.name}</code>
                </span>
                <span className="hint">{unavailable && file.name === 'pakiet.zip' ? 'Pakiet ZIP jest dostępny tylko z usługą analizy.' : file.description}</span>
              </div>
              {demo ? (
                <button type="button" className="button button-small" disabled={unavailable} onClick={() => downloadDemo(file.name)} aria-label={`Pobierz ${file.title}`}>
                  Pobierz
                </button>
              ) : (
                <a className="button button-small" href={exportUrl(caseId, file.name)} download aria-label={`Pobierz ${file.title}`}>
                  Pobierz
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="error-box" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
