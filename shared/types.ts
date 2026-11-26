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
  /** Provider album id, for blocking whole albums. Null when unknown (tracks saved before it existed). */
  albumId: string | null;
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
  /**
   * Artist rule: at most `artistMaxSongs` songs by the same main artist per `artistCooldownMinutes`
   * (0 = off). With 1, an artist rests for the whole window after each song.
   */
  artistMaxSongs: number;
  artistCooldownMinutes: number;
  /** Songs marked explicit can't be requested. */
  noExplicit: boolean;
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
  skip: SkipState;
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
  | 'artist_queued'
  /** The host blocked the song, its album or one of its artists. */
  | 'blacklisted'
  /** The host turned off explicit songs. */
  | 'explicit';

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

/** A guest the host removed from the party. */
export interface BannedGuest extends GuestTag {
  /** Their phone is banned too (by its Wi-Fi hardware address), so a new session won't get them back in. */
  device: boolean;
}

/** POST /api/admin/guests/:publicId/ban */
export interface BanResult {
  /** The phone itself could be recognised and is banned too. */
  device: boolean;
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
  banned: BannedGuest[];
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

/** POST /api/admin/vote (shortcut for PUT /api/admin/settings { voteEnabled }) */
export interface VotingToggle {
  enabled: boolean;
}
// POST /api/admin/vote/end closes the current round now and adds the winner.

// ---- Vote to skip ------------------------------------------------------------

/** A song guests voted off. */
export interface SkipResult {
  track: Track;
  votes: number;
  at: number;
}

/** Skip votes for the song that is playing (part of PublicState). Votes reset when the song changes. */
export interface SkipState {
  /** The host's on/off switch (POST /api/admin/skip-voting). */
  enabled: boolean;
  /** The song the votes are for; null when nothing is playing. */
  trackId: string | null;
  votes: number;
  /**
   * Votes needed to skip: half the guests active in the last 15 minutes, rounded up, at least 2.
   * Fixed once the first vote for a song comes in, so the target doesn't move while people vote.
   */
  needed: number;
  /** The last song guests skipped, for a short announcement. */
  lastSkip: SkipResult | null;
}

/** POST /api/skip. `trackId` is the song the guest saw, so a late tap can't skip the next one. */
export interface SkipBody {
  trackId: string;
  vote: boolean;
}

/** GET/POST /api/skip: whether this device voted to skip the current song. */
export interface MySkip {
  trackId: string | null;
  voted: boolean;
}

/** POST /api/admin/skip-voting (shortcut for PUT /api/admin/settings { skipEnabled }) */
export interface SkipVotingToggle {
  enabled: boolean;
}

// ---- House rules -------------------------------------------------------------

/**
 * Everything the host can change while the party runs. `.env` sets the defaults; the host's
 * changes are saved and kept across restarts until they reset them.
 */
export interface Settings extends Limits {
  voteEnabled: boolean;
  /** How long guests can vote in each round. */
  voteRoundSeconds: number;
  /** Rounds run while fewer than this many songs are waiting. */
  voteWhenFewerThan: number;
  skipEnabled: boolean;
  /** Share of the guests active lately whose votes skip a song. */
  skipPercent: number;
  /** Never fewer skip votes than this, so one guest alone can't skip. */
  skipMinVotes: number;
  /** Skip blocked songs (blacklist, explicit filter) that Spotify starts on its own. */
  skipBlocked: boolean;
}

/** GET /api/admin/settings, PUT /api/admin/settings (any subset), POST /api/admin/settings/reset */
export interface SettingsResponse {
  settings: Settings;
  /** What "reset to defaults" goes back to (from .env). */
  defaults: Settings;
}

// ---- Blacklist ---------------------------------------------------------------

export type BlacklistKind = 'song' | 'album' | 'artist';

export interface BlacklistEntry {
  kind: BlacklistKind;
  /** Song: main artist id + title without version suffixes (every release). Album/artist: provider id. */
  key: string;
  /** Song title, album name or artist name. */
  name: string;
  /** Main artist's name, for songs and albums. */
  artist: string | null;
}

export interface BlacklistItem extends BlacklistEntry {
  addedAt: number;
}

/** GET /api/admin/blacklist */
export interface BlacklistResponse {
  items: BlacklistItem[];
}

/**
 * POST /api/admin/blacklist: block a track's song, album or artist. The server looks the track up,
 * so names always come from the provider. `artistId` picks which credited artist to block.
 */
export interface BlacklistAdd {
  kind: BlacklistKind;
  trackId: string;
  artistId?: string;
}

export interface BlacklistAddResult {
  item: BlacklistItem;
  /** Waiting songs it took out of the queue. */
  removedFromQueue: number;
}

/** POST /api/admin/blacklist/remove: returns the removed item (for undo). */
export interface BlacklistRemove {
  kind: BlacklistKind;
  key: string;
}

/** The export file (GET /api/admin/blacklist/export). */
export interface BlacklistFile {
  app: 'midnight-box';
  type: 'blacklist';
  version: 1;
  /** Ids only mean something to the service they came from. */
  provider: 'spotify' | 'mock';
  exportedAt: string;
  items: BlacklistEntry[];
}

/** POST /api/admin/blacklist/import. `replace` drops the current list first. */
export interface BlacklistImport {
  mode: 'merge' | 'replace';
  file: BlacklistFile;
}

export interface BlacklistImportResult {
  /** Entries that weren't on the list yet. */
  added: number;
  total: number;
  removedFromQueue: number;
}
// POST /api/admin/blacklist/clear empties the list and returns the old one (BlacklistResponse) for undo.

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
