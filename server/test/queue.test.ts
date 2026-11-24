import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { MOCK_CATALOG } from '../src/providers/mock/catalog.js';
import { QueueService } from '../src/services/queue.js';

const T0 = 1_700_000_000_000;

function setup() {
  let t = T0;
  const db = openDb(':memory:');
  const queue = new QueueService(db, () => t);
  const ids = new Map<number, string>();
  const insertGuest = db.prepare('INSERT INTO guests (id, public_id, name, created_at) VALUES (?, ?, ?, 0)');
  for (const name of ['ana', 'ben', 'cy', 'dee']) insertGuest.run(name, `pub-${name}`, name);

  let next = 0;
  /** Adds a fresh catalog song for `guest` and labels it e.g. "ana1". */
  const add = (guest: string) => {
    const row = queue.add(MOCK_CATALOG[next++]!, guest);
    const count = [...ids.values()].filter((label) => label.startsWith(guest)).length;
    ids.set(row.id, `${guest}${count + 1}`);
    return row.id;
  };
  const order = () => queue.upcoming().map((r) => ids.get(r.id));
  /** Simulates the player handing the next song over and it finishing. */
  const playNext = () => {
    const row = queue.nextQueued()!;
    queue.setStatus(row.id, 'played');
  };
  const advance = (ms: number) => {
    t += ms;
  };
  return { db, queue, add, order, playNext, advance };
}

describe('fair queue', () => {
  it('lets guests take turns instead of first come, first served', () => {
    const { add, order } = setup();
    add('ana');
    add('ana');
    add('ana');
    add('ben');
    add('cy');
    expect(order()).toEqual(['ana1', 'ben1', 'cy1', 'ana2', 'ana3']);
  });

  it('puts a newcomer into the round that is playing, never into one already played', () => {
    const { add, order, playNext } = setup();
    add('ana');
    add('ana');
    add('ana');
    add('ben');
    playNext(); // ana1
    playNext(); // ben1
    playNext(); // ana2 (round 1 is now playing)

    add('cy'); // joins round 1, so plays before ana's third song
    add('ben'); // ben's last song was round 0, so round 1 as well
    expect(order()).toEqual(['cy1', 'ben2', 'ana3']);
  });

  it('keeps the pushed song first whatever its round', () => {
    const { queue, add, order } = setup();
    add('ana');
    add('ana');
    queue.setStatus(queue.upcoming()[1]!.id, 'pushed');
    expect(order()).toEqual(['ana2', 'ana1']);
  });

  it('counts recent adds per guest, ignoring songs the host removed', () => {
    const { queue, add, advance } = setup();
    const first = add('ana');
    advance(60_000);
    add('ana');
    add('ben');
    expect(queue.addedSince('ana', T0 - 1)).toEqual([T0, T0 + 60_000]);
    expect(queue.addedSince('ana', T0)).toEqual([T0 + 60_000]);

    queue.remove(first);
    expect(queue.addedSince('ana', T0 - 1)).toEqual([T0 + 60_000]);
  });
});

describe('history clean-up', () => {
  const HOUR = 60 * 60_000;
  const count = (db: ReturnType<typeof openDb>, table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it('deletes old plays and requests, but keeps waiting songs and the round the party reached', () => {
    const { db, queue, add, order, playNext, advance } = setup();
    add('ana');
    add('ana');
    add('ana');
    add('ben');
    add('ben');
    playNext(); // ana1
    playNext(); // ben1
    playNext(); // ana2: round 1 is playing
    queue.recordPlay(MOCK_CATALOG[0]!, null);

    advance(3 * HOUR);
    queue.prune(T0 + HOUR);
    expect(count(db, 'plays')).toBe(0);
    expect(order()).toEqual(['ben2', 'ana3']);

    // The played rounds are gone, but a newcomer still joins round 1 instead of jumping the queue.
    add('cy');
    expect(order()).toEqual(['ben2', 'cy1', 'ana3']);
  });

  it('keeps recent history', () => {
    const { db, queue, add, playNext, advance } = setup();
    add('ana');
    playNext();
    queue.recordPlay(MOCK_CATALOG[0]!, null);
    advance(HOUR);
    queue.prune(T0 - 1);
    expect(count(db, 'plays')).toBe(1);
    expect(count(db, 'queue')).toBe(1);
  });
});
