import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, LogOut, Pause, Play, SkipForward } from 'lucide-react';
import type { AdminStatus, CooldownList, GuestTag, HostSession, JoinInfo, QueueEntry } from '@shared/types';
import { ApiRequestError, api, errorMessage } from '../lib/api';
import { useLiveState } from '../hooks/useLiveState';
import { formatClock } from '../lib/format';
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


function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 401 || err.code === 'unauthorized');
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center p-6">{children}</div>;
}

interface PasswordFormProps {
  mode: 'setup' | 'login';
  warnUnencrypted?: boolean;
  onDone: () => void;
}

function PasswordForm({ mode, warnUnencrypted = false, onDone }: PasswordFormProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = mode === 'setup';

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (setup) {
      if (password.length < 8) return setError('Use at least 8 characters.');
      if (password.length > 128) return setError('Use at most 128 characters.');
      if (password !== confirm) return setError('Passwords do not match.');
    }
    setBusy(true);
    setError(null);
    try {
      await (setup ? api.adminSetup(password) : api.adminLogin(password));
      onDone();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 429) {
        setError('Too many attempts. Wait a few minutes.');
      } else if (!setup && err instanceof ApiRequestError && err.status === 401) {
        setError('Wrong password.');
      } else {
        setError(errorMessage(err));
      }
      setBusy(false);
    }
  };

  const input =
    'mt-3 h-12 w-full rounded-xl border border-white/15 bg-white/5 px-4 text-base text-white placeholder:text-white/40';
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="w-full max-w-sm rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl"
    >
      <h1 className="text-xl font-bold">{setup ? 'Set a host password' : 'Host login'}</h1>
      {warnUnencrypted && (
        <p
          role="alert"
          className="mt-3 rounded-2xl border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-sm text-amber-100"
        >
          This Wi-Fi connection isn&apos;t encrypted. Use a password you don&apos;t use anywhere else.
        </p>
      )}
      <label htmlFor="admin-password" className="sr-only">
        Password
      </label>
      <input
        id="admin-password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        maxLength={128}
        autoComplete={setup ? 'new-password' : 'current-password'}
        placeholder="Password"
        className={input}
      />
      {setup && (
        <>
          <label htmlFor="admin-confirm" className="sr-only">
            Confirm password
          </label>
          <input
            id="admin-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            maxLength={128}
            autoComplete="new-password"
            placeholder="Confirm password"
            className={input}
          />
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || !password} className={`${primaryBtn} mt-4 w-full`}>
        {busy ? 'Please wait…' : setup ? 'Set password' : 'Log in'}
      </button>
    </form>
  );
}

export function AdminPage() {
  const [session, setSession] = useState<HostSession | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSession(await api.getAdminSession());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session) {
    return (
      <Centered>
        <p role="status" className="text-white/60">
          {failed ? 'Cannot reach the server.' : 'Loading…'}
        </p>
      </Centered>
    );
  }

  if (!session.passwordSet) {
    return (
      <Centered>
        {session.onHostMachine ? (
          <PasswordForm mode="setup" onDone={() => void load()} />
        ) : (
          <p className="max-w-sm text-center text-white/80">
            Open the host panel on the host computer to set a password first.
          </p>
        )}
      </Centered>
    );
  }

  if (!session.loggedIn) {
    return (
      <Centered>
        <PasswordForm
          mode="login"
          warnUnencrypted={!session.onHostMachine && window.location.protocol === 'http:'}
          onDone={() => void load()}
        />
      </Centered>
    );
  }

  return <Panel onLoggedOut={() => void load()} />;
}

function Panel({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { state } = useLiveState();
  const toast = useToast();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [cooldowns, setCooldowns] = useState<CooldownList | null>(null);
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const nowPlayingId = state?.nowPlaying?.track.id ?? null;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.getAdminStatus());
    } catch (err) {
      if (isUnauthorized(err)) onLoggedOut();
    }
  }, [onLoggedOut]);

  const refreshCooldowns = useCallback(async (): Promise<void> => {
    try {
      setCooldowns(await api.getCooldowns());
    } catch (err) {
      if (isUnauthorized(err)) onLoggedOut();
    }
  }, [onLoggedOut]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    void refreshCooldowns();
    const id = window.setInterval(() => void refreshCooldowns(), 60_000);
    return () => window.clearInterval(id);
  }, [refreshCooldowns, nowPlayingId]);

  useEffect(() => {
    api.getJoinInfo().then(setJoin, () => undefined);
  }, []);

  const run = async (fn: () => Promise<unknown>, after: () => Promise<void> = refresh): Promise<void> => {
    try {
      await fn();
      await after();
    } catch (err) {
      if (isUnauthorized(err)) onLoggedOut();
      else toast.show(errorMessage(err), 'error');
    }
  };

  const remove = async (entry: QueueEntry): Promise<void> => {
    setRemovingId(entry.id);
    await run(() => api.removeFromQueue(entry.id));
    setRemovingId(null);
  };

  const logout = async (): Promise<void> => {
    try {
      await api.adminLogout();
    } catch {
      // the session may already be gone
    }
    onLoggedOut();
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

  const smallBtn = 'min-h-9 shrink-0 rounded-full border border-white/15 px-4 text-xs font-semibold';
  const rowClass = 'flex items-center justify-between gap-3 rounded-2xl border border-white/10 p-3';
  const subhead = 'mb-2 text-xs font-semibold uppercase tracking-wider text-white/50';

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="bg-linear-to-r from-violet-300 to-cyan-200 bg-clip-text text-2xl font-bold text-transparent">
          Midnight Box host
        </h1>
        <button type="button" className={`${btn} shrink-0 whitespace-nowrap`} onClick={() => void logout()}>
          <LogOut size={16} aria-hidden="true" /> Log out
        </button>
      </div>

      <Section title="Spotify">
        {status ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              <span className="capitalize">{status.provider}</span>{' '}
              <span className={status.connected ? 'text-emerald-300' : 'text-amber-300'}>
                {status.connected ? 'connected' : 'not connected'}
              </span>
            </p>
            {!status.connected &&
              (status.onHostMachine ? (
                status.connectUrl && (
                  <button
                    type="button"
                    className={primaryBtn}
                    onClick={() => {
                      if (status.connectUrl) window.location.href = status.connectUrl;
                    }}
                  >
                    Connect Spotify
                  </button>
                )
              ) : (
                <p className="text-sm text-white/60">Connect Spotify from the host computer</p>
              ))}
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
              <li key={d.id} className={rowClass}>
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
        <QueueList
          queue={state?.queue ?? []}
          onRemove={(e) => void remove(e)}
          removingId={removingId}
          onBan={(g: GuestTag) => void run(() => api.banGuest(g.publicId))}
        />
      </Section>

      <Section title="Removed guests">
        {status && status.banned.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {status.banned.map((g) => (
              <li key={g.publicId} className={rowClass}>
                <span className="min-w-0 truncate text-sm">{g.name}</span>
                <button type="button" className={smallBtn} onClick={() => void run(() => api.unbanGuest(g.publicId))}>
                  Unban
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/60">Nobody has been removed.</p>
        )}
      </Section>

      <Section title="Cooldowns">
        {cooldowns && (cooldowns.songs.length > 0 || cooldowns.artists.length > 0) ? (
          <div className="flex flex-col gap-4">
            {cooldowns.songs.length > 0 && (
              <div>
                <h3 className={subhead}>Songs resting</h3>
                <ul className="flex flex-col gap-2">
                  {cooldowns.songs.map((c) => (
                    <li key={c.key} className={rowClass}>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{c.track.name}</p>
                        <p className="truncate text-xs text-white/50">
                          {c.track.artists.map((a) => a.name).join(', ')} · until {formatClock(c.until)}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={smallBtn}
                        onClick={() => void run(() => api.clearCooldown({ kind: 'song', key: c.key }), refreshCooldowns)}
                      >
                        Clear
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {cooldowns.artists.length > 0 && (
              <div>
                <h3 className={subhead}>Artists resting</h3>
                <ul className="flex flex-col gap-2">
                  {cooldowns.artists.map((c) => (
                    <li key={c.key} className={rowClass}>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{c.artist.name}</p>
                        <p className="text-xs text-white/50">until {formatClock(c.until)}</p>
                      </div>
                      <button
                        type="button"
                        className={smallBtn}
                        onClick={() => void run(() => api.clearCooldown({ kind: 'artist', key: c.key }), refreshCooldowns)}
                      >
                        Clear
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-white/60">Nothing is cooling down.</p>
        )}
      </Section>
    </div>
  );
}
