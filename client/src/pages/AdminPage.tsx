import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, Pause, Play, SkipForward } from 'lucide-react';
import type { AdminStatus, JoinInfo, QueueEntry } from '@shared/types';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { useLiveState } from '../hooks/useLiveState';
import { QueueList } from '../components/QueueList';
import { useToast } from '../components/Toast';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/60">{title}</h2>
      {children}
    </section>
  );
}

const btn =
  'flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 text-sm font-semibold disabled:opacity-50';
const primaryBtn =
  'min-h-11 rounded-full bg-linear-to-r from-accent to-accent-2 px-5 text-sm font-semibold text-white disabled:opacity-50';

export function AdminPage() {
  const { state } = useLiveState();
  const toast = useToast();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.getAdminStatus());
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) setForbidden(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    api.getJoinInfo().then(setJoin, () => undefined);
  }, []);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      toast.show(errorMessage(err), 'error');
    }
  };

  const remove = async (entry: QueueEntry): Promise<void> => {
    setRemovingId(entry.id);
    await run(() => api.removeFromQueue(entry.id));
    setRemovingId(null);
  };

  const copy = async (): Promise<void> => {
    if (!join) return;
    try {
      await navigator.clipboard.writeText(join.joinUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.show('Could not copy. Select the link and copy it manually.', 'error');
    }
  };

  if (forbidden) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <p className="max-w-sm text-center text-white/80">
          Admin controls are only available on the host computer. Open http://127.0.0.1:
          {window.location.port}/admin on that machine.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
      <h1 className="bg-linear-to-r from-violet-300 to-cyan-200 bg-clip-text text-2xl font-bold text-transparent">
        Midnight Box admin
      </h1>

      <Section title="Spotify">
        {status ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              <span className="capitalize">{status.provider}</span>{' '}
              <span className={status.connected ? 'text-emerald-300' : 'text-amber-300'}>
                {status.connected ? 'connected' : 'not connected'}
              </span>
            </p>
            {!status.connected && status.connectUrl && (
              <button
                type="button"
                className={primaryBtn}
                onClick={() => {
                  if (status.connectUrl) window.location.href = status.connectUrl;
                }}
              >
                Connect Spotify
              </button>
            )}
          </div>
        ) : (
          <p className="text-white/60">Loading…</p>
        )}
      </Section>

      <Section title="Playback">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => void run(() => api.playback('pause'))}>
            <Pause size={16} aria-hidden="true" /> Pause
          </button>
          <button type="button" className={btn} onClick={() => void run(() => api.playback('resume'))}>
            <Play size={16} aria-hidden="true" /> Resume
          </button>
          <button type="button" className={btn} onClick={() => void run(() => api.playback('skip'))}>
            <SkipForward size={16} aria-hidden="true" /> Skip
          </button>
        </div>
        <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-white/50">Devices</h3>
        {status && status.devices.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {status.devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <p className="text-xs text-white/50">
                    {d.type}
                    {d.isActive ? ' · active' : ''}
                  </p>
                </div>
                <button type="button" className={primaryBtn} onClick={() => void run(() => api.start(d.id))}>
                  Play queue here
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/60">No devices found. Open Spotify on a device and it will show up here.</p>
        )}
      </Section>

      <Section title="Guests join">
        {join ? (
          <div className="flex flex-col items-center gap-3">
            <img src={join.qrDataUrl} alt="QR code to join Midnight Box" className="size-64 rounded-2xl bg-white p-3" />
            <p className="break-all text-center text-sm text-white/80">{join.joinUrl}</p>
            <button type="button" className={btn} onClick={() => void copy()}>
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        ) : (
          <p className="text-white/60">Loading…</p>
        )}
      </Section>

      <Section title="Queue">
        <QueueList queue={state?.queue ?? []} onRemove={(e) => void remove(e)} removingId={removingId} />
      </Section>
    </div>
  );
}
