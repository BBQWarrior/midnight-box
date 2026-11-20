import { useState } from 'react';
import { ListMusic, UserX, X } from 'lucide-react';
import type { GuestTag, QueueEntry } from '@shared/types';
import { Badge } from './Badge';
import { Cover } from './Cover';

interface Props {
  queue: QueueEntry[];
  myPublicId?: string | undefined;
  onAddSongs?: () => void;
  onRemove?: (entry: QueueEntry) => void;
  removingId?: number | null;
  onBan?: (guest: GuestTag) => void;
}

export function QueueList({ queue, myPublicId, onAddSongs, onRemove, removingId, onBan }: Props) {
  const [confirmBan, setConfirmBan] = useState<string | null>(null);

  if (queue.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-3xl border border-white/10 bg-white/5 px-6 py-10 text-center backdrop-blur-xl">
        <ListMusic size={32} className="text-white/40" aria-hidden="true" />
        <p className="font-medium">The queue is empty</p>
        <p className="text-sm text-white/60">Be the first to pick a track.</p>
        {onAddSongs && (
          <button
            type="button"
            onClick={onAddSongs}
            className="mt-1 min-h-11 rounded-full bg-linear-to-r from-accent to-accent-2 px-6 font-semibold text-white"
          >
            Add songs
          </button>
        )}
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {queue.map((entry) => {
        const mine = myPublicId !== undefined && entry.requestedBy?.publicId === myPublicId;
        return (
          <li
            key={entry.id}
            className={`flex items-center gap-3 rounded-2xl border p-2.5 backdrop-blur-xl ${
              mine ? 'border-accent/50 bg-accent/10' : 'border-white/10 bg-white/5'
            }`}
          >
            <Cover track={entry.track} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-medium">{entry.track.name}</p>
                {entry.track.explicit && <Badge tone="explicit" label="Explicit">E</Badge>}
              </div>
              <p className="truncate text-xs text-white/60">
                {entry.track.artists.map((a) => a.name).join(', ')}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-white/50">
                <span className="truncate">{entry.requestedBy?.name ?? 'Host'}</span>
                {mine && <Badge tone="accent">You</Badge>}
                {entry.status === 'pushed' && <Badge tone="cyan">Up next</Badge>}
              </p>
              {onBan && entry.requestedBy && (
                <p className="mt-1 flex items-center gap-2 text-xs">
                  {confirmBan === entry.requestedBy.publicId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.requestedBy) onBan(entry.requestedBy);
                          setConfirmBan(null);
                        }}
                        className="min-h-8 rounded-full border border-rose-400/40 bg-rose-500/20 px-3 font-semibold text-rose-100"
                      >
                        Yes, remove {entry.requestedBy.name}
                      </button>
                      <button type="button" onClick={() => setConfirmBan(null)} className="min-h-8 px-2 text-white/60">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmBan(entry.requestedBy?.publicId ?? null)}
                      className="flex min-h-8 items-center gap-1 rounded-full px-2 text-rose-200/80 hover:bg-white/10"
                    >
                      <UserX size={12} aria-hidden="true" /> Remove guest
                    </button>
                  )}
                </p>
              )}
            </div>
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${entry.track.name} from the queue`}
                disabled={removingId === entry.id}
                onClick={() => onRemove(entry)}
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/10 disabled:opacity-40"
              >
                <X size={18} />
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
