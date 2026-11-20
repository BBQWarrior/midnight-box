import type { Track } from '@shared/types';
import { mainArtist } from '../../lib/tracks.js';
import type { SongRef, SuggestionSource } from '../types.js';

/** Demo-mode stand-in for Last.fm: every other artist's songs, in a stable order per song. */
export class MockSuggestions implements SuggestionSource {
  readonly kind = 'demo' as const;

  constructor(private readonly catalog: Track[]) {}

  async similarTo(track: Track): Promise<SongRef[]> {
    const artistId = mainArtist(track)?.id;
    return this.catalog
      .filter((t) => mainArtist(t)?.id !== artistId)
      .map((t) => ({ t, rank: hash(`${track.id}>${t.id}`) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ t }) => ({ title: t.name, artist: mainArtist(t)?.name ?? '' }));
  }
}

/** FNV-1a: a cheap, stable shuffle key. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
