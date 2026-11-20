import type { GuestTag, QueueEntry, Track } from '@shared/types';
import type { Db } from '../db.js';
import { mainArtist, songKey } from '../lib/tracks.js';

/**
 * Lifecycle of a request:
 *   queued  -> waiting in our queue (removable, reorderable)
 *   pushed  -> handed to the provider's queue, plays after the current song
 *   playing -> currently playing
 *   played / removed -> history
 */
export type QueueRowStatus = 'queued' | 'pushed' | 'playing' | 'played' | 'removed';

/** Who asked for a song: a guest, or the winner of a vote round. */
export type QueueSource = 'guest' | 'vote';

export interface QueueRow {
  id: number;
  track: Track;
  guestId: string | null;
  requestedBy: GuestTag | null;
  status: QueueRowStatus;
  createdAt: number;
  round: number;
  source: QueueSource;
}

interface RawRow {
  id: number;
  track_json: string;
  guest_id: string | null;
  status: QueueRowStatus;
  created_at: number;
  round: number;
  source: QueueSource;
  public_id: string | null;
  name: string | null;
}

const SELECT = `
  SELECT q.id, q.track_json, q.guest_id, q.status, q.created_at, q.round, q.source, g.public_id, g.name
  FROM queue q LEFT JOIN guests g ON g.id = q.guest_id`;

export type RemoveResult = 'removed' | 'not_found' | 'locked';

/** Midnight Box's own queue. The provider only ever sees one upcoming song at a time. */
export class QueueService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Songs still to play, in play order: the pushed song first, then queued ones by round and arrival. */
  upcoming(): QueueRow[] {
    return this.all(
      `${SELECT} WHERE q.status IN ('pushed', 'queued')
       ORDER BY CASE q.status WHEN 'pushed' THEN 0 ELSE 1 END, q.round, q.id`,
    );
  }

  nextQueued(): QueueRow | undefined {
    return this.one(`${SELECT} WHERE q.status = 'queued' ORDER BY q.round, q.id LIMIT 1`);
  }

  pushed(): QueueRow | undefined {
    return this.one(`${SELECT} WHERE q.status = 'pushed' ORDER BY q.id LIMIT 1`);
  }

  playing(): QueueRow | undefined {
    return this.one(`${SELECT} WHERE q.status = 'playing' ORDER BY q.id DESC LIMIT 1`);
  }

  /** Songs waiting to play (queued or pushed). */
  waitingCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE status IN ('queued', 'pushed')`).get() as {
      n: number;
    };
    return row.n;
  }

  /** Songs a guest has waiting (queued or pushed). */
  pendingCountFor(guestId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM queue WHERE guest_id = ? AND status IN ('queued', 'pushed')`)
      .get(guestId) as { n: number };
    return row.n;
  }

  /** When the guest added songs after `since` (oldest first). Songs the host removed don't count. */
  addedSince(guestId: string, since: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT created_at FROM queue WHERE guest_id = ? AND created_at > ? AND status != 'removed'
         ORDER BY created_at`,
      )
      .all(guestId, since) as { created_at: number }[];
    return rows.map((r) => r.created_at);
  }

  /** True if the same song (any release of it) is waiting or playing right now. */
  hasSong(key: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM queue WHERE song_key = ? AND status IN ('queued', 'pushed', 'playing') LIMIT 1`)
        .get(key) !== undefined
    );
  }

  /** True if a song by this main artist is waiting to play. */
  hasArtistWaiting(artistId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM queue WHERE artist_id = ? AND status IN ('queued', 'pushed') LIMIT 1`)
        .get(artistId) !== undefined
    );
  }

  /**
   * Adds a song. Guests take turns: a guest's next song goes one round after their previous
   * one, but never into a round that has already been played. So a newcomer's first song
   * lands ahead of someone else's third. Vote picks take turns the same way, as if the
   * party were one more guest.
   */
  add(track: Track, guestId: string | null, source: QueueSource = 'guest'): QueueRow {
    const now = this.now();
    const current = (
      this.db
        .prepare(`SELECT COALESCE(MAX(round), 0) AS r FROM queue WHERE status IN ('pushed', 'playing', 'played')`)
        .get() as { r: number }
    ).r;
    let round = current;
    const owner =
      source === 'vote'
        ? this.db.prepare(`SELECT MAX(round) AS r FROM queue WHERE source = 'vote' AND status != 'removed'`).get()
        : guestId
          ? this.db
              .prepare(`SELECT MAX(round) AS r FROM queue WHERE guest_id = ? AND status != 'removed'`)
              .get(guestId)
          : undefined;
    const last = (owner as { r: number | null } | undefined)?.r ?? null;
    if (last !== null) round = Math.max(current, last + 1);
    const result = this.db
      .prepare(
        `INSERT INTO queue
           (track_id, uri, track_json, song_key, artist_id, round, guest_id, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        track.id,
        track.uri,
        JSON.stringify(track),
        songKey(track),
        mainArtist(track)?.id ?? null,
        round,
        guestId,
        source,
        now,
        now,
      );
    return this.one(`${SELECT} WHERE q.id = ?`, Number(result.lastInsertRowid))!;
  }

  setStatus(id: number, status: QueueRowStatus): void {
    this.db.prepare('UPDATE queue SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), id);
  }

  /** Only `queued` songs can be removed: a pushed song already sits in the provider's queue. */
  remove(id: number): RemoveResult {
    const row = this.db.prepare('SELECT status FROM queue WHERE id = ?').get(id) as
      | { status: QueueRowStatus }
      | undefined;
    if (!row || (row.status !== 'queued' && row.status !== 'pushed')) return 'not_found';
    if (row.status === 'pushed') return 'locked';
    this.setStatus(id, 'removed');
    return 'removed';
  }

  /** Removes every song a guest still has waiting in our queue (used when they are banned). */
  removeQueuedFor(guestId: string): number {
    const result = this.db
      .prepare(`UPDATE queue SET status = 'removed', updated_at = ? WHERE guest_id = ? AND status = 'queued'`)
      .run(this.now(), guestId);
    return Number(result.changes);
  }

  /** Marks whatever was playing as finished. */
  finishPlaying(): void {
    this.db
      .prepare(`UPDATE queue SET status = 'played', updated_at = ? WHERE status = 'playing'`)
      .run(this.now());
  }

  /** Every track that starts playing is recorded, requested or not: it starts the cooldowns. */
  recordPlay(track: Track, queueId: number | null): void {
    this.db
      .prepare(
        `INSERT INTO plays (track_id, uri, track_json, song_key, artist_id, queue_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        track.id,
        track.uri,
        JSON.stringify(track),
        songKey(track),
        mainArtist(track)?.id ?? null,
        queueId,
        this.now(),
      );
  }

  /** After a restart nothing is "playing" from our point of view until the player loop sees it. */
  recoverAfterRestart(): void {
    this.finishPlaying();
  }

  static toEntry(row: QueueRow): QueueEntry {
    return {
      id: row.id,
      track: row.track,
      requestedBy: row.requestedBy,
      votePick: row.source === 'vote',
      status: row.status === 'pushed' ? 'pushed' : 'queued',
      addedAt: row.createdAt,
    };
  }

  private all(sql: string, ...params: (string | number)[]): QueueRow[] {
    return (this.db.prepare(sql).all(...params) as unknown as RawRow[]).map(toRow);
  }

  private one(sql: string, ...params: (string | number)[]): QueueRow | undefined {
    const raw = this.db.prepare(sql).get(...params) as unknown as RawRow | undefined;
    return raw && toRow(raw);
  }
}

function toRow(raw: RawRow): QueueRow {
  return {
    id: raw.id,
    track: JSON.parse(raw.track_json) as Track,
    guestId: raw.guest_id,
    requestedBy: raw.public_id ? { publicId: raw.public_id, name: raw.name ?? 'Guest' } : null,
    status: raw.status,
    createdAt: raw.created_at,
    round: raw.round,
    source: raw.source,
  };
}
