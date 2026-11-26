import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { LogOut } from 'lucide-react';
import type { AdminStatus, HostSession } from '@shared/types';
import { ApiRequestError, api, errorMessage } from '../../lib/api';
import { useLiveState } from '../../hooks/useLiveState';
import { useToast } from '../../components/Toast';
import { Button, Centered, Notice, Tabs, Wordmark } from '../../components/ui';
import { BlacklistTab } from './BlacklistTab';
import { GuestsTab } from './GuestsTab';
import { type Host, HostContext, isUnauthorized } from './host';
import { NowTab } from './NowTab';
import { QueueTab } from './QueueTab';
import { RulesTab } from './RulesTab';
import { SpotifyTab } from './SpotifyTab';

const TABS = ['now', 'queue', 'rules', 'blacklist', 'guests', 'spotify'] as const;
type Tab = (typeof TABS)[number];

function tabFromHash(): Tab {
  const hash = window.location.hash.slice(1);
  return (TABS as readonly string[]).includes(hash) ? (hash as Tab) : 'now';
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
    'mt-3 h-12 w-full rounded-lg border border-line bg-bg px-4 text-base text-ink placeholder:text-faint focus:border-faint';
  return (
    <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm rounded-xl border border-line bg-surface p-6">
      <Wordmark suffix="host" />
      <h1 className="mt-6 text-xl font-bold">{setup ? 'Set a host password' : 'Host login'}</h1>
      {warnUnencrypted && (
        <div className="mt-3">
          <Notice role="alert">This Wi-Fi connection isn&apos;t encrypted. Use a password you don&apos;t use anywhere else.</Notice>
        </div>
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
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={busy || !password} className="mt-4 w-full">
        {busy ? 'Please wait…' : setup ? 'Set password' : 'Log in'}
      </Button>
      <p className="mt-4 text-center text-xs text-faint">
        <a href="/privacy" className="underline underline-offset-2">
          Privacy
        </a>
      </p>
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
        <p role="status" className="text-muted">
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
          <p className="max-w-sm text-center text-muted">Open the host panel on the host computer to set a password first.</p>
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
  const { state, skewMs } = useLiveState();
  const toast = useToast();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.getAdminStatus());
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
    const onHash = (): void => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = (t: Tab): void => {
    setTab(t);
    window.history.replaceState(null, '', `#${t}`);
  };

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<{ value: T } | null> => {
      try {
        return { value: await fn() };
      } catch (err) {
        if (isUnauthorized(err)) onLoggedOut();
        else toast.show(errorMessage(err), 'error');
        return null;
      }
    },
    [onLoggedOut, toast],
  );

  const spotify = status ? status.provider === 'spotify' : state ? !state.demoMode : false;
  const host: Host = useMemo(() => ({ status, refresh, run, spotify }), [status, refresh, run, spotify]);

  const logout = async (): Promise<void> => {
    try {
      await api.adminLogout();
    } catch {
      // the session may already be gone
    }
    onLoggedOut();
  };

  const queued = state?.queue.length ?? 0;
  const needsSpotify = status !== null && !status.connected;

  return (
    <HostContext.Provider value={host}>
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pt-4 pb-10">
        <header className="flex items-center justify-between gap-3">
          <Wordmark suffix="host" />
          <Button size="sm" variant="ghost" onClick={() => void logout()}>
            <LogOut size={15} aria-hidden="true" /> Log out
          </Button>
        </header>

        <div className="sticky top-0 z-20 -mx-4 bg-bg px-4 py-2">
          <Tabs
            scroll
            label="Host panel sections"
            value={tab}
            onChange={select}
            tabs={[
              { id: 'now', label: 'Now' },
              {
                id: 'queue',
                label: (
                  <span className="inline-flex items-baseline gap-1">
                    Queue
                    {queued > 0 && <span className="text-xs font-medium text-faint tabular-nums">{queued}</span>}
                  </span>
                ),
              },
              { id: 'rules', label: 'Rules' },
              { id: 'blacklist', label: 'Blacklist' },
              { id: 'guests', label: 'Guests' },
              {
                id: 'spotify',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    {status?.provider === 'mock' ? 'Demo' : 'Spotify'}
                    {needsSpotify && <span title="Not connected" className="size-1.5 rounded-full bg-danger" />}
                  </span>
                ),
              },
            ]}
          />
        </div>

        <main>
          {tab === 'now' && <NowTab state={state} skewMs={skewMs} />}
          {tab === 'queue' && <QueueTab state={state} />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'blacklist' && <BlacklistTab />}
          {tab === 'guests' && <GuestsTab />}
          {tab === 'spotify' && <SpotifyTab />}
        </main>
      </div>
    </HostContext.Provider>
  );
}
