import type { NowPlaying } from '@shared/types';
import { useNow } from './useNow';

/** Elapsed ms of the current song, interpolated between server snapshots (0 when nothing plays). */
export function useElapsed(nowPlaying: NowPlaying | null, skewMs: number): number {
  const playing = nowPlaying?.isPlaying ?? false;
  const now = useNow(playing);
  if (!nowPlaying) return 0;
  const elapsed = playing
    ? nowPlaying.progressMs + (now + skewMs - nowPlaying.measuredAt)
    : nowPlaying.progressMs;
  return Math.min(Math.max(elapsed, 0), nowPlaying.track.durationMs);
}
