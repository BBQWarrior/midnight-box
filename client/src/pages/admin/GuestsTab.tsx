import { useEffect, useState } from 'react';
import { Check, Copy, Smartphone, Tv } from 'lucide-react';
import type { JoinInfo } from '@shared/types';
import { api } from '../../lib/api';
import { Badge } from '../../components/Badge';
import { useToast } from '../../components/Toast';
import { Button, Card, Heading, buttonClass } from '../../components/ui';
import { useHost } from './host';

export function GuestsTab() {
  const { status, run, refresh } = useHost();
  const toast = useToast();
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getJoinInfo().then(setJoin, () => undefined);
  }, []);

  const copy = async (): Promise<void> => {
    if (!join) return;
    try {
      await navigator.clipboard.writeText(join.joinUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.show('Could not copy. Select the link and copy it manually.', 'error');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <Heading title="Let guests in" description="They scan the code, pick a name and start adding songs." />
        {join ? (
          <div className="mt-4 flex flex-col items-center gap-3">
            <img src={join.qrDataUrl} alt="QR code to join Midnight Box" className="size-60 rounded-lg bg-white p-3" />
            <p className="text-center text-sm break-all text-muted">{join.joinUrl}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => void copy()}>
                {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <a href="/tv" target="_blank" rel="noopener" className={buttonClass()}>
                <Tv size={16} aria-hidden="true" /> Open TV screen
              </a>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-muted">Loading…</p>
        )}
      </Card>

      <Card className="p-4">
        <Heading
          title="Removed guests"
          description="Removing someone bans their session, and their phone too when it can be recognised on your Wi-Fi."
        />
        {status && status.banned.length > 0 ? (
          <ul className="mt-2 divide-y divide-line">
            {status.banned.map((g) => (
              <li key={g.publicId} className="flex items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold">{g.name}</span>
                  {g.device && (
                    <Badge label="Phone banned">
                      <Smartphone size={11} aria-hidden="true" className="mr-1" /> Phone banned
                    </Badge>
                  )}
                </div>
                <Button size="sm" onClick={() => void run(() => api.unbanGuest(g.publicId)).then(() => refresh())}>
                  Let back in
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">Nobody has been removed.</p>
        )}
      </Card>
    </div>
  );
}
