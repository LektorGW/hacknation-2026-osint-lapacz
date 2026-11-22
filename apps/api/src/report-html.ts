// Wspólne elementy dokumentów HTML: escapowanie, odnośniki, daty, trzy warstwy
// (fakt / obliczenie / wniosek) i arkusz stylów do druku. Wszystkie dane ze źródeł
// są niezaufane — każda wartość trafia do dokumentu wyłącznie przez `esc`.

export const NETWORK_LABEL: Record<string, string> = {
  bitcoin: 'Bitcoin',
  'bitcoin-testnet': 'Bitcoin (sieć testowa)',
  ethereum: 'Ethereum',
  tron: 'TRON',
  litecoin: 'Litecoin',
  solana: 'Solana',
};

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Odnośnik tylko dla adresów http(s) — inne schematy (np. `javascript:`) zostają zwykłym tekstem. */
export function link(url: string, text: string = url): string {
  if (!/^https?:\/\//i.test(url)) return esc(text);
  return `<a href="${esc(url)}" rel="noreferrer noopener">${esc(text)}</a>`;
}

export function dateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return esc(iso);
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}


// Trzy warstwy raportu — każda ma własną etykietę i kolor obramowania.
export const fact = (body: string) => layer('fakt', 'Fakt źródłowy', body);
export const calc = (body: string) => layer('obliczenie', 'Wynik obliczeń', body);
export const inference = (body: string) => layer('wniosek', 'Wniosek do weryfikacji', body);
/** Czwarta warstwa: dokument wprowadzony przez analityka (odpowiedź usługi) — nie pochodzi ze źródeł publicznych ani z obliczeń narzędzia. */
export const external = (body: string) => layer('dokument', 'Dokument spoza OSINT (odpowiedź usługi)', body);

function layer(kind: string, label: string, body: string): string {
  return `<div class="warstwa ${kind}"><span class="etykieta">${label}</span>${body}</div>`;
}

const LAYER_TAG = {
  fact: ['fakt', 'Fakt źródłowy'],
  calculation: ['obliczenie', 'Wynik obliczeń'],
  inference: ['wniosek', 'Wniosek do weryfikacji'],
} as const;

/** Krótki znacznik warstwy przy pojedynczym zdaniu lub wierszu tabeli. */
export function layerTag(kind: keyof typeof LAYER_TAG, text = ''): string {
  // Zdanie oparte na odpowiedzi usługi ma własny znacznik: to dokument spoza OSINT, nie fakt ze źródła publicznego.
  if (/dokument spoza OSINT/i.test(text)) return '<span class="znacznik dokument">Dokument spoza OSINT</span>';
  const [css, label] = LAYER_TAG[kind];
  return `<span class="znacznik ${css}">${label}</span>`;
}

export const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fff; max-width: 210mm; margin: 0 auto; padding: 12mm; line-height: 1.45; font-size: 11pt; }
  h1 { font-size: 20pt; margin: 0 0 2mm; }
  h2 { font-size: 15pt; margin: 9mm 0 3mm; border-bottom: 2px solid #1a1a1a; padding-bottom: 1mm; }
  h3 { font-size: 12.5pt; margin: 6mm 0 2mm; }
  h4 { font-size: 11pt; margin: 4mm 0 1.5mm; }
  p { margin: 0 0 2mm; }
  table { width: 100%; border-collapse: collapse; margin: 2mm 0; font-size: 9.5pt; }
  th, td { border: 1px solid #999; padding: 1.2mm 1.8mm; text-align: left; vertical-align: top; }
  th { background: #eee; }
  td.liczba, th.liczba { text-align: right; white-space: nowrap; }
  code, .mono { font-family: Consolas, 'Courier New', monospace; font-size: 9pt; overflow-wrap: anywhere; }
  blockquote { margin: 1.5mm 0; padding: 1.5mm 3mm; border-left: 3px solid #999; background: #f6f6f6; font-size: 9.5pt; overflow-wrap: anywhere; }
  a { color: #0b3d91; overflow-wrap: anywhere; }
  .meta { color: #444; font-size: 9.5pt; }
  .warstwa { border: 1px solid; border-left-width: 6px; padding: 2.5mm 3mm; margin: 3mm 0; break-inside: avoid-page; }
  .warstwa .etykieta { display: inline-block; font-family: Arial, sans-serif; font-size: 8pt; font-weight: bold; text-transform: uppercase; letter-spacing: .05em; color: #fff; padding: .5mm 2mm; margin-bottom: 1.5mm; }
  .fakt { border-color: #1b5e20; } .fakt .etykieta { background: #1b5e20; }
  .obliczenie { border-color: #0b3d91; border-style: dashed; border-left-style: solid; } .obliczenie .etykieta { background: #0b3d91; }
  .wniosek { border-color: #b45309; border-style: dotted; border-left-style: solid; } .wniosek .etykieta { background: #b45309; }
  .dokument { border-color: #6a1b9a; border-style: double; border-left-style: solid; } .dokument .etykieta { background: #6a1b9a; }
  .znacznik.dokument { background: #6a1b9a; }
  .adres { border: 2px solid #1a1a1a; padding: 3mm 4mm; margin: 6mm 0; }
  .adres.odrzucony { border-color: #888; }
  .wynik { font-family: Arial, sans-serif; font-size: 22pt; font-weight: bold; }
  .poziom { font-family: Arial, sans-serif; font-size: 11pt; font-weight: bold; text-transform: uppercase; }
  .zrodlo { border-top: 1px solid #ccc; padding-top: 2mm; margin-top: 2mm; }
  .ustalenia { border: 2px solid #1a1a1a; padding: 3mm 4mm; margin: 4mm 0; }
  .ustalenia li { margin-bottom: 1.5mm; }
  .znacznik { font-family: Arial, sans-serif; font-size: 7.5pt; font-weight: bold; text-transform: uppercase; color: #fff; padding: .3mm 1.5mm; margin-right: 1.5mm; white-space: nowrap; }
  .znacznik.fakt { background: #1b5e20; } .znacznik.obliczenie { background: #0b3d91; } .znacznik.wniosek { background: #b45309; }
  .priorytet { font-family: Arial, sans-serif; font-size: 16pt; font-weight: bold; }
  .zastrzezenie { border: 2px solid #1a1a1a; padding: 3mm 4mm; margin-top: 8mm; font-size: 10pt; }
  ul, ol { margin: 1mm 0 2mm; padding-left: 6mm; }
  @media print { body { padding: 0; max-width: none; } h2 { break-after: avoid; } a { color: inherit; } }
  @page { size: A4; margin: 15mm; }
`;
