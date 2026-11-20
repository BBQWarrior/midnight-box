import type { Artist, Track } from '@shared/types';

/** The first credited artist. Artist cooldowns only look at this one, so features don't block anybody. */
export function mainArtist(track: Track): Artist | undefined {
  return track.artists[0];
}

/** A title without version suffixes: "Song (feat. X) - 2011 Remaster" -> "song". */
export function baseTitle(name: string): string {
  const base = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return base || name.toLowerCase();
}

/**
 * Identifies "the same song" across releases. Spotify lists one recording under many ids
 * (single, album, deluxe edition, remaster), so duplicates and cooldowns compare the main
 * artist plus the title without version suffixes like "(feat. X)" or " - 2011 Remaster".
 */
export function songKey(track: Track): string {
  return `${mainArtist(track)?.id ?? ''}|${baseTitle(track.name)}`;
}

/** Letters and digits only, for comparing names from different services ("AC/DC" = "ACDC"). */
function loose(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Picks the search result that really is `title` by `artist`, or null. Search engines happily
 * return a different song by the same artist (or a cover) when the exact one isn't available.
 */
export function bestMatch(tracks: Track[], title: string, artist: string): Track | null {
  const wantTitle = loose(baseTitle(title));
  const wantArtist = loose(artist);
  return (
    tracks.find(
      (t) => loose(baseTitle(t.name)) === wantTitle && t.artists.some((a) => loose(a.name) === wantArtist),
    ) ?? null
  );
}
