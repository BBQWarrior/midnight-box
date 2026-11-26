import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, Music, WifiOff } from 'lucide-react';
import type { JoinInfo, QueueEntry, VoteRound } from '@shared/types';
import { api } from '../lib/api';
import { formatTime } from '../lib/format';
import { useElapsed } from '../hooks/useElapsed';
import { useLiveState } from '../hooks/useLiveState';
import { useOnNew } from '../hooks/useOnNew';
import { useSecondsLeft } from '../hooks/useSecondsLeft';
import { Badge } from '../components/Badge';
import { Cover } from '../components/Cover';
import { Equalizer } from '../components/NowPlayingCard';
import { CoverLink, OpenSpotifyLink, SpotifyLogo } from '../components/Spotify';
import { Wordmark } from '../components/ui';

const UP_NEXT = 5;
const ANNOUNCE_MS = 6000;
const IDLE_MS = 3000;

/** True after a few seconds without mouse movement: hides the cursor and the controls. */
function useIdle(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    const wake = (): void => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener('mousemove', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
    };
  }, []);
  return idle;
}

function useFullscreen(): { fullscreen: boolean; toggle: () => void } {
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggle = useCallback((): void => {
    const op = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    op.catch(() => undefined);
  }, []);
  return { fullscreen, toggle };
}

/** Keeps the screen awake. Needs a secure context, so it quietly does nothing on plain LAN HTTP. */
function useWakeLock(): void {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let alive = true;
    const acquire = async (): Promise<void> => {
      try {
        if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
        const l = await navigator.wakeLock.request('screen');
        if (alive) lock = l;
        else await l.release();
      } catch {
        // not available or denied
      }
    };
    void acquire();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => undefined);
    };
  }, []);
}

const artistsOf = (names: { name: string }[]): string => names.map((a) => a.name).join(', ');

function QueueRow({ entry, spotify }: { entry: QueueEntry; spotify: boolean }) {
  return (
    <li className="flex items-center gap-[1vw]">
      <CoverLink track={entry.track} spotify={spotify} className="size-[4.2vh] min-w-[4.2vh]" iconSize={16} rounded="rounded-lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[2vh] font-medium leading-tight" title={entry.track.name}>{entry.track.name}</p>
        <p className="truncate text-[1.6vh] leading-tight text-muted" title={artistsOf(entry.track.artists)}>{artistsOf(entry.track.artists)}</p>
      </div>
      <span className="max-w-[35%] shrink-0 truncate text-[1.6vh] text-faint">
        {entry.votePick ? 'Vote pick' : (entry.requestedBy?.name ?? '')}
      </span>
    </li>
  );
}

function VotePanel({ round, skewMs, spotify }: { round: VoteRound; skewMs: number; spotify: boolean }) {
  const secondsLeft = useSecondsLeft(round.endsAt, skewMs);
  const total = round.candidates.reduce((sum, c) => sum + c.votes, 0);
  return (
    <section aria-label="Vote for the next song" className="rounded-[1.6vh] border border-line bg-surface p-[2vh]">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[3vh] font-semibold">Vote for the next song</h2>
        <span role="timer" aria-label={`${secondsLeft} seconds left`} className="text-[3vh] font-bold tabular-nums text-accent">
          {secondsLeft}s
        </span>
      </div>
      <ul className="mt-[1.5vh] flex flex-col gap-[1.2vh]">
        {round.candidates.map((c) => {
          const pct = total > 0 ? (c.votes / total) * 100 : 0;
          return (
            <li key={c.track.id} className="relative overflow-hidden rounded-[1vh] bg-raised">
              <div
                className="absolute inset-y-0 left-0 bg-accent/25 transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
              <div className="relative flex items-center gap-[1.2vw] p-[1vh]">
                <CoverLink track={c.track} spotify={spotify} className="size-[6vh] min-w-[6vh]" iconSize={22} rounded="rounded-lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[2.4vh] font-medium leading-tight" title={c.track.name}>{c.track.name}</p>
                  <p className="truncate text-[1.8vh] leading-tight text-muted" title={c.track.artists[0]?.name}>{c.track.artists[0]?.name}</p>
                </div>
                <span className="shrink-0 text-[2.6vh] font-bold tabular-nums">{c.votes}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function TvPage() {
  const { state, connected, skewMs } = useLiveState();
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const bannerTimer = useRef<number | undefined>(undefined);
  const idle = useIdle();
  const { fullscreen, toggle } = useFullscreen();
  const nowPlaying = state?.nowPlaying ?? null;
  const elapsed = useElapsed(nowPlaying, skewMs);

  useWakeLock();

  useEffect(() => {
    document.title = 'Midnight Box · TV';
  }, []);

  useEffect(() => {
    let alive = true;
    let retry: number | undefined;
    const load = (): void => {
      api.getJoinInfo().then(
        (j) => {
          if (alive) setJoin(j);
        },
        () => {
          if (alive) retry = window.setTimeout(load, 5000);
        },
      );
    };
    load();
    return () => {
      alive = false;
      window.clearTimeout(retry);
    };
  }, []);

  useEffect(() => () => window.clearTimeout(bannerTimer.current), []);

  const announce = useCallback((text: string): void => {
    setBanner(text);
    window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), ANNOUNCE_MS);
  }, []);

  const result = state?.vote.lastResult ?? null;
  const lastSkip = state?.skip.lastSkip ?? null;
  useOnNew(result?.roundId ?? null, state !== null, () => {
    if (result?.winner) announce(`Vote pick: ${result.winner.name} — ${artistsOf(result.winner.artists)}`);
  });
  useOnNew(lastSkip?.at ?? null, state !== null, () => {
    if (lastSkip) announce(`Skipped by vote: ${lastSkip.track.name}`);
  });

  const queue = state?.queue ?? [];
  const round = state?.vote.round ?? null;
  const track = nowPlaying?.track ?? null;
  const pct = track && track.durationMs > 0 ? (elapsed / track.durationMs) * 100 : 0;
  const skip = state?.skip;
  const spotify = state !== null && !state.demoMode;

  return (
    <div className={`relative flex h-dvh w-screen flex-col overflow-hidden p-[3vh] ${idle ? 'cursor-none' : ''}`}>
      <header className="flex shrink-0 items-center justify-between">
        <h1>
          <Wordmark size="tv" />
        </h1>
        <div className="flex items-center gap-[1.5vh]">
          {spotify && <SpotifyLogo tv />}
          {!connected && (
            <span role="status" className="flex items-center gap-[0.8vh] text-[1.8vh] text-muted">
              <WifiOff size={16} aria-hidden="true" /> Reconnecting…
            </span>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-label={fullscreen ? 'Exit full screen' : 'Enter full screen'}
            className={`flex size-[6vh] items-center justify-center rounded-[1vh] border border-line bg-surface text-muted transition-opacity ${
              idle ? 'pointer-events-none opacity-0' : 'opacity-100'
            }`}
          >
            {fullscreen ? <Minimize size={20} aria-hidden="true" /> : <Maximize size={20} aria-hidden="true" />}
          </button>
        </div>
      </header>

      <div className="mt-[2vh] flex min-h-0 flex-1 gap-[3vw]">
        <main className="flex min-w-0 flex-1 flex-col gap-[2.5vh]">
          <section aria-label="Now playing" className="flex min-h-0 flex-1 items-center gap-[3vw]">
            {state && !state.providerReady ? (
              <p role="status" className="text-[4vh] font-semibold text-muted">
                Waiting for the host to connect Spotify
              </p>
            ) : !state ? null : !nowPlaying || !track ? (
              <div className="flex items-center gap-[3vh] text-muted">
                <Music aria-hidden="true" className="size-[12vh] shrink-0" />
                <p className="text-[4vh] font-semibold">Nothing playing yet. Scan the code to add a song!</p>
              </div>
            ) : (
              <>
                <Cover
                  track={track}
                  // Square, and small enough to leave room for the vote panel while a round runs.
                  className={`${round ? 'size-[min(28vw,34vh)]' : 'size-[min(30vw,58vh)]'} shadow-2xl`}
                  rounded="rounded-lg"
                  iconSize={96}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-[1vh] text-[2.2vh] font-semibold text-accent">
                    {nowPlaying.isPlaying && <Equalizer className="h-[2vh]" />}
                    {nowPlaying.isPlaying ? 'Now playing' : 'Paused'}
                  </p>
                  <h2 className="mt-[1vh] line-clamp-2 text-[6.5vh] leading-tight font-bold tracking-tight" title={track.name}>{track.name}</h2>
                  <p className="mt-[1vh] truncate text-[3.6vh] text-muted" title={artistsOf(track.artists)}>{artistsOf(track.artists)}</p>
                  <div className="mt-[2vh] flex flex-wrap items-center gap-[1.5vh]">
                    {nowPlaying.votePick && (
                      <span className="text-[2vh]">
                        <Badge tone="accent">Vote pick</Badge>
                      </span>
                    )}
                    {!nowPlaying.votePick && nowPlaying.requestedBy && (
                      <span className="max-w-full truncate text-[2.2vh] text-muted">
                        Requested by {nowPlaying.requestedBy.name}
                      </span>
                    )}
                    {spotify && <OpenSpotifyLink track={track} className="text-[2.2vh]" />}
                    {skip && skip.enabled && skip.votes > 0 && skip.trackId === track.id && (
                      <span className="rounded-[0.8vh] border border-line px-[1.2vh] py-[0.5vh] text-[2.2vh] tabular-nums text-muted">
                        Skip votes {skip.votes}/{skip.needed}
                      </span>
                    )}
                  </div>
                  <div className="mt-[4vh]">
                    <div
                      role="progressbar"
                      aria-label="Song progress"
                      aria-valuemin={0}
                      aria-valuemax={Math.round(track.durationMs / 1000)}
                      aria-valuenow={Math.round(elapsed / 1000)}
                      className="h-[0.8vh] overflow-hidden rounded-full bg-line"
                    >
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-[1vh] flex justify-between text-[2vh] tabular-nums text-faint">
                      <span>{formatTime(elapsed)}</span>
                      <span>{formatTime(track.durationMs)}</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
          {round && <VotePanel round={round} skewMs={skewMs} spotify={spotify} />}
        </main>

        <aside className="flex w-[26vw] shrink-0 flex-col gap-[2.5vh]">
          <section className="flex flex-col items-center rounded-[1.6vh] border border-line bg-surface p-[2vh] text-center">
            <h2 className="text-[3vh] font-semibold">Scan to join</h2>
            {join ? (
              <img
                src={join.qrDataUrl}
                alt="QR code to join Midnight Box"
                className="mt-[1.5vh] size-[26vh] rounded-[1vh] bg-white p-[1vh]"
              />
            ) : (
              <div className="mt-[1.5vh] size-[26vh] rounded-[1vh] bg-raised" />
            )}
            {join && <p className="mt-[1.2vh] break-all text-[1.8vh] text-muted">{join.joinUrl}</p>}
          </section>

          <section aria-label="Up next" className="min-h-0 flex-1 overflow-hidden rounded-[1.6vh] border border-line bg-surface p-[2vh]">
            <h2 className="mb-[1.5vh] text-[2.6vh] font-semibold">Up next</h2>
            {queue.length === 0 ? (
              <p className="text-[2.2vh] text-muted">The queue is empty. Scan the code to add a song!</p>
            ) : (
              <>
                <ul className="flex flex-col gap-[1.4vh]">
                  {queue.slice(0, UP_NEXT).map((e) => (
                    <QueueRow key={e.id} entry={e} spotify={spotify} />
                  ))}
                </ul>
                {queue.length > UP_NEXT && (
                  <p className="mt-[1.4vh] text-[1.8vh] text-faint">+{queue.length - UP_NEXT} more</p>
                )}
              </>
            )}
          </section>
        </aside>
      </div>

      {banner && (
        <div
          role="status"
          className="toast-in absolute inset-x-[6vw] top-1/2 z-10 -translate-y-1/2 rounded-[2vh] border border-accent/50 bg-raised px-[4vw] py-[5vh] text-center text-[5vh] font-bold shadow-2xl shadow-black/60"
        >
          {banner}
        </div>
      )}
    </div>
  );
}
