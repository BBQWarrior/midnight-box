import type { Config } from '../config.js';
import { type Db, getOrCreateSecret } from '../db.js';
import type { MacLookup } from '../lib/arp.js';
import type { MusicProvider, SuggestionSource } from '../providers/types.js';
import { BlacklistService } from './blacklist.js';
import { Catalog } from './catalog.js';
import { CooldownService } from './cooldowns.js';
import { DeviceBans } from './device-bans.js';
import { GuestService } from './guests.js';
import { HostAuth } from './host-auth.js';
import { type Log, Player, type PlayerOptions } from './player.js';
import { QueueService } from './queue.js';
import { TrackRules } from './rules.js';
import { defaultSettings, SettingsService } from './settings.js';
import { SkipService } from './skips.js';
import { StateHub } from './state.js';
import { VoteService } from './votes.js';

const MIN = 60_000;
/** Guests count towards the skip target this long after their last request. */
const SKIP_ACTIVE_MS = 15 * MIN;
const VOTE_CANDIDATES = 4;

export interface ServiceOptions {
  db: Db;
  config: Pick<Config, 'limits' | 'vote' | 'demo'>;
  provider: MusicProvider;
  /** Null: no vote rounds. */
  suggestions: SuggestionSource | null;
  player: PlayerOptions;
  macLookup: MacLookup;
  log: Log;
  /** Clock override for tests. */
  now?: () => number;
  /** Vote candidate order override for tests. */
  shuffle?: <T>(items: T[]) => T[];
}

export interface Services {
  settings: SettingsService;
  queue: QueueService;
  guests: GuestService;
  hostAuth: HostAuth;
  cooldowns: CooldownService;
  blacklist: BlacklistService;
  rules: TrackRules;
  catalog: Catalog;
  deviceBans: DeviceBans;
  player: Player;
  votes: VoteService;
  skips: SkipService;
  hub: StateHub;
}

/**
 * Builds every service and wires them together. Services read the host's settings on every use;
 * a settings change also cancels what was switched off and drops songs the new rules forbid.
 */
export function createServices(o: ServiceOptions): Services {
  const { db, config, provider, log } = o;
  const now = o.now ?? Date.now;
  const settings = new SettingsService(db, defaultSettings(config));
  const queue = new QueueService(db, now);
  const guests = new GuestService(db, now);
  const hostAuth = new HostAuth(db, now);
  const cooldowns = new CooldownService(
    db,
    queue,
    () => {
      const s = settings.get();
      return {
        songMs: s.songCooldownMinutes * MIN,
        artistMs: s.artistCooldownMinutes * MIN,
        artistMaxSongs: s.artistMaxSongs,
      };
    },
    now,
  );
  const blacklist = new BlacklistService(db, now);
  const rules = new TrackRules({ blacklist, cooldowns, queue, noExplicit: () => settings.get().noExplicit });
  const catalog = new Catalog(provider);
  const deviceBans = new DeviceBans(db, getOrCreateSecret(db, 'device_ban_secret'), o.macLookup, now);

  let hub: StateHub | undefined;
  const onChange = () => hub?.broadcast();

  const player = new Player(
    {
      provider,
      queue,
      log,
      onChange,
      now,
      skipReason: (track) => {
        if (!settings.get().skipBlocked) return null;
        const block = rules.forbidden(track);
        if (!block) return null;
        return block.reason === 'explicit' ? 'explicit songs are off' : 'it is on the blacklist';
      },
    },
    o.player,
  );
  const votes = new VoteService(
    {
      db,
      provider,
      source: o.suggestions,
      queue,
      rules,
      player,
      log,
      onChange,
      now,
      ...(o.shuffle ? { shuffle: o.shuffle } : {}),
    },
    () => {
      const s = settings.get();
      const roundMs = s.voteRoundSeconds * 1000;
      return {
        enabled: s.voteEnabled,
        roundMs,
        maxWaiting: s.voteWhenFewerThan,
        candidates: VOTE_CANDIDATES,
        retryMs: roundMs,
      };
    },
  );
  const skips = new SkipService({ db, guests, player, log, onChange, now }, () => {
    const s = settings.get();
    return { enabled: s.skipEnabled, activeMs: SKIP_ACTIVE_MS, percent: s.skipPercent, minVotes: s.skipMinVotes };
  });
  hub = new StateHub({ provider, queue, player, votes, skips, limits: () => settings.limits(), demo: config.demo, now });

  settings.onChange(() => {
    votes.settingsChanged();
    skips.settingsChanged();
    rules.dropForbiddenFromQueue();
    player.poke();
    hub.broadcast();
  });

  return { settings, queue, guests, hostAuth, cooldowns, blacklist, rules, catalog, deviceBans, player, votes, skips, hub };
}

/**
 * Play history to keep: whatever the longest cooldown or guest window still needs. Older history
 * is deleted (Spotify's terms don't allow keeping their content longer than needed).
 */
export function historyToKeepMs(settings: SettingsService): number {
  const s = settings.get();
  return Math.max(s.songCooldownMinutes, s.artistCooldownMinutes, s.windowMinutes) * MIN;
}
