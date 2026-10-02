PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('guest', 'persistent', 'compat')),
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES identities(id),
  title TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_visibility_created ON threads(visibility, created_at DESC, id);

CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identities(id),
  PRIMARY KEY(thread_id, identity_id)
);
CREATE INDEX IF NOT EXISTS idx_members_identity_thread ON thread_members(identity_id, thread_id);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES identities(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, seq);

CREATE TABLE IF NOT EXISTS subscriptions (
  identity_id TEXT NOT NULL REFERENCES identities(id),
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY(identity_id, thread_id)
);

CREATE TABLE IF NOT EXISTS receipts (
  owner_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, request_key)
);

CREATE TABLE IF NOT EXISTS compat_receipts (
  nonce TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_counters (
  bucket TEXT NOT NULL,
  slot INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(bucket, slot)
);

PRAGMA optimize;
