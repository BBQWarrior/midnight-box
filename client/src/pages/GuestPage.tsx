import { useState } from 'react';
import { Pencil, WifiOff } from 'lucide-react';
import type { Limits } from '@shared/types';
import { formatMinutes } from '../lib/format';
import { useLiveState } from '../hooks/useLiveState';
import { useMe } from '../hooks/useMe';
import { NameCard } from '../components/NameCard';
import { NowPlayingCard } from '../components/NowPlayingCard';
import { SkipButton } from '../components/SkipButton';
import { useToast } from '../components/Toast';
import { useOnNew } from '../hooks/useOnNew';
import { QueueList } from '../components/QueueList';
import { VoteCard } from '../components/VoteCard';
import { SearchPanel } from '../components/SearchPanel';
import { SpotifyLogo } from '../components/Spotify';
import { Centered, Notice, Tabs, Wordmark } from '../components/ui';

type Tab = 'queue' | 'add';

/** The house rules in one line: "Up to 2 songs every 20 min · 3 waiting at once · songs rest 2 h, artists 20 min". */
export function rulesText(l: Limits): string {
  const parts = [`Up to ${l.windowSongs} songs every ${l.windowMinutes} min`, `${l.maxPendingPerGuest} waiting at once`];
  const rest: string[] = [];
  if (l.songCooldownMinutes > 0) rest.push(`songs rest ${formatMinutes(l.songCooldownMinutes)}`);
  if (l.artistCooldownMinutes > 0) {
    rest.push(
      l.artistMaxSongs > 1
        ? `${l.artistMaxSongs} per artist every ${formatMinutes(l.artistCooldownMinutes)}`
        : `artists ${formatMinutes(l.artistCooldownMinutes)}`,
    );
  }
  if (rest.length > 0) parts.push(rest.join(', '));
  if (l.noExplicit) parts.push('no explicit songs');
  return parts.join(' · ');
}

export function GuestPage() {
  const { state, connected, skewMs } = useLiveState();
  const { me, banned, setName, setQuota, markBanned } = useMe();
  const [tab, setTab] = useState<Tab>('queue');
  const [editingName, setEditingName] = useState(false);
  const toast = useToast();
  const lastSkip = state?.skip.lastSkip ?? null;
  useOnNew(lastSkip?.at ?? null, state !== null, () => {
    if (lastSkip) toast.show(`Skipped by vote: ${lastSkip.track.name}`);
  });

  if (banned) {
    return (
      <Centered>
        <p role="alert" className="max-w-sm text-center text-lg text-muted">
          The host removed you from this party.
        </p>
      </Centered>
    );
  }

  if (!me || !state) {
    return (
      <p role="status" className="p-10 text-center text-muted">
        Loading…
      </p>
    );
  }

  if (me.name === null) {
    return <NameCard onSubmit={setName} />;
  }

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
        <div className="flex min-w-0 flex-col items-start gap-1">
          <Wordmark />
          {state.demoMode && <span className="text-xs text-faint">Demo mode, fake songs</span>}
        </div>
        <div className="flex items-center gap-2">
          {!connected && (
            <span role="status" className="flex items-center gap-1 text-xs text-muted">
              <WifiOff size={12} aria-hidden="true" /> Reconnecting…
            </span>
          )}
          <button
            type="button"
            onClick={() => setEditingName(true)}
            aria-label={`Change your name, currently ${me.name}`}
            className="flex min-h-11 max-w-36 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-semibold hover:border-faint/60"
          >
            <span className="truncate">{me.name}</span>
            <Pencil size={12} aria-hidden="true" className="shrink-0 text-faint" />
          </button>
        </div>
      </header>

      {!state.providerReady && <Notice role="status">Waiting for the host to connect Spotify</Notice>}

      {!state.demoMode && (
        <div className="-my-3 -ml-3">
          <SpotifyLogo />
        </div>
      )}

      <NowPlayingCard
        spotify={!state.demoMode}
        nowPlaying={state.nowPlaying}
        skewMs={skewMs}
        action={
          state.skip.enabled && state.nowPlaying?.isPlaying ? (
            <SkipButton skip={state.skip} trackId={state.nowPlaying.track.id} onForbidden={markBanned} />
          ) : undefined
        }
      />

      <Tabs
        label="Sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'queue', label: `Up next${state.queue.length > 0 ? ` (${state.queue.length})` : ''}` },
          { id: 'add', label: 'Add songs' },
        ]}
      />

      <p className="-mt-1 px-1 text-[13px] text-faint">{rulesText(state.limits)}</p>

      <main className="pb-8">
        <div hidden={tab !== 'queue'}>
          <VoteCard spotify={!state.demoMode} vote={state.vote} skewMs={skewMs} onForbidden={markBanned} />
          <QueueList spotify={!state.demoMode} queue={state.queue} myPublicId={me.publicId} onAddSongs={() => setTab('add')} />
        </div>
        <div hidden={tab !== 'add'}>
          <SearchPanel
            state={state}
            myPublicId={me.publicId}
            recentAdds={me.quota.recentAdds}
            skewMs={skewMs}
            onQuota={setQuota}
            onForbidden={markBanned}
            onAdded={() => setTab('queue')}
          />
        </div>
      </main>

      <footer className="pb-6 text-center text-xs text-faint">
        <a href="/privacy" className="inline-flex min-h-11 items-center underline underline-offset-2">
          Privacy
        </a>
      </footer>
    </div>
  );
}
