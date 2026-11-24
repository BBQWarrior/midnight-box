import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Search } from 'lucide-react';
import type { PublicState, Quota, RejectReason, SearchResult, Track, TrackBlock } from '@shared/types';
import { ApiRequestError, api, errorMessage, isAbort } from '../lib/api';
import { formatClock, formatTime } from '../lib/format';
import { computeAllowance } from '../lib/quota';
import { useNow } from '../hooks/useNow';
import { Badge } from './Badge';
import { CoverLink, SpotifyLogo } from './Spotify';
import { useToast } from './Toast';

interface Props {
  state: PublicState;
  myPublicId: string;
  recentAdds: number[];
  skewMs: number;
  onQuota: (quota: Quota) => void;
  onForbidden: () => void;
  onAdded: () => void;
}

function at(availableAt: number | null): string {
  return availableAt === null ? '' : ` at ${formatClock(availableAt)}`;
}

function rejectText(reason: RejectReason, availableAt: number | null): string {
  switch (reason) {
    case 'already_queued':
      return 'already in the queue';
    case 'artist_queued':
      return 'this artist is already queued';
    case 'song_cooldown':
      return `played recently, free again${at(availableAt)}`;
    case 'artist_cooldown':
      return `artist played recently, free again${at(availableAt)}`;
    case 'too_soon':
      return availableAt === null ? "you've added enough for now" : `you can add again at ${formatClock(availableAt)}`;
    case 'limit_reached':
      return "you've hit your song limit";
    case 'not_found':
      return "couldn't find that song";
  }
}

function blockText(block: TrackBlock): string {
  const when = block.availableAt === null ? '' : ` · free again at ${formatClock(block.availableAt)}`;
  switch (block.reason) {
    case 'already_queued':
      return 'Already in the queue';
    case 'artist_queued':
      return 'This artist is already queued';
    case 'song_cooldown':
      return `Played recently${when}`;
    case 'artist_cooldown':
      return `Artist played recently${when}`;
  }
}

export function SearchPanel({ state, myPublicId, recentAdds, skewMs, onQuota, onForbidden, onAdded }: Props) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Map<string, Track>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const { limits, queue, nowPlaying, providerReady } = state;
  const now = useNow(true, 5000);
  const myPending = queue.filter((e) => e.requestedBy?.publicId === myPublicId).length;
  const allowance = computeAllowance(limits, myPending, recentAdds, now + skewMs);
  const maxSelectable = allowance.count;
  const playingId = nowPlaying?.track.id;

  const runSearch = useCallback(async (q: string, offset: number): Promise<void> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await api.search(q, offset, ctrl.signal);
      setResults((prev) => (offset === 0 ? res.results : [...prev, ...res.results]));
      setNextOffset(res.nextOffset);
      setSearched(true);
      setLoading(false);
    } catch (err) {
      if (isAbort(err)) return;
      setLoading(false);
      toast.show(errorMessage(err), 'error');
    }
  }, [toast]);

  useEffect(() => {
    const q = query.trim();
    if (!q || !providerReady) {
      abortRef.current?.abort();
      setResults([]);
      setNextOffset(null);
      setSearched(false);
      setLoading(false);
      return;
    }
    const id = window.setTimeout(() => void runSearch(q, 0), 300);
    return () => window.clearTimeout(id);
  }, [query, providerReady, runSearch]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const toggle = (track: Track): void => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(track.id)) next.delete(track.id);
      else if (next.size < maxSelectable) next.set(track.id, track);
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.addToQueue([...selected.keys()]);
      const parts: string[] = [];
      if (res.added.length > 0) {
        parts.push(`Added ${res.added.length} song${res.added.length === 1 ? '' : 's'}`);
      }
      const trackName = (id: string): string => selected.get(id)?.name ?? 'A song';
      for (const r of res.rejected) {
        parts.push(`${trackName(r.trackId)}: ${rejectText(r.reason, r.availableAt)}`);
      }
      onQuota(res.quota);
      toast.show(parts.join('. ') || 'Nothing was added', res.added.length > 0 ? 'info' : 'error');
      setSelected(new Map());
      onAdded();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'forbidden') onForbidden();
      else toast.show(errorMessage(err), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const hint =
    allowance.count > 0
      ? `You can add ${allowance.count} more${selected.size >= allowance.count ? ' · limit reached for this add' : ''}`
      : allowance.blockedBy === 'window'
        ? allowance.nextAt === null
          ? 'Next song soon'
          : `Next song at ${formatClock(allowance.nextAt)}`
        : 'Wait until one of your songs plays';

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-4 bg-midnight-950/80 px-4 pb-3 pt-1 backdrop-blur-xl">
        <label htmlFor="song-search" className="sr-only">
          Search songs
        </label>
        <div className="relative">
          <Search size={18} aria-hidden="true" className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50" />
          <input
            id="song-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!providerReady}
            maxLength={100}
            placeholder={providerReady ? 'Search songs or artists' : 'Search unavailable'}
            className="h-12 w-full rounded-full border border-white/15 bg-white/5 pl-11 pr-4 text-base text-white placeholder:text-white/40 disabled:opacity-50"
          />
        </div>
        <p className="mt-2 px-1 text-xs text-white/60">{hint}</p>
        {!state.demoMode && providerReady && (
          <div className="-mb-3 -ml-3">
            <SpotifyLogo />
          </div>
        )}
      </div>

      {loading && results.length === 0 && (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-white/60" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Searching…
        </p>
      )}
      {searched && !loading && results.length === 0 && (
        <p className="py-8 text-center text-sm text-white/60">No songs found for that search.</p>
      )}
      {!query.trim() && providerReady && (
        <p className="py-8 text-center text-sm text-white/50">Type a song or artist to start.</p>
      )}

      <ul className="flex flex-col gap-2 pb-28">
        {results.map(({ track, block }) => {
          const isPlaying = track.id === playingId;
          const disabled = isPlaying || block !== null;
          const isSel = selected.has(track.id);
          const blocked = !disabled && !isSel && selected.size >= maxSelectable;
          return (
            <li
              key={track.id}
              className={`flex items-center rounded-2xl border pl-2.5 backdrop-blur-xl transition-colors ${
                isSel ? 'border-accent bg-accent/15' : 'border-white/10 bg-white/5'
              }`}
            >
              <CoverLink track={track} spotify={!state.demoMode} />
              <button
                type="button"
                role="checkbox"
                aria-checked={isSel}
                disabled={disabled || blocked}
                onClick={() => toggle(track)}
                className={`flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-r-2xl py-2.5 pl-3 pr-2.5 text-left ${
                  disabled || blocked ? 'opacity-50' : 'active:bg-white/10'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium" title={track.name}>{track.name}</span>
                    {track.explicit && <Badge tone="explicit" label="Explicit">E</Badge>}
                  </span>
                  <span className="block truncate text-xs text-white/60" title={track.artists.map((a) => a.name).join(', ')}>
                    {track.artists.map((a) => a.name).join(', ')}
                  </span>
                  {block && <span className="block text-xs text-amber-200/80">{blockText(block)}</span>}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {isPlaying ? (
                    <Badge tone="cyan">Playing</Badge>
                  ) : block ? null : (
                    <span
                      aria-hidden="true"
                      className={`flex size-6 items-center justify-center rounded-full border ${
                        isSel ? 'border-accent bg-accent text-white' : 'border-white/30'
                      }`}
                    >
                      {isSel && <Check size={14} />}
                    </span>
                  )}
                  <span className="text-xs tabular-nums text-white/50">{formatTime(track.durationMs)}</span>
                </span>
              </button>
            </li>
          );
        })}
        {nextOffset !== null && (
          <li>
            <button
              type="button"
              disabled={loading}
              onClick={() => void runSearch(query.trim(), nextOffset)}
              className="min-h-11 w-full rounded-full border border-white/15 text-sm font-medium disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          </li>
        )}
      </ul>

      {selected.size > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md border-t border-white/10 bg-midnight-950/90 px-4 pt-3 backdrop-blur-xl"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
        >
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="min-h-12 w-full rounded-full bg-linear-to-r from-accent to-accent-2 font-semibold text-white shadow-lg disabled:opacity-60"
          >
            {submitting ? 'Adding…' : `Add ${selected.size} song${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </div>
  );
}
