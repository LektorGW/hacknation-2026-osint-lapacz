# Architektura OŁCyŚ

Stan na 21.11.2026. Monorepo pnpm (`packages/*`, `apps/*`), Node 24 — TypeScript uruchamiany natywnie, bez kroku budowania po stronie serwera. Interfejs buduje Vite.

Szczegóły poszczególnych modułów są w ich własnych plikach README; ten dokument opisuje podział, kontrakty i przepływ danych.

## Moduły

| Katalog | Pakiet | Rola | Zależności zewnętrzne |
|---|---|---|---|
| `packages/core` | `@olcys/core` | Kontrakty (`src/types.ts`), wykrywanie i walidacja adresów (`src/addresses.ts`), Wskaźnik Pewności (`src/score.ts`) | `@noble/hashes` |
| `packages/sources` | `@olcys/sources` | Łączniki do publicznych źródeł Web2 (`SourceConnector`), rejestr źródeł monitoringu, głębokie wyszukiwanie, normalizacja zapisu adresów | `undici` |
| `packages/chain` | `@olcys/chain` | Dane blockchain (`ChainProvider`): klasyfikacja adresów, wskaźniki wypłat, ścieżki środków, klaster portfela, powiązane adresy, zajęcia, pochodzenie środków, sieci EVM, wycena w PLN | — |
| `packages/ai` | `@olcys/ai` | Pomocniczy model językowy (`AiAssistant`): dostawcy `openai-compatible` i `anthropic`, weryfikacja odpowiedzi | — |
| `apps/api` | `@olcys/api` | Przebieg analizy, teczka podmiotu, monitoring, typowanie, zapis wyników i dowodów, raporty | `fastify`, `@fastify/cors`, `@electric-sql/pglite`, `pg` |
| `apps/web` | `@olcys/web` | Interfejs analityka (React 19, Vite 7) | `react`, `react-dom` |
| `apps/sandbox` | `@olcys/sandbox` | Syntetyczne środowisko demonstracyjne: fikcyjne serwisy i fikcyjny eksplorator bloków | `fastify` |
| `apps/identity-lab` | `synthetic-identity-lab` | Niezależne laboratorium: 27 syntetycznych portali i testowy łańcuch UTXO (czysty Node, bez zależności) | — |
| `scripts/` | — | `benchmark-lab.ts` — pomiar narzędzia na laboratorium tożsamości | — |

Porty domyślne: piaskownica 4100, API 4000 (nasłuch na `127.0.0.1`), interfejs 5173 (Vite, proxy `/api` → `http://localhost:4000`), laboratorium tożsamości 8787 (panel) i 8801–8827 (portale).

Moduły komunikują się wyłącznie przez typy z `@olcys/core`. `apps/api/src/server.ts` jest jedynym miejscem, w którym podłączane są prawdziwe łączniki i dostawcy; `buildApp` (`app.ts`) dostaje je przez parametry (`AppDeps`), dzięki czemu testy używają atrap i `app.inject`.

## Kontrakty między modułami

### `@olcys/core`

- `extractAddresses(text)`, `validateAddress(text)` — kandydatów znajdują wyrażenia regularne, o przyjęciu decyduje suma kontrolna. Typ `Network`: `bitcoin`, `bitcoin-testnet`, `ethereum`, `tron` oraz `lab` — sieć laboratoryjna `apps/identity-lab` (adresy `lab1` + 40 znaków szesnastkowych, bez sumy kontrolnej i bez wartości pieniężnej).
- `computeConfidence(input, rules = DEFAULT_RULES)` → `ScoreResult` z księgą reguł (`ledger`).
- Typy: `Identifier`, `SubjectQuery`, `SourceDocument`, `SourceConnector`, `DiscoveringConnector`, `ChainProvider`, `ChainActivity`, `Finding`, `AnalysisRun`, `RunDiff`, `Dossier`, `WatchHit`, `MonitorStatus`, `Lead`, `Sweep`, `CashOutTrail`, `AddressCluster`, `TextInsight`, `AiAssistant`.

Typy identyfikatorów (`IdentifierType`): `full_name`, `nick`, `login`, `email`, `messenger_id`, `crypto_address`, `profile_url`, `ens_name`.

### `@olcys/sources`

```ts
createConnectors(config: SourcesConfig): SourceConnector[]
listMonitorConnectors(connectors): SourceConnector[]   // tylko łączniki mon-*
loadMonitorSources(), mergeMonitorSources(), runMonitorPass(), summarizeMonitorSources()
htmlToText(html), normalizeAddressText(text), addressFromHref(href), findEnsNames(text)
```

`SourcesConfig` (najważniejsze pola): `sandboxUrl` (łączniki `sandbox-*`), `labUrl` (łączniki `lab-*` do laboratorium tożsamości), `enableLive` (łączniki `live-*`, `deep-search`, `mon-*`), `torProxyUrl` (łącznik `tor-onion`), `githubToken`, `fediverseInstances`, `telegramChannels`, `monitorSources`, `deepSearch`. Pełna lista łączników: `packages/sources/README.md`.

### `@olcys/chain`

```ts
createChainProviders(config: ChainConfig): ChainProvider[]
getActivityFromProviders(providers, network, address, context): Promise<ChainActivity>
matchService(label), loadLabelFile(path), classify(network, address, hints), detectCashOuts(transfers, options)
```

`ChainConfig` (najważniejsze pola): `sandboxUrl`, `labUrl`, `enableLive`, `depth: 'standard' | 'deep'`, `blockscoutApiKey`, `blockscoutKeyScope`, `requestBudget`, `externalLabels`, `evmNetworks`, `maxExtraNetworks`, `findLinks`, `linkBudget`, `fundingBudget`. Kolejność dostawców: laboratorium (tylko sieć `lab`), piaskownica, potem publiczne API (Esplora ×2 dla Bitcoina, Blockscout dla Ethereum i innych sieci EVM, TronGrid/TronScan dla Tron).

Wynik `ChainActivity` ma, poza polami kontraktu core (`profile`, `transfers`, `cashOuts`, `cashOutPlnByYear`, `limitations`, `trails`, `cluster`), pola dodatkowe czytane przez API dynamicznie: `linkedAddresses`, `networks`, `balances`, `seizures`, `fundingSources`, `openQuestions`. Opis: `packages/chain/README.md`.

### `@olcys/ai`

```ts
aiConfigFromEnv(env): AiConfig | null      // null = moduł wyłączony
createAiAssistant(config): AiAssistant | null
```

`AiAssistant`: `analyzePublication`, `summarize`, `compareAuthors`. Każda metoda zwraca `null`, gdy model zawiedzie albo odpowiedź nie przejdzie weryfikacji.

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

`label` i `addressClass` są opcjonalne. Nieznany adres → 404. Ponad ten kontrakt: adres usługi może mieć pole `kind` (`p2p_service`, `payment_gateway`, `crypto_card`, `stablecoin_swap`), a przelew — `counterpartyLabel`, `counterpartyClass`, `counterpartyKind`. Serwisy piaskownicy mają `GET /<serwis>/api/search?q=` i `GET /<serwis>/api/recent?limit=` (opis: `apps/sandbox/README.md`).

## Przepływ analizy

Kod: `apps/api/src/analysis.ts` (`runAnalysis`), `runs.ts` (tryby, przebieg w tle, postęp), `dossier.ts` (teczka).

1. **Identyfikator.** Analityk podaje identyfikatory (`SubjectQuery`) albo jedną wartość w `POST /api/quick` — jej rodzaj rozpoznaje `detectIdentifierType` (e-mail, adres profilu, adres kryptowalutowy, nazwa `.eth`, imię i nazwisko, w pozostałych przypadkach nick). Adres kryptowalutowy musi przejść `validateAddress`.
2. **Łączniki.** Odpytywane są łączniki domyślnie włączone oraz indeks własny (`corpus` — publikacje zebrane przez monitoring); w trybie głębokim dodatkowo `deep-search`. Każdy łącznik zwraca `SourceDocument[]`. Identyfikatory odkryte w dokumentach (`discoveredIdentifiers`) uruchamiają kolejne kroki wyszukiwania: 3 w trybie standardowym, 4 w głębokim; najwyżej 40 identyfikatorów w analizie.
3. **Wykrywanie adresów.** Treść przechodzi przez `normalizeAddressText` (adresy rozbite odstępami, adresy z odnośników), potem `extractAddresses`. Każdy dokument z adresem staje się śladem (`StoredEvidence`) ze skrótem SHA-256 treści; kopia treści jest zapisywana (`documents`).
4. **Wystąpienia adresu u innych autorów.** Wyszukiwanie po samym adresie liczy niepowiązanych publikujących (`unrelatedPublishers`). Adres cytowany przez co najmniej 10 autorów jest uznawany za powszechnie cytowany i nikomu nieprzypisywany; publikacja z co najmniej 10 adresami jest traktowana jako zestawienie.
5. **Ocena tożsamości i Wskaźnik Pewności.** `identity.ts` ocenia, czy profil należy do podmiotu (`IdentityMatch`); `computeConfidence` liczy wynik adresu z księgą reguł. `persons.ts` łączy profile w kandydatów na osobę (`PersonCandidate`) i liczy prawdopodobieństwo osoba–adres.
6. **Blockchain.** Najwyżej 15 adresów (40 w trybie głębokim) dostaje analizę `ChainProvider`: profil i klasę adresu, przelewy, wskaźniki wypłat (`cashOuts`), ścieżki środków do usług wymiany (`trails`), klaster portfela, zajęcia przez organy państwa (`seizures`), pochodzenie środków (`fundingSources`), powiązane adresy (`linkedAddresses`). Największych kontrahentów bez etykiety (do 10) sprawdza się dodatkowo w źródłach.
7. **Pętla rozszerzania** (`pivot.ts`). Każdy profil i adres podmiotu jest punktem wyjścia do szukania innych tożsamości: po wspólnym e-mailu, telefonie, stronie oraz po adresach powiązanych wskazanych przez moduł blockchain (siła co najmniej 50). Limity: 2 kroki × 12 zapytań (standard), 4 × 20 (głęboki). Tropy ocenia `aliases.ts`; do teczki trafiają tożsamości z wynikiem co najmniej 50 (`linkedIdentities`), słabsze są tylko policzone (`weakLeadsHidden`).
8. **Model językowy** (opcjonalnie). Czyta najwyżej 40 śladów analizy i porównuje styl autorów; wpływ na wynik określają wyłącznie reguły z `ai-rules.ts`.
9. **Zapis.** `AnalysisRun` trafia do tabeli `runs`, kopie treści do `documents`, a razem z analizą materiał pomocniczy (`RunIntel`: widziane profile, ścieżka odkrywania, wzmianki, czasy faz).
10. **Teczka i raport.** `buildDossier` składa teczkę z zapisanej analizy i decyzji analityka, bez ponownego odpytywania źródeł. Z teczki powstają raport HTML, pakiet JSON i materiał do zapytania do usługi.

Etapy raportowane w postępie (`GET /api/runs/:id/progress`): `search`, `occurrences`, `chain`, `counterparties`, `pivot`, `ai`, `scoring`, następnie `saving` i `done` albo `failed`.

### Tryby analizy (`DEPTH_LIMITS` w `runs.ts`)

| | standardowy | głęboki |
|---|---|---|
| kroki odkrywania identyfikatorów | 3 | 4 |
| adresy z analizą blockchain | 15 | 40 |
| limit czasu zapytania / całej analizy | 20 s / 120 s | 45 s / 240 s |
| współbieżność zapytań | 6 | 24 |
| pętla rozszerzania | 2 kroki × 12 zapytań | 4 kroki × 20 zapytań |
| dodatkowe źródła | — | `deep-search` (limit czasu łącznika 30 s) |

Po przekroczeniu limitu czasu analiza kończy się wynikiem częściowym (`partial: true` w teczce), nie błędem. Opcjonalny okres analizy (`period: { from, to }`) zawęża historię blockchain.

## Wskaźnik Pewności i pozostałe oceny

Wszystkie oceny wynikają z jawnych reguł; wartości zwraca API (`GET /api/rules`, `GET /api/priority-rules`) i pokazuje strona „Zasady punktacji” w interfejsie.

**Wskaźnik Pewności adresu** (`packages/core/src/score.ts`, `DEFAULT_RULES`):

1. Adres klasy `exchange`, `smart_contract`, `charity`, `mixer` lub `institutional` → wykluczenie, 0%.
2. Punkt wyjścia: najmocniejszy ślad według kategorii źródła — `cryptographic_proof` 95, `own_profile` 85, `sale_offer` 70, `settlement_message` 65, `forum_post` 50, `mass_comment` 25.
3. Korekta za tożsamość profilu: `verified_link` 0, `exact_identifier` 0, `linked_profile` −5, `same_handle` −10, `common_handle` −20, `name_only` −20.
4. Synergia: drugie niezależne źródło (inna usługa) +15; każde kolejne +5, łącznie najwyżej +10.
5. Kara −30, gdy ten sam adres publikują co najmniej 3 niepowiązane tożsamości.
6. Wynik przycinany do 0–100; progi: 80 bardzo wysokie prawdopodobieństwo, 60 prawdopodobne, 40 średnie, 10 niskie / szum, 0 wykluczone.

**Pozostałe oceny** (pola odpowiedzi `GET /api/priority-rules`):

| Pole | Co liczy | Kod |
|---|---|---|
| `persons` | łączenie profili w osoby (próg wiązania 50) i prawdopodobieństwo kandydata oraz osoba–adres | `persons.ts` |
| `aliases` | powiązane tożsamości: „prawdopodobnie ta sama osoba” 85–97, „możliwe: ta sama albo bliska” 55–75, „powiązana” 30–45; próg pokazania 50 | `aliases.ts` |
| `proof` | dowód spieniężenia: łączna pewność = P(osoba–adres) × P(ścieżka) / 100; adres z klastra portfela × 0,8 | `proof.ts` |
| `priority` | priorytet sprawy = 0,35·P + 0,30·S + 0,15·U + 0,10·A + 0,10·Z (+10 za związek z incydentem) | `priority.ts` |
| `services` | siła powiązania z usługą | `services.ts`, `data/services.json` |
| `relations` | siła powiązania z inną osobą | `relations.ts` |
| `signals` | sygnały monitoringu: związek z Polską i sygnały obrotu | `signals.ts`, `data/signals.json` |
| `ai` | reguły wykorzystania modelu językowego | `ai-rules.ts` |
| `pivot`, `analysis` | limity pętli rozszerzania i trybów analizy | `pivot.ts`, `runs.ts` |

Pewność ścieżki środków (`trailConfidence`) i siła powiązań adresów (`LINK_STRENGTH`) liczone są w `@olcys/chain`; wzory w `packages/chain/README.md`.

## Monitoring źródeł

Kod: `apps/api/src/monitor.ts`, `monitor-rules.ts`, `signals.ts`; rejestr: `packages/sources/config/monitor-sources/*.json`.

- **Rejestr źródeł.** Sześć plików (`core.json`, `discourse.json`, `feeds-forums.json`, `polska.json`, `reddit.json`, `telegram-fediverse.json`); każdy wpis wskazuje silnik (`rss`, `discourse`, `reddit`, `mastodon-tag`, `telegram`, `stackexchange`, `hn`, `lemmy`, `smf-board`, `html-list`, `github-search`) i daje łącznik `mon-<id>` z metodą `discover`. Stan z próby 21.11.2026 (`STATUS.md`): 992 wpisy, 843 włączone, 609 odrębnych hostów; wszystkie 77 wpisów Reddita wyłączone. Rejestr powstaje tylko przy `ENABLE_LIVE`; źródła piaskownicy (`sandbox-*`) są dołączane do monitoringu zawsze.
- **Przebieg.** Domyślnie wyłączony; po włączeniu co 30 minut (ustawiane, 1–10080). Do 6 źródeł naraz, do 100 publikacji na źródło. Publikacja raz przejrzana nie jest oceniana ponownie (`monitor_seen`). Błąd źródła trafia do jego statusu i nie przerywa pozostałych. Naraz działa najwyżej jeden przebieg; ustawienia są trwałe (`monitor_config`).
- **Indeks publikacji** (`corpus`). Pobrane publikacje są zapisywane z wykrytymi adresami i służą analizie jako źródło `corpus`. Przechowywanie: domyślnie 30 dni i 200 000 wierszy (`CORPUS_RETENTION_DAYS`, `CORPUS_MAX_ROWS`).
- **Definicja trafienia** (`decideHit`). Trafieniem jest publikacja spełniająca jeden z warunków:
  - `own_address` — zawiera adres, który autor podaje jako własny (odczyt modelu albo, bez modelu, reguły); niezależnie od kraju;
  - `offer_poland` — oferta kupna, sprzedaży lub wymiany kryptowaluty ze związkiem z Polską od progu 40/100; nie dotyczy kanałów wiadomości i artykułów;
  - `address_poland` — adres i związek z Polską od progu; nie dotyczy forów zarządzania protokołami.

  Sama publikacja z adresem trafieniem nie jest. Adresy rozpoznane jako kontrakty są pomijane (do 60 sprawdzeń na przebieg), a publikacja z co najmniej 10 adresami jest zestawieniem. Jedno trafienie na autora w serwisie.
- **Limity** (`data/signals.json` → `thresholds`, zmieniane przez `PUT /api/monitor`): próg automatycznej analizy autora — suma ocen 100; najwyżej 25 automatycznych analiz i 120 publikacji czytanych przez model na przebieg.
- **Przeliczenie** (`POST /api/monitor/recheck`): zapisane trafienia są oceniane bieżącymi regułami, a niespełniające kryteriów — oznaczane jako odrzucone z powodem.

**Typowanie** (`sweep.ts`, `POST /api/sweeps`) to jednorazowy przegląd świeżych publikacji źródeł z metodą `discover`, zakończony rankingiem wskazań (`Lead`) z priorytetem; ze wskazania można założyć sprawę bez ponownej analizy.

## API (`apps/api`)

Trasy z `app.ts`, `dossier-routes.ts`, `monitor-routes.ts`, `sweep-routes.ts` i `server.ts`. Błędy mają postać `{ error: string }` (400 dla błędnych danych, 404 dla nieznanego zasobu).

### Sprawy i analizy

| Metoda i ścieżka | Wynik |
|---|---|
| `GET /api/health` | `{ status: 'ok' \| 'degraded', version, time, database: 'ok' \| 'error' }` |
| `GET /api/connectors` | `{ id, service, label, description, accepts, enabledByDefault }[]` |
| `GET /api/rules` | `ScoreRules` |
| `GET /api/priority-rules` | reguły pozostałych ocen: `priority`, `persons`, `services`, `relations`, `signals`, `ai`, `aliases`, `pivot`, `proof`, `analysis` |
| `GET /api/cases` | `CaseView[]` |
| `POST /api/cases` `{ name, identifiers }` | 201 `CaseSummary` |
| `GET /api/cases/:id` | `CaseView` |
| `POST /api/cases/:id/runs` `{ connectors?, depth?, async?, period? }` | 201 `AnalysisRun` po zakończeniu; z `async: true` — 202 `{ id, status }` |
| `GET /api/runs/:id` | `AnalysisRun` |
| `GET /api/runs/:id/progress` | `RunProgress` (etap, liczniki, po zakończeniu czasy faz) |
| `GET /api/cases/:id/diff?from=&to=` | `RunDiff`; bez parametrów — dwie ostatnie analizy |
| `GET /api/runs/:id/replacements` | podmiany adresu w tym samym miejscu publikacji |
| `POST /api/cases/:id/schedule` `{ everyMinutes }` | `CaseView` z harmonogramem cyklicznych analiz (1–10080 minut) |
| `DELETE /api/cases/:id/schedule` | `CaseView` bez harmonogramu |
| `POST /api/quick` `{ value, type?, depth?, async?, period? }` | 201 `{ case, dossier }`; z `async: true` — 202 `{ case, run: { id, status } }` |

```ts
interface CaseSummary {
  id: string; name: string; createdAt: string; query: SubjectQuery;
  runs: { id: string; startedAt: string; status: string; findingCount: number; topScore: number }[];
}
type CaseView = CaseSummary & { schedule?: { everyMinutes: number; nextRunAt: string } };
```

### Teczka, decyzje, raporty

| Metoda i ścieżka | Wynik |
|---|---|
| `GET /api/runs/:id/dossier` | `DossierView` — cały obraz podmiotu |
| `GET /api/cases/:id/dossier` | `DossierView` ostatniej zakończonej analizy sprawy |
| `GET /api/cases/:id/decisions` | `DecisionRecord[]` |
| `POST /api/cases/:id/decisions` `{ target: 'profile' \| 'address' \| 'evidence', key, decision, note? }` | 201 `DecisionRecord`; kolejne pobranie teczki uwzględnia decyzję |
| `DELETE /api/cases/:id/decisions/:decisionId` | 204 |
| `POST /api/cases/:id/identifiers` `{ identifiers }` | `CaseSummary` — dopisanie identyfikatorów do sprawy (najwyżej 40) |
| `GET /api/runs/:id/report.html` | raport do druku (nagłówek CSP `default-src 'none'; style-src 'unsafe-inline'`) |
| `GET /api/runs/:id/report.json` | pakiet do odtworzenia analizy: analiza, reguły, łączniki, podmiany, `intel`, decyzje, kopie treści |
| `GET /api/runs/:id/service-request/:file` | materiał do zapytania do usługi (`<id usługi>.html`) |
| `GET /api/overview` | `{ cases, runs, linkedAddresses, cashOutPlnByYear, topCases[], monitor }` |
| `GET /api/corpus/stats` | liczność indeksu publikacji i ustawienia przechowywania |
| `GET /api/ai` | `{ enabled, provider, model, description, usage }` |

### Typowanie i monitoring

| Metoda i ścieżka | Wynik |
|---|---|
| `POST /api/sweeps` `{ connectors?, limit? }` | 201 `Sweep` po zakończeniu przeglądu |
| `GET /api/sweeps` | `Sweep[]` (bez dzienników) |
| `GET /api/sweeps/:id` | `Sweep` |
| `POST /api/sweeps/:id/leads/:leadId/case` | 201 `CaseSummary` — sprawa z wytypowanego podmiotu |
| `GET /api/monitor` | `MonitorStatus` |
| `PUT /api/monitor` `{ enabled?, everyMinutes?, autoAnalyzeThreshold?, maxAutoAnalyses?, maxAiPublications?, sources? }` | `MonitorStatus` |
| `POST /api/monitor/run` | `{ status, newHits }` po zakończeniu ręcznego przebiegu |
| `POST /api/monitor/recheck` | wynik przeliczenia zapisanych trafień + `status` |
| `GET /api/monitor/hits?status=&minPolish=&minSuspicion=&limit=` | `WatchHit[]` (domyślnie 100, najwyżej 500) |
| `POST /api/monitor/hits/:id/analyze` | `WatchHit` z wynikiem analizy autora |
| `POST /api/monitor/hits/:id/case` | 201 `CaseSummary` — sprawa z trafienia |
| `POST /api/monitor/hits/:id/dismiss` | `WatchHit` ze statusem `dismissed` |

### Administracja

| Metoda i ścieżka | Wynik |
|---|---|
| `POST /api/admin/shutdown` | `{ status: 'closing' }`; tylko z `127.0.0.1` / `::1`, inaczej 403 |

Narzędzie nie ma kont użytkowników ani uwierzytelniania; API nasłuchuje domyślnie tylko lokalnie, a autor decyzji jest stały (`analityk`).

## Model danych teczki

Kontrakt `Dossier` (`packages/core/src/types.ts`) rozszerzony lokalnie do `DossierView` (`apps/api/src/dossier.ts`).

| Pole | Zawartość |
|---|---|
| `caseId`, `runId`, `generatedAt` | której analizy dotyczy teczka |
| `subject` | nazwa, `knownNames`, identyfikatory z pochodzeniem (`analyst` / `discovered`) i ścieżką dojścia (`step`, `via`, `sourceUrl`) |
| `persons` | kandydaci na rzeczywistą osobę (`PersonCandidate`) malejąco po prawdopodobieństwie; pierwszy to ustalenie główne |
| `profiles` | profile w serwisach (`ProfileCard`) z oceną tożsamości i przesłankami |
| `findings` | adresy (`Finding`) z Wskaźnikiem Pewności i księgą reguł, śladami, danymi blockchain; dodatkowo `subjectProbability`, `annotations`, `excludedEvidence`, `relatedAddresses`, `widelyCited`, `chainSkipped`, `decision` |
| `unconfirmedAddresses` | adresy znalezione, ale nieprzypisane podmiotowi („Adresy do potwierdzenia”) |
| `cashOutProof` | dowód spieniężenia: ustalenia „osoba → adres → ścieżka → usługa”, od najpewniejszego |
| `serviceLinks` | giełdy, portfele i inne usługi powiązane z podmiotem (`ServiceLink`) wraz z danymi do zapytania (`requestHints`) |
| `seizures` | przelewy na adresy organów państwa — nie są spieniężeniem i nie wchodzą do sum wypłat |
| `fundingSources` | skąd przyszły środki na adresy podmiotu (z publicznych etykiet) |
| `linkedIdentities`, `weakLeadsHidden` | powiązane tożsamości ze ścieżką dojścia; liczba słabych tropów niewykazanych |
| `relatedPersons` | inne osoby powiązane (wspólny adres, przelew, wspólny kontrahent, wspólna cecha profilu) |
| `mentions` | identyfikatory podmiotu wymieniane w publikacjach innych autorów |
| `graph`, `timeline` | węzły i krawędzie mapy powiązań; zdarzenia osi czasu z warstwą `fact` / `calculation` / `inference` |
| `totals` | `linkedAddresses`, `excludedAddresses`, `topScore`, `cashOutPlnByYear`, `cashOutPlnTotal`, wariant „z prawdopodobnie tą samą osobą”, `priority`, `priorityReasons` |
| `keyFindings` | najważniejsze ustalenia, każde z warstwą `fact` / `calculation` / `inference` |
| `summary` | streszczenie wygenerowane przez model z `keyFindings`; `null` bez modelu |
| `explanations` | dlaczego nie ma adresów albo dowodu spieniężenia i co można zrobić |
| `decisions` | rejestr decyzji analityka |
| `partial` | analiza przerwana limitem czasu |

Zasady:

- Zapisana analiza pozostaje nietknięta — decyzje i korekty istnieją tylko w teczce. Obowiązuje najnowsza decyzja dla danego celu; wcześniejsze zostają w rejestrze.
- Decyzja `rejected` dla profilu usuwa jego ślady z oceny adresów; `confirmed` potwierdza profil. Decyzja dla adresu: `rejected` wyklucza adres. Decyzja dla śladu (`evidence`) cofa m.in. wpływ modelu językowego.
- Do sum wypłat wchodzą adresy niewykluczone, nieodrzucone, ze Wskaźnikiem Pewności co najmniej 40% albo podane przez analityka.
- Powiązane tożsamości i osoby powiązane są wskazówką do weryfikacji, nigdy ustaleniem; nie są scalane z osobą główną bez decyzji analityka.
- Teczka jest pamiętana w pamięci procesu do najbliższej zmiany danych (nowa analiza, decyzja).

## Trwałość

Kod: `apps/api/src/storage.ts`, schemat `src/schema.sql`.

- **Dwa sterowniki, ten sam SQL.** Bez `DATABASE_URL` działa wbudowany PGlite (PostgreSQL w procesie) w katalogu `OLCYS_DATA_DIR` (domyślnie `./data/pg` względem katalogu roboczego procesu). Z `DATABASE_URL` — zewnętrzny serwer PostgreSQL przez `pg`.
- **Schemat** jest zakładany przy każdym starcie poleceniami idempotentnymi; nie ma osobnego kroku migracji. Tabele: `cases`, `runs`, `documents`, `decisions`, `sweeps`, `sweep_leads`, `monitor_config`, `monitor_seen`, `monitor_hits`, `corpus`, `corpus_addresses`.
- **Migawka (PGlite).** Katalog roboczy PGlite w systemie Windows nie otwiera się ponownie po zamknięciu procesu, dlatego trwałym zapisem jest migawka całej bazy w pliku `<OLCYS_DATA_DIR>.migawka.tar.gz` — zapisywana co minutę i przy zamknięciu, przez plik tymczasowy i zmianę nazwy. Każde uruchomienie dostaje świeży katalog roboczy `sesja-<czas>` wczytany z migawki; stare katalogi robocze są usuwane, o ile system na to pozwala. Po zabiciu procesu na siłę przepadają zmiany od ostatniej migawki.
- **Łagodne zamykanie.** Sygnały SIGINT, SIGTERM, SIGBREAK, SIGHUP oraz `POST /api/admin/shutdown` (potrzebne w Windows, gdzie zatrzymanie procesu z zewnątrz nie dostarcza sygnału) zamykają Fastify, zatrzymują monitoring i analizy w tle, zapisują migawkę i zamykają sterownik.
- **Poza bazą, w pamięci procesu:** harmonogramy cyklicznych analiz spraw (`POST /api/cases/:id/schedule`) i postęp analiz w tle — po restarcie harmonogram trzeba ustawić ponownie. Harmonogram monitoringu jest trwały.
- **Pliki poza bazą:** pamięć podręczna kursów `packages/chain/data/cache/rates.json`; własne etykiety analityka `packages/chain/data/labels.local.json`.
- `.gitignore` wyklucza `.env`, `.data*/` i `*.migawka.tar.gz`. Domyślny katalog `./data/pg` nie jest objęty regułą `.data*/` — przy uruchamianiu z katalogu `apps/api` warto ustawić `OLCYS_DATA_DIR=.data`.

## Interfejs (`apps/web`)

Routing na `location.hash`, bez biblioteki routingu.

| Trasa | Strona |
|---|---|
| `#/` | Pulpit — zestawienie spraw, nowa analiza |
| `#/sprawa/<id>[/<zakładka>]`, `#/analiza/<id>[/<zakładka>]` | Teczka podmiotu |
| `#/typowanie[/<id>]` | Typowanie — przegląd źródeł i ranking wskazań |
| `#/monitoring` | Monitoring — stan, źródła, trafienia |
| `#/zasady` | Zasady punktacji |

Zakładki teczki: `dowod` (Dowód spieniężenia, domyślna), `tozsamosci` (Powiązane tożsamości), `uslugi` (Giełdy i portfele), `graf` (Graf powiązań), `profile`, `adresy`, `przeplywy`, `os-czasu`, `osoby` (Osoby powiązane), `decyzje` (Rejestr decyzji), `analizy` (Historia analiz).

Tryb demonstracyjny bez API: parametr `?demo=1` w adresie albo `VITE_DEMO=1` przy budowaniu — dane pochodzą wtedy z `src/demo-backend.ts`.

## Laboratorium tożsamości

`apps/identity-lab` jest samodzielną aplikacją (własny serwer `server.mjs`, własne testy, bez zależności). Połączenie z narzędziem jest opcjonalne i domyślnie wyłączone: `labUrl` (w API zmienna `LAB_URL`) tworzy 27 łączników `lab-<slug>` z etykietą „LAB: <nazwa>” (`packages/sources/src/lab.ts`) i dostawcę sieci laboratoryjnej `lab` (`packages/chain/src/providers/lab.ts`). To symulacja lokalna na danych syntetycznych.

- Łączniki czytają wyłącznie publiczne API laboratorium (`/api/accounts`, `/api/accounts/:id`, `/api/portal/:slug`) i nie sięgają po prawdę wzorcową ani wyniki silnika laboratorium (`/api/ground-truth`, `/api/resolve`, `/api/evaluate`, `/api/search`, `/api/export/*`). Nie mają metody `discover`, więc nie biorą udziału w typowaniu ani monitoringu.
- Dostawca sieci podaje saldo i przelewy między adresami `lab1…`; token LAB nie ma wartości, więc nie ma wyceny w PLN, wskaźników wypłat, ścieżek ani powiązanych adresów.
- Pomiar narzędzia względem prawdy wzorcowej laboratorium: `node scripts/benchmark-lab.ts` (laboratorium musi działać), wynik generowany automatycznie do [BENCHMARK-LAB.md](BENCHMARK-LAB.md). Skrypt wywołuje `buildApp` przez `app.inject` na bazie w pamięci, wyłącznie z łącznikami i dostawcą laboratorium, a prawdę wzorcową pobiera dopiero po wszystkich analizach. W dniu 21.11.2026 integracja jest oznaczona w historii repozytorium jako „w toku” — liczby z pomiaru to stan roboczy.

## Zasady

- Wyłącznie publiczne źródła; bez logowania, obchodzenia zabezpieczeń i skanowania. Odmowa źródła (403, 404, 429) kończy się pustym wynikiem z wpisem w dzienniku, bez ponawiania i obchodzenia.
- Źródła w prawdziwym internecie są wyłączone, dopóki operator nie ustawi `ENABLE_LIVE`; Tor — dopóki nie poda `TOR_PROXY_URL`; model językowy — dopóki nie wskaże dostawcy.
- Do źródła trafia wyłącznie identyfikator potrzebny do zapytania, do eksploratora — badany adres lub adres kontrahenta.
- Wynik liczą jawne reguły; model językowy tylko wspiera i jest wymienialny w konfiguracji.
- Raport i teczka rozróżniają fakty źródłowe, wyniki obliczeń i wnioski do weryfikacji (`layer: 'fact' | 'calculation' | 'inference'`).
