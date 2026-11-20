import { useState } from 'react';
import { Pencil, WifiOff } from 'lucide-react';
import { useLiveState } from '../hooks/useLiveState';
import { useMe } from '../hooks/useMe';
import { NameCard } from '../components/NameCard';
import { NowPlayingCard } from '../components/NowPlayingCard';
import { QueueList } from '../components/QueueList';
import { SearchPanel } from '../components/SearchPanel';

type Tab = 'queue' | 'add';

export function GuestPage() {
  const { state, connected, skewMs } = useLiveState();
  const { me, setName } = useMe();
  const [tab, setTab] = useState<Tab>('queue');
  const [editingName, setEditingName] = useState(false);

  if (!me || !state) {
    return (
      <p role="status" className="p-10 text-center text-white/60">
        Loading…
      </p>
    );
  }

  if (me.name === null) {
    return <NameCard onSubmit={setName} />;
  }

  const tabClass = (t: Tab): string =>
    `min-h-11 flex-1 rounded-full text-sm font-semibold transition-colors ${
      tab === t ? 'bg-linear-to-r from-accent to-accent-2 text-white' : 'text-white/70'
    }`;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 pt-4">
      {editingName && (
        <NameCard
          initialName={me.name}
          onSubmit={async (n) => {
            await setName(n);
            setEditingName(false);
          }}
          onCancel={() => setEditingName(false)}
        />
      )}

      <header className="flex items-center justify-between gap-2">
        <div>
          <h1 className="bg-linear-to-r from-violet-300 to-cyan-200 bg-clip-text text-xl font-bold text-transparent">
            Midnight Box
          </h1>
          {state.demoMode && (
            <span className="mt-0.5 inline-block rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-white/60">
              Demo mode, fake songs
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!connected && (
            <span
              role="status"
              className="flex items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-2.5 py-1 text-xs text-amber-200"
            >
              <WifiOff size={12} aria-hidden="true" /> Reconnecting…
            </span>
          )}
          <button
            type="button"
            onClick={() => setEditingName(true)}
            aria-label={`Change your name, currently ${me.name}`}
            className="flex min-h-11 max-w-36 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 text-sm"
          >
            <span className="truncate">{me.name}</span>
            <Pencil size={12} aria-hidden="true" className="shrink-0 text-white/50" />
          </button>
        </div>
      </header>

      {!state.providerReady && (
        <div role="status" className="rounded-2xl border border-amber-300/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          Waiting for the host to connect Spotify
        </div>
      )}

      <NowPlayingCard nowPlaying={state.nowPlaying} skewMs={skewMs} />

      <div role="tablist" aria-label="Sections" className="flex gap-1 rounded-full border border-white/10 bg-white/5 p-1 backdrop-blur-xl">
        <button type="button" role="tab" aria-selected={tab === 'queue'} onClick={() => setTab('queue')} className={tabClass('queue')}>
          Up next{state.queue.length > 0 ? ` (${state.queue.length})` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'add'} onClick={() => setTab('add')} className={tabClass('add')}>
          Add songs
        </button>
      </div>

      <main className="pb-8">
        <div hidden={tab !== 'queue'}>
          <QueueList queue={state.queue} myPublicId={me.publicId} onAddSongs={() => setTab('add')} />
        </div>
        <div hidden={tab !== 'add'}>
          <SearchPanel state={state} myPublicId={me.publicId} onAdded={() => setTab('queue')} />
        </div>
      </main>
    </div>
  );
}
