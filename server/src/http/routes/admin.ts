import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminStatus, Device } from '@shared/types';
import { HttpError } from '../errors.js';
import { requireHost } from '../security.js';
import type { AppDeps } from '../app.js';

const PlaybackBody = z.object({ action: z.enum(['pause', 'resume', 'skip']) });
const StartBody = z.object({ deviceId: z.string().min(1).max(128) });
const IdParams = z.object({ id: z.coerce.number().int().positive() });

/** Host-only routes. Next milestone adds a password login so the host can use a phone too. */
export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { provider, player, queue, hub, config } = deps;
  const opts = { preHandler: requireHost, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

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
      devices,
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
}
