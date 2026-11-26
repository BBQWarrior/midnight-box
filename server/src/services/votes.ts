import type { MyVotes, Track, TrackBlock, VoteResult, VoteState, VotingStatus } from '@shared/types';
import type { Db } from '../db.js';
import { LruCache } from '../lib/cache.js';
import { baseTitle, mainArtist, songKey } from '../lib/tracks.js';
import type { MusicProvider, SongRef, SuggestionSource } from '../providers/types.js';
import type { Log, Player } from './player.js';
import type { QueueService } from './queue.js';

/** Read on every use, so the host's changes apply at once. */
export interface VoteOptions {
  /** The host's on/off switch. */
  enabled: boolean;
  /** How long guests can vote in each round. */
  roundMs: number;
  /** Rounds only run while fewer than this many songs are waiting. */
  maxWaiting: number;
  /** Songs offered per round. */
  candidates: number;
  /** Wait this long after a failed round start (no suggestions, Last.fm down) before trying again. */
  retryMs: number;
}

interface VoteDeps {
  db: Db;
  provider: MusicProvider;
  /** Null when no suggestion service is configured: vote rounds are off. */
  source: SuggestionSource | null;
  queue: QueueService;
  /** Whether a song could be queued right now (TrackRules). */
  rules: { blockFor(track: Track, playing: Track | null): TrackBlock | null };
  player: Player;
  log: Log;
  /** Called whenever what guests see may have changed. */
  onChange: () => void;
  now?: () => number;
  /** Shuffles the candidates' display order. Injectable so tests are deterministic. */
  shuffle?: <T>(items: T[]) => T[];
}

interface Candidate {
  track: Track;
  /** Voter key -> when they voted. */
  voters: Map<string, number>;
}

interface Round {
  id: number;
  basedOn: Track;
  candidates: Candidate[];
  endsAt: number;
}

export type VoteOutcome = MyVotes | 'closed' | 'not_a_candidate';
/** Provider lookups allowed per round start; resolved songs are cached, so later rounds are cheaper. */
const MAX_LOOKUPS = 12;

/**
 * Vote rounds: while the queue is short, guests vote on songs related to what's playing,
 * one round after another. The winner joins the queue as a "vote pick".
 *
 * Votes are kept in memory: a round lasts seconds, so a restart only loses the one in progress.
 */
export class VoteService {
  private round: Round | null = null;
  private lastResult: VoteResult | null = null;
  private nextRoundId = 1;
  private starting = false;
  private retryAt = 0;
  private problem: string | null = null;
  /** Songs already offered for the current base song, so back-to-back rounds show new ones. */
  private offered = new Set<string>();
  private offeredFor = '';
  private readonly resolved = new LruCache<string, Track | null>(2_000, 6 * 60 * 60_000);
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly shuffle: <T>(items: T[]) => T[];

  constructor(
    private readonly deps: VoteDeps,
    private readonly options: () => VoteOptions,
  ) {
    this.now = deps.now ?? Date.now;
    this.shuffle = deps.shuffle ?? fisherYates;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private get opts(): VoteOptions {
    return this.options();
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Call after the host changed the settings: switching rounds off cancels the one in progress. */
  settingsChanged(): void {
    if (!this.enabled) this.round = null;
    this.problem = null;
    this.retryAt = 0;
    this.deps.onChange();
  }

  /** For guests (part of the live state). */
  state(): VoteState {
    const round = this.round;
    return {
      active: this.enabled && this.deps.source !== null,
      round: round && {
        id: round.id,
        basedOn: { name: round.basedOn.name, artist: mainArtist(round.basedOn)?.name ?? '' },
        candidates: round.candidates.map((c) => ({ track: c.track, votes: c.voters.size })),
        endsAt: round.endsAt,
      },
      lastResult: this.lastResult,
    };
  }

  /** For the host panel. */
  status(): VotingStatus {
    const { source, provider } = this.deps;
    let problem: string | null = null;
    if (!source) problem = 'Add a free Last.fm API key as LASTFM_API_KEY in .env and restart to turn on vote rounds.';
    else if (this.enabled && !provider.isReady()) problem = 'Connect Spotify to start vote rounds.';
    else if (this.enabled) problem = this.problem;
    return { source: source?.kind ?? null, enabled: this.enabled, problem };
  }

  myVotes(voter: string): MyVotes {
    const round = this.round;
    if (!round) return { roundId: null, trackIds: [] };
    return { roundId: round.id, trackIds: round.candidates.filter((c) => c.voters.has(voter)).map((c) => c.track.id) };
  }

  /** Adds or takes back one vote. A voter can back any number of candidates, once each. */
  vote(voter: string, roundId: number, trackId: string, on: boolean): VoteOutcome {
    const round = this.round;
    const now = this.now();
    if (!round || round.id !== roundId || now >= round.endsAt) return 'closed';
    const candidate = round.candidates.find((c) => c.track.id === trackId);
    if (!candidate) return 'not_a_candidate';
    if (on && !candidate.voters.has(voter)) candidate.voters.set(voter, now);
    if (!on) candidate.voters.delete(voter);
    this.deps.onChange();
    return this.myVotes(voter);
  }

  /** Drops someone's votes from the current round (they were removed from the party). */
  removeVoter(...voters: string[]): void {
    if (!this.round) return;
    for (const c of this.round.candidates) for (const v of voters) c.voters.delete(v);
    this.deps.onChange();
  }

  /** Host: close the current round now. Returns false if none is running. */
  endNow(): boolean {
    if (!this.round) return false;
    this.finish();
    return true;
  }

  /** One step of the round loop: close a round that ran out, start the next one if it's time. Public for tests. */
  async tick(): Promise<void> {
    if (this.round && this.now() >= this.round.endsAt) this.finish();
    if (!this.round && !this.starting && this.now() >= this.retryAt && this.shouldRun()) await this.startRound();
  }

  private playing(): Track | null {
    return this.deps.player.playback.state?.track ?? null;
  }

  private shouldRun(): boolean {
    const { source, provider, queue, player } = this.deps;
    return (
      source !== null &&
      this.enabled &&
      provider.isReady() &&
      player.playback.state?.isPlaying === true &&
      this.playing() !== null &&
      queue.waitingCount() < this.opts.maxWaiting
    );
  }

  private async startRound(): Promise<void> {
    const base = this.playing();
    if (!base) return;
    this.starting = true;
    try {
      const candidates = await this.pickCandidates(base);
      // Things may have changed while we waited for suggestions (host turned voting off).
      if (this.round || !this.shouldRun()) return;
      if (candidates.length < 2) {
        this.fail(`Found no suggestions for "${base.name}" that aren't on cooldown or already queued.`);
        return;
      }
      this.problem = null;
      this.round = {
        id: this.nextRoundId++,
        basedOn: base,
        candidates: this.shuffle(candidates.map((track) => ({ track, voters: new Map() }))),
        endsAt: this.now() + this.opts.roundMs,
      };
      this.deps.onChange();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.starting = false;
    }
  }

  private fail(message: string): void {
    if (message !== this.problem) this.deps.log.warn(`Vote rounds: ${message}`);
    this.problem = message;
    this.retryAt = this.now() + this.opts.retryMs;
    this.deps.onChange();
  }

  /**
   * Related songs that could be queued right now: not on cooldown, not queued, one per artist.
   * Songs already offered for this base song are skipped until the suggestions run out.
   */
  private async pickCandidates(base: Track): Promise<Track[]> {
    const { source, provider, rules } = this.deps;
    if (!source) return [];
    const baseKey = songKey(base);
    if (this.offeredFor !== baseKey) {
      this.offered.clear();
      this.offeredFor = baseKey;
    }
    const refs = await source.similarTo(base);

    const picked: Track[] = [];
    const pickedRefs: string[] = [];
    const artistNames = new Set<string>();
    let lookups = 0;
    const scan = async (skipOffered: boolean) => {
      for (const ref of refs) {
        if (picked.length >= this.opts.candidates || lookups >= MAX_LOOKUPS) return;
        const artistName = ref.artist.toLowerCase();
        if (artistNames.has(artistName) || (skipOffered && this.offered.has(refKey(ref)))) continue;

        const cacheKey = refKey(ref);
        let found = this.resolved.get(cacheKey);
        if (found === undefined) {
          lookups++;
          found = await provider.findTrack(ref.title, ref.artist);
          this.resolved.set(cacheKey, found);
        }
        const track = found;
        if (!track || rules.blockFor(track, base)) continue;
        if (picked.some((p) => songKey(p) === songKey(track) || mainArtist(p)?.id === mainArtist(track)?.id)) continue;
        picked.push(track);
        pickedRefs.push(cacheKey);
        artistNames.add(artistName);
      }
    };
    await scan(true);
    if (picked.length < this.opts.candidates && this.offered.size > 0) {
      // Everything related has been offered once: start over.
      this.offered.clear();
      await scan(false);
    }
    for (const key of pickedRefs) this.offered.add(key);
    return picked;
  }

  /**
   * Closes the round. Most votes wins; on a tie, the song that reached its total first.
   * If the winner can't be queued any more (a guest queued it meanwhile), the runner-up gets in.
   */
  private finish(): void {
    const round = this.round;
    if (!round) return;
    this.round = null;
    const { queue, rules, player, log } = this.deps;

    const reachedAt = (c: Candidate) => Math.max(...c.voters.values());
    const ranked = round.candidates
      .filter((c) => c.voters.size > 0)
      .sort((a, b) => b.voters.size - a.voters.size || reachedAt(a) - reachedAt(b));
    const winner = ranked.find((c) => !rules.blockFor(c.track, this.playing()));

    if (winner) {
      queue.add(winner.track, null, 'vote');
      log.info(`Vote pick: "${winner.track.name}" (${winner.voters.size} ${winner.voters.size === 1 ? 'vote' : 'votes'})`);
      player.poke();
    }
    this.lastResult = {
      roundId: round.id,
      winner: winner?.track ?? null,
      votes: winner?.voters.size ?? 0,
      endedAt: this.now(),
    };
    this.deps.onChange();
  }
}

function refKey(ref: SongRef): string {
  return `${ref.artist.toLowerCase()}|${baseTitle(ref.title)}`;
}

function fisherYates<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
