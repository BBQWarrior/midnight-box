import { describe, expect, it } from 'vitest';
import type { Track } from '@shared/types';
import { openDb } from '../src/db.js';
import { songKey } from '../src/lib/tracks.js';
import { CooldownService } from '../src/services/cooldowns.js';
import { QueueService } from '../src/services/queue.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function track(id: string, name: string, ...artists: string[]): Track {
  return {
    id,
    uri: `test:track:${id}`,
    name,
    artists: artists.map((a) => ({ id: `artist:${a}`, name: a })),
    album: 'Album',
    imageUrl: null,
    durationMs: 200_000,
    explicit: false,
  };
}

const song = track('1', 'Northern Lights', 'Ada');
const remaster = track('2', 'Northern Lights - 2011 Remaster', 'Ada');
const sameArtist = track('3', 'Southern Lights', 'Ada');
const duet = track('4', 'Together', 'Ada', 'Ben');
const byFeature = track('5', 'Alone', 'Ben');
const unrelated = track('6', 'Elsewhere', 'Cleo');

function setup(opts = { songMs: 120 * MIN, artistMs: 20 * MIN }) {
  let t = T0;
  const now = () => t;
  const db = openDb(':memory:');
  const queue = new QueueService(db, now);
  const cooldowns = new CooldownService(db, queue, opts, now);
  const advance = (ms: number) => {
    t += ms;
  };
  return { queue, cooldowns, advance };
}

describe('songKey', () => {
  it('treats other releases of a song as the same song', () => {
    expect(songKey(remaster)).toBe(songKey(song));
    expect(songKey(track('7', 'Northern Lights (feat. Ben) [Live]', 'Ada'))).toBe(songKey(song));
    expect(songKey(track('8', 'Northern Lights', 'Cleo'))).not.toBe(songKey(song));
  });
});

describe('CooldownService', () => {
  it('blocks a song (any release) until its cooldown ends', () => {
    const { queue, cooldowns, advance } = setup();
    queue.recordPlay(song, null);

    advance(30 * MIN);
    expect(cooldowns.blockFor(remaster, null)).toEqual({ reason: 'song_cooldown', availableAt: T0 + 120 * MIN });

    advance(90 * MIN);
    expect(cooldowns.blockFor(remaster, null)).toBeNull();
  });

  it('blocks the main artist for its own, shorter cooldown', () => {
    const { queue, cooldowns, advance } = setup();
    queue.recordPlay(song, null);

    expect(cooldowns.blockFor(sameArtist, null)).toEqual({ reason: 'artist_cooldown', availableAt: T0 + 20 * MIN });
    advance(20 * MIN);
    expect(cooldowns.blockFor(sameArtist, null)).toBeNull();
  });

  it('only counts the main artist, not features', () => {
    const { queue, cooldowns } = setup();
    queue.recordPlay(duet, null);
    expect(cooldowns.blockFor(byFeature, null)).toBeNull();
    expect(cooldowns.blockFor(sameArtist, null)?.reason).toBe('artist_cooldown');
  });

  it('allows one song per main artist in the queue', () => {
    const { queue, cooldowns } = setup();
    queue.add(song, null);
    expect(cooldowns.blockFor(sameArtist, null)).toEqual({ reason: 'artist_queued', availableAt: null });
    expect(cooldowns.blockFor(unrelated, null)).toBeNull();
  });

  it('reports songs that are queued or playing as duplicates', () => {
    const { queue, cooldowns } = setup();
    queue.add(song, null);
    expect(cooldowns.blockFor(remaster, null)).toEqual({ reason: 'already_queued', availableAt: null });
    // Playing on the speaker without coming from our queue (host's own pick, autoplay).
    expect(cooldowns.blockFor(unrelated, unrelated)).toEqual({ reason: 'already_queued', availableAt: null });
  });

  it('lists active cooldowns and lets the host clear them', () => {
    const { queue, cooldowns, advance } = setup();
    queue.recordPlay(duet, null);
    advance(MIN);

    const list = cooldowns.list();
    expect(list.songs).toEqual([{ key: songKey(duet), track: duet, until: T0 + 120 * MIN }]);
    expect(list.artists).toEqual([{ key: 'artist:Ada', artist: { id: 'artist:Ada', name: 'Ada' }, until: T0 + 20 * MIN }]);

    cooldowns.clear('song', songKey(duet));
    cooldowns.clear('artist', 'artist:Ada');
    expect(cooldowns.blockFor(duet, null)).toBeNull();
    expect(cooldowns.list()).toEqual({ songs: [], artists: [] });

    // A later play starts a fresh cooldown.
    advance(MIN);
    queue.recordPlay(duet, null);
    expect(cooldowns.blockFor(duet, null)?.reason).toBe('song_cooldown');
  });

  it('can be switched off', () => {
    const { queue, cooldowns } = setup({ songMs: 0, artistMs: 0 });
    queue.recordPlay(song, null);
    queue.add(unrelated, null);
    expect(cooldowns.blockFor(song, null)).toBeNull();
    expect(cooldowns.blockFor(track('9', 'Other', 'Cleo'), null)).toBeNull();
    expect(cooldowns.list()).toEqual({ songs: [], artists: [] });
  });
});
