import { useCallback, useEffect, useState } from 'react';
import { SkipForward } from 'lucide-react';
import type { PublicState } from '@shared/types';
import { ApiRequestError, api, errorMessage, isAbort } from '../lib/api';
import { useToast } from './Toast';

interface Props {
  skip: PublicState['skip'];
  /** The song the guest sees; a late tap can't skip the next one. */
  trackId: string;
  onForbidden: () => void;
}

export function SkipButton({ skip, trackId, onForbidden }: Props) {
  const toast = useToast();
  const [voted, setVoted] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = skip.trackId === trackId;

  // Load my vote when the song changes
  useEffect(() => {
    setVoted(false);
    let alive = true;
    api.getMySkip().then(
      (v) => {
        if (alive && v.trackId === trackId) setVoted(v.voted);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [trackId]);

  const toggle = useCallback(async (): Promise<void> => {
    const was = voted;
    setBusy(true);
    setVoted(!was);
    try {
      const res = await api.voteSkip(trackId, !was);
      if (res.trackId === trackId) setVoted(res.voted);
    } catch (err) {
      if (isAbort(err)) return;
      setVoted(was);
      if (err instanceof ApiRequestError && err.code === 'forbidden') onForbidden();
      else toast.show(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }, [voted, trackId, onForbidden, toast]);

  if (!current) return null;

  return (
    <button
      type="button"
      aria-pressed={voted}
      aria-label={`${voted ? 'Take back skip vote' : 'Vote to skip this song'}, ${skip.votes} of ${skip.needed} votes`}
      disabled={busy}
      onClick={() => void toggle()}
      className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-full border text-sm font-semibold transition-colors disabled:opacity-60 ${
        voted
          ? 'border-transparent bg-linear-to-r from-accent to-accent-2 text-white'
          : 'border-white/20 bg-white/5 text-white/80'
      }`}
    >
      <SkipForward size={16} aria-hidden="true" />
      Skip · {skip.votes}/{skip.needed}
    </button>
  );
}
