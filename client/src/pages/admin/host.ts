import { createContext, useContext } from 'react';
import type { AdminStatus, BlacklistEntry, BlacklistFile } from '@shared/types';
import { ApiRequestError } from '../../lib/api';

export interface Host {
  /** Spotify connection, devices, removed guests and vote-round status; refreshed every few seconds. */
  status: AdminStatus | null;
  refresh: () => Promise<void>;
  /**
   * Runs a host action. An expired session logs out; other errors show as a toast.
   * Returns `{ value }` on success and null on failure.
   */
  run: <T>(fn: () => Promise<T>) => Promise<{ value: T } | null>;
  /** Real Spotify content (not demo mode). */
  spotify: boolean;
}

export const HostContext = createContext<Host | null>(null);

export function useHost(): Host {
  const host = useContext(HostContext);
  if (!host) throw new Error('useHost must be used inside the host panel');
  return host;
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 401 || err.code === 'unauthorized');
}

/** A blacklist file holding these entries (export format), for undo and imports. */
export function blacklistFile(provider: BlacklistFile['provider'], entries: BlacklistEntry[]): BlacklistFile {
  return {
    app: 'midnight-box',
    type: 'blacklist',
    version: 1,
    provider,
    exportedAt: new Date().toISOString(),
    items: entries.map(({ kind, key, name, artist }) => ({ kind, key, name, artist })),
  };
}
