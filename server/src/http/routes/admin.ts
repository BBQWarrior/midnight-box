import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AdminStatus, CooldownList, Device, HostSession } from '@shared/types';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, SESSION_TTL_MS } from '../../services/host-auth.js';
import { voterKey } from '../../services/votes.js';
import { HttpError } from '../errors.js';
import { clientIp, HOST_COOKIE, isHostRequest, makeRequireAdmin, requireHost } from '../security.js';
import type { AppDeps } from '../app.js';

const SetupBody = z.object({
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`),
});
const LoginBody = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
const PlaybackBody = z.object({ action: z.enum(['pause', 'resume', 'skip']) });
const StartBody = z.object({ deviceId: z.string().min(1).max(128) });
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const GuestParams = z.object({ publicId: z.string().regex(/^[A-Za-z0-9_-]{12}$/, 'Invalid guest id') });
const VotingBody = z.object({ enabled: z.boolean() });
const ClearBody = z.object({ kind: z.enum(['song', 'artist']), key: z.string().min(1).max(512) });

/** Host panel: password setup and login, then playback, queue, cooldown and guest controls. */
export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { provider, player, queue, hub, config, guests, hostAuth, cooldowns, votes } = deps;
  const opts = {
    preHandler: makeRequireAdmin(hostAuth),
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  };

  function startSession(reply: FastifyReply): void {
    const { token } = hostAuth.createSession();
    reply.setCookie(HOST_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  // ---- Session -------------------------------------------------------------

  app.get('/api/admin/session', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const session: HostSession = {
      passwordSet: hostAuth.hasPassword(),
      loggedIn: hostAuth.isValid(req.cookies[HOST_COOKIE]),
      onHostMachine: isHostRequest(req),
    };
    return session;
  });

  // First run only, and only on the host computer: nobody on the Wi-Fi can claim the party.
  app.post(
    '/api/admin/setup',
    { preHandler: requireHost, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { password } = SetupBody.parse(req.body);
      if (!(await hostAuth.setInitialPassword(password))) {
        throw new HttpError(400, 'bad_request', 'A host password is already set. Log in instead.');
      }
      req.log.info('Host password set');
      startSession(reply);
      return reply.status(204).send();
    },
  );

  // Strict per-address limit: with argon2id that's about 60 guesses an hour from one device.
  app.post('/api/admin/login', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const { password } = LoginBody.parse(req.body);
    if (!hostAuth.hasPassword()) {
      throw new HttpError(400, 'bad_request', 'Set a host password on the host computer first.');
    }
    if (!(await hostAuth.verify(password))) {
      req.log.warn(`Failed host login from ${clientIp(req)}`);
      throw new HttpError(401, 'unauthorized', 'Wrong password.');
    }
    req.log.info(`Host logged in from ${clientIp(req)}`);
    startSession(reply);
    return reply.status(204).send();
  });

  app.post('/api/admin/logout', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    hostAuth.revoke(req.cookies[HOST_COOKIE]);
    reply.clearCookie(HOST_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  // ---- Playback ------------------------------------------------------------

  app.get('/api/admin/status', opts, async (req): Promise<AdminStatus> => {
    const connected = provider.isReady();
    let devices: Device[] = [];
    if (connected) {
      devices = await provider.getDevices().catch((err: unknown) => {
        req.log.warn(`Could not list devices: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      });
    }
    return {
      provider: provider.kind,
      connected,
      connectUrl:
        provider.kind === 'spotify' && !connected ? `http://127.0.0.1:${config.port}/auth/spotify/login` : null,
      onHostMachine: isHostRequest(req),
      devices,
      banned: guests.bannedList(),
      voting: votes.status(),
    };
  });

  app.post('/api/admin/playback', opts, async (req, reply) => {
    const { action } = PlaybackBody.parse(req.body);
    if (action === 'pause') await player.pause();
    else if (action === 'resume') await player.resume();
    else await player.skip();
    return reply.status(204).send();
  });

  app.post('/api/admin/start', opts, async (req, reply) => {
    const { deviceId } = StartBody.parse(req.body);
    const started = await player.startOn(deviceId);
    if (!started) throw new HttpError(400, 'bad_request', 'The queue is empty. Add a song first.');
    hub.broadcast();
    return reply.status(204).send();
  });

  // ---- Queue and cooldowns -------------------------------------------------

  app.delete('/api/admin/queue/:id', opts, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const result = queue.remove(id);
    if (result === 'not_found') throw new HttpError(404, 'not_found', 'That song is not in the queue.');
    if (result === 'locked') {
      throw new HttpError(400, 'bad_request', 'That song was already sent to Spotify. Skip it when it starts.');
    }
    hub.broadcast();
    return reply.status(204).send();
  });

  app.get('/api/admin/cooldowns', opts, async (): Promise<CooldownList> => cooldowns.list());

  app.post('/api/admin/cooldowns/clear', opts, async (req, reply) => {
    const { kind, key } = ClearBody.parse(req.body);
    cooldowns.clear(kind, key);
    return reply.status(204).send();
  });

  // ---- Vote rounds ---------------------------------------------------------

  app.post('/api/admin/vote', opts, async (req, reply) => {
    const { enabled } = VotingBody.parse(req.body);
    votes.setEnabled(enabled);
    req.log.info(`Vote rounds turned ${enabled ? 'on' : 'off'}`);
    return reply.status(204).send();
  });

  app.post('/api/admin/vote/end', opts, async (_req, reply) => {
    if (!votes.endNow()) throw new HttpError(400, 'bad_request', 'No vote is running.');
    return reply.status(204).send();
  });

  // ---- Guests --------------------------------------------------------------

  app.post('/api/admin/guests/:publicId/ban', opts, async (req, reply) => {
    const { publicId } = GuestParams.parse(req.params);
    const guest = guests.ban(publicId);
    if (!guest) throw new HttpError(404, 'not_found', 'No guest with that id.');
    const removed = queue.removeQueuedFor(guest.id);
    votes.removeVoter(voterKey(guest.id, guests.ipOf(guest.id)), voterKey(guest.id, undefined));
    req.log.info(`Host removed ${guest.name ?? 'a guest'} from the party (${removed} queued songs dropped)`);
    hub.broadcast();
    return reply.status(204).send();
  });

  app.delete('/api/admin/guests/:publicId/ban', opts, async (req, reply) => {
    const { publicId } = GuestParams.parse(req.params);
    if (!guests.unban(publicId)) throw new HttpError(404, 'not_found', 'No guest with that id.');
    return reply.status(204).send();
  });
}
