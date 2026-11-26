import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AddToQueueResponse,
  AdminStatus,
  BanResult,
  BlacklistAddResult,
  BlacklistFile,
  BlacklistImportResult,
  BlacklistItem,
  BlacklistResponse,
  SettingsResponse,
  CooldownList,
  HostSession,
  Limits,
  Me,
  MySkip,
  MyVotes,
  PublicState,
  SearchResponse,
} from '@shared/types';
import type { Config } from '../src/config.js';
import { type Db, kvSet, openDb } from '../src/db.js';
import { buildApp } from '../src/http/app.js';
import { MOCK_CATALOG } from '../src/providers/mock/catalog.js';
import { MockProvider } from '../src/providers/mock/provider.js';
import { MockSuggestions } from '../src/providers/mock/suggestions.js';
import type { MacLookup } from '../src/lib/arp.js';
import { SpotifyAuth } from '../src/providers/spotify/auth.js';
import { createServices } from '../src/services/container.js';
import type { Player } from '../src/services/player.js';
import type { VoteService } from '../src/services/votes.js';

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
    artistMaxSongs: 1,
    artistCooldownMinutes: 20,
    noExplicit: false,
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
let db: Db;
let spotifyAuth: SpotifyAuth | null;
const REDIRECT = 'http://127.0.0.1:8080/auth/spotify/callback';

async function makeApp(limits: Partial<Limits> = {}, withSpotify = false, macLookup: MacLookup = async () => null) {
  let t = T0;
  const now = () => t;
  advance = (ms) => {
    t += ms;
  };
  const config = { ...baseConfig, limits: { ...baseConfig.limits, ...limits } };
  db = openDb(':memory:');
  spotifyAuth = null;
  if (withSpotify) {
    // A host who connected Spotify earlier: the tokens are already saved.
    kvSet(db, 'spotify_tokens', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: T0 + 3_600_000 }));
    spotifyAuth = new SpotifyAuth(db, 'test-client-id', REDIRECT);
  }
  const provider = new MockProvider({ startPlaying: true, now });
  const services = createServices({
    db,
    config,
    provider,
    suggestions: new MockSuggestions(MOCK_CATALOG),
    player: { pollMs: 1_000, idlePollMs: 1_000, pushAheadMs: 1_000, autoStartCooldownMs: 0 },
    macLookup,
    log: silent,
    now,
    shuffle: (items) => items,
  });
  ({ player, votes } = services);
  ({ app } = await buildApp({
    ...services,
    config,
    provider,
    spotifyAuth,
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
    // The test network has no neighbour table, so only the session and address are banned.
    expect(ban.json<BanResult>()).toEqual({ device: false });
    expect((await state()).queue).toEqual([]);
    expect((await queueSongs(alex, [t2], GUEST_IP)).statusCode).toBe(403);
    // Clearing cookies doesn't help: the address is blocked too.
    expect((await app.inject({ method: 'GET', url: '/api/me', remoteAddress: GUEST_IP })).statusCode).toBe(403);
    // Other guests are fine.
    expect((await queueSongs(await join('Sam', '192.168.1.31'), [t2], '192.168.1.31')).statusCode).toBe(200);

    const panel = (await app.inject({ method: 'GET', url: '/api/admin/status', cookies: host })).json<AdminStatus>();
    expect(panel.banned).toEqual([{ publicId, name: 'Alex', device: false }]);

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

describe('vote to skip', () => {
  const PHONES = ['192.168.1.21', '192.168.1.22', '192.168.1.23', '192.168.1.24'];

  /** Refreshes playback and returns the id of the song playing. */
  async function playing() {
    await player.tick();
    const id = (await state()).nowPlaying?.track.id;
    if (!id) throw new Error('nothing is playing');
    return id;
  }

  const skipVote = (cookies: Record<string, string>, trackId: string, vote = true, remoteAddress = PHONE) =>
    app.inject({ method: 'POST', url: '/api/skip', cookies, remoteAddress, payload: { trackId, vote } });

  it('skips the song once half the guests vote, counting one vote per device', async () => {
    await makeApp();
    const song = await playing();
    const maya = await join('Maya', PHONE);
    const mayaAgain = await join('Maya again', PHONE);
    const others: Record<string, string>[] = [];
    for (const [i, ip] of PHONES.entries()) others.push(await join(`Guest ${i}`, ip));
    // Five devices are around, so three votes are needed.
    expect((await state()).skip).toMatchObject({ enabled: true, trackId: song, votes: 0, needed: 3 });

    expect((await skipVote(maya, song)).json<MySkip>()).toEqual({ trackId: song, voted: true });
    await skipVote(mayaAgain, song);
    const mine = await app.inject({ method: 'GET', url: '/api/skip', cookies: mayaAgain, remoteAddress: PHONE });
    expect(mine.json<MySkip>()).toEqual({ trackId: song, voted: true });
    await skipVote(others[0]!, song, true, PHONES[0]);
    await skipVote(others[0]!, song, false, PHONES[0]);
    expect((await state()).skip).toMatchObject({ votes: 1, needed: 3 });

    await skipVote(others[1]!, song, true, PHONES[1]);
    await skipVote(others[2]!, song, true, PHONES[2]);
    expect((await state()).skip.lastSkip).toMatchObject({ track: { id: song }, votes: 3 });
    expect(await playing()).not.toBe(song);
    expect((await state()).skip.votes).toBe(0);
  });

  it('needs two votes or more, counts only guests seen lately, and keeps the target once voting starts', async () => {
    await makeApp();
    for (const [i, ip] of PHONES.entries()) await join(`Guest ${i}`, ip);
    advance(16 * MIN);
    // The others have gone quiet; one guest alone can't skip.
    const maya = await join('Maya', PHONE);
    const song = await playing();
    expect((await state()).skip.needed).toBe(2);
    await skipVote(maya, song);

    // More guests show up mid-song: the target stays where it was when voting started.
    const late: Record<string, string>[] = [];
    for (const [i, ip] of PHONES.entries()) late.push(await join(`Late ${i}`, ip));
    expect((await state()).skip).toMatchObject({ votes: 1, needed: 2 });
    await skipVote(late[0]!, song, true, PHONES[0]);
    expect(await playing()).not.toBe(song);
  });

  it('rejects votes for a song that ended, while paused, from unnamed guests, or when the host turned it off', async () => {
    await makeApp();
    const host = await setUpHost();
    const song = await playing();
    const maya = await join('Maya', PHONE);
    const other = MOCK_CATALOG.find((t) => t.id !== song)!.id;
    expect((await skipVote(maya, other)).json().error.message).toMatch(/already ended/);
    const unnamed = await join(null, PHONES[0]);
    expect((await skipVote(unnamed, song, true, PHONES[0])).json().error.code).toBe('name_required');

    await player.pause();
    await player.tick();
    expect((await skipVote(maya, song)).json().error.message).toMatch(/paused/);
    await player.resume();
    await player.tick();

    await skipVote(maya, song);
    const toggle = (enabled: boolean, cookies?: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/admin/skip-voting', cookies, payload: { enabled } });
    expect((await toggle(false)).statusCode).toBe(401);
    expect((await toggle(false, host)).statusCode).toBe(204);
    expect((await state()).skip).toMatchObject({ enabled: false, votes: 0 });
    expect((await skipVote(maya, song)).json().error.message).toMatch(/turned off/);
  });

  it("drops a removed guest's vote", async () => {
    await makeApp();
    const host = await setUpHost();
    const song = await playing();
    const rowdy = await join('Rowdy', PHONE);
    await skipVote(rowdy, song);
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: rowdy, remoteAddress: PHONE });
    const ban = `/api/admin/guests/${me.json<Me>().publicId}/ban`;
    await app.inject({ method: 'POST', url: ban, cookies: host, payload: {} });
    expect((await state()).skip.votes).toBe(0);
  });
});

describe('Spotify disconnect', () => {
  it('deletes the saved login and listening history, and needs a host session', async () => {
    await makeApp({}, true);
    const host = await setUpHost();
    await player.tick(); // the song playing is recorded, so it's on cooldown
    const cooldowns = async () =>
      (await app.inject({ method: 'GET', url: '/api/admin/cooldowns', cookies: host })).json<CooldownList>();
    expect((await cooldowns()).songs).toHaveLength(1);

    const disconnect = (cookies?: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/admin/spotify/disconnect', cookies, payload: {} });
    expect((await disconnect()).statusCode).toBe(401);
    expect(spotifyAuth?.isConnected()).toBe(true);

    expect((await disconnect(host)).statusCode).toBe(204);
    expect(spotifyAuth?.isConnected()).toBe(false);
    expect(new SpotifyAuth(db, 'test-client-id', REDIRECT).isConnected()).toBe(false);
    expect((await cooldowns()).songs).toHaveLength(0);
  });
});

describe('house rules', () => {
  const put = (cookies: Record<string, string>, payload: object) =>
    app.inject({ method: 'PUT', url: '/api/admin/settings', cookies, payload });

  it('lets the host change the limits while the party runs, and guests see them at once', async () => {
    await makeApp({ windowSongs: 1, maxPendingPerGuest: 5, maxPerRequest: 1 });
    const host = await setUpHost();
    const alex = await join();
    await queueSongs(alex, [t1]);
    expect((await queueSongs(alex, [t2])).json<AddToQueueResponse>().rejected[0]?.reason).toBe('too_soon');

    const res = await put(host, { windowSongs: 3, maxPerRequest: 2 });
    expect(res.json<SettingsResponse>().settings).toMatchObject({ windowSongs: 3, maxPerRequest: 2 });
    expect(res.json<SettingsResponse>().defaults).toMatchObject({ windowSongs: 1, maxPerRequest: 1 });
    expect((await state()).limits).toMatchObject({ windowSongs: 3, maxPerRequest: 2 });
    expect((await queueSongs(alex, [t2, t3])).json<AddToQueueResponse>().added).toHaveLength(2);

    const reset = await app.inject({ method: 'POST', url: '/api/admin/settings/reset', cookies: host, payload: {} });
    expect(reset.json<SettingsResponse>().settings.windowSongs).toBe(1);
    expect((await state()).limits.windowSongs).toBe(1);
  });

  it('rejects bad values and combinations, and needs a host session', async () => {
    await makeApp();
    const host = await setUpHost();
    expect((await put(host, { windowSongs: 0 })).statusCode).toBe(400);
    expect((await put(host, { windowSongs: '5' })).statusCode).toBe(400);
    expect((await put(host, { madeUp: 1 })).statusCode).toBe(400);
    const combo = await put(host, { maxPendingPerGuest: 2, maxPerRequest: 3 });
    expect(combo.statusCode).toBe(400);
    expect(combo.json<{ error: { message: string } }>().error.message).toMatch(/waiting at once/);
    expect((await put({}, { windowSongs: 5 })).statusCode).toBe(401);
  });

  it('turns explicit songs off: search marks them, and waiting ones leave the queue', async () => {
    await makeApp();
    const host = await setUpHost();
    const explicit = MOCK_CATALOG.find((t) => t.explicit)!;
    const alex = await join();
    await queueSongs(alex, [explicit.id]);
    expect((await state()).queue).toHaveLength(1);

    await put(host, { noExplicit: true });
    expect((await state()).queue).toHaveLength(0);
    expect((await state()).limits.noExplicit).toBe(true);
    const q = encodeURIComponent(explicit.name);
    const res = await app.inject({ method: 'GET', url: `/api/search?q=${q}`, cookies: alex });
    expect(res.json<SearchResponse>().results.find((r) => r.track.id === explicit.id)?.block?.reason).toBe('explicit');
  });

  it('lets an artist play several songs per window when the host allows it', async () => {
    await makeApp({ artistMaxSongs: 2, artistCooldownMinutes: 30 });
    const alex = await join();
    // The mock starts on catalog song 0; songs 1 and 2 are by the same artist.
    await player.tick();
    const res = (await queueSongs(alex, [MOCK_CATALOG[1]!.id])).json<AddToQueueResponse>();
    expect(res.added).toHaveLength(1);
  });
});

describe('blacklist', () => {
  const block = (cookies: Record<string, string>, payload: object) =>
    app.inject({ method: 'POST', url: '/api/admin/blacklist', cookies, payload });
  const list = async (cookies: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: '/api/admin/blacklist', cookies })).json<BlacklistResponse>().items;
  const blocks = async (cookies: Record<string, string>, q: string) =>
    (await app.inject({ method: 'GET', url: `/api/search?q=${q}`, cookies }))
      .json<SearchResponse>()
      .results.map((r) => r.block?.reason ?? null);

  it('blocks a song: guests see it, can no longer queue it, and a waiting copy leaves the queue', async () => {
    await makeApp();
    const host = await setUpHost();
    const alex = await join();
    await queueSongs(alex, [t1]);

    const res = (await block(host, { kind: 'song', trackId: t1 })).json<BlacklistAddResult>();
    expect(res.item).toMatchObject({ kind: 'song', name: 'Gravity Waltz', artist: 'The Velvet Satellites' });
    expect(res.removedFromQueue).toBe(1);
    expect((await state()).queue).toEqual([]);
    expect((await blocks(alex, 'gravity'))[0]).toBe('blacklisted');
    expect((await queueSongs(alex, [t1])).json<AddToQueueResponse>().rejected[0]?.reason).toBe('blacklisted');
    // Blocking it again changes nothing.
    await block(host, { kind: 'song', trackId: t1 });
    expect(await list(host)).toHaveLength(1);
  });

  it('blocks whole artists and albums', async () => {
    await makeApp();
    const host = await setUpHost();
    const alex = await join();
    await block(host, { kind: 'artist', trackId: t1 });
    await block(host, { kind: 'album', trackId: t2 });
    expect(await blocks(alex, 'velvet')).toEqual(['blacklisted', 'blacklisted', 'blacklisted']);
    expect(await blocks(alex, 'juno')).toEqual(['blacklisted', 'blacklisted', 'blacklisted']);
    expect((await block(host, { kind: 'artist', trackId: t1, artistId: 'mock:nobody' })).statusCode).toBe(400);
  });

  it('removes, clears and restores entries', async () => {
    await makeApp();
    const host = await setUpHost();
    await block(host, { kind: 'song', trackId: t1 });
    await block(host, { kind: 'song', trackId: t2 });
    const [newest] = await list(host);

    const removed = await app.inject({
      method: 'POST',
      url: '/api/admin/blacklist/remove',
      cookies: host,
      payload: { kind: newest!.kind, key: newest!.key },
    });
    expect(removed.json<BlacklistItem>().name).toBe(newest!.name);
    expect(await list(host)).toHaveLength(1);

    const cleared = await app.inject({ method: 'POST', url: '/api/admin/blacklist/clear', cookies: host, payload: {} });
    expect(cleared.json<BlacklistResponse>().items).toHaveLength(1);
    expect(await list(host)).toEqual([]);
  });

  it('exports and imports the list, merging or replacing, and refuses files from another service', async () => {
    await makeApp();
    const host = await setUpHost();
    await block(host, { kind: 'song', trackId: t1 });
    await block(host, { kind: 'artist', trackId: t2 });
    const exported = await app.inject({ method: 'GET', url: '/api/admin/blacklist/export', cookies: host });
    expect(exported.headers['content-disposition']).toMatch(/attachment; filename="midnight-box-blacklist-/);
    const file = exported.json<BlacklistFile>();
    expect(file).toMatchObject({ app: 'midnight-box', type: 'blacklist', version: 1, provider: 'mock' });
    expect(file.items.map((i) => i.kind)).toEqual(['song', 'artist']);

    const importFile = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/admin/blacklist/import', cookies: host, payload });
    await app.inject({ method: 'POST', url: '/api/admin/blacklist/clear', cookies: host, payload: {} });
    await block(host, { kind: 'song', trackId: t3 });

    expect((await importFile({ mode: 'merge', file })).json<BlacklistImportResult>()).toMatchObject({ added: 2, total: 3 });
    expect((await importFile({ mode: 'replace', file })).json<BlacklistImportResult>()).toMatchObject({ added: 2, total: 2 });
    expect((await importFile({ mode: 'merge', file: { ...file, provider: 'spotify' } })).statusCode).toBe(400);
    expect((await importFile({ mode: 'merge', file: { hello: 'world' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/admin/blacklist/export' })).statusCode).toBe(401);
  });

  /** A fresh app whose first song is on the blacklist; returns what plays after the player looks. */
  async function blockedStart(skipBlocked: boolean): Promise<string | undefined> {
    await makeApp();
    const host = await setUpHost();
    await app.inject({ method: 'PUT', url: '/api/admin/settings', cookies: host, payload: { skipBlocked } });
    await block(host, { kind: 'song', trackId: MOCK_CATALOG[0]!.id });
    await player.tick();
    await player.tick();
    return (await state()).nowPlaying?.track.id;
  }

  it('skips a blocked song that Spotify starts on its own, unless the host turned that off', async () => {
    expect(await blockedStart(true)).not.toBe(MOCK_CATALOG[0]!.id);
    expect(await blockedStart(false)).toBe(MOCK_CATALOG[0]!.id);
  });

  it('lets the host search for things to block', async () => {
    await makeApp();
    const host = await setUpHost();
    const res = await app.inject({ method: 'GET', url: '/api/admin/search?q=velvet', cookies: host });
    expect(res.json<SearchResponse>().results).toHaveLength(3);
    expect((await app.inject({ method: 'GET', url: '/api/admin/search?q=velvet' })).statusCode).toBe(401);
  });
});

describe('device bans', () => {
  const MAC = 'aa:bb:cc:dd:ee:01';
  // The same phone on two addresses (its lease changed), and another phone.
  const macs: Record<string, string> = { '192.168.1.30': MAC, '192.168.1.40': MAC, '192.168.1.31': 'aa:bb:cc:dd:ee:02' };
  const lookup: MacLookup = async (ip) => macs[ip] ?? null;
  const me = (remoteAddress: string, cookies?: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/api/me', remoteAddress, ...(cookies ? { cookies } : {}) });

  it('bans the phone itself: a new session on a new address stays out, until the host unbans', async () => {
    await makeApp({}, false, lookup);
    const host = await setUpHost();
    const alex = await join('Alex', '192.168.1.30');
    const publicId = (await me('192.168.1.30', alex)).json<Me>().publicId;

    const ban = await app.inject({ method: 'POST', url: `/api/admin/guests/${publicId}/ban`, cookies: host });
    expect(ban.json<BanResult>()).toEqual({ device: true });
    const panel = (await app.inject({ method: 'GET', url: '/api/admin/status', cookies: host })).json<AdminStatus>();
    expect(panel.banned).toEqual([{ publicId, name: 'Alex', device: true }]);

    // New address, no cookies: still the same phone.
    expect((await me('192.168.1.40')).statusCode).toBe(403);
    // Another phone is fine.
    expect((await me('192.168.1.31')).statusCode).toBe(200);

    await app.inject({ method: 'DELETE', url: `/api/admin/guests/${publicId}/ban`, cookies: host });
    expect((await me('192.168.1.40')).statusCode).toBe(200);
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
