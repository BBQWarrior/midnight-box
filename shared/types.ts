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
  /** The song won a vote round (requestedBy is null then). */
  votePick: boolean;
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
  votePick: boolean;
  deviceName: string | null;
}

/** House rules, shown to guests. Every limit is enforced by the server. */
export interface Limits {
  /** Songs one guest can have waiting at once. */
  maxPendingPerGuest: number;
  /** Songs one guest can add in a single request. */
  maxPerRequest: number;
  /** Songs one guest can add per rolling window of `windowMinutes`. */
  windowSongs: number;
  windowMinutes: number;
  /** Minutes before the same song can be requested again (0 = off). */
  songCooldownMinutes: number;
  /** Minutes before the same main artist can be requested again (0 = off). */
  artistCooldownMinutes: number;
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
  vote: VoteState;
  /** Server clock (ms) at snapshot time, used to correct client clock skew. */
  serverTime: number;
}

/** A guest's own usage of the limits. */
export interface Quota {
  /** Songs this guest has waiting (queued or pushed). */
  pending: number;
  /** When this guest's adds inside the current window happened (ms, oldest first). */
  recentAdds: number[];
}

/** GET /api/me, PUT /api/me { name } */
export interface Me {
  publicId: string;
  name: string | null;
  quota: Quota;
}

/** Why a specific track can't be requested right now. */
export type TrackBlockReason =
  /** The same song (any version) is playing or waiting in the queue. */
  | 'already_queued'
  /** The same song played recently. */
  | 'song_cooldown'
  /** A song by the same main artist played recently. */
  | 'artist_cooldown'
  /** A song by the same main artist is already waiting in the queue. */
  | 'artist_queued';

export interface TrackBlock {
  reason: TrackBlockReason;
  /** When the track can be requested again (ms), or null if that depends on the queue. */
  availableAt: number | null;
}

export interface SearchResult {
  track: Track;
  /** Null when the track can be requested. */
  block: TrackBlock | null;
}

/** GET /api/search?q=&offset= */
export interface SearchResponse {
  results: SearchResult[];
  /** Pass as `offset` to load more, or null when there are no more results. */
  nextOffset: number | null;
}

/** POST /api/queue { trackIds: string[] } */
export interface AddToQueueRequest {
  trackIds: string[];
}

export type RejectReason =
  | TrackBlockReason
  /** The guest already has `maxPendingPerGuest` songs waiting. */
  | 'limit_reached'
  /** The guest used up `windowSongs` for the current window. */
  | 'too_soon'
  | 'not_found';

export interface AddToQueueResponse {
  added: QueueEntry[];
  rejected: { trackId: string; reason: RejectReason; availableAt: number | null }[];
  quota: Quota;
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

/** GET /api/admin/session (public): what the host panel should show. */
export interface HostSession {
  /** False on first run, until the host sets a password. */
  passwordSet: boolean;
  loggedIn: boolean;
  /** The request came from the host computer (first-run setup and Spotify login need this). */
  onHostMachine: boolean;
}

/** POST /api/admin/setup and POST /api/admin/login */
export interface PasswordBody {
  password: string;
}

/** GET /api/admin/status (host session required) */
export interface AdminStatus {
  provider: 'spotify' | 'mock';
  connected: boolean;
  /** Present when not connected: open this URL on the host computer to connect Spotify. */
  connectUrl: string | null;
  onHostMachine: boolean;
  devices: Device[];
  /** Guests the host removed. Unban with DELETE /api/admin/guests/:publicId/ban. */
  banned: GuestTag[];
  voting: VotingStatus;
}

// ---- Vote rounds -------------------------------------------------------------

export interface VoteCandidate {
  track: Track;
  votes: number;
}

/** A 30-second round: guests vote for songs related to what's playing, the winner joins the queue. */
export interface VoteRound {
  id: number;
  /** The song the suggestions are related to. */
  basedOn: { name: string; artist: string };
  candidates: VoteCandidate[];
  /** Server clock (ms) when voting closes. */
  endsAt: number;
}

export interface VoteResult {
  roundId: number;
  /** Null when nobody voted (or every voted song became unavailable). */
  winner: Track | null;
  votes: number;
  endedAt: number;
}

/** Part of PublicState. */
export interface VoteState {
  /** The host has vote rounds switched on and suggestions are available. */
  active: boolean;
  /** Null between rounds: rounds only run while fewer than 2 songs are waiting. */
  round: VoteRound | null;
  lastResult: VoteResult | null;
}

/**
 * POST /api/vote: vote for (vote: true) or take back a vote for (vote: false) one candidate.
 * Guests can vote for any number of candidates, one vote each. Votes never count against queue limits.
 */
export interface VoteBody {
  roundId: number;
  trackId: string;
  vote: boolean;
}

/** GET /api/vote and POST /api/vote: the caller's own votes in the current round. */
export interface MyVotes {
  /** Null when no round is running. */
  roundId: number | null;
  /** Track ids of the candidates this device voted for. */
  trackIds: string[];
}

/** Host view of vote rounds (in AdminStatus). */
export interface VotingStatus {
  /** Where suggestions come from; null when no Last.fm API key is configured. */
  source: 'lastfm' | 'demo' | null;
  /** The host's on/off switch (POST /api/admin/vote). */
  enabled: boolean;
  /** Why rounds aren't running, in words for the host; null when all is well. */
  problem: string | null;
}

/** POST /api/admin/vote */
export interface VotingToggle {
  enabled: boolean;
}
// POST /api/admin/vote/end closes the current round now and adds the winner.

/** GET /api/admin/cooldowns: what is cooling down right now. */
export interface CooldownList {
  songs: { key: string; track: Track; until: number }[];
  artists: { key: string; artist: Artist; until: number }[];
}

/** POST /api/admin/cooldowns/clear */
export interface ClearCooldown {
  kind: 'song' | 'artist';
  key: string;
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
      | 'unauthorized'
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
