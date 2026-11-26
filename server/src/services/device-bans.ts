import { createHmac } from 'node:crypto';
import type { Db } from '../db.js';
import type { MacLookup } from '../lib/arp.js';

/** How long a "this address is (not) a banned device" answer is reused before asking the OS again. */
const CACHE_MS = 60_000;

/**
 * Bans a guest's phone, not just their session: by its Wi-Fi hardware address, so clearing
 * cookies, a private tab, a new IP address or a server restart don't get them back in.
 *
 * Only a keyed hash of the address is stored, and only for banned devices. Addresses are looked up
 * only while at least one device is banned.
 */
export class DeviceBans {
  private count: number;
  private readonly cache = new Map<string, { publicId: string | null; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly lookup: MacLookup,
    private readonly now: () => number = Date.now,
  ) {
    this.count = (db.prepare('SELECT COUNT(*) AS n FROM banned_devices').get() as { n: number }).n;
  }

  /** Bans the device behind `ip` for this guest. False when its hardware address can't be read. */
  async ban(ip: string | undefined, publicId: string): Promise<boolean> {
    if (!ip) return false;
    const mac = await this.lookup(ip).catch(() => null);
    if (!mac) return false;
    this.db
      .prepare(
        `INSERT INTO banned_devices (device_hash, public_id, banned_at) VALUES (?, ?, ?)
         ON CONFLICT(device_hash) DO UPDATE SET public_id = excluded.public_id, banned_at = excluded.banned_at`,
      )
      .run(this.hash(mac), publicId, this.now());
    this.changed();
    return true;
  }

  /** Lifts the device ban that came with this guest's ban. */
  unban(publicId: string): void {
    this.db.prepare('DELETE FROM banned_devices WHERE public_id = ?').run(publicId);
    this.changed();
  }

  /** Guests whose ban covers their device. */
  bannedGuests(): Set<string> {
    const rows = this.db.prepare('SELECT public_id FROM banned_devices').all() as { public_id: string }[];
    return new Set(rows.map((r) => r.public_id));
  }

  /** The public id of the guest whose device ban covers `ip`, or null. */
  async bannedFor(ip: string): Promise<string | null> {
    if (this.count === 0) return null;
    const now = this.now();
    const hit = this.cache.get(ip);
    if (hit && now - hit.at < CACHE_MS) return hit.publicId;
    const mac = await this.lookup(ip).catch(() => null);
    const row = mac
      ? (this.db.prepare('SELECT public_id FROM banned_devices WHERE device_hash = ?').get(this.hash(mac)) as
          | { public_id: string }
          | undefined)
      : undefined;
    const publicId = row?.public_id ?? null;
    this.cache.set(ip, { publicId, at: now });
    return publicId;
  }

  private changed(): void {
    this.count = (this.db.prepare('SELECT COUNT(*) AS n FROM banned_devices').get() as { n: number }).n;
    this.cache.clear();
  }

  private hash(mac: string): string {
    return createHmac('sha256', this.secret).update(mac).digest('hex');
  }
}
