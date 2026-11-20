import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Limits } from '@shared/types';

/** Repo root. Works from both server/src (tsx) and server/dist (bundled). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Treat `KEY=` (empty) in .env the same as an unset variable. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const int = (fallback: number, min: number, max: number) =>
  optional(z.coerce.number().int().min(min).max(max)).transform((v) => v ?? fallback);

const EnvSchema = z.object({
  PORT: int(8080, 1, 65535),
  HOST: optional(z.string()).transform((v) => v ?? '0.0.0.0'),
  PUBLIC_URL: optional(z.url({ protocol: /^https?$/ })),
  SPOTIFY_CLIENT_ID: optional(
    z.string().trim().regex(/^[A-Za-z0-9]{32}$/, 'SPOTIFY_CLIENT_ID should be the 32-character Client ID from the Spotify dashboard'),
  ),
  MAX_PENDING_PER_GUEST: int(3, 1, 50),
  MAX_PER_REQUEST: int(3, 1, 10),
  GUEST_WINDOW_SONGS: int(2, 1, 50),
  GUEST_WINDOW_MINUTES: int(20, 1, 24 * 60),
  SONG_COOLDOWN_MINUTES: int(120, 0, 7 * 24 * 60),
  ARTIST_COOLDOWN_MINUTES: int(20, 0, 7 * 24 * 60),
  LASTFM_API_KEY: optional(
    z.string().trim().regex(/^[0-9a-f]{32}$/i, 'LASTFM_API_KEY should be the 32-character API key from last.fm/api/accounts'),
  ),
  VOTE_ROUND_SECONDS: int(30, 10, 600),
  VOTE_WHEN_FEWER_THAN: int(2, 1, 50),
  DATA_DIR: optional(z.string()),
});

export interface Config {
  /** Started with --dev (tsx watch + Vite dev server). */
  dev: boolean;
  /** Started with --demo: fake music provider, no Spotify needed. */
  demo: boolean;
  /** Started with --reset-host-password: clear the host password and exit. */
  resetHostPassword: boolean;
  port: number;
  host: string;
  /** Explicit URL for the QR code; otherwise derived from the LAN IP. */
  publicUrl: string | undefined;
  spotify: { clientId: string; redirectUri: string } | null;
  limits: Limits;
  vote: {
    /** Null: no suggestions outside demo mode, so vote rounds are off. */
    lastfmApiKey: string | null;
    roundMs: number;
    /** Rounds run while fewer than this many songs are waiting. */
    maxWaiting: number;
  };
  dataDir: string;
  clientDistDir: string;
  /** Where the browser UI lives: Vite in dev, this server in production. */
  uiPort: number;
}

export class ConfigError extends Error {}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const dev = argv.includes('--dev');
  const demo = argv.includes('--demo');
  const resetHostPassword = argv.includes('--reset-host-password');

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid .env configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;

  if (!demo && !resetHostPassword && !e.SPOTIFY_CLIENT_ID) {
    throw new ConfigError(
      'SPOTIFY_CLIENT_ID is not set. Copy .env.example to .env and add your Spotify app Client ID,\n' +
        'or try Midnight Box without Spotify: npm run demo',
    );
  }

  return {
    dev,
    demo,
    resetHostPassword,
    port: e.PORT,
    host: e.HOST,
    publicUrl: e.PUBLIC_URL,
    spotify:
      demo || !e.SPOTIFY_CLIENT_ID
        ? null
        : {
            clientId: e.SPOTIFY_CLIENT_ID,
            // Spotify only allows plain-HTTP redirect URIs on loopback IPs (not "localhost").
            redirectUri: `http://127.0.0.1:${e.PORT}/auth/spotify/callback`,
          },
    limits: {
      maxPendingPerGuest: e.MAX_PENDING_PER_GUEST,
      maxPerRequest: Math.min(e.MAX_PER_REQUEST, e.MAX_PENDING_PER_GUEST),
      windowSongs: e.GUEST_WINDOW_SONGS,
      windowMinutes: e.GUEST_WINDOW_MINUTES,
      songCooldownMinutes: e.SONG_COOLDOWN_MINUTES,
      artistCooldownMinutes: e.ARTIST_COOLDOWN_MINUTES,
    },
    vote: {
      lastfmApiKey: e.LASTFM_API_KEY ?? null,
      roundMs: e.VOTE_ROUND_SECONDS * 1000,
      maxWaiting: e.VOTE_WHEN_FEWER_THAN,
    },
    dataDir: path.resolve(ROOT_DIR, e.DATA_DIR ?? 'data'),
    clientDistDir: path.join(ROOT_DIR, 'client', 'dist'),
    uiPort: dev ? 5173 : e.PORT,
  };
}
