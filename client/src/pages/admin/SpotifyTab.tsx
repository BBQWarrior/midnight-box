import { useState } from 'react';
import { api } from '../../lib/api';
import { ExtLink } from '../../components/Spotify';
import { Button, Card, Heading, Notice } from '../../components/ui';
import { useHost } from './host';

export function SpotifyTab() {
  const { status, run, refresh } = useHost();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [disconnected, setDisconnected] = useState(false);

  if (!status) return <p className="p-4 text-muted">Loading…</p>;

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    const res = await run(() => api.disconnectSpotify());
    setBusy(false);
    if (!res) return;
    setConfirm(false);
    setDisconnected(true);
    await refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <Heading
          title={status.provider === 'mock' ? 'Demo mode' : 'Spotify'}
          description={
            status.provider === 'mock' ? (
              'A fake music catalog and a simulated player. Nothing talks to Spotify.'
            ) : (
              <span className={status.connected ? 'text-ok' : 'text-muted'}>{status.connected ? 'Connected' : 'Not connected'}</span>
            )
          }
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {!status.connected &&
            (status.onHostMachine ? (
              status.connectUrl && (
                <Button
                  variant="primary"
                  onClick={() => {
                    if (status.connectUrl) window.location.href = status.connectUrl;
                  }}
                >
                  Connect Spotify
                </Button>
              )
            ) : (
              <p className="text-sm text-muted">Connect Spotify from the host computer.</p>
            ))}
          {status.provider === 'spotify' && status.connected && !confirm && (
            <Button onClick={() => setConfirm(true)}>Disconnect Spotify</Button>
          )}
        </div>
        {confirm && (
          <div className="mt-3 rounded-lg border border-danger/30 bg-danger-soft p-3">
            <p className="text-sm text-ink">Deletes the saved Spotify login and listening history from this computer.</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void disconnect()}>
                {busy ? 'Disconnecting…' : 'Disconnect'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {disconnected && (
          <div className="mt-3">
            <Notice>
              To also remove Midnight Box&apos;s access on Spotify&apos;s side, remove it at{' '}
              <ExtLink href="https://www.spotify.com/account/apps/" className="underline underline-offset-2">
                spotify.com/account/apps
              </ExtLink>
              . Your blacklist and house rules stay.
            </Notice>
          </div>
        )}
      </Card>
      <p className="px-1 text-xs text-faint">
        <a href="/privacy" className="underline underline-offset-2">
          Privacy
        </a>
      </p>
    </div>
  );
}
