import { useEffect, useState } from 'react';
import type { PublicState } from '@shared/types';
import { api } from '../lib/api';
import { createSocket } from '../lib/socket';

export interface LiveState {
  state: PublicState | null;
  connected: boolean;
  /** serverTime - Date.now(): add to local time to get server time. */
  skewMs: number;
}

export function useLiveState(): LiveState {
  const [state, setState] = useState<PublicState | null>(null);
  const [connected, setConnected] = useState(false);
  const [skewMs, setSkewMs] = useState(0);

  useEffect(() => {
    let alive = true;
    const apply = (s: PublicState): void => {
      if (!alive) return;
      setState(s);
      setSkewMs(s.serverTime - Date.now());
    };
    const socket = createSocket();
    socket.on('connect', () => {
      setConnected(true);
      api.getState().then(apply, () => undefined);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('state', apply);
    api.getState().then(apply, () => undefined);
    return () => {
      alive = false;
      socket.disconnect();
    };
  }, []);

  return { state, connected, skewMs };
}
