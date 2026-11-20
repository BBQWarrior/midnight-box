import type { GuestTag, QueueEntry, Track } from '@shared/types';
import type { Db } from '../db.js';

/**
 * Lifecycle of a request:
 *   queued  -> waiting in our queue (removable, reorderable)
 *   pushed  -> handed to the provider's queue, plays after the current song
 *   playing -> currently playing
 *   played / removed -> history
 */
export type QueueRowStatus = 'queued' | 'pushed' | 'playing' | 'played' | 'removed';

export interface QueueRow {
  id: number;
  track: Track;
  guestId: string | null;
  requestedBy: GuestTag | null;
  status: QueueRowStatus;
  createdAt: number;
}

interface RawRow {
  id: number;
  track_json: string;
  guest_id: string | null;
  status: QueueRowStatus;
  created_at: number;
  public_id: string | null;
  name: string | null;
}

const SELECT = `
  SELECT q.id, q.track_json, q.guest_id, q.status, q.created_at, g.public_id, g.name
  FROM queue q LEFT JOIN guests g ON g.id = q.guest_id`;

export type RemoveResult = 'removed' | 'not_found' | 'locked';

/** Midnight Box's own queue. The provider only ever sees one upcoming song at a time. */
export class QueueService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Songs still to play, in play order: the pushed song first, then queued by arrival. */
  upcoming(): QueueRow[] {
    return this.all(
      `${SELECT} WHERE q.status IN ('pushed', 'queued')
       ORDER BY CASE q.status WHEN 'pushed' THEN 0 ELSE 1 END, q.id`,
    );
  }

  nextQueued(): QueueRow | undefined {
    return this.one(`${SELECT} WHERE q.status = 'queued' ORDER BY q.id LIMIT 1`);
  }

  pushed(): QueueRow | undefined {
    return this.one(`${SELECT} WHERE q.status = 'pushed' ORDER BY q.id LIMIT 1`);
  }

  playing(): QueueRow | undefined {
    return this.one(`${SELECT} WHERE q.status = 'playing' ORDER BY q.id DESC LIMIT 1`);
  }

  /** Songs a guest has waiting (queued or pushed). */
  pendingCountFor(guestId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM queue WHERE guest_id = ? AND status IN ('queued', 'pushed')`)
      .get(guestId) as { n: number };
    return row.n;
  }

  /** True if the track is waiting or playing right now. */
  isActive(trackId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM queue WHERE track_id = ? AND status IN ('queued', 'pushed', 'playing') LIMIT 1`)
        .get(trackId) !== undefined
    );
  }

  add(track: Track, guestId: string | null): QueueRow {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO queue (track_id, uri, track_json, guest_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(track.id, track.uri, JSON.stringify(track), guestId, now, now);
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

  /** Marks whatever was playing as finished. */
  finishPlaying(): void {
    this.db
      .prepare(`UPDATE queue SET status = 'played', updated_at = ? WHERE status = 'playing'`)
      .run(this.now());
  }

  recordPlay(track: Track, queueId: number | null): void {
    this.db
      .prepare('INSERT INTO plays (track_id, uri, track_json, queue_id, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(track.id, track.uri, JSON.stringify(track), queueId, this.now());
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
  };
}
