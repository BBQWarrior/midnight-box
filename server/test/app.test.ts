import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AddToQueueResponse,
  AdminStatus,
  HostSession,
  Limits,
  Me,
  MyVotes,
  PublicState,
  SearchResponse,
} from '@shared/types';
import type { Config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { MOCK_CATALOG } from '../src/providers/mock/catalog.js';
import { MockProvider } from '../src/providers/mock/provider.js';
import { MockSuggestions } from '../src/providers/mock/suggestions.js';
import { CooldownService } from '../src/services/cooldowns.js';
import { GuestService } from '../src/services/guests.js';
import { HostAuth } from '../src/services/host-auth.js';
import { Player } from '../src/services/player.js';
import { QueueService } from '../src/services/queue.js';
import { StateHub } from '../src/services/state.js';
import { VoteService } from '../src/services/votes.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const silent = { info() {}, warn() {} };
// The catalog lists three songs per artist, so these are by three different artists.
const [t1, t2, t3] = [3, 6, 9].map((i) => MOCK_CATALOG[i]!.id) as [string, string, string];
const t1Sibling = MOCK_CATALOG[4]!.id;

const PHONE = '192.168.1.20';
const PASSWORD = 'correct horse battery';

const baseConfig: Config = {
  dev: false,
  demo: true,
  resetHostPassword: false,
  port: 8080,
  host: '127.0.0.1',
  publicUrl: undefined,
  spotify: null,
  limits: {
    maxPendingPerGuest: 2,
    maxPerRequest: 2,
    windowSongs: 10,
    windowMinutes: 20,
    songCooldownMinutes: 120,
    artistCooldownMinutes: 20,
  },
  vote: { lastfmApiKey: null, roundMs: 30_000, maxWaiting: 2 },
  dataDir: '',
  clientDistDir: '/nonexistent',
  uiPort: 8080,
};

let app: FastifyInstance;
let advance: (ms: number) => void;
let player: Player;
let votes: VoteService;

async function makeApp(limits: Partial<Limits> = {}) {
  let t = T0;
  const now = () => t;
  advance = (ms) => {
    t += ms;
  };
  const config = { ...baseConfig, limits: { ...baseConfig.limits, ...limits } };
  const db = openDb(':memory:');
  const provider = new MockProvider({ startPlaying: true, now });
  const queue = new QueueService(db, now);
  const guests = new GuestService(db, now);
  const cooldowns = new CooldownService(
    db,
    queue,
    { songMs: config.limits.songCooldownMinutes * MIN, artistMs: config.limits.artistCooldownMinutes * MIN },
    now,
  );
  const hostAuth = new HostAuth(db, now);
  player = new Player(
    { provider, queue, onChange: () => {}, log: silent, now },
    { pollMs: 1_000, idlePollMs: 1_000, pushAheadMs: 1_000, autoStartCooldownMs: 0 },
  );
  votes = new VoteService(
    {
      db,
      provider,
      source: new MockSuggestions(MOCK_CATALOG),
      queue,
      cooldowns,
      player,
      log: silent,
      onChange: () => {},
      now,
      shuffle: (items) => items,
    },
    { roundMs: config.vote.roundMs, maxWaiting: config.vote.maxWaiting, candidates: 4, retryMs: 30_000 },
  );
  const hub = new StateHub({ provider, queue, player, votes, limits: config.limits, demo: true, now });
  ({ app } = await buildApp({
    config,
    provider,
    spotifyAuth: null,
    guests,
    queue,
    cooldowns,
    hostAuth,
    player,
    votes,
    hub,
    joinInfo: { joinUrl: 'http://192.168.1.10:8080/', qrDataUrl: 'data:image/svg+xml;base64,' },
    cookieSecret: 'test-cookie-secret-that-is-long-enough',
    logger: false,
    now,
  }));
  return app;
}

/** Joins as a new guest; returns the cookie jar to use for that guest's requests. */
async function join(name: string | null = 'Alex', remoteAddress = '127.0.0.1') {
  const res = await app.inject({ method: 'GET', url: '/api/me', remoteAddress });
  const cookie = res.cookies.find((c) => c.name === 'mb_guest');
  if (!cookie) throw new Error('no guest cookie');
  const cookies = { mb_guest: cookie.value };
  if (name) await app.inject({ method: 'PUT', url: '/api/me', cookies, remoteAddress, payload: { name } });
  return cookies;
}

const queueSongs = (cookies: Record<string, string>, trackIds: string[], remoteAddress = '127.0.0.1') =>
  app.inject({ method: 'POST', url: '/api/queue', cookies, remoteAddress, payload: { trackIds } });

const state = async () => (await app.inject({ method: 'GET', url: '/api/state' })).json<PublicState>();

/** First-run setup on the host computer; returns the host session cookie. */
async function setUpHost() {
  const res = await app.inject({ method: 'POST', url: '/api/admin/setup', payload: { password: PASSWORD } });
  const cookie = res.cookies.find((c) => c.name === 'mb_host');
  if (res.statusCode !== 204 || !cookie) throw new Error(`setup failed: ${res.statusCode}`);
  return { mb_host: cookie.value };
}

afterEach(async () => {
  await app.close();
});

describe('guests', () => {
  it('get an anonymous, httpOnly session and can pick a name', async () => {
    await makeApp();
    const first = await app.inject({ method: 'GET', url: '/api/me' });
    expect(first.json<Me>()).toMatchObject({ name: null, quota: { pending: 0, recentAdds: [] } });
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
    expect(first.quota).toEqual({ pending: 2, recentAdds: [T0, T0] });

    const second = (await queueSongs(alex, [t3])).json<AddToQueueResponse>();
    expect(second.rejected).toEqual([{ trackId: t3, reason: 'limit_reached', availableAt: null }]);
  });

  it('limits how many songs a guest can add per time window', async () => {
    await makeApp({ windowSongs: 2, windowMinutes: 20, maxPendingPerGuest: 5, maxPerRequest: 3 });
    const alex = await join();
    await queueSongs(alex, [t1]);
    advance(5 * MIN);
    await queueSongs(alex, [t2]);

    const blocked = (await queueSongs(alex, [t3])).json<AddToQueueResponse>();
    expect(blocked.rejected).toEqual([{ trackId: t3, reason: 'too_soon', availableAt: T0 + 20 * MIN }]);

    advance(15 * MIN);
    const later = (await queueSongs(alex, [t3])).json<AddToQueueResponse>();
    expect(later.added.map((e) => e.track.id)).toEqual([t3]);
  });

  it('rejects songs that are already in the queue', async () => {
    await makeApp();
    await queueSongs(await join('Alex'), [t1]);
    const res = (await queueSongs(await join('Sam'), [t1])).json<AddToQueueResponse>();
    expect(res.rejected).toEqual([{ trackId: t1, reason: 'already_queued', availableAt: null }]);
  });

  it('allows one song per main artist in the queue', async () => {
    await makeApp();
    await queueSongs(await join('Alex'), [t1]);
    const res = (await queueSongs(await join('Sam'), [t1Sibling, t2])).json<AddToQueueResponse>();
    expect(res.rejected).toEqual([{ trackId: t1Sibling, reason: 'artist_queued', availableAt: null }]);
    expect(res.added.map((e) => e.track.id)).toEqual([t2]);
  });

  it('marks search results that cannot be requested', async () => {
    await makeApp();
    const alex = await join();
    await queueSongs(alex, [t1]);
    const res = await app.inject({ method: 'GET', url: '/api/search?q=velvet', cookies: alex });
    const blocks = Object.fromEntries(res.json<SearchResponse>().results.map((r) => [r.track.id, r.block?.reason]));
    expect(blocks).toEqual({ [t1]: 'already_queued', [t1Sibling]: 'artist_queued', [MOCK_CATALOG[5]!.id]: 'artist_queued' });
  });

  it('looks tracks up itself instead of trusting the client', async () => {
    await makeApp();
    const res = (await queueSongs(await join(), ['mock:made-up-song'])).json<AddToQueueResponse>();
    expect(res.rejected).toEqual([{ trackId: 'mock:made-up-song', reason: 'not_found', availableAt: null }]);
  });

  it('rejects oversized batches', async () => {
    await makeApp();
    const res = await queueSongs(await join(), [t1, t2, t3]);
    expect(res.statusCode).toBe(400);
  });
});

describe('host login', () => {
  const session = async (remoteAddress = '127.0.0.1', cookies = {}) =>
    (await app.inject({ method: 'GET', url: '/api/admin/session', remoteAddress, cookies })).json<HostSession>();
  const status = (cookies: Record<string, string>, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'GET', url: '/api/admin/status', cookies, remoteAddress });
  const login = (password: string, remoteAddress = PHONE) =>
    app.inject({ method: 'POST', url: '/api/admin/login', remoteAddress, payload: { password } });

  it('sets the password on first run, from the host computer only', async () => {
    await makeApp();
    expect(await session()).toEqual({ passwordSet: false, loggedIn: false, onHostMachine: true });

    const setup = (remoteAddress: string, host = '127.0.0.1:8080', password = PASSWORD) =>
      app.inject({ method: 'POST', url: '/api/admin/setup', remoteAddress, headers: { host }, payload: { password } });
    expect((await setup(PHONE)).statusCode).toBe(403);
    expect((await setup('127.0.0.1', 'evil.example:8080')).statusCode).toBe(403); // DNS rebinding
    expect((await setup('127.0.0.1', '127.0.0.1:8080', 'short')).statusCode).toBe(400);

    const ok = await setup('127.0.0.1');
    expect(ok.statusCode).toBe(204);
    expect(ok.cookies[0]).toMatchObject({ name: 'mb_host', httpOnly: true, sameSite: 'Strict' });
    // Never overwritten afterwards, not even from the host computer.
    expect((await setup('127.0.0.1')).statusCode).toBe(400);
  });

  it('requires a session for the host panel, even on the host computer', async () => {
    await makeApp();
    expect((await status({})).statusCode).toBe(401);
    expect((await status({ mb_host: 'made-up-token' })).statusCode).toBe(401);
    expect((await status(await setUpHost())).statusCode).toBe(200);
  });

  it('lets the host log in from a phone', async () => {
    await makeApp();
    await setUpHost();
    expect((await login('wrong password')).statusCode).toBe(401);

    const res = await login(PASSWORD);
    expect(res.statusCode).toBe(204);
    const cookies = { mb_host: res.cookies[0]!.value };
    expect(await session(PHONE, cookies)).toEqual({ passwordSet: true, loggedIn: true, onHostMachine: false });
    const panel = await status(cookies, PHONE);
    expect(panel.statusCode).toBe(200);
    expect(panel.json<AdminStatus>().onHostMachine).toBe(false);
  });

  it('rate limits password guessing', async () => {
    await makeApp();
    await setUpHost();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await login(`guess ${i}`)).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('expires sessions after 12 hours and on logout', async () => {
    await makeApp();
    const cookies = await setUpHost();
    advance(12 * 60 * MIN - 1);
    expect((await status(cookies)).statusCode).toBe(200);
    advance(1);
    expect((await status(cookies)).statusCode).toBe(401);

    const fresh = { mb_host: (await login(PASSWORD)).cookies[0]!.value };
    await app.inject({ method: 'POST', url: '/api/admin/logout', cookies: fresh });
    expect((await status(fresh)).statusCode).toBe(401);
  });
});

describe('banning', () => {
  const GUEST_IP = '192.168.1.30';

  it('locks out the guest and their device, and drops their queued songs', async () => {
    await makeApp();
    const host = await setUpHost();
    const alex = await join('Alex', GUEST_IP);
    const added = (await queueSongs(alex, [t1], GUEST_IP)).json<AddToQueueResponse>();
    const publicId = added.added[0]!.requestedBy!.publicId;

    const ban = await app.inject({ method: 'POST', url: `/api/admin/guests/${publicId}/ban`, cookies: host });
    expect(ban.statusCode).toBe(204);
    expect((await state()).queue).toEqual([]);
    expect((await queueSongs(alex, [t2], GUEST_IP)).statusCode).toBe(403);
    // Clearing cookies doesn't help: the address is blocked too.
    expect((await app.inject({ method: 'GET', url: '/api/me', remoteAddress: GUEST_IP })).statusCode).toBe(403);
    // Other guests are fine.
    expect((await queueSongs(await join('Sam', '192.168.1.31'), [t2], '192.168.1.31')).statusCode).toBe(200);

    const panel = (await app.inject({ method: 'GET', url: '/api/admin/status', cookies: host })).json<AdminStatus>();
    expect(panel.banned).toEqual([{ publicId, name: 'Alex' }]);

    await app.inject({ method: 'DELETE', url: `/api/admin/guests/${publicId}/ban`, cookies: host });
    expect((await queueSongs(alex, [t3], GUEST_IP)).statusCode).toBe(200);
  });

  it('needs a host session', async () => {
    await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/admin/guests/AAAAAAAAAAAA/ban' });
    expect(res.statusCode).toBe(401);
  });
});

describe('vote rounds', () => {
  async function startRound() {
    await player.tick();
    await votes.tick();
    const round = (await state()).vote.round;
    if (!round) throw new Error('no round started');
    return round;
  }

  const castVote = (cookies: Record<string, string>, roundId: number, trackId: string, vote = true, remoteAddress = PHONE) =>
    app.inject({ method: 'POST', url: '/api/vote', cookies, remoteAddress, payload: { roundId, trackId, vote } });

  const voteCounts = async () => (await state()).vote.round!.candidates.map((c) => c.votes);

  it('adds the most voted song as a vote pick, and votes never use up queue limits', async () => {
    await makeApp({ windowSongs: 1 });
    const maya = await join('Maya', PHONE);
    expect((await queueSongs(maya, [t1], PHONE)).json<AddToQueueResponse>().added).toHaveLength(1);

    // Maya has used up her songs for this window, but she can still vote, for several songs.
    const round = await startRound();
    expect(round.candidates).toHaveLength(4);
    const [a, b] = round.candidates.map((c) => c.track.id) as [string, string];
    expect((await castVote(maya, round.id, a)).json<MyVotes>().trackIds).toEqual([a]);
    expect((await castVote(maya, round.id, b)).json<MyVotes>().trackIds).toEqual([a, b]);
    const leo = await join('Leo', '192.168.1.21');
    await castVote(leo, round.id, b, true, '192.168.1.21');
    expect(await voteCounts()).toEqual([1, 2, 0, 0]);

    advance(30_000);
    await votes.tick();
    const after = await state();
    expect(after.vote.lastResult).toMatchObject({ roundId: round.id, winner: { id: b }, votes: 2 });
    expect(after.queue.map((e) => [e.track.id, e.votePick, e.requestedBy?.name ?? null])).toEqual([
      [t1, false, 'Maya'],
      [b, true, null],
    ]);
    // Two songs are waiting now, so no new round starts.
    expect(after.vote.round).toBeNull();
  });

  it('counts one vote per device and lets guests take votes back', async () => {
    await makeApp();
    const round = await startRound();
    const id = round.candidates[0]!.track.id;
    const phone = await join('Maya', PHONE);
    const samePhoneNewCookie = await join('Maya again', PHONE);
    await castVote(phone, round.id, id);
    await castVote(samePhoneNewCookie, round.id, id);
    expect((await voteCounts())[0]).toBe(1);

    // On the host computer every guest session counts, since they all share 127.0.0.1.
    await castVote(await join('Host A'), round.id, id, true, '127.0.0.1');
    await castVote(await join('Host B'), round.id, id, true, '127.0.0.1');
    expect((await voteCounts())[0]).toBe(3);

    expect((await castVote(phone, round.id, id, false)).json<MyVotes>()).toEqual({ roundId: round.id, trackIds: [] });
    expect((await voteCounts())[0]).toBe(2);
    const mine = await app.inject({ method: 'GET', url: '/api/vote', cookies: samePhoneNewCookie, remoteAddress: PHONE });
    expect(mine.json<MyVotes>()).toEqual({ roundId: round.id, trackIds: [] });
  });

  it('rejects votes for another round, a song not on the ballot, or after time is up', async () => {
    await makeApp();
    const round = await startRound();
    const guest = await join('Maya', PHONE);
    const candidate = round.candidates[0]!.track.id;
    const other = MOCK_CATALOG.find((t) => !round.candidates.some((c) => c.track.id === t.id))!.id;

    expect((await castVote(guest, round.id + 1, candidate)).json().error.message).toMatch(/ended/);
    expect((await castVote(guest, round.id, other)).json().error.message).toMatch(/not in this vote/);
    advance(30_000);
    expect((await castVote(guest, round.id, candidate)).statusCode).toBe(400);
    expect((await castVote(await join(null, PHONE), round.id, candidate)).json().error.code).toBe('name_required');
  });

  it('lets the host end a round early and turn voting off', async () => {
    await makeApp();
    const host = await setUpHost();
    const round = await startRound();
    const pick = round.candidates[2]!.track.id;
    await castVote(await join('Maya', PHONE), round.id, pick);

    const end = (cookies?: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/admin/vote/end', cookies, payload: {} });
    expect((await end()).statusCode).toBe(401);
    expect((await end(host)).statusCode).toBe(204);
    expect((await state()).queue.at(-1)).toMatchObject({ votePick: true, track: { id: pick } });

    await app.inject({ method: 'POST', url: '/api/admin/vote', cookies: host, payload: { enabled: false } });
    await votes.tick();
    expect((await state()).vote).toMatchObject({ active: false, round: null });
    const status = (await app.inject({ method: 'GET', url: '/api/admin/status', cookies: host })).json<AdminStatus>();
    expect(status.voting).toEqual({ source: 'demo', enabled: false, problem: null });
  });

  it("drops a removed guest's votes", async () => {
    await makeApp();
    const host = await setUpHost();
    const round = await startRound();
    const guest = await join('Rowdy', PHONE);
    await castVote(guest, round.id, round.candidates[0]!.track.id);
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: guest, remoteAddress: PHONE });
    await app.inject({
      method: 'POST',
      url: `/api/admin/guests/${me.json<Me>().publicId}/ban`,
      cookies: host,
      payload: {},
    });
    expect((await voteCounts())[0]).toBe(0);
  });
});

describe('security', () => {
  it('blocks phones reaching host-only routes through the dev proxy', async () => {
    await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/setup',
      headers: { host: '127.0.0.1:8080', 'x-forwarded-for': PHONE },
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks cross-site writes', async () => {
    await makeApp();
    const host = await setUpHost();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/playback',
      cookies: host,
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
