CREATE TABLE IF NOT EXISTS steward_ticks (
  trigger TEXT PRIMARY KEY CHECK(trigger IN ('scheduled','operator')),
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS steward_runs (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','operator')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  input_sha256 TEXT,
  source_threads_json TEXT NOT NULL DEFAULT '[]',
  report_json TEXT,
  error_code TEXT,
  reply_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_steward_started ON steward_runs(started_at DESC);
CREATE TABLE IF NOT EXISTS steward_replies (
  source_message_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES steward_runs(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
