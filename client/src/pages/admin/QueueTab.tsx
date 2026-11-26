import { useState } from 'react';
import { UserX, X } from 'lucide-react';
import type { GuestTag, PublicState, QueueEntry } from '@shared/types';
import { api } from '../../lib/api';
import { QueueList } from '../../components/QueueList';
import { SpotifyLogo } from '../../components/Spotify';
import { useToast } from '../../components/Toast';
import { Button } from '../../components/ui';
import { BlockMenu } from './BlockMenu';
import { useHost } from './host';

/** Removes a guest from the party after a confirmation; the toast offers Undo. */
export function RemoveGuestButton({ guest, onDone }: { guest: GuestTag; onDone?: () => void }) {
  const { run, refresh } = useHost();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);

  if (!confirm) {
    return (
      <Button size="sm" variant="ghost-danger" onClick={() => setConfirm(true)}>
        <UserX size={14} aria-hidden="true" /> Remove {guest.name}
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <span className="w-full text-xs text-muted">
        Remove {guest.name} from the party? Their waiting songs go too, and their phone is banned if it can be recognised.
      </span>
      <Button
        size="sm"
        variant="danger"
        onClick={async () => {
          const res = await run(() => api.banGuest(guest.publicId));
          setConfirm(false);
          if (!res) return;
          await refresh();
          toast.show(`Removed ${guest.name}${res.value.device ? ' and banned their phone' : ''}`, 'info', {
            label: 'Undo',
            onClick: () => void run(() => api.unbanGuest(guest.publicId)).then(() => refresh()),
          });
          onDone?.();
        }}
      >
        Yes, remove {guest.name}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
        Cancel
      </Button>
    </div>
  );
}

export function QueueTab({ state }: { state: PublicState | null }) {
  const { run, spotify } = useHost();
  const [removingId, setRemovingId] = useState<number | null>(null);

  const remove = async (entry: QueueEntry): Promise<void> => {
    setRemovingId(entry.id);
    await run(() => api.removeFromQueue(entry.id));
    setRemovingId(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {spotify && (
        <div className="-my-2 -ml-3">
          <SpotifyLogo />
        </div>
      )}
      <QueueList
        spotify={spotify}
        queue={state?.queue ?? []}
        renderActions={(entry, close) => (
          <>
            {entry.status === 'queued' ? (
              <Button size="sm" disabled={removingId === entry.id} onClick={() => void remove(entry).then(close)}>
                <X size={14} aria-hidden="true" /> Remove song
              </Button>
            ) : (
              <span className="self-center text-xs text-muted">Already sent to Spotify: skip it when it starts.</span>
            )}
            <BlockMenu track={entry.track} onDone={close} />
            {entry.requestedBy && <RemoveGuestButton guest={entry.requestedBy} onDone={close} />}
          </>
        )}
      />
      <p className="px-1 text-[13px] text-faint">Tap ⋯ on a song to remove it, block it, or remove the guest who added it.</p>
    </div>
  );
}
