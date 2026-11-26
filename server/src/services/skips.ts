import type { MySkip, SkipResult, SkipState, Track } from '@shared/types';
import type { Db } from '../db.js';
import type { GuestService } from './guests.js';
import type { Log, Player } from './player.js';

/** Read on every use, so the host's changes apply at once. */
export interface SkipOptions {
  /** The host's on/off switch. */
  enabled: boolean;
  /** Guests count towards the target this long after their last request. */
  activeMs: number;
  /** Share of the active guests (percent) whose votes skip a song. */
  percent: number;
  /** Never fewer votes than this, so one guest alone can't skip. */
  minVotes: number;
}

interface SkipDeps {
  db: Db;
  guests: GuestService;
  player: Player;
  log: Log;
  /** Called whenever what guests see may have changed. */
  onChange: () => void;
  now?: () => number;
}

export type SkipOutcome = MySkip | 'disabled' | 'ended' | 'paused';

/**
 * Vote to skip: once enough guests vote against the song that is playing, it's skipped.
 * The target is half the guests active lately, so it scales with the party.
 * Votes are per device (see voterKey), kept in memory, and reset when the song changes.
 */
export class SkipService {
  /** The song the current votes are for. Votes for any other song are stale. */
  private trackId: string | null = null;
  private readonly voters = new Set<string>();
  private needed: number | null = null;
  /** Set once the target is reached, so parallel votes can't skip twice. */
  private skipping = false;
  private lastSkip: SkipResult | null = null;
  private readonly now: () => number;

  constructor(
    private readonly deps: SkipDeps,
    private readonly options: () => SkipOptions,
  ) {
    this.now = deps.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.options().enabled;
  }

  /** Call after the host changed the settings: switching skip votes off drops the votes so far. */
  settingsChanged(): void {
    if (!this.enabled) this.reset(null);
    this.deps.onChange();
  }

  /** For guests (part of the live state). */
  state(): SkipState {
    const playing = this.playing();
    const current = this.isCurrent(playing);
    return {
      enabled: this.enabled,
      trackId: playing?.id ?? null,
      votes: current ? this.voters.size : 0,
      needed: (current && this.voters.size > 0 ? this.needed : null) ?? this.target(),
      lastSkip: this.lastSkip,
    };
  }

  mine(voter: string): MySkip {
    const playing = this.playing();
    return { trackId: playing?.id ?? null, voted: this.isCurrent(playing) && this.voters.has(voter) };
  }

  /** Adds or takes back a vote to skip `trackId`, and skips it once enough guests agree. */
  async vote(voter: string, trackId: string, on: boolean): Promise<SkipOutcome> {
    if (!this.enabled) return 'disabled';
    const playback = this.deps.player.playback.state;
    const playing = playback?.track;
    if (!playing || playing.id !== trackId) return 'ended';
    // Skipping would also restart music the host paused on purpose.
    if (!playback.isPlaying) return 'paused';

    if (!this.isCurrent(playing)) this.reset(playing.id);
    if (on) {
      if (this.voters.size === 0) this.needed = this.target();
      this.voters.add(voter);
    } else {
      this.voters.delete(voter);
    }

    const needed = this.needed ?? this.target();
    if (on && !this.skipping && this.voters.size >= needed) await this.skip(playing, needed);
    this.deps.onChange();
    return this.mine(voter);
  }

  /** Drops someone's votes (they were removed from the party). */
  removeVoter(...voters: string[]): void {
    for (const v of voters) this.voters.delete(v);
    this.deps.onChange();
  }

  private async skip(track: Track, needed: number): Promise<void> {
    this.skipping = true;
    const votes = this.voters.size;
    try {
      await this.deps.player.skip();
    } catch (err) {
      // Let the next vote try again.
      this.skipping = false;
      throw err;
    }
    this.deps.log.info(`Guests voted to skip "${track.name}" (${votes} of ${needed} votes)`);
    this.lastSkip = { track, votes, at: this.now() };
  }

  /** The host's share (half by default) of the guests active lately, rounded up, but never fewer than `minVotes`. */
  private target(): number {
    const { activeMs, percent, minVotes } = this.options();
    const active = this.deps.guests.activeDevices(this.now() - activeMs);
    return Math.max(minVotes, Math.ceil((active * percent) / 100));
  }

  private playing(): Track | null {
    return this.deps.player.playback.state?.track ?? null;
  }

  private isCurrent(playing: Track | null): boolean {
    return playing !== null && playing.id === this.trackId;
  }

  private reset(trackId: string | null): void {
    this.trackId = trackId;
    this.voters.clear();
    this.needed = null;
    this.skipping = false;
  }
}
