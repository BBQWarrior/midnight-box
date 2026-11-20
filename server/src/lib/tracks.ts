import type { Artist, Track } from '@shared/types';

/** The first credited artist. Artist cooldowns only look at this one, so features don't block anybody. */
export function mainArtist(track: Track): Artist | undefined {
  return track.artists[0];
}

/**
 * Identifies "the same song" across releases. Spotify lists one recording under many ids
 * (single, album, deluxe edition, remaster), so duplicates and cooldowns compare the main
 * artist plus the title without version suffixes like "(feat. X)" or " - 2011 Remaster".
 */
export function songKey(track: Track): string {
  const base = track.name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${mainArtist(track)?.id ?? ''}|${base || track.name.toLowerCase()}`;
}
