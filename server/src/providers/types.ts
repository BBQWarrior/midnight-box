import type { Device, Track } from '@shared/types';

export interface PlaybackState {
  /** Null when nothing is loaded or the item is not a track (e.g. a podcast episode). */
  track: Track | null;
  isPlaying: boolean;
  progressMs: number;
  device: { id: string | null; name: string } | null;
}

export interface SearchResult {
  tracks: Track[];
  total: number;
}

/**
 * Everything Midnight Box needs from a music service.
 * Implemented by Spotify for real use and by MockProvider for demo mode and tests.
 */
export interface MusicProvider {
  readonly kind: 'spotify' | 'mock';
  isReady(): boolean;
  search(query: string, offset: number, limit: number): Promise<SearchResult>;
  getTrack(id: string): Promise<Track | null>;
  /** Looks up a song by title and artist name (e.g. a Last.fm suggestion). Null if there's no exact match. */
  findTrack(title: string, artist: string): Promise<Track | null>;
  /** Null when there is no active playback session at all. */
  getPlayback(): Promise<PlaybackState | null>;
  /** URIs in the provider's own upcoming queue. */
  getQueueUris(): Promise<string[]>;
  enqueue(uri: string): Promise<void>;
  playNow(uri: string, deviceId?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  skip(): Promise<void>;
  getDevices(): Promise<Device[]>;
}

/** A song named by a suggestion service, not yet matched to the music provider. */
export interface SongRef {
  title: string;
  artist: string;
}

/** Finds songs related to a track, most related first. Powers vote rounds. */
export interface SuggestionSource {
  readonly kind: 'lastfm' | 'demo';
  similarTo(track: Track): Promise<SongRef[]>;
}

/** A provider call failed. `message` is safe to show to the host. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** The host has not connected (or has disconnected) their music account. */
export class ProviderNotReadyError extends Error {
  constructor(message = 'The host has not connected Spotify yet.') {
    super(message);
    this.name = 'ProviderNotReadyError';
  }
}
