import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from 'fastify';
import { Server } from 'socket.io';
import { ZodError } from 'zod';
import type { JoinInfo } from '@shared/types';
import type { Config } from '../config.js';
import type { SpotifyAuth } from '../providers/spotify/auth.js';
import { type MusicProvider, ProviderError, ProviderNotReadyError } from '../providers/types.js';
import type { CooldownService } from '../services/cooldowns.js';
import type { GuestService } from '../services/guests.js';
import type { HostAuth } from '../services/host-auth.js';
import type { Player } from '../services/player.js';
import type { QueueService } from '../services/queue.js';
import type { IoServer, StateHub } from '../services/state.js';
import type { SkipService } from '../services/skips.js';
import type { VoteService } from '../services/votes.js';
import { apiError, HttpError } from './errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGuestRoutes } from './routes/guest.js';
import { blockCrossSite, clientIp } from './security.js';

export interface AppDeps {
  config: Config;
  provider: MusicProvider;
  spotifyAuth: SpotifyAuth | null;
  guests: GuestService;
  queue: QueueService;
  cooldowns: CooldownService;
  hostAuth: HostAuth;
  player: Player;
  votes: VoteService;
  skips: SkipService;
  hub: StateHub;
  joinInfo: JoinInfo;
  cookieSecret: string;
  logger: FastifyServerOptions['logger'];
  /** Clock override for tests. */
  now?: () => number;
}

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; io: IoServer }> {
  const { config } = deps;
  const app = Fastify({
    logger: deps.logger,
    // Request logs would include query strings (search terms, OAuth codes); errors are logged below.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    bodyLimit: 16 * 1024,
  });

  // JSON bodies only: removes the text/plain parser that cross-site HTML forms could target.
  app.removeContentTypeParser('text/plain');

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://i.scdn.co'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    // The app is served over plain HTTP on a home network; HSTS would only break it.
    strictTransportSecurity: false,
  });
  await app.register(cookie, { secret: deps.cookieSecret });
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => clientIp(req),
  });

  app.addHook('onRequest', blockCrossSite);

  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send(apiError(error.code, error.message));
    }
    if (error instanceof ZodError) {
      return reply.status(400).send(apiError('bad_request', error.issues[0]?.message ?? 'Invalid request'));
    }
    if (error instanceof ProviderNotReadyError) {
      return reply.status(503).send(apiError('provider_not_ready', error.message));
    }
    if (error instanceof ProviderError) {
      if (error.status === 429) {
        return reply.status(429).send(apiError('rate_limited', 'Spotify is busy. Try again in a few seconds.'));
      }
      req.log.warn(`Provider error on ${req.method} ${req.routeOptions.url ?? ''}: ${error.message}`);
      return reply.status(502).send(apiError('provider_error', error.message));
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      return reply.status(429).send(apiError('rate_limited', 'Too many requests. Slow down a little.'));
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send(apiError('bad_request', (error as Error).message));
    }
    req.log.error(error);
    return reply.status(500).send(apiError('internal', 'Something went wrong.'));
  });

  registerGuestRoutes(app, deps);
  registerAdminRoutes(app, deps);
  if (deps.spotifyAuth) registerAuthRoutes(app, deps, deps.spotifyAuth);

  // Production: serve the built client. Only client/dist is exposed, never the project root.
  const hasClient = existsSync(path.join(config.clientDistDir, 'index.html'));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: config.clientDistDir,
      setHeaders(res, filePath) {
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
        res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    const isApi = url.startsWith('/api/') || url.startsWith('/auth/') || url.startsWith('/socket.io');
    if (hasClient && req.method === 'GET' && !isApi) {
      // Single-page app: /admin and friends are client-side routes.
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send(apiError('not_found', 'Not found'));
  });

  const io: IoServer = new Server(app.server, {
    serveClient: false,
    // Same-origin only. The socket is read-only, but there's no reason to let other sites in.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (!origin) return callback(null, true);
      try {
        callback(null, new URL(origin).host === req.headers.host);
      } catch {
        callback(null, false);
      }
    },
  });
  deps.hub.attach(io);
  app.addHook('preClose', async () => {
    io.disconnectSockets(true);
    io.engine.close();
  });

  return { app, io };
}
