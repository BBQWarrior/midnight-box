import { describe, expect, it } from 'vitest';
import type { Track } from '@shared/types';
import { LastFmSuggestions } from '../src/providers/lastfm.js';

const KEY = '0123456789abcdef0123456789abcdef';
const track: Track = {
  id: 'abc',
  uri: 'spotify:track:abc',
  name: 'Heroes - 2017 Remaster',
  artists: [{ id: 'bowie', name: 'David Bowie' }],
  album: 'Heroes',
  albumId: null,
  imageUrl: null,
  durationMs: 371_000,
  explicit: false,
};

const song = (name: string, artist: string) => ({ name, artist: { name: artist } });

/** Answers by API method (and artist, for top tracks), recording each request. */
function fakeLastFm(answers: (params: URLSearchParams) => unknown) {
  const requests: URL[] = [];
  const fetchFn = (async (input: URL) => {
    requests.push(input);
    return new Response(JSON.stringify(answers(input.searchParams)), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe('Last.fm suggestions', () => {
  it('asks for tracks similar to the song without its version suffix, and caches them', async () => {
    const tracks = Array.from({ length: 25 }, (_, i) => song(`Song ${i}`, `Artist ${i}`));
    const { fetchFn, requests } = fakeLastFm(() => ({ similartracks: { track: tracks } }));
    const lastfm = new LastFmSuggestions(KEY, fetchFn);

    const refs = await lastfm.similarTo(track);
    expect(refs).toHaveLength(25);
    expect(refs[0]).toEqual({ title: 'Song 0', artist: 'Artist 0' });
    const params = requests[0]!.searchParams;
    expect(params.get('method')).toBe('track.getsimilar');
    expect(params.get('track')).toBe('heroes');
    expect(params.get('artist')).toBe('David Bowie');
    expect(params.get('api_key')).toBe(KEY);

    await lastfm.similarTo(track);
    expect(requests).toHaveLength(1);
  });

  it("tops up a short list with similar artists' best songs, best songs first", async () => {
    const { fetchFn } = fakeLastFm((p) => {
      switch (p.get('method')) {
        case 'track.getsimilar':
          // A single result comes back as an object, not an array.
          return { similartracks: { track: song('Ashes to Ashes', 'David Bowie') } };
        case 'artist.getsimilar':
          return { similarartists: { artist: [{ name: 'Iggy Pop' }, { name: 'Brian Eno' }] } };
        default: {
          const a = p.get('artist')!;
          return { toptracks: { track: [song(`${a} hit`, a), song(`${a} deep cut`, a)] } };
        }
      }
    });
    const refs = await new LastFmSuggestions(KEY, fetchFn).similarTo(track);
    expect(refs.map((r) => r.title)).toEqual([
      'Ashes to Ashes',
      'Iggy Pop hit',
      'Brian Eno hit',
      'Iggy Pop deep cut',
      'Brian Eno deep cut',
    ]);
  });

  it('treats unknown songs as no suggestions', async () => {
    const { fetchFn } = fakeLastFm(() => ({ error: 6, message: 'Track not found' }));
    expect(await new LastFmSuggestions(KEY, fetchFn).similarTo(track)).toEqual([]);
  });

  it('explains a bad API key without ever echoing it', async () => {
    const { fetchFn } = fakeLastFm(() => ({ error: 10, message: 'Invalid API key' }));
    const err = await new LastFmSuggestions(KEY, fetchFn).similarTo(track).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/LASTFM_API_KEY/);
    expect((err as Error).message).not.toContain(KEY);

    const offline = (async () => {
      throw new TypeError(`fetch failed for https://ws.audioscrobbler.com/2.0/?api_key=${KEY}`);
    }) as typeof fetch;
    const down = await new LastFmSuggestions(KEY, offline).similarTo(track).catch((e: unknown) => e);
    expect((down as Error).message).not.toContain(KEY);
  });
});
