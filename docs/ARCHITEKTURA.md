# Architektura OŁCyŚ

Monorepo pnpm, Node 24 (TypeScript uruchamiany natywnie, bez kroku budowania po stronie serwera).

## Moduły

| Katalog | Rola |
|---|---|
| `packages/core` | Kontrakty (`src/types.ts`), wykrywanie i walidacja adresów, Wskaźnik Pewności |
| `packages/sources` | Łączniki do publicznych źródeł Web2 (`SourceConnector`) |
| `packages/chain` | Dane blockchain: klasyfikacja adresów, przepływy, wskaźniki wyjścia do walut tradycyjnych (`ChainProvider`) |
| `apps/sandbox` | Syntetyczne środowisko demonstracyjne: fikcyjne serwisy i fikcyjny eksplorator bloków |
| `apps/api` | Przebieg analizy, zapis wyników i dowodów, porównywanie analiz, raport |
| `apps/web` | Interfejs analityka (React) |

Porty: sandbox 4100, API 4000, web 5173 (proxy `/api` → 4000).

## Przepływ analizy

1. Analityk podaje identyfikatory podmiotu (`SubjectQuery`).
2. Łączniki przeszukują źródła i zwracają `SourceDocument[]`. Identyfikatory odkryte w dokumentach (`discoveredIdentifiers`) uruchamiają jedną dodatkową rundę wyszukiwania.
3. `extractAddresses` wyciąga adresy z treści; każdy dokument z adresem staje się śladem (`StoredEvidence`) ze skrótem SHA-256 treści.
4. `ChainProvider` zwraca profil adresu, przepływy i wskaźniki wypłat (`ChainActivity`).
5. `computeConfidence` liczy Wskaźnik Pewności z księgą reguł.
6. Wynik (`AnalysisRun`) jest zapisywany; kolejne analizy tego samego podmiotu można porównać (`RunDiff`).

## Kontrakty między modułami

### `@olcys/sources`
```ts
createConnectors(config: { sandboxUrl?: string; enableLive?: boolean; torProxyUrl?: string }): SourceConnector[]
htmlToText(html: string): string
```

### `@olcys/chain`
```ts
createChainProviders(config: { sandboxUrl?: string; enableLive?: boolean }): ChainProvider[]
```

### Fikcyjny eksplorator w `apps/sandbox`
`GET {sandboxUrl}/explorer/api/address/:address` → 200:
```json
{
  "address": "…", "network": "bitcoin", "isContract": false,
  "label": "Kraken: Hot Wallet", "addressClass": "exchange",
  "transfers": [
    { "txid": "…", "time": "2025-03-14T10:22:00Z", "direction": "out",
      "counterparty": "…", "asset": "BTC", "amount": 0.42 }
  ]
}
```
`label` i `addressClass` są opcjonalne. Nieznany adres → 404.

### API (`apps/api`)
| Metoda i ścieżka | Wynik |
|---|---|
| `GET /api/connectors` | `{ id, service, label, description, accepts, enabledByDefault }[]` |
| `GET /api/rules` | `ScoreRules` |
| `GET /api/cases` | `CaseSummary[]` |
| `POST /api/cases` `{ name, identifiers }` | `CaseSummary` |
| `GET /api/cases/:id` | `CaseSummary` |
| `POST /api/cases/:id/runs` `{ connectors?: string[] }` | `AnalysisRun` (po zakończeniu analizy) |
| `GET /api/runs/:id` | `AnalysisRun` |
| `GET /api/cases/:id/diff?from=&to=` | `RunDiff` |
| `GET /api/runs/:id/report.html` | raport do druku |
| `GET /api/runs/:id/report.json` | pakiet do odtworzenia analizy |

```ts
interface CaseSummary {
  id: string; name: string; createdAt: string; query: SubjectQuery;
  runs: { id: string; startedAt: string; status: string; findingCount: number; topScore: number }[];
}
```

## Zasady
- Wyłącznie publiczne źródła; bez logowania, obchodzenia zabezpieczeń i skanowania.
- Dane analizy nie trafiają do żadnej usługi poza odpytywanym źródłem publicznym.
- Wynik liczą jawne reguły; model językowy może najwyżej wspierać i musi być wymienialny w konfiguracji.

## Teczka podmiotu, decyzje analityka i typowanie (etap 2)

Typy: `Dossier`, `ProfileCard`, `RelatedPerson`, `GraphNode`, `GraphEdge`, `TimelineEvent`, `AnalystDecision`, `Lead`, `Sweep`, `ProfileAttributes`, `DiscoveringConnector` w `packages/core/src/types.ts`.

| Metoda i ścieżka | Wynik |
|---|---|
| `GET /api/runs/:id/dossier` | `Dossier` — cały obraz podmiotu dla jednego ekranu |
| `GET /api/cases/:id/dossier` | `Dossier` ostatniej zakończonej analizy sprawy |
| `GET /api/cases/:id/decisions` | `AnalystDecision[]` |
| `POST /api/cases/:id/decisions` `{ target, key, decision, note? }` | `AnalystDecision`; kolejne pobranie teczki uwzględnia decyzję |
| `DELETE /api/cases/:id/decisions/:decisionId` | 204 |
| `POST /api/cases/:id/identifiers` `{ identifiers }` | `CaseSummary` — dopisanie identyfikatorów (np. odkrytych) do sprawy |
| `GET /api/overview` | `{ cases: number; runs: number; linkedAddresses: number; cashOutPlnByYear: Record<string, number>; topCases: { caseId, name, priority, topScore, cashOutPlnTotal }[] }` |
| `POST /api/sweeps` `{ connectors?: string[]; limit?: number }` | `Sweep` po zakończeniu przeglądu |
| `GET /api/sweeps` | `Sweep[]` (bez dzienników) |
| `GET /api/sweeps/:id` | `Sweep` |
| `POST /api/sweeps/:id/leads/:leadId/case` | `CaseSummary` — sprawa założona z wytypowanego podmiotu |

Zasady:
- Decyzja `rejected` dla profilu usuwa jego ślady z oceny adresów; `confirmed` podnosi tożsamość profilu do `verified_link`. Decyzja dla adresu: `rejected` wyklucza adres, `confirmed` jest tylko odnotowana. Każda decyzja zostaje w rejestrze z czasem i notatką.
- Priorytet (0–100) łączy Wskaźnik Pewności najlepszego adresu ze skalą szacowanych wypłat w PLN i ich aktualnością; `priorityReasons` wyjaśnia składniki.
- Powiązane osoby są wskazówką do weryfikacji, nigdy ustaleniem.
