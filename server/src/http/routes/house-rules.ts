import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type {
  BlacklistAddResult,
  BlacklistFile,
  BlacklistImportResult,
  BlacklistItem,
  BlacklistResponse,
  SearchResponse,
  SettingsResponse,
} from '@shared/types';
import { entryFor } from '../../services/blacklist.js';
import { HttpError } from '../errors.js';
import type { AppDeps } from '../app.js';
import { SearchQuery, searchWithBlocks, TrackId } from './guest.js';

const Kind = z.enum(['song', 'album', 'artist']);
const AddBody = z.object({ kind: Kind, trackId: TrackId, artistId: z.string().min(1).max(128).optional() });
const RemoveBody = z.object({ kind: Kind, key: z.string().min(1).max(512) });
const Entry = z.object({
  kind: Kind,
  key: z.string().min(1).max(512),
  name: z.string().trim().min(1).max(300),
  artist: z.string().trim().max(300).nullable().default(null),
});
export const MAX_BLACKLIST = 5_000;
const ImportBody = z.object({
  mode: z.enum(['merge', 'replace']),
  file: z.object(
    {
      app: z.literal('midnight-box', 'This is not a Midnight Box blacklist file.'),
      type: z.literal('blacklist', 'This is not a Midnight Box blacklist file.'),
      version: z.literal(1, 'This blacklist file is from a newer version of Midnight Box.'),
      provider: z.enum(['spotify', 'mock']),
      exportedAt: z.string().max(64).optional(),
      items: z.array(Entry).max(MAX_BLACKLIST, `A blacklist can hold up to ${MAX_BLACKLIST} entries.`),
    },
    'This is not a Midnight Box blacklist file.',
  ),
});

interface Opts {
  preHandler: preHandlerHookHandler;
  config: { rateLimit: { max: number; timeWindow: string } };
}

/** Host panel: house rules (settings) and the blacklist. */
export function registerHouseRuleRoutes(app: FastifyInstance, deps: AppDeps, opts: Opts): void {
  const { settings, blacklist, rules, provider, catalog, hub, player } = deps;

  const settingsResponse = (): SettingsResponse => ({ settings: settings.get(), defaults: settings.defaults() });

  // ---- Settings ------------------------------------------------------------

  app.get('/api/admin/settings', opts, async () => settingsResponse());

  app.put('/api/admin/settings', opts, async (req) => {
    settings.update(req.body);
    req.log.info('Host changed the house rules');
    return settingsResponse();
  });

  app.post('/api/admin/settings/reset', opts, async (req) => {
    settings.reset();
    req.log.info('Host reset the house rules to the defaults');
    return settingsResponse();
  });

  // ---- Search (to find things to block) -------------------------------------

  app.get('/api/admin/search', opts, async (req): Promise<SearchResponse> => {
    if (!provider.isReady()) throw new HttpError(503, 'provider_not_ready', 'Connect Spotify first.');
    const { q, offset } = SearchQuery.parse(req.query);
    return searchWithBlocks(deps, q, offset);
  });

  // ---- Blacklist -------------------------------------------------------------

  /** Songs the new list forbids leave the queue; the player skips them if Spotify starts one anyway. */
  const afterChange = (): number => {
    const removed = rules.dropForbiddenFromQueue();
    hub.broadcast();
    player.poke();
    return removed;
  };

  app.get('/api/admin/blacklist', opts, async (): Promise<BlacklistResponse> => ({ items: blacklist.list() }));

  app.post('/api/admin/blacklist', opts, async (req): Promise<BlacklistAddResult> => {
    const { kind, trackId, artistId } = AddBody.parse(req.body);
    if (blacklist.size >= MAX_BLACKLIST) {
      throw new HttpError(400, 'bad_request', `The blacklist is full (${MAX_BLACKLIST} entries).`);
    }
    const track = await catalog.get(trackId);
    if (!track) throw new HttpError(404, 'not_found', "Couldn't find that song.");
    const entry = entryFor(kind, track, artistId);
    if (!entry) {
      throw new HttpError(400, 'bad_request', kind === 'album' ? 'That song has no album to block.' : 'No such artist on that song.');
    }
    const item = blacklist.add(entry);
    req.log.info(`Host blocked the ${kind} "${item.name}"`);
    return { item, removedFromQueue: afterChange() };
  });

  app.post('/api/admin/blacklist/remove', opts, async (req): Promise<BlacklistItem> => {
    const { kind, key } = RemoveBody.parse(req.body);
    const item = blacklist.remove(kind, key);
    if (!item) throw new HttpError(404, 'not_found', 'That is not on the blacklist.');
    afterChange();
    return item;
  });

  app.post('/api/admin/blacklist/clear', opts, async (req): Promise<BlacklistResponse> => {
    const items = blacklist.clear();
    req.log.info(`Host cleared the blacklist (${items.length} entries)`);
    afterChange();
    return { items };
  });

  // Big lists don't fit the default 16 KB body limit.
  app.post(
    '/api/admin/blacklist/import',
    { ...opts, bodyLimit: 1024 * 1024 },
    async (req): Promise<BlacklistImportResult> => {
      const { mode, file } = ImportBody.parse(req.body);
      if (file.provider !== provider.kind) {
        throw new HttpError(
          400,
          'bad_request',
          file.provider === 'mock'
            ? 'This file was exported in demo mode, so its ids mean nothing to Spotify.'
            : 'This file was exported with Spotify, so its ids mean nothing in demo mode.',
        );
      }
      const keep = mode === 'merge' ? blacklist.size : 0;
      const fresh = new Set(file.items.map((i) => `${i.kind}\n${i.key}`)).size;
      if (keep + fresh > MAX_BLACKLIST) {
        throw new HttpError(400, 'bad_request', `That would make the blacklist longer than ${MAX_BLACKLIST} entries.`);
      }
      const added = blacklist.addMany(file.items, mode);
      req.log.info(`Host imported a blacklist (${mode}, ${added} new entries)`);
      return { added, total: blacklist.size, removedFromQueue: afterChange() };
    },
  );

  app.get('/api/admin/blacklist/export', opts, async (_req, reply) => {
    const file: BlacklistFile = {
      app: 'midnight-box',
      type: 'blacklist',
      version: 1,
      provider: provider.kind,
      exportedAt: new Date().toISOString(),
      // Oldest first, so an import keeps the order.
      items: blacklist
        .list()
        .reverse()
        .map(({ kind, key, name, artist }) => ({ kind, key, name, artist })),
    };
    const date = file.exportedAt.slice(0, 10);
    return reply
      .header('Content-Disposition', `attachment; filename="midnight-box-blacklist-${date}.json"`)
      .header('Cache-Control', 'no-store')
      .type('application/json')
      .send(JSON.stringify(file, null, 2));
  });
}
