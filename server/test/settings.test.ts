import { describe, expect, it } from 'vitest';
import type { Settings } from '@shared/types';
import { kvGet, kvSet, openDb } from '../src/db.js';
import { parseMac } from '../src/lib/arp.js';
import { SettingsError, SettingsService } from '../src/services/settings.js';

const DEFAULTS: Settings = {
  maxPendingPerGuest: 3,
  maxPerRequest: 3,
  windowSongs: 2,
  windowMinutes: 20,
  songCooldownMinutes: 120,
  artistMaxSongs: 1,
  artistCooldownMinutes: 20,
  noExplicit: false,
  voteEnabled: true,
  voteRoundSeconds: 30,
  voteWhenFewerThan: 2,
  skipEnabled: true,
  skipPercent: 50,
  skipMinVotes: 2,
  skipBlocked: true,
};

describe('SettingsService', () => {
  it('keeps the host changes across restarts and resets to the defaults', () => {
    const db = openDb(':memory:');
    const settings = new SettingsService(db, DEFAULTS);
    settings.update({ windowSongs: 5, artistMaxSongs: 3, artistCooldownMinutes: 30 });
    expect(new SettingsService(db, DEFAULTS).get()).toMatchObject({ windowSongs: 5, artistMaxSongs: 3, artistCooldownMinutes: 30 });

    settings.reset();
    expect(new SettingsService(db, DEFAULTS).get()).toEqual(DEFAULTS);
  });

  it('only saves what differs from the defaults, so a new default applies to untouched settings', () => {
    const db = openDb(':memory:');
    new SettingsService(db, DEFAULTS).update({ windowSongs: 5, windowMinutes: 20 });
    expect(JSON.parse(kvGet(db, 'settings')!)).toEqual({ windowSongs: 5 });
    expect(new SettingsService(db, { ...DEFAULTS, windowMinutes: 45 }).get().windowMinutes).toBe(45);
  });

  it('rejects values out of range, unknown names and impossible combinations', () => {
    const settings = new SettingsService(openDb(':memory:'), DEFAULTS);
    expect(() => settings.update({ windowSongs: 0 })).toThrow();
    expect(() => settings.update({ skipPercent: 101 })).toThrow();
    expect(() => settings.update({ nonsense: true })).toThrow();
    expect(() => settings.update({ maxPerRequest: 5 })).toThrow(SettingsError);
    expect(settings.get()).toEqual(DEFAULTS);
  });

  it('tells listeners what changed', () => {
    const settings = new SettingsService(openDb(':memory:'), DEFAULTS);
    const seen: [boolean, boolean][] = [];
    settings.onChange((next, prev) => seen.push([prev.voteEnabled, next.voteEnabled]));
    settings.update({ voteEnabled: false });
    expect(seen).toEqual([[true, false]]);
  });

  it('drops saved values that are no longer valid, and takes over the old on/off switches', () => {
    const db = openDb(':memory:');
    kvSet(db, 'settings', JSON.stringify({ windowSongs: 999, windowMinutes: 45, gone: 1 }));
    kvSet(db, 'voting_enabled', '0');
    kvSet(db, 'skip_voting_enabled', '1');
    const settings = new SettingsService(db, DEFAULTS);
    expect(settings.get()).toMatchObject({ windowSongs: 2, windowMinutes: 45, voteEnabled: false, skipEnabled: true });
    expect(kvGet(db, 'voting_enabled')).toBeUndefined();
  });

  it('never lets one request beat the waiting limit, even with a stale saved value', () => {
    const db = openDb(':memory:');
    kvSet(db, 'settings', JSON.stringify({ maxPerRequest: 3 }));
    const settings = new SettingsService(db, { ...DEFAULTS, maxPendingPerGuest: 2, maxPerRequest: 2 });
    expect(settings.limits().maxPerRequest).toBe(2);
  });
});

describe('parseMac', () => {
  it('reads Windows, Linux and macOS neighbour tables', () => {
    const windows = `
Interface: 192.168.1.233 --- 0xc
  Internet Address      Physical Address      Type
  192.168.1.1           78-8c-b5-42-6a-c0     dynamic
  192.168.1.216         86-9f-d0-82-73-78     dynamic
`;
    expect(parseMac(windows, '192.168.1.216')).toBe('86:9f:d0:82:73:78');
    expect(parseMac(windows, '192.168.1.21')).toBeNull();

    const linux = `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.40     0x1         0x2         aa:bb:cc:dd:ee:01     *        wlan0
192.168.1.41     0x1         0x0         00:00:00:00:00:00     *        wlan0
`;
    expect(parseMac(linux, '192.168.1.40')).toBe('aa:bb:cc:dd:ee:01');
    // An incomplete entry is not an address.
    expect(parseMac(linux, '192.168.1.41')).toBeNull();

    const mac = '? (192.168.1.50) at 0:1c:42:a:b:c on en0 ifscope [ethernet]\n';
    expect(parseMac(mac, '192.168.1.50')).toBe('00:1c:42:0a:0b:0c');
  });
});
