import type { Track } from '@shared/types';
import { LruCache } from '../lib/cache.js';
import type { MusicProvider } from '../providers/types.js';

/** Spotify Development Mode caps search at 10 results per page. */
export const PAGE_SIZE = 10;
export const MAX_OFFSET = 990;

export interface CatalogPage {
  tracks: Track[];
  /** Pass as `offset` for the next page, or null when there are no more results. */
  nextOffset: number | null;
}

/**
 * Searches and track lookups, with short-lived caches so typing and paging don't hit the provider
 * again. Temporary only: Spotify allows caching their content just to keep the app responsive.
 */
export class Catalog {
  private readonly tracks = new LruCache<string, Track>(5_000, 60 * 60_000);
  private readonly searches = new LruCache<string, CatalogPage>(300, 60_000);

  constructor(private readonly provider: MusicProvider) {}

  async search(q: string, offset: number): Promise<CatalogPage> {
    const key = `${q.toLowerCase()}|${offset}`;
    const cached = this.searches.get(key);
    if (cached) return cached;
    const result = await this.provider.search(q, offset, PAGE_SIZE);
    for (const t of result.tracks) this.tracks.set(t.id, t);
    const next = offset + PAGE_SIZE;
    const page = { tracks: result.tracks, nextOffset: next < result.total && next <= MAX_OFFSET ? next : null };
    this.searches.set(key, page);
    return page;
  }

  /** A track by id, as the provider describes it. Never trust track details from the client. */
  async get(trackId: string): Promise<Track | null> {
    const track = this.tracks.get(trackId) ?? (await this.provider.getTrack(trackId));
    if (track) this.tracks.set(track.id, track);
    return track;
  }
}
