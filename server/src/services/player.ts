import {
  type MusicProvider,
  type PlaybackState,
  ProviderError,
  ProviderNotReadyError,
} from '../providers/types.js';
import type { Track } from '@shared/types';
import type { QueueService } from './queue.js';

export interface PlayerOptions {
  /** Poll interval while music is playing. */
  pollMs: number;
  /** Poll interval while idle or paused. */
  idlePollMs: number;
  /** Hand the next song to the provider when this much of the current song is left. */
  pushAheadMs: number;
  /** Minimum gap between automatic "start playing" attempts. */
  autoStartCooldownMs: number;
}

export interface Log {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface PlaybackSnapshot {
  state: PlaybackState | null;
  /** When `state` was fetched (ms). */
  measuredAt: number;
}

interface PlayerDeps {
  provider: MusicProvider;
  queue: QueueService;
  /** Called after every tick that may have changed what guests see. */
  onChange: () => void;
  /**
   * Why a song that just started should be skipped at once (the host blocked it), or null.
   * Covers songs Spotify starts on its own, which never went through the guests' rules.
   */
  skipReason?: (track: Track) => string | null;
  log: Log;
  now?: () => number;
}

/**
 * The control loop that bridges Midnight Box's queue and the provider.
 *
 * Spotify's API can append to its queue but cannot reorder or remove items, so we keep the
 * real queue ourselves and hand Spotify exactly one song, shortly before the current one ends.
 */
export class Player {
  private readonly now: () => number;
  private snapshot: PlaybackSnapshot = { state: null, measuredAt: 0 };
  /** URI seen on the previous tick; undefined until the first successful tick. */
  private lastUri: string | null | undefined = undefined;
  /** Check that the provider still holds our pushed song (after restarts or unexpected track changes). */
  private verifyPushed = true;
  /** The host paused on purpose: don't auto-start until they resume. */
  private pausedByHost = false;
  private lastDeviceId: string | null = null;
  private nextAutoStartAt = 0;
  private backoffUntil = 0;
  private lastError = '';

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private rerun = false;
  private stopped = true;

  constructor(
    private readonly deps: PlayerDeps,
    private readonly opts: PlayerOptions,
  ) {
    this.now = deps.now ?? Date.now;
  }

  get playback(): PlaybackSnapshot {
    return this.snapshot;
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run a tick soon, e.g. right after a guest adds a song. */
  poke(): void {
    if (this.stopped) return;
    if (this.ticking) this.rerun = true;
    else this.schedule(50);
  }

  // ---- Host commands -------------------------------------------------------

  async pause(): Promise<void> {
    await this.deps.provider.pause();
    this.pausedByHost = true;
    this.poke();
  }

  async resume(): Promise<void> {
    await this.deps.provider.resume();
    this.pausedByHost = false;
    this.poke();
  }

  async skip(): Promise<void> {
    const { queue, provider } = this.deps;
    // If our next song hasn't been handed over yet, the provider's "next" would be its own pick
    // (autoplay/context), so jump straight to the guests' queue instead.
    const next = queue.pushed() ? undefined : queue.nextQueued();
    if (next) {
      await provider.playNow(next.track.uri, this.lastDeviceId ?? undefined);
      queue.setStatus(next.id, 'pushed');
    } else {
      await provider.skip();
    }
    this.pausedByHost = false;
    this.poke();
  }

  /** Starts playing the queue on a device. Returns false when there is nothing to play. */
  async startOn(deviceId: string): Promise<boolean> {
    const { queue, provider } = this.deps;
    const next = queue.pushed() ?? queue.nextQueued();
    if (!next) return false;
    await provider.playNow(next.track.uri, deviceId);
    queue.setStatus(next.id, 'pushed');
    this.pausedByHost = false;
    this.lastDeviceId = deviceId;
    this.poke();
    return true;
  }

  // ---- Loop ----------------------------------------------------------------

  /** One control-loop step. Returns ms until the next poll. Public for tests. */
  async tick(): Promise<number> {
    const { provider } = this.deps;
    const now = this.now();
    if (now < this.backoffUntil) return this.backoffUntil - now;

    if (!provider.isReady()) {
      this.setSnapshot(null);
      return this.opts.idlePollMs;
    }

    const pb = await provider.getPlayback();
    this.setSnapshot(pb);
    if (pb?.device?.id) this.lastDeviceId = pb.device.id;

    const uri = pb?.track?.uri ?? null;
    if (uri !== this.lastUri) {
      this.onTrackChanged(pb);
      this.lastUri = uri;
      const reason = pb?.track && pb.isPlaying ? (this.deps.skipReason?.(pb.track) ?? null) : null;
      if (pb?.track && reason) {
        this.deps.log.info(`Skipped "${pb.track.name}": ${reason}`);
        // skip() pokes the loop, so the next song shows up right after this tick.
        await this.skip();
        this.deps.onChange();
        return this.opts.pollMs;
      }
    }
    if (this.verifyPushed) await this.verifyPushedEntry();
    await this.maybePushNext(pb);
    await this.maybeAutoStart(pb);

    this.lastError = '';
    this.deps.onChange();
    return pb?.isPlaying ? this.opts.pollMs : this.opts.idlePollMs;
  }

  private onTrackChanged(pb: PlaybackState | null): void {
    const { queue } = this.deps;
    queue.finishPlaying();
    const track = pb?.track;
    if (!track) return;

    const pushed = queue.pushed();
    if (pushed && pushed.track.uri === track.uri) {
      queue.setStatus(pushed.id, 'playing');
      queue.recordPlay(track, pushed.id);
    } else {
      queue.recordPlay(track, null);
      // Something else started (host's own queue, autoplay, manual change). Make sure our
      // pushed song is still waiting in the provider's queue.
      if (pushed) this.verifyPushed = true;
    }
  }

  private async verifyPushedEntry(): Promise<void> {
    this.verifyPushed = false;
    const { queue, provider, log } = this.deps;
    const pushed = queue.pushed();
    if (!pushed || this.snapshot.state?.track?.uri === pushed.track.uri) return;
    const upcoming = await provider.getQueueUris();
    if (!upcoming.includes(pushed.track.uri)) {
      queue.setStatus(pushed.id, 'queued');
      log.warn(`"${pushed.track.name}" was no longer in the Spotify queue; it will be sent again.`);
    }
  }

  private async maybePushNext(pb: PlaybackState | null): Promise<void> {
    const { queue, provider, log } = this.deps;
    const track = pb?.track;
    if (!pb || !track || !pb.isPlaying || queue.pushed()) return;
    if (track.durationMs - pb.progressMs > this.opts.pushAheadMs) return;

    const next = queue.nextQueued();
    if (!next) return;
    await provider.enqueue(next.track.uri);
    queue.setStatus(next.id, 'pushed');
    log.info(`Up next: "${next.track.name}"`);
  }

  private async maybeAutoStart(pb: PlaybackState | null): Promise<void> {
    const { queue, provider, log } = this.deps;
    if (this.pausedByHost || queue.pushed() || !isIdle(pb)) return;
    const next = queue.nextQueued();
    const deviceId = pb?.device?.id ?? this.lastDeviceId;
    if (!next || !deviceId) return;

    const now = this.now();
    if (now < this.nextAutoStartAt) return;
    this.nextAutoStartAt = now + this.opts.autoStartCooldownMs;

    await provider.playNow(next.track.uri, deviceId);
    queue.setStatus(next.id, 'pushed');
    log.info(`Playback was idle, starting the queue with "${next.track.name}"`);
  }

  private setSnapshot(state: PlaybackState | null): void {
    this.snapshot = { state, measuredAt: this.now() };
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), ms);
  }

  private async run(): Promise<void> {
    this.timer = null;
    this.ticking = true;
    let delay = this.opts.pollMs;
    try {
      delay = await this.tick();
    } catch (err) {
      delay = this.handleError(err);
    } finally {
      this.ticking = false;
    }
    if (this.stopped) return;
    if (this.rerun) {
      this.rerun = false;
      delay = 50;
    }
    this.schedule(delay);
  }

  private handleError(err: unknown): number {
    if (err instanceof ProviderNotReadyError) {
      this.setSnapshot(null);
      this.deps.onChange();
      return this.opts.idlePollMs;
    }
    let delay = 5_000;
    if (err instanceof ProviderError && err.status === 429) {
      delay = err.retryAfterMs ?? 5_000;
      this.backoffUntil = this.now() + delay;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message !== this.lastError) this.deps.log.warn(`Player: ${message}`);
    this.lastError = message;
    return delay;
  }
}

/** Nothing loaded, or a song sitting at its very start/end while paused (i.e. playback ran out). */
function isIdle(pb: PlaybackState | null): boolean {
  if (!pb?.track) return true;
  if (pb.isPlaying) return false;
  return pb.progressMs === 0 || pb.track.durationMs - pb.progressMs < 2_000;
}
