import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AddToQueueResponse, Me, SearchResponse, Track } from '@shared/types';
import { LruCache } from '../../lib/cache.js';
import { cleanName, type Guest, NAME_MAX_LENGTH } from '../../services/guests.js';
import { QueueService } from '../../services/queue.js';
import { HttpError } from '../errors.js';
import type { AppDeps } from '../app.js';

const COOKIE = 'mb_guest';
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;
const PAGE_SIZE = 10; // Spotify Development Mode caps search at 10 results per page
const MAX_OFFSET = 990;

const NameBody = z.object({ name: z.string().max(200) });
const SearchQuery = z.object({
  q: z.string().trim().min(1, 'Type something to search').max(100),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
});
const TrackId = z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/, 'Invalid track id');

export function registerGuestRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { guests, queue, provider, player, hub, config, joinInfo } = deps;
  const tracks = new LruCache<string, Track>(5_000);
  const searches = new LruCache<string, SearchResponse>(300, 60_000);

  const AddBody = z.object({
    trackIds: z.array(TrackId).min(1).max(config.limits.maxPerRequest),
  });

  function readGuest(req: FastifyRequest): Guest | undefined {
    const raw = req.cookies[COOKIE];
    if (!raw) return undefined;
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid && unsigned.value ? guests.get(unsigned.value) : undefined;
  }

  function requireGuest(req: FastifyRequest): Guest {
    const guest = readGuest(req);
    if (!guest) throw new HttpError(400, 'name_required', 'Your session expired. Reload the page.');
    if (guest.banned) throw new HttpError(403, 'forbidden', 'The host removed you from this party.');
    return guest;
  }

  function requireProvider(): void {
    if (!provider.isReady()) {
      throw new HttpError(503, 'provider_not_ready', 'The host has not connected Spotify yet.');
    }
  }

  const toMe = (g: Guest): Me => ({ publicId: g.publicId, name: g.name });

  app.get('/api/me', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const guest = readGuest(req) ?? guests.create();
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
    const cached = searches.get(key);
    if (cached) return cached;

    const result = await provider.search(q, offset, PAGE_SIZE);
    for (const t of result.tracks) tracks.set(t.id, t);
    const next = offset + PAGE_SIZE;
    const response: SearchResponse = {
      tracks: result.tracks,
      nextOffset: next < result.total && next <= MAX_OFFSET ? next : null,
    };
    searches.set(key, response);
    return response;
  });

  app.post('/api/queue', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (req) => {
    const guest = requireGuest(req);
    if (!guest.name) throw new HttpError(400, 'name_required', 'Pick a name first.');
    requireProvider();
    const { trackIds } = AddBody.parse(req.body);

    const response: AddToQueueResponse = { added: [], rejected: [] };
    const seen = new Set<string>();
    const nowPlayingId = player.playback.state?.track?.id;
    let pending = queue.pendingCountFor(guest.id);

    for (const trackId of trackIds) {
      if (seen.has(trackId) || trackId === nowPlayingId || queue.isActive(trackId)) {
        response.rejected.push({ trackId, reason: 'already_queued' });
        continue;
      }
      seen.add(trackId);
      if (pending >= config.limits.maxPendingPerGuest) {
        response.rejected.push({ trackId, reason: 'limit_reached' });
        continue;
      }
      // Never trust track details from the client: use what the provider told us.
      const track = tracks.get(trackId) ?? (await provider.getTrack(trackId));
      if (!track) {
        response.rejected.push({ trackId, reason: 'not_found' });
        continue;
      }
      tracks.set(track.id, track);
      response.added.push(QueueService.toEntry(queue.add(track, guest.id)));
      pending++;
    }

    if (response.added.length > 0) {
      req.log.info(`${guest.name} queued ${response.added.map((e) => `"${e.track.name}"`).join(', ')}`);
      player.poke();
      hub.broadcast();
    }
    return response;
  });
}
