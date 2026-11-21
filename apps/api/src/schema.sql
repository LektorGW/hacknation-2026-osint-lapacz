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

-- Wycofanie decyzji nie usuwa wpisu: zostaje ślad audytowy (kto i kiedy wycofał), a wynik wraca do automatycznego.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS withdrawn_by TEXT;

-- Odpowiedzi usług (giełd, serwisów wymiany) na zapytania uprawnionego organu — dokumenty spoza OSINT wprowadzane przez analityka.
-- Wycofanie nie usuwa wpisu (ślad audytowy). Identyfikator klienta i numer rachunku są w payload wyłącznie zamaskowane.
CREATE TABLE IF NOT EXISTS service_replies (
  id            TEXT PRIMARY KEY,
  seq           SERIAL,
  case_id       TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  service_name  TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  reference     TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL,
  recorded_by   TEXT NOT NULL,
  payload       JSONB NOT NULL,
  withdrawn_at  TIMESTAMPTZ,
  withdrawn_by  TEXT
);

CREATE INDEX IF NOT EXISTS service_replies_case_idx ON service_replies (case_id, seq);

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

-- Rozwinięcia sieci na żądanie („Rozwiń” w grafie): kto, kiedy, jaki węzeł i jakie grupy relacji, wynik z dowodami,
-- powody zatrzymania i błędy źródeł. Wycofanie nie usuwa wpisu (ślad audytowy), jak przy decyzjach analityka.
CREATE TABLE IF NOT EXISTS network_expansions (
  id             TEXT PRIMARY KEY,
  seq            SERIAL,
  case_id        TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  node_id        TEXT NOT NULL,
  relations      JSONB NOT NULL,
  depth          INTEGER NOT NULL DEFAULT 1,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ NOT NULL,
  requested_by   TEXT NOT NULL,
  results        JSONB NOT NULL,
  stops          JSONB NOT NULL,
  source_errors  JSONB NOT NULL,
  budget         JSONB NOT NULL,
  run_id         TEXT,
  withdrawn_at   TIMESTAMPTZ,
  withdrawn_by   TEXT
);

CREATE INDEX IF NOT EXISTS network_expansions_case_idx ON network_expansions (case_id, seq);

-- Cykl życia sprawy: otwarta → zamknięta (tylko do odczytu) → zarchiwizowana. Istniejące sprawy są otwarte.
-- W bazie zostaje wyłącznie skrót SHA-256 i metadane archiwum, nie sam plik.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';

ALTER TABLE cases ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE cases ADD COLUMN IF NOT EXISTS closed_reason TEXT;

ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE cases ADD COLUMN IF NOT EXISTS archive_sha256 TEXT;

ALTER TABLE cases ADD COLUMN IF NOT EXISTS archive_meta JSONB;

-- Dziennik audytu: tylko dopisywanie. Bez danych osobowych — w szczegółach są identyfikatory techniczne,
-- rodzaje i liczby. Bez klucza obcego do spraw: wpisy zostają po usunięciu sprawy.
CREATE TABLE IF NOT EXISTS audit_log (
  seq      SERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL,
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  case_id  TEXT,
  target   TEXT,
  details  JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_case_idx ON audit_log (case_id, seq);

-- Ślad po usuniętej sprawie: identyfikator, czas, skrót archiwum i liczby usuniętych wierszy — bez nazw i identyfikatorów osób.
CREATE TABLE IF NOT EXISTS case_tombstones (
  id              TEXT PRIMARY KEY,
  deleted_at      TIMESTAMPTZ NOT NULL,
  archive_sha256  TEXT,
  mode            TEXT NOT NULL,
  counts          JSONB NOT NULL
);
