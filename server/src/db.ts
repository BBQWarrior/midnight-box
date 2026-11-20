import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Track } from '@shared/types';
import { mainArtist, songKey } from './lib/tracks.js';

export type Db = DatabaseSync;

/** Each entry runs once, in order; PRAGMA user_version tracks progress. Append only. */
const MIGRATIONS: (string | ((db: Db) => void))[] = [
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

  // v2: cooldowns, fair queue, host login.
  (db) => {
    db.exec(`
      ALTER TABLE queue ADD COLUMN song_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE queue ADD COLUMN artist_id TEXT;
      -- Fair queue: a guest's n-th waiting song goes into round n, and rounds play in order.
      ALTER TABLE queue ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plays ADD COLUMN song_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE plays ADD COLUMN artist_id TEXT;
      CREATE INDEX queue_by_guest ON queue(guest_id, created_at);
      CREATE INDEX plays_by_song ON plays(song_key, started_at);
      CREATE INDEX plays_by_artist ON plays(artist_id, started_at);

      -- The host cleared a cooldown: plays before reset_at no longer count for that key.
      CREATE TABLE cooldown_resets (
        kind     TEXT NOT NULL CHECK (kind IN ('song', 'artist')),
        key      TEXT NOT NULL,
        reset_at INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
      ) STRICT;

      -- Only a SHA-256 of each session token is stored, so a copied database can't be used to log in.
      CREATE TABLE host_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
    `);
    for (const table of ['queue', 'plays']) {
      const update = db.prepare(`UPDATE ${table} SET song_key = ?, artist_id = ? WHERE id = ?`);
      const rows = db.prepare(`SELECT id, track_json FROM ${table}`).all() as { id: number; track_json: string }[];
      for (const row of rows) {
        const track = JSON.parse(row.track_json) as Track;
        update.run(songKey(track), mainArtist(track)?.id ?? null, row.id);
      }
    }
  },

  // v3: vote rounds. Winners join the queue without a guest.
  `ALTER TABLE queue ADD COLUMN source TEXT NOT NULL DEFAULT 'guest' CHECK (source IN ('guest', 'vote'));`,
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
    const step = MIGRATIONS[v]!;
    transaction(db, () => {
      if (typeof step === 'string') db.exec(step);
      else step(db);
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
