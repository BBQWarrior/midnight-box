import type { Device, Track } from '@shared/types';
import type { MusicProvider, PlaybackState, SearchResult } from '../types.js';
import { MOCK_CATALOG } from './catalog.js';

const DEVICE: Device = { id: 'mock-speaker', name: 'Demo Speaker', type: 'Speaker', isActive: true };

export interface MockProviderOptions {
  catalog?: Track[];
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Playback speed multiplier, so demo songs don't take 3 real minutes. */
  speed?: number;
  /** Mimic Spotify autoplay: keep playing catalog songs when the queue runs dry. */
  autoplay?: boolean;
  /** Start with a song already playing. */
  startPlaying?: boolean;
}

/**
 * In-memory stand-in for Spotify: simulated catalog, playback clock and queue.
 * Powers `npm run demo` and the test suite.
 */
export class MockProvider implements MusicProvider {
  readonly kind = 'mock' as const;

  private readonly catalog: Track[];
  private readonly now: () => number;
  private readonly speed: number;
  private readonly autoplay: boolean;

  private current: Track | null = null;
  private progressMs = 0;
  private playing = false;
  private lastAdvance: number;
  private upcoming: Track[] = [];
  private autoplayIndex = 0;

  constructor(opts: MockProviderOptions = {}) {
    this.catalog = opts.catalog ?? MOCK_CATALOG;
    this.now = opts.now ?? Date.now;
    this.speed = opts.speed ?? 1;
    this.autoplay = opts.autoplay ?? true;
    this.lastAdvance = this.now();
    if (opts.startPlaying) {
      this.current = this.pickFromCatalog();
      this.playing = this.current !== null;
    }
  }

  isReady(): boolean {
    return true;
  }

  async search(query: string, offset: number, limit: number): Promise<SearchResult> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = this.catalog.filter((t) => {
      const haystack = `${t.name} ${t.artists.map((a) => a.name).join(' ')} ${t.album}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    return { tracks: matches.slice(offset, offset + limit), total: matches.length };
  }

  async getTrack(id: string): Promise<Track | null> {
    return this.catalog.find((t) => t.id === id) ?? null;
  }

  async getPlayback(): Promise<PlaybackState | null> {
    this.advance();
    return {
      track: this.current,
      isPlaying: this.playing,
      progressMs: Math.floor(this.progressMs),
      device: { id: DEVICE.id, name: DEVICE.name },
    };
  }

  async getQueueUris(): Promise<string[]> {
    return this.upcoming.map((t) => t.uri);
  }

  async enqueue(uri: string): Promise<void> {
    this.advance();
    this.upcoming.push(this.byUri(uri));
  }

  async playNow(uri: string): Promise<void> {
    this.advance();
    this.current = this.byUri(uri);
    this.progressMs = 0;
    this.playing = true;
  }

  async pause(): Promise<void> {
    this.advance();
    this.playing = false;
  }

  async resume(): Promise<void> {
    this.advance();
    if (this.current) this.playing = true;
  }

  async skip(): Promise<void> {
    this.advance();
    this.startNext();
  }

  async getDevices(): Promise<Device[]> {
    return [DEVICE];
  }

  /** Simulates the host clearing their Spotify queue by hand. */
  clearQueue(): void {
    this.upcoming = [];
  }

  /** Moves the simulated clock forward, rolling over to the next song(s) as they finish. */
  private advance(): void {
    const t = this.now();
    let delta = (t - this.lastAdvance) * this.speed;
    this.lastAdvance = t;
    while (this.playing && this.current && delta > 0) {
      const remaining = this.current.durationMs - this.progressMs;
      if (delta < remaining) {
        this.progressMs += delta;
        delta = 0;
      } else {
        delta -= remaining;
        this.startNext();
      }
    }
  }

  private startNext(): void {
    this.current = this.upcoming.shift() ?? this.nextAutoplay();
    this.progressMs = 0;
    this.playing = this.current !== null;
  }

  private nextAutoplay(): Track | null {
    return this.autoplay ? this.pickFromCatalog() : null;
  }

  private pickFromCatalog(): Track | null {
    if (this.catalog.length === 0) return null;
    const track = this.catalog[this.autoplayIndex % this.catalog.length]!;
    this.autoplayIndex += 7; // stride through artists instead of playing one album in order
    return track;
  }

  private byUri(uri: string): Track {
    const track = this.catalog.find((t) => t.uri === uri);
    if (!track) throw new Error(`Unknown mock track ${uri}`);
    return track;
  }
}
