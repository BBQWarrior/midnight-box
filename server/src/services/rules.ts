import type { Track, TrackBlock } from '@shared/types';
import type { BlacklistService } from './blacklist.js';
import type { CooldownService } from './cooldowns.js';
import type { QueueService } from './queue.js';

interface RulesDeps {
  blacklist: BlacklistService;
  cooldowns: CooldownService;
  queue: QueueService;
  /** The host's explicit-songs switch, read on every call. */
  noExplicit: () => boolean;
}

/**
 * The one place that decides whether a track can be requested: the host's own rules first
 * (blacklist, explicit filter), then play history (duplicates and cooldowns). Search, adding songs
 * and vote rounds all ask here.
 */
export class TrackRules {
  constructor(private readonly deps: RulesDeps) {}

  /** Why `track` can't be requested right now, or null if it can. `playing` is what the speaker plays. */
  blockFor(track: Track, playing: Track | null): TrackBlock | null {
    return this.forbidden(track) ?? this.deps.cooldowns.blockFor(track, playing);
  }

  /** Blocked by the host whatever the time: on the blacklist, or explicit while explicit songs are off. */
  forbidden(track: Track): TrackBlock | null {
    if (this.deps.blacklist.match(track)) return { reason: 'blacklisted', availableAt: null };
    if (track.explicit && this.deps.noExplicit()) return { reason: 'explicit', availableAt: null };
    return null;
  }

  /**
   * Takes songs the host's rules now forbid out of the queue (after a blacklist or explicit change).
   * Songs already handed to Spotify stay; the player skips them when they start, if the host wants.
   * Returns how many were removed.
   */
  dropForbiddenFromQueue(): number {
    const { queue } = this.deps;
    let removed = 0;
    for (const row of queue.upcoming()) {
      if (row.status === 'queued' && this.forbidden(row.track) && queue.remove(row.id) === 'removed') removed++;
    }
    return removed;
  }
}
