import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { MOCK_CATALOG } from '../src/providers/mock/catalog.js';
import { MockProvider, type MockProviderOptions } from '../src/providers/mock/provider.js';
import { Player } from '../src/services/player.js';
import { QueueService } from '../src/services/queue.js';

const silent = { info() {}, warn() {} };
const OPTS = { pollMs: 1_000, idlePollMs: 2_000, pushAheadMs: 10_000, autoStartCooldownMs: 0 };

// With startPlaying, the mock begins on catalog[0].
const opener = MOCK_CATALOG[0]!;
const request = MOCK_CATALOG[1]!;
const other = MOCK_CATALOG[5]!;

function setup(providerOpts: MockProviderOptions = {}) {
  let t = 1_700_000_000_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const db = openDb(':memory:');
  const provider = new MockProvider({ now, startPlaying: true, ...providerOpts });
  const queue = new QueueService(db, now);
  const player = new Player({ provider, queue, onChange: () => {}, log: silent, now }, OPTS);
  const plays = () => db.prepare('SELECT track_id, queue_id FROM plays ORDER BY id').all();
  return { provider, queue, player, advance, plays };
}

describe('Player', () => {
  it('hands the next song to the provider only shortly before the current one ends', async () => {
    const { provider, queue, player, advance } = setup();
    queue.add(request, null);

    await player.tick();
    expect(queue.pushed()).toBeUndefined();
    expect(await provider.getQueueUris()).toEqual([]);

    advance(opener.durationMs - 9_000); // 9s left, inside the 10s window
    await player.tick();
    expect(queue.pushed()?.track.id).toBe(request.id);
    expect(await provider.getQueueUris()).toEqual([request.uri]);

    await player.tick(); // must not push twice
    expect(await provider.getQueueUris()).toEqual([request.uri]);
  });

  it('tracks a request through pushed -> playing -> played and records plays', async () => {
    const { queue, player, advance, plays } = setup();
    const entry = queue.add(request, null);

    await player.tick();
    advance(opener.durationMs - 5_000);
    await player.tick();
    advance(6_000); // opener ends, request starts
    await player.tick();

    expect(queue.playing()?.id).toBe(entry.id);
    expect(queue.upcoming()).toEqual([]);

    advance(request.durationMs); // request ends, autoplay continues
    await player.tick();
    expect(queue.playing()).toBeUndefined();
    expect(plays()).toEqual([
      { track_id: opener.id, queue_id: null },
      { track_id: request.id, queue_id: entry.id },
      expect.objectContaining({ queue_id: null }),
    ]);
  });

  it('re-sends a pushed song if the provider lost it', async () => {
    const { provider, queue, player, advance } = setup();
    queue.add(request, null);
    await player.tick();
    advance(opener.durationMs - 5_000);
    await player.tick();
    expect(queue.pushed()).toBeDefined();

    // The host clears their Spotify queue and picks a song by hand.
    provider.clearQueue();
    await provider.playNow(other.uri);
    await player.tick();

    expect(queue.pushed()).toBeUndefined();
    expect(queue.nextQueued()?.track.id).toBe(request.id);
  });

  it('starts the queue when the speaker is idle', async () => {
    const { provider, queue, player } = setup({ startPlaying: false, autoplay: false });
    const entry = queue.add(request, null);

    await player.tick();
    expect((await provider.getPlayback())?.track?.id).toBe(request.id);

    await player.tick();
    expect(queue.playing()?.id).toBe(entry.id);
  });

  it('skips straight to the guests’ queue instead of the provider’s own next song', async () => {
    const { provider, queue, player } = setup();
    const entry = queue.add(request, null);
    await player.tick();

    await player.skip();
    await player.tick();
    expect((await provider.getPlayback())?.track?.id).toBe(request.id);
    expect(queue.playing()?.id).toBe(entry.id);
  });

  it('does not auto-start while the host has paused on purpose', async () => {
    const { provider, queue, player } = setup({ autoplay: false });
    queue.add(request, null);

    await player.pause();
    await player.tick();
    const pb = await provider.getPlayback();
    expect(pb?.isPlaying).toBe(false);
    expect(pb?.track?.id).toBe(opener.id);
    expect(queue.pushed()).toBeUndefined();
  });
});
