import type { CooldownList, Track, TrackBlock } from '@shared/types';
import type { Db } from '../db.js';
import { mainArtist, songKey } from '../lib/tracks.js';
import type { QueueService } from './queue.js';

export interface CooldownOptions {
  /** How long after a song starts before it can be requested again. 0 disables. */
  songMs: number;
  /** The artist window: at most `artistMaxSongs` songs per main artist start within it. 0 disables. */
  artistMs: number;
  /** With 1, an artist rests for the whole window after each song. */
  artistMaxSongs: number;
}

type Kind = 'song' | 'artist';
const COLUMN: Record<Kind, string> = { song: 'song_key', artist: 'artist_id' };
const LIST_LIMIT = 50;

/**
 * Decides whether a track can be requested right now as far as play history goes. Cooldowns start
 * when a song starts playing, whoever picked it: guests, the host's own Spotify queue or autoplay.
 * The host's own rules (blacklist, explicit filter) are checked first, in TrackRules.
 */
export class CooldownService {
  constructor(
    private readonly db: Db,
    private readonly queue: QueueService,
    /** Read on every call, so the host's changes apply at once. */
    private readonly opts: () => CooldownOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Why `track` can't be requested, or null if it can.
   * `playing` is what the speaker is playing now; it may not have come from our queue.
   */
  blockFor(track: Track, playing: Track | null): TrackBlock | null {
    const now = this.now();
    const { songMs, artistMs, artistMaxSongs } = this.opts();
    const key = songKey(track);
    if (this.queue.hasSong(key) || (playing && songKey(playing) === key)) {
      return { reason: 'already_queued', availableAt: null };
    }
    if (songMs > 0) {
      const last = this.playsSince('song', key, now - songMs).at(-1);
      if (last !== undefined) return { reason: 'song_cooldown', availableAt: last + songMs };
    }
    const artist = mainArtist(track);
    if (artist && artistMs > 0) {
      // One song per artist in the queue; otherwise fair-queue rounds could play them back to back.
      if (this.queue.hasArtistWaiting(artist.id)) return { reason: 'artist_queued', availableAt: null };
      const plays = this.playsSince('artist', artist.id, now - artistMs);
      if (plays.length >= artistMaxSongs) {
        // A slot frees up when the oldest play that still counts leaves the window.
        return { reason: 'artist_cooldown', availableAt: plays[plays.length - artistMaxSongs]! + artistMs };
      }
    }
    return null;
  }

  /** Everything cooling down right now, newest first (for the host panel). */
  list(): CooldownList {
    const { songMs, artistMs, artistMaxSongs } = this.opts();
    const songs = this.resting('song', songMs, 1);
    const artists = this.resting('artist', artistMs, artistMaxSongs).flatMap(({ key, track, until }) => {
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

  /** When the song or artist started playing after `since`, oldest first. Plays before a host reset don't count. */
  private playsSince(kind: Kind, key: string, since: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT started_at FROM plays
         WHERE ${COLUMN[kind]} = ? AND started_at > ?
           AND started_at > COALESCE((SELECT reset_at FROM cooldown_resets WHERE kind = ? AND key = ?), -1)
         ORDER BY started_at`,
      )
      .all(key, since, kind, key) as { started_at: number }[];
    return rows.map((r) => r.started_at);
  }

  /**
   * Songs or artists that reached `maxPlays` inside the window, newest first, with when they're free
   * again. `track` is the latest play, for names.
   */
  private resting(kind: Kind, windowMs: number, maxPlays: number): { key: string; track: Track; until: number }[] {
    if (windowMs <= 0) return [];
    const column = COLUMN[kind];
    const rows = this.db
      .prepare(
        `SELECT p.${column} AS key, p.started_at AS t, p.track_json
         FROM plays p
         LEFT JOIN cooldown_resets r ON r.kind = ? AND r.key = p.${column}
         WHERE p.${column} IS NOT NULL AND p.started_at > ? AND p.started_at > COALESCE(r.reset_at, -1)
         ORDER BY p.started_at`,
      )
      .all(kind, this.now() - windowMs) as { key: string; t: number; track_json: string }[];
    const byKey = new Map<string, { times: number[]; trackJson: string }>();
    for (const row of rows) {
      const entry = byKey.get(row.key) ?? { times: [], trackJson: row.track_json };
      entry.times.push(row.t);
      entry.trackJson = row.track_json;
      byKey.set(row.key, entry);
    }
    return [...byKey]
      .filter(([, e]) => e.times.length >= maxPlays)
      .map(([key, e]) => ({
        key,
        track: JSON.parse(e.trackJson) as Track,
        until: e.times[e.times.length - maxPlays]! + windowMs,
        last: e.times.at(-1)!,
      }))
      .sort((a, b) => b.last - a.last)
      .slice(0, LIST_LIMIT)
      .map(({ key, track, until }) => ({ key, track, until }));
  }
}
