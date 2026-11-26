import { z } from 'zod';
import type { Limits, Settings } from '@shared/types';
import type { Config } from '../config.js';
import { type Db, kvDelete, kvGet, kvSet } from '../db.js';

/** The host's changes, as JSON: only the values that differ from the defaults. */
const SETTINGS_KEY = 'settings';
/** On/off switches saved before settings existed; folded into the settings on first start. */
const LEGACY_SWITCHES = { voteEnabled: 'voting_enabled', skipEnabled: 'skip_voting_enabled' } as const;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Allowed values. The ranges match what `.env` accepts. */
const SHAPE = {
  maxPendingPerGuest: int(1, 50),
  maxPerRequest: int(1, 10),
  windowSongs: int(1, 50),
  windowMinutes: int(1, 24 * 60),
  songCooldownMinutes: int(0, 7 * 24 * 60),
  artistMaxSongs: int(1, 20),
  artistCooldownMinutes: int(0, 7 * 24 * 60),
  noExplicit: z.boolean(),
  voteEnabled: z.boolean(),
  voteRoundSeconds: int(10, 600),
  voteWhenFewerThan: int(1, 50),
  skipEnabled: z.boolean(),
  skipPercent: int(10, 100),
  skipMinVotes: int(1, 50),
  skipBlocked: z.boolean(),
} satisfies Record<keyof Settings, z.ZodType>;

/** PUT /api/admin/settings: any subset of the settings. */
export const SettingsPatch = z.object(SHAPE).partial().strict();

/** The settings a fresh install starts with: `.env` values, and fixed defaults for the rest. */
export function defaultSettings(config: Pick<Config, 'limits' | 'vote'>): Settings {
  return {
    ...config.limits,
    voteEnabled: true,
    voteRoundSeconds: Math.round(config.vote.roundMs / 1000),
    voteWhenFewerThan: config.vote.maxWaiting,
    skipEnabled: true,
    skipPercent: 50,
    skipMinVotes: 2,
    skipBlocked: true,
  };
}

/** A change the host asked for doesn't make sense (the message says why, in their words). */
export class SettingsError extends Error {}

type Listener = (next: Settings, prev: Settings) => void;

/**
 * House rules the host can change while the party runs. `.env` gives the defaults; the host's
 * changes are saved in the database and kept across restarts until they reset them.
 * Services read the current values on every use, so a change applies at once.
 */
export class SettingsService {
  private overrides: Partial<Settings>;
  private current: Settings;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly db: Db,
    private readonly defaultValues: Settings,
  ) {
    this.overrides = this.load();
    this.current = { ...defaultValues, ...this.overrides };
  }

  get(): Settings {
    return this.current;
  }

  defaults(): Settings {
    return this.defaultValues;
  }

  /** The part guests see. */
  limits(): Limits {
    const s = this.current;
    return {
      maxPendingPerGuest: s.maxPendingPerGuest,
      // A stale saved value could exceed a lower default; never let one request beat the waiting limit.
      maxPerRequest: Math.min(s.maxPerRequest, s.maxPendingPerGuest),
      windowSongs: s.windowSongs,
      windowMinutes: s.windowMinutes,
      songCooldownMinutes: s.songCooldownMinutes,
      artistMaxSongs: s.artistMaxSongs,
      artistCooldownMinutes: s.artistCooldownMinutes,
      noExplicit: s.noExplicit,
    };
  }

  /** Applies a partial change. Throws a ZodError for bad values and SettingsError for bad combinations. */
  update(patch: unknown): Settings {
    const parsed = SettingsPatch.parse(patch) as Partial<Settings>;
    const next = { ...this.current, ...parsed };
    if (next.maxPerRequest > next.maxPendingPerGuest) {
      throw new SettingsError(
        `Songs per request can't be more than songs waiting at once (${next.maxPendingPerGuest}).`,
      );
    }
    const overrides: Partial<Settings> = {};
    for (const key of Object.keys(SHAPE) as (keyof Settings)[]) {
      if (next[key] !== this.defaultValues[key]) Object.assign(overrides, { [key]: next[key] });
    }
    this.save(overrides);
    return this.current;
  }

  /** Back to the `.env` defaults. */
  reset(): Settings {
    this.save({});
    return this.current;
  }

  /** Called after every change with the new and previous values. Returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private save(overrides: Partial<Settings>): void {
    if (Object.keys(overrides).length === 0) kvDelete(this.db, SETTINGS_KEY);
    else kvSet(this.db, SETTINGS_KEY, JSON.stringify(overrides));
    const prev = this.current;
    this.overrides = overrides;
    this.current = { ...this.defaultValues, ...overrides };
    for (const listener of this.listeners) listener(this.current, prev);
  }

  /** Reads the saved changes, dropping anything that's no longer valid (e.g. after an upgrade). */
  private load(): Partial<Settings> {
    let raw: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(kvGet(this.db, SETTINGS_KEY) ?? '{}');
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
    } catch {
      // corrupt value: start from the defaults
    }
    const out: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(SHAPE)) {
      const result = schema.safeParse(raw[key]);
      if (key in raw && result.success) out[key] = result.data;
    }
    let migrated = false;
    for (const [key, legacyKey] of Object.entries(LEGACY_SWITCHES)) {
      const value = kvGet(this.db, legacyKey);
      if (value === undefined) continue;
      if (!(key in out) && value === '0') out[key] = false;
      kvDelete(this.db, legacyKey);
      migrated = true;
    }
    if (migrated) kvSet(this.db, SETTINGS_KEY, JSON.stringify(out));
    return out as Partial<Settings>;
  }
}
