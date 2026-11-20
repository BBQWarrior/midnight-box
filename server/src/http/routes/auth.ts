import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SpotifyAuth } from '../../providers/spotify/auth.js';
import { requireHost } from '../security.js';
import type { AppDeps } from '../app.js';

const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});

/** Spotify login. Host machine only: the redirect URI is a loopback address anyway. */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps, auth: SpotifyAuth): void {
  const { player, hub, config } = deps;
  const adminUrl = config.dev ? `http://127.0.0.1:${config.uiPort}/admin` : '/admin';
  const opts = { preHandler: requireHost, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get('/auth/spotify/login', opts, async (_req, reply) => reply.redirect(auth.createAuthorizeUrl()));

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
}
