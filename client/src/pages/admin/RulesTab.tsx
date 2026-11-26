import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CooldownList, Settings, SettingsResponse } from '@shared/types';
import { api } from '../../lib/api';
import { formatClock } from '../../lib/format';
import { ExtLink, artistUrl, trackUrl } from '../../components/Spotify';
import { useToast } from '../../components/Toast';
import { Button, Card, Heading, Notice, SettingRow, Stepper, Switch } from '../../components/ui';
import { useHost } from './host';

const SAVE_DELAY_MS = 600;
type Save = 'idle' | 'saving' | 'saved';

/** A setting's label, with a dot when it differs from the default. */
function Label({ children, changed }: { children: ReactNode; changed: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      {changed && <span title="Changed from the default" className="size-1.5 rounded-full bg-accent" />}
    </span>
  );
}

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="px-4 pt-4 pb-1">
      <Heading title={title} description={description} />
      <div className="mt-1 divide-y divide-line">{children}</div>
    </Card>
  );
}

export function RulesTab() {
  const { run, status, spotify } = useHost();
  const toast = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [save, setSave] = useState<Save>('idle');
  const pending = useRef<Partial<Settings>>({});
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    const res = await run(() => api.getSettings());
    if (res) setData(res.value);
  }, [run]);

  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    setSave('saving');
    const res = await run(() => api.updateSettings(patch));
    if (res) {
      setData(res.value);
      setSave('saved');
    } else {
      setSave('idle');
      await load();
    }
  }, [run, load]);

  // Send what's left when leaving the tab.
  useEffect(() => () => void flush(), [flush]);

  /** Shows the change at once and saves it shortly after (switches save right away). */
  const change = (patch: Partial<Settings>, now = false): void => {
    setData((d) => d && { ...d, settings: { ...d.settings, ...patch } });
    pending.current = { ...pending.current, ...patch };
    window.clearTimeout(timer.current);
    if (now) void flush();
    else timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  const reset = async (): Promise<void> => {
    if (!data) return;
    const before = data.settings;
    await flush();
    const res = await run(() => api.resetSettings());
    if (!res) return;
    setData(res.value);
    toast.show('House rules are back to the defaults', 'info', {
      label: 'Undo',
      onClick: () =>
        void run(() => api.updateSettings(before)).then((r) => {
          if (r) setData(r.value);
        }),
    });
  };

  if (!data) return <p className="p-4 text-muted">Loading…</p>;
  const s = data.settings;
  const d = data.defaults;
  const changed = (k: keyof Settings): boolean => s[k] !== d[k];
  const changedCount = (Object.keys(s) as (keyof Settings)[]).filter(changed).length;
  const voting = status?.voting;

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-[13px] text-muted" aria-live="polite">
        Changes apply at once and are kept until you reset them.{' '}
        <span className="text-faint">{save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved.' : ''}</span>
      </p>

      <Group title="Guest requests" description="How many songs each guest can add.">
        <SettingRow label={<Label changed={changed('windowSongs')}>Songs per guest</Label>} help="In a rolling window">
          <Stepper label="Songs per guest" value={s.windowSongs} min={1} max={50} onChange={(v) => change({ windowSongs: v })} />
        </SettingRow>
        <SettingRow label={<Label changed={changed('windowMinutes')}>Window length</Label>}>
          <Stepper label="Window length" unit="min" value={s.windowMinutes} min={1} max={1440} step={5} onChange={(v) => change({ windowMinutes: v })} />
        </SettingRow>
        <SettingRow label={<Label changed={changed('maxPendingPerGuest')}>Waiting at once</Label>} help="Songs one guest can have in the queue">
          <Stepper
            label="Waiting at once"
            value={s.maxPendingPerGuest}
            min={1}
            max={50}
            onChange={(v) => change({ maxPendingPerGuest: v, ...(s.maxPerRequest > v ? { maxPerRequest: v } : {}) })}
          />
        </SettingRow>
        <SettingRow label={<Label changed={changed('maxPerRequest')}>Songs per add</Label>} help="Picked together in one go">
          <Stepper
            label="Songs per add"
            value={s.maxPerRequest}
            min={1}
            max={Math.min(10, s.maxPendingPerGuest)}
            onChange={(v) => change({ maxPerRequest: v })}
          />
        </SettingRow>
      </Group>

      <Group title="Rest times" description="Counted from when a song starts playing, whoever picked it.">
        <SettingRow label={<Label changed={changed('songCooldownMinutes')}>Same song rests</Label>} help="0 turns it off">
          <Stepper
            label="Same song rests"
            unit="min"
            value={s.songCooldownMinutes}
            min={0}
            max={10080}
            step={15}
            onChange={(v) => change({ songCooldownMinutes: v })}
          />
        </SettingRow>
        <SettingRow
          label={<Label changed={changed('artistMaxSongs')}>Songs per artist</Label>}
          help={`At most this many by one artist every ${s.artistCooldownMinutes} min`}
        >
          <Stepper label="Songs per artist" value={s.artistMaxSongs} min={1} max={20} onChange={(v) => change({ artistMaxSongs: v })} />
        </SettingRow>
        <SettingRow label={<Label changed={changed('artistCooldownMinutes')}>Artist window</Label>} help="0 turns the artist rule off">
          <Stepper
            label="Artist window"
            unit="min"
            value={s.artistCooldownMinutes}
            min={0}
            max={10080}
            step={5}
            onChange={(v) => change({ artistCooldownMinutes: v })}
          />
        </SettingRow>
      </Group>

      <Group title="Filters">
        <SettingRow
          label={<Label changed={changed('noExplicit')}>No explicit songs</Label>}
          help="Guests can't add them, and waiting ones leave the queue"
        >
          <Switch label="No explicit songs" checked={s.noExplicit} onChange={(v) => change({ noExplicit: v }, true)} />
        </SettingRow>
        <SettingRow
          label={<Label changed={changed('skipBlocked')}>Skip blocked songs Spotify plays</Label>}
          help="When autoplay or your own Spotify queue starts a blocked song"
        >
          <Switch label="Skip blocked songs Spotify plays" checked={s.skipBlocked} onChange={(v) => change({ skipBlocked: v }, true)} />
        </SettingRow>
      </Group>

      <Group
        title="Vote rounds"
        description={
          voting?.source === 'lastfm' ? 'Suggestions from Last.fm.' : voting?.source === 'demo' ? 'Demo suggestions.' : undefined
        }
      >
        <SettingRow label={<Label changed={changed('voteEnabled')}>Let guests vote for the next song</Label>}>
          <Switch
            label="Let guests vote for the next song"
            checked={s.voteEnabled}
            disabled={voting?.source === null}
            onChange={(v) => change({ voteEnabled: v }, true)}
          />
        </SettingRow>
        {voting?.problem && (
          <div className="py-3">
            <Notice>{voting.problem}</Notice>
          </div>
        )}
        <SettingRow label={<Label changed={changed('voteRoundSeconds')}>Round length</Label>}>
          <Stepper label="Round length" unit="s" value={s.voteRoundSeconds} min={10} max={600} step={5} onChange={(v) => change({ voteRoundSeconds: v })} />
        </SettingRow>
        <SettingRow label={<Label changed={changed('voteWhenFewerThan')}>Start when fewer than</Label>} help="Songs waiting in the queue">
          <Stepper label="Start when fewer than" value={s.voteWhenFewerThan} min={1} max={50} onChange={(v) => change({ voteWhenFewerThan: v })} />
        </SettingRow>
      </Group>

      <Group title="Vote to skip" description="Counts guests active in the last 15 minutes, one vote per phone.">
        <SettingRow label={<Label changed={changed('skipEnabled')}>Let guests vote to skip</Label>}>
          <Switch label="Let guests vote to skip" checked={s.skipEnabled} onChange={(v) => change({ skipEnabled: v }, true)} />
        </SettingRow>
        <SettingRow label={<Label changed={changed('skipPercent')}>Share of guests needed</Label>}>
          <Stepper label="Share of guests needed" unit="%" value={s.skipPercent} min={10} max={100} step={5} onChange={(v) => change({ skipPercent: v })} />
        </SettingRow>
        <SettingRow label={<Label changed={changed('skipMinVotes')}>At least</Label>} help="Votes, however few guests are around">
          <Stepper label="Minimum skip votes" value={s.skipMinVotes} min={1} max={50} onChange={(v) => change({ skipMinVotes: v })} />
        </SettingRow>
      </Group>

      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-[13px] text-faint">
          {changedCount === 0 ? 'Everything is at the defaults from .env.' : `${changedCount} changed from the defaults.`}
        </p>
        <Button size="sm" disabled={changedCount === 0} onClick={() => void reset()}>
          Reset to defaults
        </Button>
      </div>

      <Resting spotify={spotify} />
    </div>
  );
}

/** Songs and artists cooling down right now, with a Clear button each. */
function Resting({ spotify }: { spotify: boolean }) {
  const { run } = useHost();
  const [list, setList] = useState<CooldownList | null>(null);

  const load = useCallback(async () => {
    const res = await run(() => api.getCooldowns());
    if (res) setList(res.value);
  }, [run]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const clear = (kind: 'song' | 'artist', key: string) => void run(() => api.clearCooldown({ kind, key })).then(load);
  const empty = list && list.songs.length === 0 && list.artists.length === 0;

  return (
    <Card className="p-4">
      <Heading title="Resting now" description="Clear one to let guests pick it again right away." />
      {!list ? (
        <p className="mt-2 text-sm text-muted">Loading…</p>
      ) : empty ? (
        <p className="mt-2 text-sm text-muted">Nothing is resting.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {list.songs.map((c) => (
            <li key={`s:${c.key}`} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold" title={c.track.name}>
                  {spotify ? (
                    <ExtLink href={trackUrl(c.track)} className="hover:underline">
                      {c.track.name}
                    </ExtLink>
                  ) : (
                    c.track.name
                  )}
                </p>
                <p className="truncate text-xs text-muted">
                  Song · {c.track.artists[0]?.name} · until {formatClock(c.until)}
                </p>
              </div>
              <Button size="sm" onClick={() => clear('song', c.key)}>
                Clear
              </Button>
            </li>
          ))}
          {list.artists.map((c) => (
            <li key={`a:${c.key}`} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold" title={c.artist.name}>
                  {spotify ? (
                    <ExtLink href={artistUrl(c.artist.id)} className="hover:underline">
                      {c.artist.name}
                    </ExtLink>
                  ) : (
                    c.artist.name
                  )}
                </p>
                <p className="text-xs text-muted">Artist · until {formatClock(c.until)}</p>
              </div>
              <Button size="sm" onClick={() => clear('artist', c.key)}>
                Clear
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
