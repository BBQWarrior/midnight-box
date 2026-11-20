import type { CooldownList, Track, TrackBlock } from '@shared/types';
import type { Db } from '../db.js';
import { mainArtist, songKey } from '../lib/tracks.js';
import type { QueueService } from './queue.js';

export interface CooldownOptions {
  /** How long after a song starts before it can be requested again. 0 disables. */
  songMs: number;
  /** How long after a main artist's song starts before they can be requested again. 0 disables. */
  artistMs: number;
}

type Kind = 'song' | 'artist';
const COLUMN: Record<Kind, string> = { song: 'song_key', artist: 'artist_id' };
const LIST_LIMIT = 50;

/**
 * Decides whether a track can be requested right now. Cooldowns start when a song starts
 * playing, whoever picked it: guests, the host's own Spotify queue or autoplay.
 */
export class CooldownService {
  constructor(
    private readonly db: Db,
    private readonly queue: QueueService,
    private readonly opts: CooldownOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Why `track` can't be requested, or null if it can.
   * `playing` is what the speaker is playing now; it may not have come from our queue.
   */
  blockFor(track: Track, playing: Track | null): TrackBlock | null {
    const now = this.now();
    const key = songKey(track);
    if (this.queue.hasSong(key) || (playing && songKey(playing) === key)) {
      return { reason: 'already_queued', availableAt: null };
    }
    if (this.opts.songMs > 0) {
      const last = this.lastPlay('song', key);
      if (last !== null && last + this.opts.songMs > now) {
        return { reason: 'song_cooldown', availableAt: last + this.opts.songMs };
      }
    }
    const artist = mainArtist(track);
    if (artist && this.opts.artistMs > 0) {
      // One song per artist in the queue; otherwise fair-queue rounds could play them back to back.
      if (this.queue.hasArtistWaiting(artist.id)) return { reason: 'artist_queued', availableAt: null };
      const last = this.lastPlay('artist', artist.id);
      if (last !== null && last + this.opts.artistMs > now) {
        return { reason: 'artist_cooldown', availableAt: last + this.opts.artistMs };
      }
    }
    return null;
  }

  /** Everything cooling down right now, newest first (for the host panel). */
  list(): CooldownList {
    const songs = this.recent('song', this.opts.songMs).map(({ key, track, until }) => ({ key, track, until }));
    const artists = this.recent('artist', this.opts.artistMs).flatMap(({ key, track, until }) => {
      const artist = track.artists.find((a) => a.id === key);
      return artist ? [{ key, artist, until }] : [];
    });
    return { songs, artists };
  }

  /** Host override: plays before now stop counting towards this song's or artist's cooldown. */
  clear(kind: Kind, key: string): void {
    this.db
      .prepare(
        `INSERT INTO cooldown_resets (kind, key, reset_at) VALUES (?, ?, ?)
         ON CONFLICT(kind, key) DO UPDATE SET reset_at = excluded.reset_at`,
      )
      .run(kind, key, this.now());
  }

  private lastPlay(kind: Kind, key: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(started_at) AS t FROM plays
         WHERE ${COLUMN[kind]} = ?
           AND started_at > COALESCE((SELECT reset_at FROM cooldown_resets WHERE kind = ? AND key = ?), -1)`,
      )
      .get(key, kind, key) as { t: number | null };
    return row.t;
  }

  private recent(kind: Kind, windowMs: number): { key: string; track: Track; until: number }[] {
    if (windowMs <= 0) return [];
    const column = COLUMN[kind];
    // SQLite returns the other columns from the row holding MAX(started_at).
    const rows = this.db
      .prepare(
        `SELECT p.${column} AS key, MAX(p.started_at) AS t, p.track_json
         FROM plays p
         LEFT JOIN cooldown_resets r ON r.kind = ? AND r.key = p.${column}
         WHERE p.${column} IS NOT NULL AND p.started_at > ? AND p.started_at > COALESCE(r.reset_at, -1)
         GROUP BY p.${column}
         ORDER BY t DESC
         LIMIT ${LIST_LIMIT}`,
      )
      .all(kind, this.now() - windowMs) as { key: string; t: number; track_json: string }[];
    return rows.map((r) => ({ key: r.key, track: JSON.parse(r.track_json) as Track, until: r.t + windowMs }));
  }
}
