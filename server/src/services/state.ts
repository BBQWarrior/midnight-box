import type { Server } from 'socket.io';
import type { ClientToServerEvents, Limits, NowPlaying, PublicState, ServerToClientEvents } from '@shared/types';
import type { MusicProvider } from '../providers/types.js';
import type { Player } from './player.js';
import { QueueService } from './queue.js';
import type { SkipService } from './skips.js';
import type { VoteService } from './votes.js';

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;

/** Resend progress if it drifts this far from what clients would have interpolated. */
const DRIFT_MS = 2_500;

interface StateDeps {
  provider: MusicProvider;
  queue: QueueService;
  player: Player;
  votes: VoteService;
  skips: SkipService;
  limits: Limits;
  demo: boolean;
  now?: () => number;
}

/** Builds the public snapshot and pushes it to every connected client when it changes. */
export class StateHub {
  private io: IoServer | null = null;
  private lastSignature = '';
  private lastNowPlaying: NowPlaying | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: StateDeps) {
    this.now = deps.now ?? Date.now;
  }

  attach(io: IoServer): void {
    this.io = io;
    io.on('connection', (socket) => {
      socket.emit('state', this.snapshot());
    });
  }

  snapshot(): PublicState {
    const { provider, queue, player, votes, skips, limits, demo } = this.deps;
    const { state, measuredAt } = player.playback;
    const row = queue.playing();
    const playingRow = row && row.track.uri === state?.track?.uri ? row : undefined;

    const nowPlaying: NowPlaying | null = state?.track
      ? {
          track: state.track,
          progressMs: state.progressMs,
          isPlaying: state.isPlaying,
          measuredAt,
          requestedBy: playingRow?.requestedBy ?? null,
          votePick: playingRow?.source === 'vote',
          deviceName: state.device?.name ?? null,
        }
      : null;

    return {
      providerReady: provider.isReady(),
      demoMode: demo,
      nowPlaying,
      queue: queue.upcoming().map(QueueService.toEntry),
      limits,
      vote: votes.state(),
      skip: skips.state(),
      serverTime: this.now(),
    };
  }

  /** Emits only when something visible changed (or progress drifted, e.g. after a seek). */
  broadcast(force = false): void {
    if (!this.io) return;
    const state = this.snapshot();
    const np = state.nowPlaying;
    const signature = JSON.stringify({
      ...state,
      serverTime: 0,
      nowPlaying: np && { ...np, progressMs: 0, measuredAt: 0 },
    });

    let drifted = false;
    const prev = this.lastNowPlaying;
    if (np && prev) {
      const expected = prev.progressMs + (prev.isPlaying ? np.measuredAt - prev.measuredAt : 0);
      drifted = Math.abs(expected - np.progressMs) > DRIFT_MS;
    }

    if (force || drifted || signature !== this.lastSignature) {
      this.io.emit('state', state);
      this.lastSignature = signature;
      this.lastNowPlaying = np;
    }
  }
}
