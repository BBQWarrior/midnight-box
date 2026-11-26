import type { ReactNode } from 'react';
import { Disc3, Pause } from 'lucide-react';
import type { NowPlaying } from '@shared/types';
import { useElapsed } from '../hooks/useElapsed';
import { artistNames, formatTime } from '../lib/format';
import { Badge } from './Badge';
import { Cover } from './Cover';
import { OpenSpotifyLink } from './Spotify';
import { Card } from './ui';

interface Props {
  nowPlaying: NowPlaying | null;
  skewMs: number;
  /** Optional extra row under the progress bar (guest page: skip vote; host: block). */
  action?: ReactNode;
  /** Real Spotify content (not demo mode): show the link back. */
  spotify?: boolean;
}

/** Three small bars that move while music plays. */
export function Equalizer({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`eq inline-flex h-3 items-end gap-[2px] ${className}`}>
      <span className="h-full w-[3px] rounded-sm bg-current" />
      <span className="h-full w-[3px] rounded-sm bg-current" />
      <span className="h-full w-[3px] rounded-sm bg-current" />
    </span>
  );
}

export function NowPlayingCard({ nowPlaying, skewMs, action, spotify = false }: Props) {
  const playing = nowPlaying?.isPlaying ?? false;
  const clamped = useElapsed(nowPlaying, skewMs);

  if (!nowPlaying) {
    return (
      <Card className="flex items-center gap-4 p-4">
        <div className="flex size-20 items-center justify-center rounded-md bg-raised text-faint">
          <Disc3 size={30} aria-hidden="true" />
        </div>
        <div>
          <h2 className="font-semibold">Nothing playing</h2>
          <p className="text-sm text-muted">Add a song and get the night started.</p>
        </div>
      </Card>
    );
  }

  const { track } = nowPlaying;
  const pct = track.durationMs > 0 ? (clamped / track.durationMs) * 100 : 0;

  return (
    <Card label="Now playing" className="p-4">
      <div className="flex items-center gap-4">
        <Cover track={track} className="size-24" iconSize={34} rounded="rounded-md" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-xs font-semibold text-accent">
            {playing ? (
              <>
                <Equalizer /> Now playing
              </>
            ) : (
              <>
                <Pause size={12} aria-hidden="true" /> Paused
              </>
            )}
          </p>
          <h2 className="mt-1 text-lg leading-snug font-bold break-words">{track.name}</h2>
          <p className="truncate text-sm text-muted" title={artistNames(track.artists)}>
            {artistNames(track.artists)}
          </p>
          {(nowPlaying.votePick || nowPlaying.requestedBy) && (
            <p className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted">
              {nowPlaying.votePick ? (
                <Badge tone="accent">Vote pick</Badge>
              ) : (
                <span className="truncate">Requested by {nowPlaying.requestedBy?.name}</span>
              )}
            </p>
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
          className="h-1 overflow-hidden rounded-full bg-line"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-faint tabular-nums">
          <span>{formatTime(clamped)}</span>
          <span>{formatTime(track.durationMs)}</span>
        </div>
      </div>
      {spotify && (
        <div className="mt-1 flex min-h-8 items-center">
          <OpenSpotifyLink track={track} className="text-xs" />
        </div>
      )}
      {action && <div className="mt-3">{action}</div>}
    </Card>
  );
}
