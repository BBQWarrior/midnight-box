import { describe, expect, it } from 'vitest';
import { kvSet, openDb } from '../src/db.js';
import { SpotifyAuth } from '../src/providers/spotify/auth.js';
import { SpotifyProvider } from '../src/providers/spotify/provider.js';
import { ProviderError } from '../src/providers/types.js';

/** A connected provider whose every API call gets this answer. */
function answering(status: number, body: unknown) {
  const db = openDb(':memory:');
  kvSet(db, 'spotify_tokens', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
  const auth = new SpotifyAuth(db, 'client-id', 'http://127.0.0.1:8080/auth/spotify/callback');
  const fetchFn = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  return new SpotifyProvider(auth, fetchFn);
}

async function searchError(status: number, message: string): Promise<ProviderError> {
  try {
    await answering(status, { error: { status, message } }).search('posts', 0, 10);
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error('search should have failed');
}

describe('Spotify errors', () => {
  it("tells the host when the Spotify account isn't allowed to use their app", async () => {
    const err = await searchError(403, 'Check settings on developer.spotify.com/dashboard, the user may not be registered.');
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/User Management/);
  });

  it('passes on what Spotify said for other refusals and failures', async () => {
    expect((await searchError(403, 'Insufficient client scope')).message).toBe(
      'Spotify refused that action: Insufficient client scope',
    );
    expect((await searchError(400, 'Invalid limit')).message).toBe('Spotify request failed (400): Invalid limit');
  });
});

describe('Spotify search', () => {
  it('sends no market parameter, which would need an extra permission', async () => {
    const urls: URL[] = [];
    const db = openDb(':memory:');
    kvSet(db, 'spotify_tokens', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
    const fetchFn = (async (input: URL) => {
      urls.push(input);
      return new Response(JSON.stringify({ tracks: { items: [], total: 0 } }), { status: 200 });
    }) as typeof fetch;
    const spotify = new SpotifyProvider(new SpotifyAuth(db, 'client-id', 'http://127.0.0.1:8080/auth/spotify/callback'), fetchFn);
    await spotify.search('posts', 0, 10);
    expect(urls[0]?.pathname).toBe('/v1/search');
    expect(urls[0]?.searchParams.has('market')).toBe(false);
  });
});
