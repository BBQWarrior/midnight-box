import type { RejectReason, TrackBlock } from '@shared/types';
import { formatClock } from './format';

const at = (availableAt: number | null): string => (availableAt === null ? '' : ` at ${formatClock(availableAt)}`);

/** Why a search result can't be picked, shown under the song. */
export function blockText(block: TrackBlock): string {
  const when = block.availableAt === null ? '' : ` · free again at ${formatClock(block.availableAt)}`;
  switch (block.reason) {
    case 'already_queued':
      return 'Already in the queue';
    case 'artist_queued':
      return 'This artist is already queued';
    case 'song_cooldown':
      return `Played recently${when}`;
    case 'artist_cooldown':
      return `Artist played recently${when}`;
    case 'blacklisted':
      return 'Not played at this party';
    case 'explicit':
      return 'No explicit songs tonight';
  }
}

/** Why an add was refused, in a sentence after the song's name. */
export function rejectText(reason: RejectReason, availableAt: number | null): string {
  switch (reason) {
    case 'already_queued':
      return 'already in the queue';
    case 'artist_queued':
      return 'this artist is already queued';
    case 'song_cooldown':
      return `played recently, free again${at(availableAt)}`;
    case 'artist_cooldown':
      return `artist played recently, free again${at(availableAt)}`;
    case 'blacklisted':
      return "the host doesn't want this one played";
    case 'explicit':
      return 'no explicit songs tonight';
    case 'too_soon':
      return availableAt === null ? "you've added enough for now" : `you can add again at ${formatClock(availableAt)}`;
    case 'limit_reached':
      return "you've hit your song limit";
    case 'not_found':
      return "couldn't find that song";
  }
}
