import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AddToQueueResponse,
  Me,
  MySkip,
  MyVotes,
  Quota,
  RejectReason,
  SearchResponse,
  Track,
} from '@shared/types';
import { LruCache } from '../../lib/cache.js';
import { cleanName, type Guest, NAME_MAX_LENGTH, voterKey } from '../../services/guests.js';
import { QueueService } from '../../services/queue.js';
import { HttpError } from '../errors.js';
import { clientIp } from '../security.js';
import type { AppDeps } from '../app.js';

const COOKIE = 'mb_guest';
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;
const PAGE_SIZE = 10; // Spotify Development Mode caps search at 10 results per page
const MAX_OFFSET = 990;
const BANNED_MESSAGE = 'The host removed you from this party.';

const NameBody = z.object({ name: z.string().max(200) });
const SearchQuery = z.object({
  q: z.string().trim().min(1, 'Type something to search').max(100),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
});
const TrackId = z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/, 'Invalid track id');
const VoteBody = z.object({ roundId: z.number().int().positive(), trackId: TrackId, vote: z.boolean() });
const SkipBody = z.object({ trackId: TrackId, vote: z.boolean() });

interface RawPage {
  tracks: Track[];
  nextOffset: number | null;
}

export function registerGuestRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { guests, queue, cooldowns, provider, player, votes, skips, hub, config, joinInfo } = deps;
  const now = deps.now ?? Date.now;
  const { limits } = config;
  const windowMs = limits.windowMinutes * 60_000;
  // Temporary only: Spotify allows caching their content just to keep the app responsive.
  const tracks = new LruCache<string, Track>(5_000, 60 * 60_000);
  const searches = new LruCache<string, RawPage>(300, 60_000);

  const AddBody = z.object({
    trackIds: z.array(TrackId).min(1).max(limits.maxPerRequest),
  });

  /** Reads the session cookie. Throws if the guest or their address is banned. */
  function readGuest(req: FastifyRequest): Guest | undefined {
    const ip = clientIp(req);
    if (guests.isIpBanned(ip)) throw new HttpError(403, 'forbidden', BANNED_MESSAGE);
    const raw = req.cookies[COOKIE];
    if (!raw) return undefined;
    const unsigned = req.unsignCookie(raw);
    const guest = unsigned.valid && unsigned.value ? guests.get(unsigned.value) : undefined;
    if (!guest) return undefined;
    if (guest.banned) throw new HttpError(403, 'forbidden', BANNED_MESSAGE);
    guests.seen(guest, ip);
    return guest;
  }

  function requireGuest(req: FastifyRequest): Guest {
    const guest = readGuest(req);
    if (!guest) throw new HttpError(400, 'name_required', 'Your session expired. Reload the page.');
    return guest;
  }

  function requireProvider(): void {
    if (!provider.isReady()) {
      throw new HttpError(503, 'provider_not_ready', 'The host has not connected Spotify yet.');
    }
  }

  const quotaFor = (guestId: string): Quota => ({
    pending: queue.pendingCountFor(guestId),
    recentAdds: queue.addedSince(guestId, now() - windowMs),
  });

  /** Checks the per-guest limits against the database, so parallel requests can't overshoot them. */
  function limitFor(guestId: string): { reason: RejectReason; availableAt: number | null } | null {
    const { pending, recentAdds } = quotaFor(guestId);
    if (pending >= limits.maxPendingPerGuest) return { reason: 'limit_reached', availableAt: null };
    if (recentAdds.length >= limits.windowSongs) {
      // A slot frees up when the oldest add that still counts leaves the window.
      return { reason: 'too_soon', availableAt: recentAdds[recentAdds.length - limits.windowSongs]! + windowMs };
    }
    return null;
  }

  const playingTrack = () => player.playback.state?.track ?? null;
  const toMe = (g: Guest): Me => ({ publicId: g.publicId, name: g.name, quota: quotaFor(g.id) });

  app.get('/api/me', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    let guest = readGuest(req);
    if (!guest) {
      guest = guests.create();
      guests.seen(guest, clientIp(req));
    }
    reply.setCookie(COOKIE, guest.id, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE_S,
    });
    return toMe(guest);
  });

  app.put('/api/me', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const guest = requireGuest(req);
    const name = cleanName(NameBody.parse(req.body).name);
    if (name.length < 1 || name.length > NAME_MAX_LENGTH) {
      throw new HttpError(400, 'bad_request', `Pick a name between 1 and ${NAME_MAX_LENGTH} characters.`);
    }
    const updated = guests.setName(guest.id, name);
    hub.broadcast();
    return toMe(updated);
  });

  app.get('/api/state', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async () =>
    hub.snapshot(),
  );

  app.get('/api/join-info', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => joinInfo);

  app.get('/api/search', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    requireGuest(req);
    requireProvider();
    const { q, offset } = SearchQuery.parse(req.query);

    const key = `${q.toLowerCase()}|${offset}`;
    let page = searches.get(key);
    if (!page) {
      const result = await provider.search(q, offset, PAGE_SIZE);
      for (const t of result.tracks) tracks.set(t.id, t);
      const next = offset + PAGE_SIZE;
      page = { tracks: result.tracks, nextOffset: next < result.total && next <= MAX_OFFSET ? next : null };
      searches.set(key, page);
    }
    // Availability changes with every play, so it's worked out per request, never cached.
    const playing = playingTrack();
    const response: SearchResponse = {
      results: page.tracks.map((track) => ({ track, block: cooldowns.blockFor(track, playing) })),
      nextOffset: page.nextOffset,
    };
    return response;
  });

  app.post('/api/queue', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (req) => {
    const guest = requireGuest(req);
    if (!guest.name) throw new HttpError(400, 'name_required', 'Pick a name first.');
    requireProvider();
    const { trackIds } = AddBody.parse(req.body);

    const added: AddToQueueResponse['added'] = [];
    const rejected: AddToQueueResponse['rejected'] = [];

    for (const trackId of new Set(trackIds)) {
      // Cheap check first, so a guest at their limit doesn't cost a provider lookup.
      const early = limitFor(guest.id);
      if (early) {
        rejected.push({ trackId, ...early });
        continue;
      }
      // Never trust track details from the client: use what the provider told us.
      const track = tracks.get(trackId) ?? (await provider.getTrack(trackId));
      if (!track) {
        rejected.push({ trackId, reason: 'not_found', availableAt: null });
        continue;
      }
      tracks.set(track.id, track);
      // Re-check after the await, with nothing async before the insert: another request may
      // have added songs in the meantime.
      const blocked = limitFor(guest.id) ?? cooldowns.blockFor(track, playingTrack());
      if (blocked) {
        rejected.push({ trackId, reason: blocked.reason, availableAt: blocked.availableAt });
        continue;
      }
      added.push(QueueService.toEntry(queue.add(track, guest.id)));
    }

    if (added.length > 0) {
      req.log.info(`${guest.name} queued ${added.map((e) => `"${e.track.name}"`).join(', ')}`);
      player.poke();
      hub.broadcast();
    }
    const response: AddToQueueResponse = { added, rejected, quota: quotaFor(guest.id) };
    return response;
  });

  // ---- Vote rounds ---------------------------------------------------------
  // Voting never counts against the queue limits: guests at their limit can still pick the next song.

  app.get('/api/vote', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<MyVotes> => {
    const guest = requireGuest(req);
    return votes.myVotes(voterKey(guest.id, clientIp(req)));
  });

  app.post('/api/vote', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<MyVotes> => {
    const guest = requireGuest(req);
    if (!guest.name) throw new HttpError(400, 'name_required', 'Pick a name first.');
    const { roundId, trackId, vote } = VoteBody.parse(req.body);
    const result = votes.vote(voterKey(guest.id, clientIp(req)), roundId, trackId, vote);
    if (result === 'closed') throw new HttpError(400, 'bad_request', 'That vote has ended.');
    if (result === 'not_a_candidate') throw new HttpError(400, 'bad_request', 'That song is not in this vote.');
    return result;
  });

  // ---- Vote to skip --------------------------------------------------------

  app.get('/api/skip', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<MySkip> => {
    const guest = requireGuest(req);
    return skips.mine(voterKey(guest.id, clientIp(req)));
  });

  app.post('/api/skip', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<MySkip> => {
    const guest = requireGuest(req);
    if (!guest.name) throw new HttpError(400, 'name_required', 'Pick a name first.');
    const { trackId, vote } = SkipBody.parse(req.body);
    const result = await skips.vote(voterKey(guest.id, clientIp(req)), trackId, vote);
    if (result === 'disabled') throw new HttpError(400, 'bad_request', 'The host turned off skip voting.');
    if (result === 'ended') throw new HttpError(400, 'bad_request', 'That song already ended.');
    if (result === 'paused') throw new HttpError(400, 'bad_request', 'The music is paused.');
    return result;
  });
}
