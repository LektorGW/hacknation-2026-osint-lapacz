-- Schemat OŁCyŚ (PostgreSQL). Wykonywany przy każdym starcie — wszystkie polecenia są idempotentne.
-- Polecenia oddziela średnik na końcu wiersza; nie używać średników wewnątrz poleceń.

CREATE TABLE IF NOT EXISTS cases (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  query       JSONB NOT NULL
);

-- Pełny wynik analizy (AnalysisRun) w kolumnie result; pozostałe kolumny służą do list i sortowania.
CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  case_id        TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL,
  finding_count  INTEGER NOT NULL DEFAULT 0,
  top_score      INTEGER NOT NULL DEFAULT 0,
  result         JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_case_started_idx ON runs (case_id, started_at);

-- Łańcuch dowodowy: kopia treści dokładnie w postaci, z której policzono skrót SHA-256.
CREATE TABLE IF NOT EXISTS documents (
  run_id        TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  service       TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  author        TEXT,
  published_at  TEXT,
  archived_at   TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL,
  content       TEXT NOT NULL,
  PRIMARY KEY (run_id, content_hash, url)
);

-- Materiał do teczki (profile, ścieżka odkrywania) — obok wyniku, żeby AnalysisRun pozostał zgodny z kontraktem.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS intel JSONB;

-- Rejestr decyzji analityka. Wpisy nie są zmieniane; obowiązuje najnowsza decyzja dla danego celu.
CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  seq         SERIAL,
  case_id     TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  target      TEXT NOT NULL,
  target_key  TEXT NOT NULL,
  decision    TEXT NOT NULL,
  note        TEXT,
  author      TEXT NOT NULL,
  decided_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS decisions_case_idx ON decisions (case_id, seq);

-- Przegląd źródeł (typowanie podmiotów): wynik z rankingiem w kolumnie result.
CREATE TABLE IF NOT EXISTS sweeps (
  id          TEXT PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL,
  result      JSONB NOT NULL
);

-- Pełna analiza wytypowanego podmiotu — po założeniu sprawy staje się jej pierwszą analizą.
CREATE TABLE IF NOT EXISTS sweep_leads (
  sweep_id  TEXT NOT NULL REFERENCES sweeps (id) ON DELETE CASCADE,
  lead_id   TEXT NOT NULL,
  analysis  JSONB NOT NULL,
  PRIMARY KEY (sweep_id, lead_id)
);

-- Monitoring źródeł: ustawienia i statystyki źródeł w jednym wierszu (trwałe między uruchomieniami).
CREATE TABLE IF NOT EXISTS monitor_config (
  id    TEXT PRIMARY KEY,
  data  JSONB NOT NULL
);

-- Publikacje już przejrzane — kolejny przebieg ich nie ocenia ponownie.
CREATE TABLE IF NOT EXISTS monitor_seen (
  url      TEXT PRIMARY KEY,
  seen_at  TIMESTAMPTZ NOT NULL
);

-- Trafienia monitoringu: jedno na autora w serwisie (dedupe_key), z opcjonalną analizą autora.
CREATE TABLE IF NOT EXISTS monitor_hits (
  id           TEXT PRIMARY KEY,
  dedupe_key   TEXT NOT NULL UNIQUE,
  detected_at  TIMESTAMPTZ NOT NULL,
  data         JSONB NOT NULL,
  analysis     JSONB
);

-- Własny indeks publikacji: wszystko, co monitoring kiedykolwiek pobrał. Analiza osoby i adresu
-- przeszukuje go bez wychodzenia do sieci (łącznik wewnętrzny `corpus`).
CREATE TABLE IF NOT EXISTS corpus (
  url           TEXT PRIMARY KEY,
  service       TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  author        TEXT,
  author_key    TEXT,
  published_at  TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  category      TEXT NOT NULL,
  profile       JSONB
);

CREATE INDEX IF NOT EXISTS corpus_author_idx ON corpus (author_key);

CREATE INDEX IF NOT EXISTS corpus_fetched_idx ON corpus (fetched_at);

CREATE TABLE IF NOT EXISTS corpus_addresses (
  url      TEXT NOT NULL REFERENCES corpus (url) ON DELETE CASCADE,
  network  TEXT NOT NULL,
  address  TEXT NOT NULL,
  PRIMARY KEY (url, network, address)
);

CREATE INDEX IF NOT EXISTS corpus_addresses_address_idx ON corpus_addresses (address);
