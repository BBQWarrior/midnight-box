import type { ReactNode } from 'react';
import { Pause, Disc3 } from 'lucide-react';
import type { NowPlaying } from '@shared/types';
import { useElapsed } from '../hooks/useElapsed';
import { formatTime } from '../lib/format';
import { Badge } from './Badge';
import { Cover } from './Cover';
import { OpenSpotifyLink } from './Spotify';

interface Props {
  nowPlaying: NowPlaying | null;
  skewMs: number;
  /** Optional extra row under the progress bar (guest page: skip vote). */
  action?: ReactNode;
  /** Real Spotify content (not demo mode): show the link back. */
  spotify?: boolean;
}

export function NowPlayingCard({ nowPlaying, skewMs, action, spotify = false }: Props) {
  const playing = nowPlaying?.isPlaying ?? false;
  const clamped = useElapsed(nowPlaying, skewMs);

  if (!nowPlaying) {
    return (
      <section className="flex items-center gap-4 rounded-3xl border border-white/10 bg-white/5 p-4 backdrop-blur-xl">
        <div className="flex size-20 items-center justify-center rounded-2xl bg-white/5 text-white/40">
          <Disc3 size={32} />
        </div>
        <div>
          <h2 className="font-semibold">Nothing playing</h2>
          <p className="text-sm text-white/60">Add a song and get the night started.</p>
        </div>
      </section>
    );
  }

  const { track } = nowPlaying;
  const pct = track.durationMs > 0 ? (clamped / track.durationMs) * 100 : 0;

  return (
    <section
      aria-label="Now playing"
      className="rounded-3xl border border-white/10 bg-white/5 p-4 backdrop-blur-xl"
    >
      <div className="flex items-center gap-4">
        <Cover track={track} className="size-24" iconSize={36} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-glow">
            {playing ? 'Now playing' : (
              <>
                <Pause size={12} aria-hidden="true" /> Paused
              </>
            )}
          </p>
          <h2 className="mt-1 break-words text-lg font-semibold">{track.name}</h2>
          <p className="truncate text-sm text-white/70" title={track.artists.map((a) => a.name).join(', ')}>
            {track.artists.map((a) => a.name).join(', ')}
          </p>
          {nowPlaying.votePick && (
            <span className="mt-2 inline-block">
              <Badge tone="cyan">Vote pick</Badge>
            </span>
          )}
          {!nowPlaying.votePick && nowPlaying.requestedBy && (
            <span className="mt-2 inline-block max-w-full truncate rounded-full border border-accent/40 bg-accent/20 px-2.5 py-0.5 text-xs text-violet-100">
              Requested by {nowPlaying.requestedBy.name}
            </span>
          )}
        </div>
      </div>
      <div className="mt-4">
        <div
          role="progressbar"
          aria-label="Song progress"
          aria-valuemin={0}
          aria-valuemax={Math.round(track.durationMs / 1000)}
          aria-valuenow={Math.round(clamped / 1000)}
          className="h-1.5 overflow-hidden rounded-full bg-white/10"
        >
          <div className="h-full rounded-full bg-glow" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1.5 flex justify-between text-xs tabular-nums text-white/60">
          <span>{formatTime(clamped)}</span>
          <span>{formatTime(track.durationMs)}</span>
        </div>
      </div>
      {spotify && (
        <div className="mt-2 flex min-h-8 items-center">
          <OpenSpotifyLink track={track} className="text-xs" />
        </div>
      )}
      {action && <div className="mt-3">{action}</div>}
    </section>
  );
}
