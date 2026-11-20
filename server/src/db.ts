import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Each entry runs once, in order; PRAGMA user_version tracks progress. Append only. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE guests (
    id         TEXT PRIMARY KEY,
    public_id  TEXT NOT NULL UNIQUE,
    name       TEXT,
    created_at INTEGER NOT NULL,
    banned     INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE queue (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id   TEXT NOT NULL,
    uri        TEXT NOT NULL,
    track_json TEXT NOT NULL,
    guest_id   TEXT REFERENCES guests(id),
    status     TEXT NOT NULL CHECK (status IN ('queued', 'pushed', 'playing', 'played', 'removed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX queue_by_status ON queue(status, id);

  -- Every track that started playing, whether it came from our queue or not.
  -- Used for history and (next milestone) song/artist cooldowns.
  CREATE TABLE plays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id   TEXT NOT NULL,
    uri        TEXT NOT NULL,
    track_json TEXT NOT NULL,
    queue_id   INTEGER REFERENCES queue(id),
    started_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX plays_by_time ON plays(started_at);
  `,
];

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function kvDelete(db: Db, key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

/** Random secret generated on first run and kept in the local database (never in git). */
export function getOrCreateSecret(db: Db, key: string): string {
  const existing = kvGet(db, key);
  if (existing) return existing;
  const secret = randomBytes(32).toString('base64url');
  kvSet(db, key, secret);
  return secret;
}
