import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// Mirrors the D1 calls used by the Worker. Production uses Cloudflare's D1
// binding directly; this adapter is only for local development and tests.
export function createDatabase(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const prepare = (sql, values = []) => ({
    sql, values,
    bind(...args) { return prepare(sql, args); },
    async first(column) {
      const row = db.prepare(sql).get(...values);
      return row ? (column ? row[column] : { ...row }) : null;
    },
    async all() {
      return { results: db.prepare(sql).all(...values).map(row => ({ ...row })), success: true };
    },
    async run() {
      const result = db.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  });
  return {
    prepare,
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Execute synchronously so concurrent requests cannot interleave an
        // await while a transaction is open on this local connection.
        const results = statements.map(s => {
          const result = db.prepare(s.sql).run(...s.values);
          return { success: true, meta: { changes: Number(result.changes) } };
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() { db.close(); },
    raw: db
  };
}
