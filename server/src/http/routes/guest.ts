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
} from '@shared/types';
import { MAX_OFFSET } from '../../services/catalog.js';
import { cleanName, type Guest, NAME_MAX_LENGTH, voterKey } from '../../services/guests.js';
import { QueueService } from '../../services/queue.js';
import { HttpError } from '../errors.js';
import { clientIp } from '../security.js';
import type { AppDeps } from '../app.js';

const COOKIE = 'mb_guest';
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;
const BANNED_MESSAGE = 'The host removed you from this party.';

const NameBody = z.object({ name: z.string().max(200) });
export const SearchQuery = z.object({
  q: z.string().trim().min(1, 'Type something to search').max(100),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
});
export const TrackId = z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/, 'Invalid track id');
const VoteBody = z.object({ roundId: z.number().int().positive(), trackId: TrackId, vote: z.boolean() });
const SkipBody = z.object({ trackId: TrackId, vote: z.boolean() });

/** One page of search results, with whether each song can be requested right now (guests and host search). */
export async function searchWithBlocks(deps: AppDeps, q: string, offset: number): Promise<SearchResponse> {
  const page = await deps.catalog.search(q, offset);
  // Availability changes with every play, so it's worked out per request, never cached.
  const playing = deps.player.playback.state?.track ?? null;
  return {
    results: page.tracks.map((track) => ({ track, block: deps.rules.blockFor(track, playing) })),
    nextOffset: page.nextOffset,
  };
}

export function registerGuestRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { guests, queue, rules, settings, deviceBans, catalog, provider, player, votes, skips, hub, joinInfo } = deps;
  const now = deps.now ?? Date.now;
  // The host can change the rules at any time, so they're read per request.
  const limits = () => settings.limits();
  const windowMs = () => limits().windowMinutes * 60_000;

  const AddBody = z.object({ trackIds: z.array(TrackId).min(1).max(10) });

  /** Reads the session cookie. Throws if the guest, their address or their phone is banned. */
  async function readGuest(req: FastifyRequest): Promise<Guest | undefined> {
    const ip = clientIp(req);
    if (guests.isIpBanned(ip)) throw new HttpError(403, 'forbidden', BANNED_MESSAGE);
    const bannedFor = await deviceBans.bannedFor(ip);
    if (bannedFor) {
      // A banned phone with a new session or address: block the address too, without asking the OS again.
      guests.banIp(ip, bannedFor);
      throw new HttpError(403, 'forbidden', BANNED_MESSAGE);
    }
    const raw = req.cookies[COOKIE];
    if (!raw) return undefined;
    const unsigned = req.unsignCookie(raw);
    const guest = unsigned.valid && unsigned.value ? guests.get(unsigned.value) : undefined;
    if (!guest) return undefined;
    if (guest.banned) throw new HttpError(403, 'forbidden', BANNED_MESSAGE);
    guests.seen(guest, ip);
    return guest;
  }

  async function requireGuest(req: FastifyRequest): Promise<Guest> {
    const guest = await readGuest(req);
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
    recentAdds: queue.addedSince(guestId, now() - windowMs()),
  });

  /** Checks the per-guest limits against the database, so parallel requests can't overshoot them. */
  function limitFor(guestId: string): { reason: RejectReason; availableAt: number | null } | null {
    const { maxPendingPerGuest, windowSongs } = limits();
    const { pending, recentAdds } = quotaFor(guestId);
    if (pending >= maxPendingPerGuest) return { reason: 'limit_reached', availableAt: null };
    if (recentAdds.length >= windowSongs) {
      // A slot frees up when the oldest add that still counts leaves the window.
      return { reason: 'too_soon', availableAt: recentAdds[recentAdds.length - windowSongs]! + windowMs() };
    }
    return null;
  }

  const playingTrack = () => player.playback.state?.track ?? null;
  const toMe = (g: Guest): Me => ({ publicId: g.publicId, name: g.name, quota: quotaFor(g.id) });

  app.get('/api/me', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    let guest = await readGuest(req);
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
    const guest = await requireGuest(req);
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
    await requireGuest(req);
    requireProvider();
    const { q, offset } = SearchQuery.parse(req.query);
    return searchWithBlocks(deps, q, offset);
  });

  app.post('/api/queue', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (req) => {
    const guest = await requireGuest(req);
    if (!guest.name) throw new HttpError(400, 'name_required', 'Pick a name first.');
    requireProvider();
    const { trackIds } = AddBody.parse(req.body);
    const { maxPerRequest } = limits();
    if (trackIds.length > maxPerRequest) {
      throw new HttpError(400, 'bad_request', `You can add up to ${maxPerRequest} songs at once.`);
    }

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
      const track = await catalog.get(trackId);
      if (!track) {
        rejected.push({ trackId, reason: 'not_found', availableAt: null });
        continue;
      }
      // Re-check after the await, with nothing async before the insert: another request may
      // have added songs in the meantime.
      const blocked = limitFor(guest.id) ?? rules.blockFor(track, playingTrack());
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
    const guest = await requireGuest(req);
    return votes.myVotes(voterKey(guest.id, clientIp(req)));
  });

  app.post('/api/vote', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<MyVotes> => {
    const guest = await requireGuest(req);
    if (!guest.name) throw new HttpError(400, 'name_required', 'Pick a name first.');
    const { roundId, trackId, vote } = VoteBody.parse(req.body);
    const result = votes.vote(voterKey(guest.id, clientIp(req)), roundId, trackId, vote);
    if (result === 'closed') throw new HttpError(400, 'bad_request', 'That vote has ended.');
    if (result === 'not_a_candidate') throw new HttpError(400, 'bad_request', 'That song is not in this vote.');
    return result;
  });

  // ---- Vote to skip --------------------------------------------------------

  app.get('/api/skip', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<MySkip> => {
    const guest = await requireGuest(req);
    return skips.mine(voterKey(guest.id, clientIp(req)));
  });

  app.post('/api/skip', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<MySkip> => {
    const guest = await requireGuest(req);
    if (!guest.name) throw new HttpError(400, 'name_required', 'Pick a name first.');
    const { trackId, vote } = SkipBody.parse(req.body);
    const result = await skips.vote(voterKey(guest.id, clientIp(req)), trackId, vote);
    if (result === 'disabled') throw new HttpError(400, 'bad_request', 'The host turned off skip voting.');
    if (result === 'ended') throw new HttpError(400, 'bad_request', 'That song already ended.');
    if (result === 'paused') throw new HttpError(400, 'bad_request', 'The music is paused.');
    return result;
  });
}
