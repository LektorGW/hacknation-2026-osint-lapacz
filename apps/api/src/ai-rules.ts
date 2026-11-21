// Reguły wykorzystania modelu językowego — JEDYNE miejsce, w którym odczyt modelu
// przekłada się na wynik. Model jest opcjonalny i tylko sugeruje; o wyniku decydują
// jawne reguły poniżej, a każdy wpływ modelu jest widoczny (wpis w księdze z cytatem)
// i może zostać cofnięty decyzją analityka.

import type { AiAssistant, StoredEvidence, TextInsight } from '@olcys/core';

/** Ślad z odczytem publikacji przez model (lokalne rozszerzenie kontraktu). */
export type InsightEvidence = StoredEvidence & { insight?: TextInsight };

export const AI_RULES = {
  /** Najwyżej tyle śladów jednej analizy czyta model (najpierw najmocniejsze). */
  maxPublicationsPerAnalysis: 40,
  /** Najwyżej tyle trafień jednego przebiegu monitoringu czyta model (najwyżej oceniane najpierw). */
  maxPublicationsPerMonitorRun: 60,
  concurrency: 4,
  /** Odczyty, po których ślad nie liczy się do Wskaźnika Pewności. */
  excludingOwnership: ['third_party_address', 'warning_about_address', 'quoted'] as TextInsight['ownership'][],
  /** Porównanie stylu autorów tylko dla wiązań „możliwych, ale niepotwierdzonych”. */
  authorComparison: { minTieWeight: 20, maxTieWeight: 49, maxBonus: 10 },
  rules: [
    'own_address — przesłanka potwierdzająca przy śladzie, bez zmiany punktów.',
    'third_party_address / warning_about_address / quoted — ślad przeniesiony do niewliczonych, z wpisem „ai.ownership” w księdze (cytat, model, wersja polecenia); tylko gdy cytat został zweryfikowany w treści (niepusty).',
    'suggestedCategory inna niż kategoria źródła — wyłącznie adnotacja, bez zmiany punktów.',
    'Decyzja analityka „potwierdzony” dla śladu lub jego profilu cofa wpływ modelu.',
    'Monitoring: związek z Polską = większa z ocen (reguły, model) z przesłankami obu; oferta odczytana przez model uzupełnia sygnały obrotu z oznaczeniem „model”.',
    'Porównanie autorów: dodatkowa słaba przesłanka (najwyżej +10 do wagi wiązania 20–49), nigdy sama nie łączy profili.',
    'Streszczenie teczki powstaje wyłącznie z gotowych kluczowych ustaleń i jest oznaczone jako wygenerowane przez model.',
  ],
} as const;

const OWNERSHIP_LABEL: Record<TextInsight['ownership'], string> = {
  own_address: 'autor podaje adres jako własny',
  third_party_address: 'adres należy do kogoś innego niż autor',
  warning_about_address: 'autor ostrzega przed tym adresem',
  quoted: 'adres jest tylko cytowany',
  unclear: 'z treści nie wynika, czyj jest adres',
};

export interface InsightEffect {
  /** `excludes`: ślad nie liczy się do wyniku; `confirms`: przesłanka potwierdzająca; `none`: bez wpływu. */
  effect: 'excludes' | 'confirms' | 'none';
  /** Opis dla analityka, z cytatem i nazwą modelu. */
  note: string;
  /** Adnotacja o innej kategorii sugerowanej przez model. */
  categoryNote?: string;
}

/** Wpływ odczytu modelu na ślad według reguł; `undefined`, gdy ślad nie ma odczytu. */
export function insightEffect(evidence: InsightEvidence): InsightEffect | undefined {
  const { insight } = evidence;
  if (!insight) return undefined;
  const source = `model ${insight.model}, wersja polecenia ${insight.promptVersion}`;
  const quote = insight.quote.trim();
  const cited = quote ? ` Cytat: „${quote}”.` : '';
  const categoryNote =
    insight.suggestedCategory && insight.suggestedCategory !== evidence.category
      ? `Model sugeruje inną kategorię publikacji (${insight.suggestedCategory}) niż źródło (${evidence.category}) — bez wpływu na punkty.`
      : undefined;
  const label = OWNERSHIP_LABEL[insight.ownership];
  if (AI_RULES.excludingOwnership.includes(insight.ownership)) {
    // Bez zweryfikowanego cytatu odczyt nie może zmienić wyniku.
    return quote
      ? { effect: 'excludes', note: `Odczyt modelu: ${label} — ślad nie jest wliczany.${cited} (${source})`, categoryNote }
      : { effect: 'none', note: `Odczyt modelu: ${label}, ale bez zweryfikowanego cytatu — bez wpływu na wynik. (${source})`, categoryNote };
  }
  if (insight.ownership === 'own_address') {
    return { effect: 'confirms', note: `Odczyt modelu: ${label} — przesłanka potwierdzająca, bez zmiany punktów.${cited} (${source})`, categoryNote };
  }
  return { effect: 'none', note: `Odczyt modelu: ${label}. (${source})`, categoryNote };
}

/**
 * Zastępuje dane osobowe i adresy znacznikami przed wysłaniem faktów do modelu działającego
 * poza tą maszyną; `restore` podstawia je z powrotem w odpowiedzi. `terms`: znane nazwiska,
 * nazwy kont, e-maile, telefony i adresy sprawy (najdłuższe zastępowane najpierw).
 */
export function anonymizeFacts(facts: string[], terms: { kind: 'OSOBA' | 'NICK' | 'EMAIL' | 'TELEFON' | 'ADRES'; value: string }[]): { facts: string[]; restore: (text: string) => string } {
  const map = new Map<string, string>();
  const counters: Record<string, number> = {};
  const marker = (kind: string, value: string): string => {
    const key = value.toLowerCase();
    let found = map.get(key);
    if (!found) {
      counters[kind] = (counters[kind] ?? 0) + 1;
      found = `[${kind}-${counters[kind]}]`;
      map.set(key, found);
    }
    return found;
  };
  const known = terms.filter((term) => term.value.trim().length >= 3).sort((a, b) => b.value.length - a.value.length);
  const originals = new Map<string, string>();
  const replace = (text: string): string => {
    let result = text;
    for (const term of known) {
      const value = term.value.trim();
      const token = marker(term.kind, value);
      originals.set(token, value);
      result = result.split(value).join(token);
    }
    // Pozostałe e-maile i adresy (pełne lub skrócone „początek…koniec”) — także spoza listy.
    return result
      .replace(/[^\s@„”"()]+@[^\s@„”"()]+\.[a-z]{2,}/gi, (value) => (originals.set(marker('EMAIL', value), value), marker('EMAIL', value)))
      .replace(/\b(?:0x[0-9a-fA-F]{8,}|[13T][1-9A-HJ-NP-Za-km-z]{9,}|bc1[0-9a-z]{7,})(?:…[0-9A-Za-z]{4,})?/g, (value) => (originals.set(marker('ADRES', value), value), marker('ADRES', value)));
  };
  return {
    facts: facts.map(replace),
    restore: (text) => text.replace(/\[(?:OSOBA|NICK|EMAIL|TELEFON|ADRES)-\d+\]/g, (token) => originals.get(token) ?? token),
  };
}

export interface AiUsage {
  analyzePublication: number;
  summarize: number;
  compareAuthors: number;
  errors: number;
}

/** Asystent z licznikiem wywołań; błąd modelu nigdy nie przerywa analizy — zwracany jest brak odczytu. */
export function trackAi(assistant: AiAssistant): { assistant: AiAssistant; usage: AiUsage } {
  const usage: AiUsage = { analyzePublication: 0, summarize: 0, compareAuthors: 0, errors: 0 };
  const guard = async <T>(kind: keyof Omit<AiUsage, 'errors'>, call: () => Promise<T | null>): Promise<T | null> => {
    usage[kind]++;
    try {
      return await call();
    } catch {
      usage.errors++;
      return null;
    }
  };
  return {
    usage,
    assistant: {
      id: assistant.id,
      model: assistant.model,
      description: assistant.description,
      analyzePublication: (input) => guard('analyzePublication', () => assistant.analyzePublication(input)),
      summarize: (facts) => guard('summarize', () => assistant.summarize(facts)),
      compareAuthors: (a, b) => guard('compareAuthors', () => assistant.compareAuthors(a, b)),
    },
  };
}
