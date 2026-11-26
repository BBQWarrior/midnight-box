import { z } from 'zod';
import type { Device, Track } from '@shared/types';
import {
  type MusicProvider,
  type PlaybackState,
  ProviderError,
  type SearchResult,
} from '../types.js';
import { bestMatch } from '../../lib/tracks.js';
import type { SpotifyAuth } from './auth.js';

const API = 'https://api.spotify.com/v1';
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

// Minimal response schemas: only the fields we use. Unknown fields are stripped.
const SpotifyImage = z.object({ url: z.string(), width: z.number().nullish() });
const SpotifyTrack = z.object({
  id: z.string().nullable(),
  uri: z.string(),
  name: z.string(),
  type: z.literal('track'),
  is_local: z.boolean().optional(),
  is_playable: z.boolean().optional(),
  duration_ms: z.number(),
  explicit: z.boolean(),
  artists: z.array(z.object({ id: z.string().nullable(), name: z.string() })),
  album: z.object({ id: z.string().nullish(), name: z.string(), images: z.array(SpotifyImage).optional() }).optional(),
});
type SpotifyTrack = z.infer<typeof SpotifyTrack>;

const SearchResponse = z.object({
  tracks: z.object({ items: z.array(z.unknown()), total: z.number() }),
});
const PlayerResponse = z.object({
  is_playing: z.boolean(),
  progress_ms: z.number().nullable(),
  item: z.unknown().nullable(),
  device: z.object({ id: z.string().nullable(), name: z.string() }).nullish(),
});
const QueueResponse = z.object({ queue: z.array(z.object({ uri: z.string() }).loose()) });
const DevicesResponse = z.object({
  devices: z.array(
    z.object({
      id: z.string().nullable(),
      name: z.string(),
      type: z.string(),
      is_active: z.boolean(),
      is_restricted: z.boolean().optional(),
    }),
  ),
});

/** Picks the smallest cover that still looks sharp in a ~150px slot at 2x. */
function pickImage(images: { url: string; width?: number | null }[] | undefined): string | null {
  if (!images?.length) return null;
  const sized = images.filter((i) => typeof i.width === 'number').sort((a, b) => a.width! - b.width!);
  return (sized.find((i) => i.width! >= 250) ?? sized.at(-1) ?? images[0]!).url;
}

function toTrack(raw: unknown): Track | null {
  const parsed = SpotifyTrack.safeParse(raw);
  if (!parsed.success) return null;
  const t: SpotifyTrack = parsed.data;
  if (!t.id || t.is_local || t.is_playable === false) return null;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => ({ id: a.id ?? a.name, name: a.name })),
    album: t.album?.name ?? '',
    albumId: t.album?.id ?? null,
    imageUrl: pickImage(t.album?.images),
    durationMs: t.duration_ms,
    explicit: t.explicit,
  };
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export class SpotifyProvider implements MusicProvider {
  readonly kind = 'spotify' as const;

  constructor(
    private readonly auth: SpotifyAuth,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  isReady(): boolean {
    return this.auth.isConnected();
  }

  async search(query: string, offset: number, limit: number): Promise<SearchResult> {
    const data = SearchResponse.parse(
      await this.request('GET', '/search', {
        // No market parameter: with a user token Spotify applies the account's country by itself, and
        // market=from_token on search now needs an extra permission ("Insufficient client scope").
        query: { q: query, type: 'track', limit, offset },
      }),
    );
    return {
      tracks: data.tracks.items.map(toTrack).filter((t): t is Track => t !== null),
      total: data.tracks.total,
    };
  }

  async findTrack(title: string, artist: string): Promise<Track | null> {
    const quoted = (s: string) => `"${s.replace(/"/g, ' ').trim()}"`;
    const { tracks } = await this.search(`track:${quoted(title)} artist:${quoted(artist)}`, 0, 5);
    return bestMatch(tracks, title, artist);
  }

  async getTrack(id: string): Promise<Track | null> {
    if (!SPOTIFY_ID.test(id)) return null;
    try {
      return toTrack(await this.request('GET', `/tracks/${id}`));
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  async getPlayback(): Promise<PlaybackState | null> {
    const raw = await this.request('GET', '/me/player');
    if (raw === null) return null; // 204: no active session
    const data = PlayerResponse.parse(raw);
    return {
      track: data.item ? toTrack(data.item) : null,
      isPlaying: data.is_playing,
      progressMs: data.progress_ms ?? 0,
      device: data.device ?? null,
    };
  }

  async getQueueUris(): Promise<string[]> {
    const raw = await this.request('GET', '/me/player/queue');
    return raw === null ? [] : QueueResponse.parse(raw).queue.map((q) => q.uri);
  }

  async enqueue(uri: string): Promise<void> {
    await this.request('POST', '/me/player/queue', { query: { uri } });
  }

  async playNow(uri: string, deviceId?: string): Promise<void> {
    await this.request('PUT', '/me/player/play', { query: { device_id: deviceId }, body: { uris: [uri] } });
  }

  async pause(): Promise<void> {
    await this.request('PUT', '/me/player/pause');
  }

  async resume(): Promise<void> {
    await this.request('PUT', '/me/player/play');
  }

  async skip(): Promise<void> {
    await this.request('POST', '/me/player/next');
  }

  async getDevices(): Promise<Device[]> {
    const data = DevicesResponse.parse(await this.request('GET', '/me/player/devices'));
    return data.devices
      .filter((d): d is typeof d & { id: string } => d.id !== null && !d.is_restricted)
      .map((d) => ({ id: d.id, name: d.name, type: d.type, isActive: d.is_active }));
  }

  /** Returns parsed JSON, or null for empty (204) responses. */
  private async request(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<unknown> {
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const token = await this.auth.getAccessToken();
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ProviderError('Could not reach Spotify. Check the internet connection.');
    }

    if (res.status === 401 && !retried) {
      await this.auth.refresh();
      return this.request(method, path, opts, true);
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after'));
      throw new ProviderError('Spotify is rate limiting us.', 429, (Number.isFinite(seconds) ? seconds : 5) * 1000);
    }

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null; // some player endpoints answer 200 with a non-JSON body
      }
    }

    if (!res.ok) throw new ProviderError(describeError(res.status, data), res.status);
    return res.status === 204 ? null : data;
  }
}

const ErrorBody = z.object({
  error: z.object({ reason: z.string().optional(), message: z.string().optional() }),
});

/** Turns Spotify's error into words the host can act on, keeping Spotify's own explanation. */
function describeError(status: number, data: unknown): string {
  const body = ErrorBody.safeParse(data);
  const why = body.success ? body.data.error.reason : undefined;
  const said = body.success ? body.data.error.message?.trim().slice(0, 200) : undefined;
  if (why === 'NO_ACTIVE_DEVICE' || (status === 404 && !why)) {
    return 'No active Spotify device. Open Spotify on the speaker device, or pick a device in the admin panel.';
  }
  if (why === 'PREMIUM_REQUIRED') return 'Playback control needs a Spotify Premium account.';
  if (status === 403) {
    // Development Mode: only the app's owner and accounts added in the dashboard may use it.
    if (said && /not be registered|not registered/i.test(said)) {
      return (
        "This Spotify account isn't allowed to use your Spotify app. Connect with the account that created " +
        'the app, or add this one under User Management in the Spotify Developer Dashboard.'
      );
    }
    if (said && /premium/i.test(said)) {
      return `Spotify needs Premium for this (${said}). In Development Mode the app's owner needs Premium too.`;
    }
    return said ? `Spotify refused that action: ${said}` : 'Spotify refused that action.';
  }
  return said ? `Spotify request failed (${status}): ${said}` : `Spotify request failed (${status}).`;
}
