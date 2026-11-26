import type { BlacklistEntry, BlacklistItem, BlacklistKind, Track } from '@shared/types';
import { type Db, transaction } from '../db.js';
import { mainArtist, songKey } from '../lib/tracks.js';

interface Row {
  kind: BlacklistKind;
  key: string;
  name: string;
  artist: string | null;
  added_at: number;
}

const id = (kind: BlacklistKind, key: string): string => `${kind}\n${key}`;

/**
 * Songs, albums and artists the host never wants played. Kept in the database (ids and names only)
 * and mirrored in memory, because every search result is checked against it.
 *
 * A song entry covers every release of it (same main artist and title, see songKey). An artist
 * entry matches any credited artist, so songs they only feature on are blocked too.
 */
export class BlacklistService {
  private readonly items = new Map<string, BlacklistItem>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    const rows = db
      .prepare('SELECT kind, key, name, artist, added_at FROM blacklist ORDER BY added_at, rowid')
      .all() as unknown as Row[];
    for (const row of rows) this.items.set(id(row.kind, row.key), toItem(row));
  }

  /** Newest first (entries added in the same millisecond: last added first). */
  list(): BlacklistItem[] {
    return [...this.items.values()].reverse().sort((a, b) => b.addedAt - a.addedAt);
  }

  get size(): number {
    return this.items.size;
  }

  /** The entry that blocks this track, or null. */
  match(track: Track): BlacklistItem | null {
    if (this.items.size === 0) return null;
    const song = this.items.get(id('song', songKey(track)));
    if (song) return song;
    if (track.albumId) {
      const album = this.items.get(id('album', track.albumId));
      if (album) return album;
    }
    for (const artist of track.artists) {
      const hit = this.items.get(id('artist', artist.id));
      if (hit) return hit;
    }
    return null;
  }

  /** Adds an entry, or returns the one already there. */
  add(entry: BlacklistEntry): BlacklistItem {
    const existing = this.items.get(id(entry.kind, entry.key));
    if (existing) return existing;
    const item: BlacklistItem = { ...entry, addedAt: this.now() };
    this.insert(item);
    return item;
  }

  /** Returns the removed entry, or undefined if it wasn't on the list. */
  remove(kind: BlacklistKind, key: string): BlacklistItem | undefined {
    const item = this.items.get(id(kind, key));
    if (!item) return undefined;
    this.db.prepare('DELETE FROM blacklist WHERE kind = ? AND key = ?').run(kind, key);
    this.items.delete(id(kind, key));
    return item;
  }

  /** Empties the list. Returns what was on it, so the host can undo. */
  clear(): BlacklistItem[] {
    const old = this.list();
    this.db.exec('DELETE FROM blacklist');
    this.items.clear();
    return old;
  }

  /**
   * Adds many entries at once (import, or undoing a clear). `replace` empties the list first.
   * Returns how many weren't on the list yet.
   */
  addMany(entries: BlacklistEntry[], mode: 'merge' | 'replace'): number {
    return transaction(this.db, () => {
      if (mode === 'replace') {
        this.db.exec('DELETE FROM blacklist');
        this.items.clear();
      }
      let added = 0;
      // Oldest first keeps the file's order when the list is shown newest first.
      const at = this.now();
      entries.forEach((entry, i) => {
        if (this.items.has(id(entry.kind, entry.key))) return;
        this.insert({ ...entry, addedAt: at - entries.length + i });
        added++;
      });
      return added;
    });
  }

  private insert(item: BlacklistItem): void {
    this.db
      .prepare('INSERT OR IGNORE INTO blacklist (kind, key, name, artist, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(item.kind, item.key, item.name, item.artist, item.addedAt);
    this.items.set(id(item.kind, item.key), item);
  }
}

/**
 * The entry that blocks `kind` for this track: the song (every release), its album, or one of its
 * artists (the main one unless `artistId` names another). Null when the track lacks what's needed.
 */
export function entryFor(kind: BlacklistKind, track: Track, artistId?: string): BlacklistEntry | null {
  const main = mainArtist(track);
  switch (kind) {
    case 'song':
      return { kind, key: songKey(track), name: track.name, artist: main?.name ?? null };
    case 'album':
      return track.albumId ? { kind, key: track.albumId, name: track.album, artist: main?.name ?? null } : null;
    case 'artist': {
      const artist = artistId ? track.artists.find((a) => a.id === artistId) : main;
      return artist ? { kind, key: artist.id, name: artist.name, artist: null } : null;
    }
  }
}

function toItem(row: Row): BlacklistItem {
  return { kind: row.kind, key: row.key, name: row.name, artist: row.artist, addedAt: row.added_at };
}
