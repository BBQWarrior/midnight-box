import { z } from 'zod';
import type { Track } from '@shared/types';
import { LruCache } from '../lib/cache.js';
import { baseTitle, mainArtist, songKey } from '../lib/tracks.js';
import { ProviderError, type SongRef, type SuggestionSource } from './types.js';

const API = 'https://ws.audioscrobbler.com/2.0/';
const TIMEOUT_MS = 8_000;
/** Below this many similar tracks, top songs by similar artists are added. */
const ENOUGH_TRACKS = 20;
const SIMILAR_ARTISTS = 6;
const TOP_TRACKS_PER_ARTIST = 3;

// Last.fm sends a single object instead of a one-element array, and omits empty lists.
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]), z.array(item));
const Song = z.object({ name: z.string(), artist: z.object({ name: z.string() }) });
const SimilarTracks = z.object({ similartracks: z.object({ track: list(Song) }) });
const TopTracks = z.object({ toptracks: z.object({ track: list(Song) }) });
const SimilarArtists = z.object({ similarartists: z.object({ artist: list(z.object({ name: z.string() })) }) });
const ErrorBody = z.object({ error: z.number(), message: z.string().optional() });

/** Last.fm error codes: https://www.last.fm/api/errorcodes */
const NOT_FOUND = 6;
const BAD_KEY = new Set([10, 26]);
const RATE_LIMITED = 29;

/**
 * Song suggestions from Last.fm's listening data: tracks similar to the one playing, topped
 * up with the best-known songs of similar artists. Spotify removed its own recommendation
 * endpoints for new apps, so this is where vote candidates come from.
 */
export class LastFmSuggestions implements SuggestionSource {
  readonly kind = 'lastfm' as const;
  private readonly cache: LruCache<string, SongRef[]>;

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    // Listening data changes slowly; an hour keeps repeat rounds for a song from calling Last.fm again.
    this.cache = new LruCache(200, 60 * 60_000, now);
  }

  async similarTo(track: Track): Promise<SongRef[]> {
    const artist = mainArtist(track)?.name;
    if (!artist) return [];
    const key = songKey(track);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const similar = await this.call(
      { method: 'track.getsimilar', artist, track: baseTitle(track.name), limit: '50', autocorrect: '1' },
      SimilarTracks,
    );
    const refs: SongRef[] = (similar?.similartracks.track ?? []).map(toRef);

    if (refs.length < ENOUGH_TRACKS) {
      const artists = await this.call(
        { method: 'artist.getsimilar', artist, limit: String(SIMILAR_ARTISTS), autocorrect: '1' },
        SimilarArtists,
      );
      const names = (artists?.similarartists.artist ?? []).map((a) => a.name);
      const tops = await Promise.all(
        names.map((name) =>
          this.call(
            { method: 'artist.gettoptracks', artist: name, limit: String(TOP_TRACKS_PER_ARTIST) },
            TopTracks,
          ).then((r) => (r?.toptracks.track ?? []).map(toRef)),
        ),
      );
      // Interleave, so each similar artist gets their best song in before anyone's second.
      for (let i = 0; i < TOP_TRACKS_PER_ARTIST; i++) {
        for (const songs of tops) if (songs[i]) refs.push(songs[i]!);
      }
    }

    const seen = new Set<string>();
    const unique = refs.filter((r) => {
      const id = `${r.artist.toLowerCase()}|${baseTitle(r.title)}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    this.cache.set(key, unique);
    return unique;
  }

  /** Calls one API method. Returns null when Last.fm doesn't know the track or artist. */
  private async call<T extends z.ZodType>(params: Record<string, string>, schema: T): Promise<z.infer<T> | null> {
    const url = new URL(API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { 'User-Agent': 'MidnightBox', Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // Never echo the URL: it contains the API key.
      throw new ProviderError('Last.fm did not answer. Check the internet connection.');
    }

    const body: unknown = await res.json().catch(() => null);
    const error = ErrorBody.safeParse(body);
    if (error.success) {
      const { error: code } = error.data;
      if (code === NOT_FOUND) return null;
      if (BAD_KEY.has(code)) throw new ProviderError('Last.fm rejected the API key. Check LASTFM_API_KEY in .env.');
      if (code === RATE_LIMITED) throw new ProviderError('Last.fm is rate limiting requests. Trying again shortly.', 429);
      throw new ProviderError(`Last.fm error ${code}: ${error.data.message ?? 'unknown'}`);
    }
    if (!res.ok) throw new ProviderError(`Last.fm returned HTTP ${res.status}.`, res.status);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ProviderError('Last.fm sent an unexpected response.');
    return parsed.data;
  }
}

function toRef(song: z.infer<typeof Song>): SongRef {
  return { title: song.name, artist: song.artist.name };
}
