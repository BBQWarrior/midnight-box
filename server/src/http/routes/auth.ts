import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SpotifyAuth } from '../../providers/spotify/auth.js';
import { HOST_COOKIE, makeRequireAdmin, requireHost } from '../security.js';
import type { AppDeps } from '../app.js';

const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});

/**
 * Spotify login. Host computer only (the redirect URI is a loopback address anyway), and
 * starting it needs a host session. The callback is protected by the single-use `state`.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps, auth: SpotifyAuth): void {
  const { player, hub, config, hostAuth, queue } = deps;
  const adminUrl = config.dev ? `http://127.0.0.1:${config.uiPort}/admin` : '/admin';
  const opts = { preHandler: requireHost, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get('/auth/spotify/login', opts, async (req, reply) => {
    // A plain link, so send the browser back to the panel (which shows the login) instead of JSON.
    if (!hostAuth.isValid(req.cookies[HOST_COOKIE])) return reply.redirect(adminUrl);
    return reply.redirect(auth.createAuthorizeUrl());
  });

  app.get('/auth/spotify/callback', opts, async (req, reply) => {
    try {
      await auth.handleCallback(CallbackQuery.parse(req.query));
    } catch (err) {
      req.log.warn(`Spotify login failed: ${err instanceof Error ? err.message : String(err)}`);
      return reply.redirect(`${adminUrl}?spotify=error`);
    }
    req.log.info('Spotify connected');
    player.poke();
    hub.broadcast();
    return reply.redirect(`${adminUrl}?spotify=connected`);
  });

  // Spotify's terms: the host must be able to disconnect at any time, and their Spotify data is
  // deleted with it. Works from any device with a host session, unlike connecting.
  app.post(
    '/api/admin/spotify/disconnect',
    { preHandler: makeRequireAdmin(hostAuth), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      auth.disconnect();
      queue.forgetHistory();
      req.log.info('Spotify disconnected: the saved login and listening history were deleted');
      player.poke();
      hub.broadcast();
      return reply.status(204).send();
    },
  );
}
