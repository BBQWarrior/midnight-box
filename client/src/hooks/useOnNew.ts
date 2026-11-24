import { useEffect, useRef } from 'react';

/**
 * Calls `onNew` when `key` changes to a non-null value after the first one was seen.
 * The key present when `ready` first becomes true is never announced.
 */
export function useOnNew(key: number | null, ready: boolean, onNew: () => void): void {
  const seen = useRef<{ key: number | null } | null>(null);
  const cb = useRef(onNew);
  cb.current = onNew;
  useEffect(() => {
    if (!ready) return;
    if (seen.current === null) {
      seen.current = { key };
      return;
    }
    if (key === null || key === seen.current.key) return;
    seen.current.key = key;
    cb.current();
  }, [key, ready]);
}
