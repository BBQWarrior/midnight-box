import { useState } from 'react';
import { Ban } from 'lucide-react';
import type { BlacklistKind, Track } from '@shared/types';
import { api } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { Button } from '../../components/ui';
import { useHost } from './host';

const KIND_LABEL: Record<BlacklistKind, string> = { song: 'song', album: 'album', artist: 'artist' };

interface Option {
  kind: BlacklistKind;
  label: string;
  artistId?: string;
}

/**
 * "Block…" for one track: the song (every version), its album, or one of its artists.
 * Every block can be undone from the toast.
 */
export function BlockMenu({
  track,
  onDone,
  startOpen = false,
  onClose,
}: {
  track: Track;
  /** After a successful block. */
  onDone?: () => void;
  /** Show the choices straight away (the caller has its own "Block…" button). */
  startOpen?: boolean;
  /** Cancel was pressed. */
  onClose?: () => void;
}) {
  const { run } = useHost();
  const toast = useToast();
  const [open, setOpen] = useState(startOpen);
  const [busy, setBusy] = useState(false);

  const options: Option[] = [
    { kind: 'song', label: 'This song' },
    ...(track.albumId ? [{ kind: 'album' as const, label: `Album: ${track.album}` }] : []),
    ...track.artists.map((a) => ({ kind: 'artist' as const, label: `Artist: ${a.name}`, artistId: a.id })),
  ];

  const block = async (o: Option): Promise<void> => {
    setBusy(true);
    const res = await run(() => api.block({ kind: o.kind, trackId: track.id, ...(o.artistId ? { artistId: o.artistId } : {}) }));
    setBusy(false);
    if (!res) return;
    const { item, removedFromQueue } = res.value;
    const removed = removedFromQueue > 0 ? `, ${removedFromQueue} waiting ${removedFromQueue === 1 ? 'song' : 'songs'} removed` : '';
    toast.show(`Blocked the ${KIND_LABEL[item.kind]} “${item.name}”${removed}`, 'info', {
      label: 'Undo',
      onClick: () => void run(() => api.unblock({ kind: item.kind, key: item.key })),
    });
    setOpen(false);
    onDone?.();
  };

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Ban size={14} aria-hidden="true" /> Block…
      </Button>
    );
  }

  return (
    <div role="group" aria-label={`Block ${track.name}`} className="flex w-full flex-wrap items-center gap-2">
      <span className="w-full text-xs text-muted">Never play:</span>
      {options.map((o) => (
        <Button key={`${o.kind}:${o.artistId ?? ''}`} size="sm" variant="danger" disabled={busy} onClick={() => void block(o)}>
          <span className="max-w-56 truncate">{o.label}</span>
        </Button>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(false);
          onClose?.();
        }}
      >
        Cancel
      </Button>
    </div>
  );
}
