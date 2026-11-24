import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import type { JoinInfo } from '@shared/types';
import { ConfigError, loadConfig, ROOT_DIR } from './config.js';
import { getOrCreateSecret, openDb } from './db.js';
import { buildApp } from './http/app.js';
import { lanAddress } from './lib/net.js';
import { MOCK_CATALOG } from './providers/mock/catalog.js';
import { LastFmSuggestions } from './providers/lastfm.js';
import { MockProvider } from './providers/mock/provider.js';
import { MockSuggestions } from './providers/mock/suggestions.js';
import { SpotifyAuth } from './providers/spotify/auth.js';
import { SpotifyProvider } from './providers/spotify/provider.js';
import type { MusicProvider, SuggestionSource } from './providers/types.js';
import { CooldownService } from './services/cooldowns.js';
import { GuestService } from './services/guests.js';
import { HostAuth } from './services/host-auth.js';
import { Player } from './services/player.js';
import { QueueService } from './services/queue.js';
import { StateHub } from './services/state.js';
import { SkipService } from './services/skips.js';
import { VoteService } from './services/votes.js';

async function main(): Promise<void> {
  const envFile = path.join(ROOT_DIR, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig(process.argv.slice(2), process.env);

  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, config.demo ? 'midnight-box-demo.db' : 'midnight-box.db'));
  const hostAuth = new HostAuth(db);

  if (config.resetHostPassword) {
    hostAuth.reset();
    db.close();
    console.log('\n  Host password cleared. Open the host panel on this computer to set a new one.\n');
    return;
  }

  let provider: MusicProvider;
  let suggestions: SuggestionSource | null = null;
  let spotifyAuth: SpotifyAuth | null = null;
  if (config.spotify) {
    spotifyAuth = new SpotifyAuth(db, config.spotify.clientId, config.spotify.redirectUri);
    provider = new SpotifyProvider(spotifyAuth);
    if (config.vote.lastfmApiKey) suggestions = new LastFmSuggestions(config.vote.lastfmApiKey);
  } else {
    // Demo songs are shortened so you can watch the queue move without waiting minutes.
    const catalog = MOCK_CATALOG.map((t) => ({ ...t, durationMs: Math.round(t.durationMs / 4) }));
    provider = new MockProvider({ catalog, startPlaying: true });
    suggestions = new MockSuggestions(catalog);
  }

  const queue = new QueueService(db);
  queue.recoverAfterRestart();
  const guests = new GuestService(db);
  const cooldowns = new CooldownService(db, queue, {
    songMs: config.limits.songCooldownMinutes * 60_000,
    artistMs: config.limits.artistCooldownMinutes * 60_000,
  });

  let hub: StateHub | undefined;
  // Human-readable logs: the person reading them is the host at a party, not a log pipeline.
  const logger = {
    level: 'info',
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  };

  // The player needs somewhere to log before Fastify exists; it's rebound below.
  const log = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };
  const player = new Player(
    { provider, queue, log, onChange: () => hub?.broadcast() },
    config.demo
      ? { pollMs: 1_000, idlePollMs: 2_000, pushAheadMs: 8_000, autoStartCooldownMs: 5_000 }
      : { pollMs: 3_000, idlePollMs: 5_000, pushAheadMs: 20_000, autoStartCooldownMs: 10_000 },
  );
  const votes = new VoteService(
    { db, provider, source: suggestions, queue, cooldowns, player, log, onChange: () => hub?.broadcast() },
    {
      roundMs: config.vote.roundMs,
      maxWaiting: config.vote.maxWaiting,
      candidates: 4,
      retryMs: config.vote.roundMs,
    },
  );
  const skips = new SkipService(
    { db, guests, player, log, onChange: () => hub?.broadcast() },
    { activeMs: 15 * 60_000, minVotes: 2 },
  );
  hub = new StateHub({ provider, queue, player, votes, skips, limits: config.limits, demo: config.demo });

  const joinUrl = config.publicUrl ?? `http://${lanAddress()}:${config.uiPort}/`;
  const joinInfo: JoinInfo = {
    joinUrl,
    qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(
      await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    ).toString('base64')}`,
  };

  const { app } = await buildApp({
    config,
    provider,
    spotifyAuth,
    guests,
    queue,
    cooldowns,
    hostAuth,
    player,
    votes,
    skips,
    hub,
    joinInfo,
    cookieSecret: getOrCreateSecret(db, 'cookie_secret'),
    logger,
  });
  log.info = (m) => app.log.info(m);
  log.warn = (m) => app.log.warn(m);

  await app.listen({ port: config.port, host: config.host });
  player.start();
  votes.start();

  // Keep only the history that cooldowns and limits still need: Spotify's terms forbid storing
  // their content indefinitely.
  const { limits } = config;
  const historyMs = Math.max(limits.songCooldownMinutes, limits.artistCooldownMinutes, limits.windowMinutes) * 60_000;
  const prune = () => queue.prune(Date.now() - historyMs);
  prune();
  const pruneTimer = setInterval(prune, 10 * 60_000);

  const adminUrl = `http://127.0.0.1:${config.uiPort}/admin`;
  const qr = await QRCode.toString(joinUrl, { type: 'terminal', small: true });
  console.log(
    [
      '',
      `  Midnight Box${config.demo ? ' (demo mode)' : ''} is running`,
      '',
      `  Guests join:  ${joinUrl}`,
      `  Host panel:   ${adminUrl}`,
      hostAuth.hasPassword() ? null : '  First run: open the host panel on this computer to set a host password.',
      provider.isReady() ? null : '  Connect Spotify from the host panel to start.',
      '',
      qr,
    ]
      .filter((line) => line !== null)
      .join('\n'),
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    player.stop();
    votes.stop();
    clearInterval(pruneTimer);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
