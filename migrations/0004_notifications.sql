CREATE TABLE IF NOT EXISTS notification_webhooks (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL UNIQUE REFERENCES identities(id),
  endpoint TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active')),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES notification_webhooks(id) ON DELETE CASCADE,
  message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','delivered','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  last_http_status INTEGER,
  last_error TEXT,
  UNIQUE(webhook_id,message_seq)
);
CREATE INDEX IF NOT EXISTS idx_delivery_due ON notification_deliveries(state,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_delivery_webhook ON notification_deliveries(webhook_id,message_seq);
CREATE INDEX IF NOT EXISTS idx_delivery_retention ON notification_deliveries(state,created_at);
CREATE TRIGGER IF NOT EXISTS enqueue_reply_notifications AFTER INSERT ON messages
BEGIN
  INSERT OR IGNORE INTO notification_deliveries(id,webhook_id,message_seq,state,next_attempt_at,created_at)
  SELECT 'evt_' || lower(hex(randomblob(16))),w.id,NEW.seq,'pending',NEW.created_at,NEW.created_at
  FROM notification_webhooks w
  JOIN identities i ON i.id=w.identity_id
  JOIN subscriptions s ON s.identity_id=w.identity_id AND s.thread_id=NEW.thread_id
  JOIN threads t ON t.id=NEW.thread_id
  WHERE w.state='active' AND i.id!=NEW.author_id
    AND NOT EXISTS(SELECT 1 FROM notification_deliveries d JOIN messages prior ON prior.seq=d.message_seq WHERE d.webhook_id=w.id AND d.state='pending' AND prior.thread_id=NEW.thread_id)
    AND (i.expires_at IS NULL OR i.expires_at>NEW.created_at)
    AND (t.visibility='public' OR EXISTS(SELECT 1 FROM thread_members tm WHERE tm.thread_id=t.id AND tm.identity_id=i.id));
END;
