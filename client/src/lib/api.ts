import type {
  AddToQueueResponse,
  AdminStatus,
  ApiError,
  ClearCooldown,
  CooldownList,
  HostSession,
  JoinInfo,
  Me,
  MySkip,
  MyVotes,
  PlaybackCommand,
  PublicState,
  SearchResponse,
  VoteBody,
} from '@shared/types';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiError['error']['code'] | 'network';

  constructor(status: number, code: ApiError['error']['code'] | 'network', message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    const isRead = !init?.method || init.method === 'GET';
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      ...(isRead ? {} : { body: init?.body ?? '{}' }),
      headers: {
        ...(isRead ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError(0, 'network', 'Network error');
  }
  if (!res.ok) {
    let code: ApiError['error']['code'] = 'internal';
    let message = res.statusText || 'Request failed';
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // non-JSON error body
    }
    throw new ApiRequestError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'rate_limited' || err.status === 429) {
      return 'Slow down a little, try again in a moment';
    }
    if (err.code === 'network') return 'Cannot reach the server. Check your connection.';
    return err.message;
  }
  return 'Something went wrong';
}

const json = (body: unknown): string => JSON.stringify(body);

export const api = {
  getMe: () => request<Me>('/api/me'),
  setName: (name: string) => request<Me>('/api/me', { method: 'PUT', body: json({ name }) }),
  getState: () => request<PublicState>('/api/state'),
  search: (q: string, offset: number, signal?: AbortSignal) =>
    request<SearchResponse>(
      `/api/search?q=${encodeURIComponent(q)}&offset=${offset}`,
      signal ? { signal } : undefined,
    ),
  addToQueue: (trackIds: string[]) =>
    request<AddToQueueResponse>('/api/queue', { method: 'POST', body: json({ trackIds }) }),
  getJoinInfo: () => request<JoinInfo>('/api/join-info'),
  getAdminStatus: () => request<AdminStatus>('/api/admin/status'),
  playback: (action: PlaybackCommand['action']) =>
    request<unknown>('/api/admin/playback', { method: 'POST', body: json({ action }) }),
  start: (deviceId: string) =>
    request<unknown>('/api/admin/start', { method: 'POST', body: json({ deviceId }) }),
  removeFromQueue: (id: number) => request<void>(`/api/admin/queue/${id}`, { method: 'DELETE' }),
  getAdminSession: () => request<HostSession>('/api/admin/session'),
  adminSetup: (password: string) =>
    request<void>('/api/admin/setup', { method: 'POST', body: json({ password }) }),
  adminLogin: (password: string) =>
    request<void>('/api/admin/login', { method: 'POST', body: json({ password }) }),
  disconnectSpotify: () => request<void>('/api/admin/spotify/disconnect', { method: 'POST' }),
  adminLogout: () => request<void>('/api/admin/logout', { method: 'POST' }),
  banGuest: (publicId: string) =>
    request<void>(`/api/admin/guests/${encodeURIComponent(publicId)}/ban`, { method: 'POST' }),
  unbanGuest: (publicId: string) =>
    request<void>(`/api/admin/guests/${encodeURIComponent(publicId)}/ban`, { method: 'DELETE' }),
  getCooldowns: () => request<CooldownList>('/api/admin/cooldowns'),
  getMyVotes: () => request<MyVotes>('/api/vote'),
  vote: (body: VoteBody) => request<MyVotes>('/api/vote', { method: 'POST', body: json(body) }),
  setVoting: (enabled: boolean) =>
    request<void>('/api/admin/vote', { method: 'POST', body: json({ enabled }) }),
  getMySkip: () => request<MySkip>('/api/skip'),
  voteSkip: (trackId: string, vote: boolean) =>
    request<MySkip>('/api/skip', { method: 'POST', body: json({ trackId, vote }) }),
  setSkipVoting: (enabled: boolean) =>
    request<void>('/api/admin/skip-voting', { method: 'POST', body: json({ enabled }) }),
  endVoteRound: () => request<void>('/api/admin/vote/end', { method: 'POST' }),
  clearCooldown: (body: ClearCooldown) =>
    request<void>('/api/admin/cooldowns/clear', { method: 'POST', body: json(body) }),
};
