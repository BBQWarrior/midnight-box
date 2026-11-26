import { Pause, Play, SkipForward, Speaker } from 'lucide-react';
import type { PublicState } from '@shared/types';
import { api } from '../../lib/api';
import { useSecondsLeft } from '../../hooks/useSecondsLeft';
import { NowPlayingCard } from '../../components/NowPlayingCard';
import { ExtLink, trackUrl } from '../../components/Spotify';
import { Button, Card, Heading } from '../../components/ui';
import { BlockMenu } from './BlockMenu';
import { useHost } from './host';

export function NowTab({ state, skewMs }: { state: PublicState | null; skewMs: number }) {
  const { status, run, refresh, spotify } = useHost();
  const np = state?.nowPlaying ?? null;
  const round = state?.vote.round ?? null;
  const secondsLeft = useSecondsLeft(round?.endsAt ?? null, skewMs);
  const lastResult = state?.vote.lastResult ?? null;

  return (
    <div className="flex flex-col gap-4">
      <NowPlayingCard
        spotify={spotify}
        nowPlaying={np}
        skewMs={skewMs}
        action={
          <div className="flex flex-wrap gap-2">
            {np?.isPlaying ? (
              <Button onClick={() => void run(() => api.playback('pause'))}>
                <Pause size={16} aria-hidden="true" /> Pause
              </Button>
            ) : (
              <Button onClick={() => void run(() => api.playback('resume'))}>
                <Play size={16} aria-hidden="true" /> Resume
              </Button>
            )}
            <Button onClick={() => void run(() => api.playback('skip'))}>
              <SkipForward size={16} aria-hidden="true" /> Skip
            </Button>
            {np && <BlockMenu key={np.track.id} track={np.track} />}
            {state && state.skip.enabled && state.skip.votes > 0 && (
              <p className="w-full text-xs text-muted tabular-nums">
                Skip votes: {state.skip.votes} of {state.skip.needed}
              </p>
            )}
          </div>
        }
      />

      {round && (
        <Card className="p-4">
          <Heading
            title="Vote round"
            description={`Related to ${round.basedOn.name} by ${round.basedOn.artist}`}
            actions={<span className="text-sm font-semibold text-accent tabular-nums">{secondsLeft}s</span>}
          />
          <ul className="mt-3 divide-y divide-line">
            {round.candidates.map((c) => (
              <li key={c.track.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold" title={c.track.name}>
                    {spotify ? (
                      <ExtLink href={trackUrl(c.track)} className="hover:underline">
                        {c.track.name}
                      </ExtLink>
                    ) : (
                      c.track.name
                    )}
                  </p>
                  <p className="truncate text-[13px] text-muted">{c.track.artists[0]?.name}</p>
                </div>
                <span className="shrink-0 text-sm text-muted tabular-nums">
                  {c.votes} {c.votes === 1 ? 'vote' : 'votes'}
                </span>
              </li>
            ))}
          </ul>
          <Button className="mt-3" onClick={() => void run(() => api.endVoteRound())}>
            End round now
          </Button>
        </Card>
      )}
      {!round && lastResult && (
        <p className="px-1 text-[13px] text-faint">
          {lastResult.winner
            ? `Last vote: ${lastResult.winner.name} (${lastResult.votes} ${lastResult.votes === 1 ? 'vote' : 'votes'})`
            : 'Last vote: no votes'}
        </p>
      )}

      <Card className="p-4">
        <Heading title="Speakers" description="Spotify devices that are on right now." />
        {status && status.devices.length > 0 ? (
          <ul className="mt-2 divide-y divide-line">
            {status.devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <Speaker size={18} aria-hidden="true" className={d.isActive ? 'text-accent' : 'text-faint'} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{d.name}</p>
                    <p className="text-xs text-muted">
                      {d.type}
                      {d.isActive ? ' · playing here' : ''}
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="primary" onClick={() => void run(() => api.start(d.id)).then(() => refresh())}>
                  Play queue here
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No devices found. Open Spotify on a device and it will show up here.</p>
        )}
      </Card>
    </div>
  );
}
