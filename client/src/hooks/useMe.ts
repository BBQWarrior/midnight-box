import { useCallback, useEffect, useState } from 'react';
import type { Me } from '@shared/types';
import { api } from '../lib/api';

export function useMe(): { me: Me | null; setName: (name: string) => Promise<void> } {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let alive = true;
    api.getMe().then(
      (m) => {
        if (alive) setMe(m);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const setName = useCallback(async (name: string) => {
    setMe(await api.setName(name.trim()));
  }, []);

  return { me, setName };
}
