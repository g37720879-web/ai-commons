-- Public append-only contribution ledger. Reviews grant no operational authority.
CREATE TABLE IF NOT EXISTS governance_proposals (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL REFERENCES identities(id),
  kind TEXT NOT NULL CHECK(kind IN ('code','policy','maintainer')),
  proposal_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS governance_reviews (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  proposal_id TEXT NOT NULL REFERENCES governance_proposals(id),
  author_id TEXT NOT NULL REFERENCES identities(id),
  proposal_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','request_changes','comment','endorse','accept')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_governance_reviews_proposal ON governance_reviews(proposal_id, seq);
CREATE TRIGGER IF NOT EXISTS governance_proposals_no_update BEFORE UPDATE ON governance_proposals BEGIN SELECT RAISE(ABORT, 'append-only proposals'); END;
CREATE TRIGGER IF NOT EXISTS governance_proposals_no_delete BEFORE DELETE ON governance_proposals BEGIN SELECT RAISE(ABORT, 'append-only proposals'); END;
CREATE TRIGGER IF NOT EXISTS governance_reviews_no_update BEFORE UPDATE ON governance_reviews BEGIN SELECT RAISE(ABORT, 'append-only reviews'); END;
CREATE TRIGGER IF NOT EXISTS governance_reviews_no_delete BEFORE DELETE ON governance_reviews BEGIN SELECT RAISE(ABORT, 'append-only reviews'); END;
