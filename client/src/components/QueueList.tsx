import { useState, type ReactNode } from 'react';
import { ListMusic, MoreHorizontal } from 'lucide-react';
import type { QueueEntry } from '@shared/types';
import { artistNames } from '../lib/format';
import { Badge } from './Badge';
import { CoverLink } from './Spotify';
import { Button, Card } from './ui';

interface Props {
  queue: QueueEntry[];
  myPublicId?: string | undefined;
  onAddSongs?: () => void;
  /** Host panel: what to show when a row's "more" button is pressed (remove, block, remove guest). */
  renderActions?: (entry: QueueEntry, close: () => void) => ReactNode;
  /** Real Spotify content (not demo mode): covers link to Spotify. */
  spotify?: boolean;
}

export function QueueList({ queue, myPublicId, onAddSongs, renderActions, spotify = false }: Props) {
  const [open, setOpen] = useState<number | null>(null);

  if (queue.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <ListMusic size={28} className="text-faint" aria-hidden="true" />
        <p className="mt-1 font-semibold">The queue is empty</p>
        <p className="text-sm text-muted">Be the first to pick a track.</p>
        {onAddSongs && (
          <Button variant="primary" className="mt-3 px-6" onClick={onAddSongs}>
            Add songs
          </Button>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <ol className="divide-y divide-line">
        {queue.map((entry, i) => {
          const mine = myPublicId !== undefined && entry.requestedBy?.publicId === myPublicId;
          const expanded = open === entry.id;
          return (
            <li key={entry.id} className={mine ? 'bg-accent-soft' : ''}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <span className="w-4 shrink-0 text-right text-xs text-faint tabular-nums">{i + 1}</span>
                <CoverLink track={entry.track} spotify={spotify} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-semibold" title={entry.track.name}>
                      {entry.track.name}
                    </p>
                    {entry.track.explicit && (
                      <Badge tone="explicit" label="Explicit">
                        E
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-[13px] text-muted" title={artistNames(entry.track.artists)}>
                    {artistNames(entry.track.artists)}
                  </p>
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-faint">
                    {entry.votePick ? (
                      <Badge tone="accent">Vote pick</Badge>
                    ) : (
                      <span className="truncate">{entry.requestedBy?.name ?? 'Host'}</span>
                    )}
                    {mine && <Badge tone="accent">You</Badge>}
                    {entry.status === 'pushed' && <Badge>Up next</Badge>}
                  </p>
                </div>
                {renderActions && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-expanded={expanded}
                    aria-label={`Actions for ${entry.track.name}`}
                    onClick={() => setOpen(expanded ? null : entry.id)}
                  >
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </Button>
                )}
              </div>
              {renderActions && expanded && (
                <div className="flex flex-wrap gap-2 px-3 pb-3 pl-[4.75rem]">{renderActions(entry, () => setOpen(null))}</div>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
