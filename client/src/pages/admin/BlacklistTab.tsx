import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Download, Loader2, Search, Trash2, Upload, X } from 'lucide-react';
import type { BlacklistFile, BlacklistItem, BlacklistKind, SearchResult } from '@shared/types';
import { BLACKLIST_EXPORT_URL, api, errorMessage, isAbort } from '../../lib/api';
import { artistNames } from '../../lib/format';
import { blockText } from '../../lib/reasons';
import { CoverLink } from '../../components/Spotify';
import { useToast } from '../../components/Toast';
import { Button, Card, Heading, Notice, buttonClass } from '../../components/ui';
import { BlockMenu } from './BlockMenu';
import { blacklistFile, useHost } from './host';

type Filter = 'all' | BlacklistKind;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'artist', label: 'Artists' },
  { id: 'album', label: 'Albums' },
  { id: 'song', label: 'Songs' },
];
const KIND: Record<BlacklistKind, string> = { song: 'Song', album: 'Album', artist: 'Artist' };

export function BlacklistTab() {
  const { run, status } = useHost();
  const toast = useToast();
  const [items, setItems] = useState<BlacklistItem[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [pendingImport, setPendingImport] = useState<BlacklistFile | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const provider = status?.provider ?? null;

  const load = useCallback(async () => {
    const res = await run(() => api.getBlacklist());
    if (res) setItems(res.value.items);
  }, [run]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Puts entries back (undo of a remove or of "start clean"). */
  const restore = async (entries: BlacklistItem[], mode: 'merge' | 'replace'): Promise<void> => {
    if (!provider) return;
    await run(() => api.importBlacklist({ mode, file: blacklistFile(provider, entries) }));
    await load();
  };

  const remove = async (item: BlacklistItem): Promise<void> => {
    const res = await run(() => api.unblock({ kind: item.kind, key: item.key }));
    if (!res) return;
    await load();
    toast.show(`“${item.name}” can be played again`, 'info', { label: 'Undo', onClick: () => void restore([item], 'merge') });
  };

  const clear = async (): Promise<void> => {
    const res = await run(() => api.clearBlacklist());
    setConfirmClear(false);
    if (!res) return;
    const old = res.value.items;
    await load();
    toast.show(`Blacklist cleared (${old.length} removed)`, 'info', { label: 'Undo', onClick: () => void restore(old, 'replace') });
  };

  const pickFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('That file is too big for a blacklist.');
      const parsed = JSON.parse(await file.text()) as BlacklistFile;
      if (parsed?.app !== 'midnight-box' || parsed.type !== 'blacklist' || !Array.isArray(parsed.items)) {
        throw new Error('This is not a Midnight Box blacklist file.');
      }
      setPendingImport(parsed);
    } catch (err) {
      const message =
        err instanceof SyntaxError ? 'That file is not valid JSON.' : err instanceof Error ? err.message : 'Could not read that file.';
      toast.show(message, 'error');
    }
  };

  const doImport = async (mode: 'merge' | 'replace'): Promise<void> => {
    if (!pendingImport) return;
    const before = items ?? [];
    const res = await run(() => api.importBlacklist({ mode, file: pendingImport }));
    setPendingImport(null);
    if (!res) return;
    await load();
    const { added, removedFromQueue } = res.value;
    const extra = removedFromQueue > 0 ? `, ${removedFromQueue} waiting ${removedFromQueue === 1 ? 'song' : 'songs'} removed` : '';
    toast.show(`Imported: ${added} new ${added === 1 ? 'entry' : 'entries'}${extra}`, 'info', {
      label: 'Undo',
      onClick: () => void restore(before, 'replace'),
    });
  };

  const shown = (items ?? []).filter((i) => filter === 'all' || i.kind === filter);
  const count = (k: Filter) => (k === 'all' ? (items?.length ?? 0) : (items ?? []).filter((i) => i.kind === k).length);

  return (
    <div className="flex flex-col gap-4">
      <HostSearch onBlocked={() => void load()} />

      <Card className="p-4">
        <Heading
          title="Never played"
          description="Guests see these greyed out. Blocking an artist also blocks songs they feature on."
        />
        <div role="tablist" aria-label="Show" className="no-scrollbar mt-3 flex gap-1.5 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`min-h-9 shrink-0 rounded-full border px-3 text-[13px] font-semibold ${
                filter === f.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
              }`}
            >
              {f.label} <span className="font-normal tabular-nums opacity-70">{count(f.id)}</span>
            </button>
          ))}
        </div>
        {items === null ? (
          <p className="mt-3 text-sm text-muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            {items.length === 0 ? 'Nothing is blocked. Search above, or use Block… on a song in the queue.' : 'Nothing here.'}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {shown.map((item) => (
              <li key={`${item.kind}:${item.key}`} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold" title={item.name}>
                    {item.name}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {KIND[item.kind]}
                    {item.artist ? ` · ${item.artist}` : ''}
                  </p>
                </div>
                <Button size="icon" variant="ghost" aria-label={`Unblock ${item.name}`} onClick={() => void remove(item)}>
                  <X size={18} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <Heading title="Save, load or start over" description="Take your list to the next party, or share it with a friend." />
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={BLACKLIST_EXPORT_URL}
            download
            className={buttonClass('secondary', 'md', items && items.length > 0 ? '' : 'pointer-events-none opacity-45')}
            aria-disabled={!items || items.length === 0}
          >
            <Download size={16} aria-hidden="true" /> Export
          </a>
          <Button onClick={() => fileInput.current?.click()}>
            <Upload size={16} aria-hidden="true" /> Import
          </Button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => void pickFile(e)} />
          <Button variant="ghost-danger" disabled={!items || items.length === 0} onClick={() => setConfirmClear(true)}>
            <Trash2 size={16} aria-hidden="true" /> Start clean
          </Button>
        </div>

        {pendingImport && (
          <div className="mt-3 rounded-lg border border-line bg-raised p-3">
            <p className="text-sm">
              Import {pendingImport.items.length} {pendingImport.items.length === 1 ? 'entry' : 'entries'}
              {pendingImport.exportedAt ? ` (saved ${new Date(pendingImport.exportedAt).toLocaleDateString()})` : ''}?
            </p>
            {provider && pendingImport.provider !== provider && (
              <div className="mt-2">
                <Notice tone="danger">
                  This file comes from {pendingImport.provider === 'mock' ? 'demo mode' : 'Spotify'}, so it won&apos;t match
                  anything here.
                </Notice>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => void doImport('merge')}>
                Add to my list
              </Button>
              <Button size="sm" onClick={() => void doImport('replace')}>
                Replace my list
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingImport(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {confirmClear && (
          <div className="mt-3 rounded-lg border border-danger/30 bg-danger-soft p-3">
            <p className="text-sm text-ink">
              Remove all {items?.length ?? 0} entries? Export first if you might want them back later.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={BLACKLIST_EXPORT_URL} download className={buttonClass('secondary', 'sm')}>
                <Download size={14} aria-hidden="true" /> Export first
              </a>
              <Button size="sm" variant="danger" onClick={() => void clear()}>
                Remove all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Search the catalog to find a song, album or artist to block. */
function HostSearch({ onBlocked }: { onBlocked: () => void }) {
  const { spotify, status } = useHost();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const ready = status?.connected ?? false;

  const runSearch = useCallback(
    async (q: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        setResults((await api.hostSearch(q, 0, ctrl.signal)).results);
        setLoading(false);
      } catch (err) {
        if (isAbort(err)) return;
        setLoading(false);
        toast.show(errorMessage(err), 'error');
      }
    },
    [toast],
  );

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      abortRef.current?.abort();
      setResults([]);
      setLoading(false);
      return;
    }
    const id = window.setTimeout(() => void runSearch(q), 300);
    return () => window.clearTimeout(id);
  }, [query, runSearch]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <Card className="p-4">
      <Heading title="Block something" description="Find a song, then choose to block the song, its album or an artist." />
      <div className="relative mt-3">
        <Search size={18} aria-hidden="true" className="absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
        <label htmlFor="host-search" className="sr-only">
          Search songs to block
        </label>
        <input
          id="host-search"
          type="search"
          value={query}
          maxLength={100}
          disabled={!ready}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ready ? 'Search songs or artists' : 'Connect Spotify to search'}
          className="h-11 w-full rounded-lg border border-line bg-bg pr-4 pl-11 text-base text-ink placeholder:text-faint focus:border-faint disabled:opacity-50"
        />
        {loading && (
          <Loader2 size={16} aria-hidden="true" className="absolute top-1/2 right-3.5 -translate-y-1/2 animate-spin text-faint" />
        )}
      </div>
      {results.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {results.map(({ track, block }) => (
            <li key={track.id} className="py-2">
              <div className="flex items-center gap-3">
                <CoverLink track={track} spotify={spotify} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold" title={track.name}>
                    {track.name}
                  </p>
                  <p className="truncate text-[13px] text-muted">{artistNames(track.artists)}</p>
                  {block && <p className="text-xs text-faint">{blockText(block)}</p>}
                </div>
                {open !== track.id && (
                  <Button size="sm" onClick={() => setOpen(track.id)}>
                    Block…
                  </Button>
                )}
              </div>
              {open === track.id && (
                <div className="mt-2 pl-[3.75rem]">
                  <BlockMenu
                    track={track}
                    startOpen
                    onClose={() => setOpen(null)}
                    onDone={() => {
                      setOpen(null);
                      onBlocked();
                      void runSearch(query.trim());
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
