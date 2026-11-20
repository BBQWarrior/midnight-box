import { useCallback, useEffect, useState } from 'react';
import type { Me, Quota } from '@shared/types';
import { ApiRequestError, api } from '../lib/api';

export interface UseMe {
  me: Me | null;
  banned: boolean;
  setName: (name: string) => Promise<void>;
  setQuota: (quota: Quota) => void;
  markBanned: () => void;
}

export function useMe(): UseMe {
  const [me, setMe] = useState<Me | null>(null);
  const [banned, setBanned] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getMe().then(
      (m) => {
        if (alive) setMe(m);
      },
      (err: unknown) => {
        if (alive && err instanceof ApiRequestError && err.code === 'forbidden') setBanned(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const setName = useCallback(async (name: string) => {
    try {
      setMe(await api.setName(name.trim()));
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'forbidden') setBanned(true);
      throw err;
    }
  }, []);

  const setQuota = useCallback((quota: Quota) => {
    setMe((prev) => (prev ? { ...prev, quota } : prev));
  }, []);

  const markBanned = useCallback(() => setBanned(true), []);

  return { me, banned, setName, setQuota, markBanned };
}
