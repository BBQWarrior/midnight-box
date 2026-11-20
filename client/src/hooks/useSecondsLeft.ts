import { useNow } from './useNow';

/** Whole seconds left until a server-clock time (null: no deadline). */
export function useSecondsLeft(endsAt: number | null, skewMs: number): number {
  const now = useNow(endsAt !== null, 250);
  if (endsAt === null) return 0;
  return Math.max(0, Math.ceil((endsAt - (now + skewMs)) / 1000));
}
