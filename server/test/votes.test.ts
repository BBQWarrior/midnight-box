import { beforeEach, describe, expect, it } from 'vitest';
import type { Track } from '@shared/types';
import { openDb } from '../src/db.js';
import { MOCK_CATALOG } from '../src/providers/mock/catalog.js';
import { MockProvider } from '../src/providers/mock/provider.js';
import { ProviderError, type SongRef, type SuggestionSource } from '../src/providers/types.js';
import { BlacklistService } from '../src/services/blacklist.js';
import { CooldownService } from '../src/services/cooldowns.js';
import { Player } from '../src/services/player.js';
import { QueueService } from '../src/services/queue.js';
import { TrackRules } from '../src/services/rules.js';
import { type VoteOptions, VoteService } from '../src/services/votes.js';

const MIN = 60_000;
const silent = { info() {}, warn() {} };
const song = (i: number): Track => MOCK_CATALOG[i]!;
const ref = (i: number): SongRef => ({ title: song(i).name, artist: song(i).artists[0]!.name });

class FakeSource implements SuggestionSource {
  readonly kind = 'demo' as const;
  refs: SongRef[] = [];
  error: Error | null = null;
  calls = 0;
  async similarTo(): Promise<SongRef[]> {
    this.calls++;
    if (this.error) throw this.error;
    return this.refs;
  }
}

let t: number;
let source: FakeSource;
let provider: MockProvider;
let queue: QueueService;
let player: Player;
let votes: VoteService;
let options: VoteOptions;
let blacklist: BlacklistService;

function setup(withSource = true) {
  t = 1_700_000_000_000;
  const now = () => t;
  const db = openDb(':memory:');
  // Song 0 is playing (the mock starts with the first catalog song), so its artist is cooling down.
  provider = new MockProvider({ startPlaying: true, now });
  queue = new QueueService(db, now);
  const cooldowns = new CooldownService(db, queue, () => ({ songMs: 120 * MIN, artistMs: 20 * MIN, artistMaxSongs: 1 }), now);
  blacklist = new BlacklistService(db, now);
  const rules = new TrackRules({ blacklist, cooldowns, queue, noExplicit: () => false });
  player = new Player(
    { provider, queue, onChange() {}, log: silent, now },
    { pollMs: 1_000, idlePollMs: 1_000, pushAheadMs: 1_000, autoStartCooldownMs: 0 },
  );
  source = new FakeSource();
  // Catalog songs come in threes per artist: 3 and 4 share an artist, everything else differs.
  source.refs = [1, 3, 4, 6, 9, 12, 15, 18].map(ref);
  options = { enabled: true, roundMs: 30_000, maxWaiting: 2, candidates: 4, retryMs: 30_000 };
  votes = new VoteService(
    {
      db,
      provider,
      source: withSource ? source : null,
      queue,
      rules,
      player,
      log: silent,
      onChange() {},
      now,
      shuffle: (items) => items,
    },
    () => options,
  );
}

async function tick() {
  await player.tick();
  await votes.tick();
}

const ids = () => votes.state().round?.candidates.map((c) => c.track.id) ?? [];

describe('vote rounds', () => {
  beforeEach(() => setup());

  it('offers related songs that could be queued right now, one per artist', async () => {
    queue.add(song(6), null);
    await tick();
    // 1: same artist as the playing song (cooldown). 4: same artist as 3. 6: already queued.
    expect(ids()).toEqual([3, 9, 12, 15].map((i) => song(i).id));
    expect(votes.state().round?.basedOn).toEqual({ name: song(0).name, artist: song(0).artists[0]!.name });
  });

  it('runs back to back, offering new songs each round until it runs out', async () => {
    source.refs = [3, 6, 9, 12, 15, 18, 21, 24].map(ref);
    const rounds: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await tick();
      rounds.push(ids());
      t += 30_000; // nobody votes, so nothing is queued and the next round follows
    }
    expect(rounds[0]).toEqual([3, 6, 9, 12].map((i) => song(i).id));
    expect(rounds[1]).toEqual([15, 18, 21, 24].map((i) => song(i).id));
    expect(rounds[2]).toEqual(rounds[0]);
    expect(votes.state().round?.id).toBe(3);
  });

  it('only runs while fewer than 2 songs wait, music plays and voting is on', async () => {
    queue.add(song(6), null);
    queue.add(song(9), null);
    await tick();
    expect(votes.state().round).toBeNull();

    setup();
    await provider.pause();
    await tick();
    expect(votes.state().round).toBeNull();

    setup();
    options = { ...options, enabled: false };
    votes.settingsChanged();
    await tick();
    expect(votes.state()).toMatchObject({ active: false, round: null });

    setup(false);
    await tick();
    expect(votes.state()).toMatchObject({ active: false, round: null });
    expect(votes.status()).toMatchObject({ source: null, problem: expect.stringContaining('LASTFM_API_KEY') });
  });

  it('queues the winner as a vote pick; a tie goes to the song that got there first', async () => {
    await tick();
    const round = votes.state().round!;
    const [a, b] = ids() as [string, string];
    votes.vote('x', round.id, b, true);
    t += 1_000;
    votes.vote('y', round.id, a, true);
    // x takes back their vote and votes again: b reached its total last now.
    t += 1_000;
    votes.vote('x', round.id, b, false);
    votes.vote('x', round.id, b, true);

    t += 30_000;
    await votes.tick();
    expect(votes.state().lastResult).toMatchObject({ roundId: round.id, winner: { id: a }, votes: 1 });
    expect(queue.upcoming().map((r) => [r.track.id, r.source, r.guestId])).toEqual([[a, 'vote', null]]);
  });

  it('falls back to the runner-up if the winner was queued meanwhile', async () => {
    await tick();
    const round = votes.state().round!;
    const [a, b] = ids() as [string, string];
    votes.vote('x', round.id, a, true);
    votes.vote('y', round.id, a, true);
    votes.vote('z', round.id, b, true);
    queue.add(song(MOCK_CATALOG.findIndex((s) => s.id === a)), null);
    t += 30_000;
    await votes.tick();
    expect(votes.state().lastResult?.winner?.id).toBe(b);
    // Two songs wait now, so rounds pause.
    expect(votes.state().round).toBeNull();
  });

  it('adds nothing when nobody votes, and starts the next round right away', async () => {
    await tick();
    t += 30_000;
    await votes.tick();
    expect(votes.state().lastResult).toMatchObject({ roundId: 1, winner: null, votes: 0 });
    expect(queue.waitingCount()).toBe(0);
    expect(votes.state().round?.id).toBe(2);
  });

  it('reports suggestion failures to the host and retries later', async () => {
    source.error = new ProviderError('Last.fm did not answer. Check the internet connection.');
    await tick();
    expect(votes.state().round).toBeNull();
    expect(votes.status().problem).toMatch(/did not answer/);

    t += 10_000;
    await tick();
    expect(source.calls).toBe(1);

    source.error = null;
    t += 20_000;
    await tick();
    expect(votes.state().round).not.toBeNull();
    expect(votes.status().problem).toBeNull();
  });
});
