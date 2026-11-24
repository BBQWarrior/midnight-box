import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import type { VoteState } from '@shared/types';
import { ApiRequestError, api, errorMessage, isAbort } from '../lib/api';
import { useSecondsLeft } from '../hooks/useSecondsLeft';
import { CoverLink } from './Spotify';
import { useToast } from './Toast';

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
    return <p className="mb-3 px-1 text-xs text-white/50">The next vote starts when the queue runs low.</p>;
  }

  return (
    <section aria-label="Vote for the next song" className="mb-3 rounded-3xl border border-white/10 bg-white/5 p-4 backdrop-blur-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Vote for the next song</h2>
          <p className="truncate text-xs text-white/60">
            Related to {round.basedOn.name} by {round.basedOn.artist}
          </p>
        </div>
        <span
          role="timer"
          aria-label={`${secondsLeft} seconds left`}
          className="shrink-0 rounded-full border border-glow/30 bg-glow/15 px-2.5 py-1 text-xs font-semibold tabular-nums text-cyan-200"
        >
          {secondsLeft}s
        </span>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {round.candidates.map((c) => {
          const picked = mine.includes(c.track.id);
          return (
            <li key={c.track.id} className="flex items-center gap-3">
              <CoverLink track={c.track} spotify={spotify} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={c.track.name}>{c.track.name}</p>
                <p className="truncate text-xs text-white/60" title={c.track.artists[0]?.name}>{c.track.artists[0]?.name}</p>
                <p className="text-xs tabular-nums text-white/50">
                  {c.votes} {c.votes === 1 ? 'vote' : 'votes'}
                </p>
              </div>
              <button
                type="button"
                aria-pressed={picked}
                aria-label={`${picked ? 'Take back vote for' : 'Vote for'} ${c.track.name}`}
                disabled={busy.has(c.track.id) || secondsLeft === 0}
                onClick={() => void toggle(c.track.id)}
                className={`flex size-12 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-60 ${
                  picked
                    ? 'border-transparent bg-linear-to-r from-accent to-accent-2 text-white'
                    : 'border-white/20 bg-white/5 text-white/80'
                }`}
              >
                {picked ? <Check size={20} aria-hidden="true" /> : <Plus size={20} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-white/50">Vote for as many as you like. Votes don&apos;t use up your song requests.</p>
    </section>
  );
}
