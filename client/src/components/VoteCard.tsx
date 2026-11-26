import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import type { VoteState } from '@shared/types';
import { ApiRequestError, api, errorMessage, isAbort } from '../lib/api';
import { useSecondsLeft } from '../hooks/useSecondsLeft';
import { CoverLink } from './Spotify';
import { useToast } from './Toast';
import { Card, Heading } from './ui';

interface Props {
  vote: VoteState;
  skewMs: number;
  onForbidden: () => void;
  spotify?: boolean;
}

export function VoteCard({ vote, skewMs, onForbidden, spotify = false }: Props) {
  const toast = useToast();
  const round = vote.round;
  const roundId = round?.id ?? null;
  const secondsLeft = useSecondsLeft(round?.endsAt ?? null, skewMs);
  const [mine, setMine] = useState<string[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const seenResult = useRef(vote.lastResult?.roundId ?? null);

  // Toast the winner of a round that ended while the page was open
  const result = vote.lastResult;
  useEffect(() => {
    if (!result || result.roundId === seenResult.current) return;
    seenResult.current = result.roundId;
    if (result.winner) toast.show(`“${result.winner.name}” won the vote`);
  }, [result, toast]);

  // Load my votes when the round changes
  useEffect(() => {
    setMine([]);
    if (roundId === null) return;
    let alive = true;
    api.getMyVotes().then(
      (v) => {
        if (alive && v.roundId === roundId) setMine(v.trackIds);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [roundId]);

  const toggle = useCallback(
    async (trackId: string): Promise<void> => {
      if (roundId === null) return;
      const was = mine.includes(trackId);
      setBusy((b) => new Set(b).add(trackId));
      setMine((m) => (was ? m.filter((id) => id !== trackId) : [...m, trackId]));
      try {
        const res = await api.vote({ roundId, trackId, vote: !was });
        if (res.roundId === roundId) setMine(res.trackIds);
      } catch (err) {
        if (isAbort(err)) return;
        setMine((m) => (was ? [...m, trackId] : m.filter((id) => id !== trackId)));
        if (err instanceof ApiRequestError && err.code === 'forbidden') onForbidden();
        else toast.show(errorMessage(err), 'error');
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(trackId);
          return next;
        });
      }
    },
    [roundId, mine, onForbidden, toast],
  );

  if (!vote.active) return null;

  if (!round) {
    return <p className="mb-3 px-1 text-[13px] text-faint">The next vote starts when the queue runs low.</p>;
  }

  const total = round.candidates.reduce((sum, c) => sum + c.votes, 0);

  return (
    <Card label="Vote for the next song" className="mb-3 p-4">
      <Heading
        title="Vote for the next song"
        description={
          <span className="block truncate">
            Related to {round.basedOn.name} by {round.basedOn.artist}
          </span>
        }
        actions={
          <span
            role="timer"
            aria-label={`${secondsLeft} seconds left`}
            className="rounded-md bg-accent-soft px-2 py-1 text-xs font-bold text-accent tabular-nums"
          >
            {secondsLeft}s
          </span>
        }
      />
      <ul className="mt-3 flex flex-col gap-3">
        {round.candidates.map((c) => {
          const picked = mine.includes(c.track.id);
          const share = total > 0 ? (c.votes / total) * 100 : 0;
          return (
            <li key={c.track.id} className="flex items-center gap-3">
              <CoverLink track={c.track} spotify={spotify} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold" title={c.track.name}>
                  {c.track.name}
                </p>
                <p className="truncate text-[13px] text-muted" title={c.track.artists[0]?.name}>
                  {c.track.artists[0]?.name}
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${share}%` }} />
                  </div>
                  <span className="w-12 shrink-0 text-right text-xs text-faint tabular-nums">
                    {c.votes} {c.votes === 1 ? 'vote' : 'votes'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                aria-pressed={picked}
                aria-label={`${picked ? 'Take back vote for' : 'Vote for'} ${c.track.name}`}
                disabled={busy.has(c.track.id) || secondsLeft === 0}
                onClick={() => void toggle(c.track.id)}
                className={`flex size-11 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-60 ${
                  picked ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-raised text-ink hover:border-faint/60'
                }`}
              >
                {picked ? <Check size={20} aria-hidden="true" /> : <Plus size={20} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-faint">Vote for as many as you like. Votes don&apos;t use up your song requests.</p>
    </Card>
  );
}
