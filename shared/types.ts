/**
 * API contract shared by server and client.
 * Types only: always import with `import type` so nothing ends up in a runtime bundle.
 */

export interface Artist {
  id: string;
  name: string;
}

export interface Track {
  /** Provider track id (Spotify id, or `mock:*` in demo mode). */
  id: string;
  /** Provider URI used for playback, e.g. `spotify:track:...`. */
  uri: string;
  name: string;
  artists: Artist[];
  album: string;
  /** ~300px cover art, or null when unavailable (client renders a placeholder). */
  imageUrl: string | null;
  durationMs: number;
  explicit: boolean;
}

/** Public, non-secret identity of a guest. Safe to show to other guests. */
export interface GuestTag {
  publicId: string;
  name: string;
}

export type QueueStatus =
  /** Waiting in Midnight Box's own queue (can still be removed/reordered). */
  | 'queued'
  /** Already handed to Spotify; will play after the current song. */
  | 'pushed';

export interface QueueEntry {
  id: number;
  track: Track;
  requestedBy: GuestTag | null;
  status: QueueStatus;
  addedAt: number;
}

export interface NowPlaying {
  track: Track;
  progressMs: number;
  isPlaying: boolean;
  /** Server clock (ms) when progressMs was measured; clients interpolate from this. */
  measuredAt: number;
  requestedBy: GuestTag | null;
  deviceName: string | null;
}

export interface Limits {
  maxPendingPerGuest: number;
  maxPerRequest: number;
}

/** Broadcast to every client on the `state` socket event and returned by GET /api/state. */
export interface PublicState {
  /** False until the host has connected Spotify (always true in demo mode). */
  providerReady: boolean;
  demoMode: boolean;
  nowPlaying: NowPlaying | null;
  /** Upcoming songs in play order. `pushed` entries come first. */
  queue: QueueEntry[];
  limits: Limits;
  /** Server clock (ms) at snapshot time, used to correct client clock skew. */
  serverTime: number;
}

/** GET /api/me, PUT /api/me { name } */
export interface Me {
  publicId: string;
  name: string | null;
}

/** GET /api/search?q=&offset= */
export interface SearchResponse {
  tracks: Track[];
  /** Pass as `offset` to load more, or null when there are no more results. */
  nextOffset: number | null;
}

/** POST /api/queue { trackIds: string[] } */
export interface AddToQueueRequest {
  trackIds: string[];
}

export type RejectReason = 'already_queued' | 'limit_reached' | 'not_found';

export interface AddToQueueResponse {
  added: QueueEntry[];
  rejected: { trackId: string; reason: RejectReason }[];
}

/** GET /api/join-info */
export interface JoinInfo {
  joinUrl: string;
  /** `data:image/svg+xml;base64,...` QR code for joinUrl; use as an <img src>. */
  qrDataUrl: string;
}

export interface Device {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
}

/** GET /api/admin/status (host machine only) */
export interface AdminStatus {
  provider: 'spotify' | 'mock';
  connected: boolean;
  /** Present when not connected: open this URL on the host machine to connect Spotify. */
  connectUrl: string | null;
  devices: Device[];
}

/** POST /api/admin/playback */
export interface PlaybackCommand {
  action: 'pause' | 'resume' | 'skip';
}

/** POST /api/admin/start: start playing the queue on a device. */
export interface StartCommand {
  deviceId: string;
}

/** Every non-2xx JSON response. */
export interface ApiError {
  error: {
    code:
      | 'bad_request'
      | 'name_required'
      | 'not_found'
      | 'rate_limited'
      | 'forbidden'
      | 'provider_not_ready'
      | 'provider_error'
      | 'internal';
    message: string;
  };
}

export interface ServerToClientEvents {
  state: (state: PublicState) => void;
}

// Client -> server communication is REST only; the socket is broadcast-only.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClientToServerEvents {}
