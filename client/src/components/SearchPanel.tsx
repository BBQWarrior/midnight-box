import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Search } from 'lucide-react';
import type { PublicState, Quota, SearchResult, Track } from '@shared/types';
import { ApiRequestError, api, errorMessage, isAbort } from '../lib/api';
import { artistNames, formatClock, formatTime } from '../lib/format';
import { computeAllowance } from '../lib/quota';
import { blockText, rejectText } from '../lib/reasons';
import { useNow } from '../hooks/useNow';
import { Badge } from './Badge';
import { CoverLink, SpotifyLogo } from './Spotify';
import { useToast } from './Toast';
import { Button, Card } from './ui';

interface Props {
  state: PublicState;
  myPublicId: string;
  recentAdds: number[];
  skewMs: number;
  onQuota: (quota: Quota) => void;
  onForbidden: () => void;
  onAdded: () => void;
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
      <div className="sticky top-0 z-10 -mx-4 bg-bg px-4 pt-1 pb-3">
        <label htmlFor="song-search" className="sr-only">
          Search songs
        </label>
        <div className="relative">
          <Search size={18} aria-hidden="true" className="absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
          <input
            id="song-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!providerReady}
            maxLength={100}
            placeholder={providerReady ? 'Search songs or artists' : 'Search unavailable'}
            className="h-12 w-full rounded-lg border border-line bg-surface pr-4 pl-11 text-base text-ink placeholder:text-faint focus:border-faint disabled:opacity-50"
          />
        </div>
        <p className="mt-2 px-1 text-[13px] text-muted">{hint}</p>
        {!state.demoMode && providerReady && (
          <div className="-mb-3 -ml-3">
            <SpotifyLogo />
          </div>
        )}
      </div>

      {loading && results.length === 0 && (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Searching…
        </p>
      )}
      {searched && !loading && results.length === 0 && (
        <p className="py-8 text-center text-sm text-muted">No songs found for that search.</p>
      )}
      {!query.trim() && providerReady && (
        <p className="py-8 text-center text-sm text-faint">Type a song or artist to start.</p>
      )}

      <div className="pb-28">
        {results.length > 0 && (
          <Card>
            <ul className="divide-y divide-line">
              {results.map(({ track, block }) => {
                const isPlaying = track.id === playingId;
                const disabled = isPlaying || block !== null;
                const isSel = selected.has(track.id);
                const blocked = !disabled && !isSel && selected.size >= maxSelectable;
                return (
                  <li key={track.id} className={`flex items-center pl-3 transition-colors ${isSel ? 'bg-accent-soft' : ''}`}>
                    <CoverLink track={track} spotify={!state.demoMode} />
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isSel}
                      disabled={disabled || blocked}
                      onClick={() => toggle(track)}
                      className={`flex min-h-16 min-w-0 flex-1 items-center gap-3 py-2.5 pr-3 pl-3 text-left ${
                        disabled || blocked ? 'opacity-50' : 'active:bg-raised'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold" title={track.name}>
                            {track.name}
                          </span>
                          {track.explicit && (
                            <Badge tone="explicit" label="Explicit">
                              E
                            </Badge>
                          )}
                        </span>
                        <span className="block truncate text-[13px] text-muted" title={artistNames(track.artists)}>
                          {artistNames(track.artists)}
                        </span>
                        {block && <span className="block text-xs text-faint">{blockText(block)}</span>}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {isPlaying ? (
                          <Badge tone="accent">Playing</Badge>
                        ) : block ? null : (
                          <span
                            aria-hidden="true"
                            className={`flex size-6 items-center justify-center rounded-full border ${
                              isSel ? 'border-accent bg-accent text-accent-ink' : 'border-faint'
                            }`}
                          >
                            {isSel && <Check size={14} strokeWidth={3} />}
                          </span>
                        )}
                        <span className="text-xs text-faint tabular-nums">{formatTime(track.durationMs)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
        {nextOffset !== null && (
          <Button className="mt-3 w-full" disabled={loading} onClick={() => void runSearch(query.trim(), nextOffset)}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>

      {selected.size > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md border-t border-line bg-bg px-4 pt-3"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
        >
          <Button variant="primary" className="min-h-12 w-full text-base" disabled={submitting} onClick={() => void submit()}>
            {submitting ? 'Adding…' : `Add ${selected.size} song${selected.size === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}
    </div>
  );
}
