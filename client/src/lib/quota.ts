import type { Limits } from '@shared/types';

export interface Allowance {
  /** Songs the guest can select right now. */
  count: number;
  /** Why count is 0, if it is. */
  blockedBy: 'pending' | 'window' | null;
  /** When the window frees a slot (server ms), if blockedBy is 'window'. */
  nextAt: number | null;
}

export function computeAllowance(
  limits: Limits,
  pending: number,
  recentAdds: number[],
  serverNow: number,
): Allowance {
  const windowMs = limits.windowMinutes * 60_000;
  const inWindow = recentAdds.filter((t) => t > serverNow - windowMs).sort((a, b) => a - b);
  const pendingRoom = Math.max(0, limits.maxPendingPerGuest - pending);
  const windowRoom = Math.max(0, limits.windowSongs - inWindow.length);
  const count = Math.min(limits.maxPerRequest, pendingRoom, windowRoom);
  if (count > 0) return { count, blockedBy: null, nextAt: null };
  if (pendingRoom === 0) return { count: 0, blockedBy: 'pending', nextAt: null };
  // Same rule as the server: a slot frees up when the oldest add that still counts leaves the window.
  const freesUp = inWindow[inWindow.length - limits.windowSongs];
  return { count: 0, blockedBy: 'window', nextAt: freesUp === undefined ? null : freesUp + windowMs };
}
