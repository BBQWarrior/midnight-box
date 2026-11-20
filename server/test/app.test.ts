import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddToQueueResponse, Me } from '@shared/types';
import type { Config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { MOCK_CATALOG } from '../src/providers/mock/catalog.js';
import { MockProvider } from '../src/providers/mock/provider.js';
import { GuestService } from '../src/services/guests.js';
import { Player } from '../src/services/player.js';
import { QueueService } from '../src/services/queue.js';
import { StateHub } from '../src/services/state.js';

const silent = { info() {}, warn() {} };
const [t1, t2, t3] = MOCK_CATALOG.slice(3).map((t) => t.id) as [string, string, string];

const config: Config = {
  dev: false,
  demo: true,
  port: 8080,
  host: '127.0.0.1',
  publicUrl: undefined,
  spotify: null,
  limits: { maxPendingPerGuest: 2, maxPerRequest: 2 },
  dataDir: '',
  clientDistDir: '/nonexistent',
  uiPort: 8080,
};

let app: FastifyInstance;

async function makeApp() {
  const db = openDb(':memory:');
  const provider = new MockProvider({ startPlaying: true });
  const queue = new QueueService(db);
  const guests = new GuestService(db);
  const player = new Player(
    { provider, queue, onChange: () => {}, log: silent },
    { pollMs: 1_000, idlePollMs: 1_000, pushAheadMs: 1_000, autoStartCooldownMs: 0 },
  );
  const hub = new StateHub({ provider, queue, player, limits: config.limits, demo: true });
  ({ app } = await buildApp({
    config,
    provider,
    spotifyAuth: null,
    guests,
    queue,
    player,
    hub,
    joinInfo: { joinUrl: 'http://192.168.1.10:8080/', qrDataUrl: 'data:image/svg+xml;base64,' },
    cookieSecret: 'test-cookie-secret-that-is-long-enough',
    logger: false,
  }));
  return app;
}

/** Joins as a new guest; returns the cookie jar to use for that guest's requests. */
async function join(name: string | null = 'Alex') {
  const res = await app.inject({ method: 'GET', url: '/api/me' });
  const cookie = res.cookies.find((c) => c.name === 'mb_guest');
  if (!cookie) throw new Error('no guest cookie');
  const cookies = { mb_guest: cookie.value };
  if (name) await app.inject({ method: 'PUT', url: '/api/me', cookies, payload: { name } });
  return cookies;
}

const queueSongs = (cookies: Record<string, string>, trackIds: string[]) =>
  app.inject({ method: 'POST', url: '/api/queue', cookies, payload: { trackIds } });

afterEach(async () => {
  await app.close();
});

describe('guests', () => {
  it('get an anonymous, httpOnly session and can pick a name', async () => {
    await makeApp();
    const first = await app.inject({ method: 'GET', url: '/api/me' });
    expect(first.json<Me>().name).toBeNull();
    expect(first.cookies[0]).toMatchObject({ name: 'mb_guest', httpOnly: true, sameSite: 'Lax' });

    const cookies = { mb_guest: first.cookies[0]!.value };
    const named = await app.inject({ method: 'PUT', url: '/api/me', cookies, payload: { name: '  Zoë \u0007 ' } });
    expect(named.json<Me>().name).toBe('Zoë');
  });

  it('must pick a name before queueing', async () => {
    await makeApp();
    const res = await queueSongs(await join(null), [t1]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('name_required');
  });

  it('cannot forge a session cookie', async () => {
    await makeApp();
    const res = await queueSongs({ mb_guest: '00000000-0000-4000-8000-000000000000.fake' }, [t1]);
    expect(res.json().error.code).toBe('name_required');
  });
});

describe('queueing', () => {
  it('adds several songs at once and enforces the per-guest limit', async () => {
    await makeApp();
    const alex = await join();

    const first = (await queueSongs(alex, [t1, t2])).json<AddToQueueResponse>();
    expect(first.added.map((e) => e.track.id)).toEqual([t1, t2]);
    expect(first.added[0]?.requestedBy?.name).toBe('Alex');

    const second = (await queueSongs(alex, [t3])).json<AddToQueueResponse>();
    expect(second.rejected).toEqual([{ trackId: t3, reason: 'limit_reached' }]);
  });

  it('rejects songs that are already in the queue', async () => {
    await makeApp();
    await queueSongs(await join('Alex'), [t1]);
    const res = (await queueSongs(await join('Sam'), [t1])).json<AddToQueueResponse>();
    expect(res.rejected).toEqual([{ trackId: t1, reason: 'already_queued' }]);
  });

  it('looks tracks up itself instead of trusting the client', async () => {
    await makeApp();
    const res = (await queueSongs(await join(), ['mock:made-up-song'])).json<AddToQueueResponse>();
    expect(res.rejected).toEqual([{ trackId: 'mock:made-up-song', reason: 'not_found' }]);
  });

  it('rejects oversized batches', async () => {
    await makeApp();
    const res = await queueSongs(await join(), [t1, t2, t3]);
    expect(res.statusCode).toBe(400);
  });
});

describe('security', () => {
  const status = (remoteAddress: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/admin/status', remoteAddress, headers: { host: '127.0.0.1:8080', ...headers } });

  it('allows admin routes from the host machine', async () => {
    await makeApp();
    expect((await status('127.0.0.1')).statusCode).toBe(200);
    expect((await status('::1', { host: 'localhost:8080' })).statusCode).toBe(200);
  });

  it('blocks admin routes from other devices on the network', async () => {
    await makeApp();
    expect((await status('192.168.1.20')).statusCode).toBe(403);
  });

  it('blocks phones reaching admin through the dev proxy', async () => {
    await makeApp();
    expect((await status('127.0.0.1', { 'x-forwarded-for': '192.168.1.20' })).statusCode).toBe(403);
  });

  it('blocks DNS rebinding (loopback peer, foreign Host header)', async () => {
    await makeApp();
    expect((await status('127.0.0.1', { host: 'evil.example:8080' })).statusCode).toBe(403);
  });

  it('blocks cross-site writes', async () => {
    await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/playback',
      headers: { host: '127.0.0.1:8080', origin: 'http://evil.example', 'content-type': 'application/json' },
      payload: { action: 'skip' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('only accepts JSON bodies', async () => {
    await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/queue',
      headers: { 'content-type': 'text/plain' },
      payload: '{"trackIds":["x"]}',
    });
    expect(res.statusCode).toBe(415);
  });

  it('sends a strict CSP and no HSTS', async () => {
    await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
