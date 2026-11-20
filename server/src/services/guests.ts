import { randomBytes, randomUUID } from 'node:crypto';
import type { GuestTag } from '@shared/types';
import type { Db } from '../db.js';
import { isLoopbackIp } from '../lib/net.js';

export const NAME_MAX_LENGTH = 24;

export interface Guest {
  /** Secret session id, only ever stored in the guest's signed cookie. */
  id: string;
  /** Public id, safe to share with other guests (used for "You" badges). */
  publicId: string;
  name: string | null;
  banned: boolean;
}

interface GuestRow {
  id: string;
  public_id: string;
  name: string | null;
  banned: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Normalizes a display name: no control characters, single spaces, trimmed. */
export function cleanName(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class GuestService {
  private readonly lastIp = new Map<string, string>();
  /** Banned address -> public id of the guest it was banned for. */
  private readonly bannedIps = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string | undefined): Guest | undefined {
    if (!id || !UUID.test(id)) return undefined;
    const row = this.db.prepare('SELECT id, public_id, name, banned FROM guests WHERE id = ?').get(id) as
      | GuestRow
      | undefined;
    return row && toGuest(row);
  }

  create(): Guest {
    const guest: Guest = {
      id: randomUUID(),
      publicId: randomBytes(9).toString('base64url'),
      name: null,
      banned: false,
    };
    this.db
      .prepare('INSERT INTO guests (id, public_id, name, created_at) VALUES (?, ?, NULL, ?)')
      .run(guest.id, guest.publicId, this.now());
    return guest;
  }

  setName(id: string, name: string): Guest {
    this.db.prepare('UPDATE guests SET name = ? WHERE id = ?').run(name, id);
    const guest = this.get(id);
    if (!guest) throw new Error('Guest disappeared');
    return guest;
  }

  // ---- Bans ----------------------------------------------------------------
  // A ban blocks the guest's session for good (until unbanned) and the address they last used
  // until the server restarts, so clearing cookies isn't enough to come back. Addresses are
  // only kept in memory.

  /** Remembers where a guest's requests come from, so a ban can cover their address too. */
  seen(guest: Guest, ip: string): void {
    this.lastIp.set(guest.id, ip);
  }

  isIpBanned(ip: string): boolean {
    return this.bannedIps.has(ip);
  }

  /** Returns the banned guest, or undefined if no guest has that public id. */
  ban(publicId: string): Guest | undefined {
    const guest = this.byPublicId(publicId);
    if (!guest) return undefined;
    this.db.prepare('UPDATE guests SET banned = 1 WHERE id = ?').run(guest.id);
    const ip = this.lastIp.get(guest.id);
    // Never lock out the host computer itself (or everyone behind the dev proxy).
    if (ip && !isLoopbackIp(ip)) this.bannedIps.set(ip, publicId);
    return { ...guest, banned: true };
  }

  unban(publicId: string): Guest | undefined {
    const guest = this.byPublicId(publicId);
    if (!guest) return undefined;
    this.db.prepare('UPDATE guests SET banned = 0 WHERE id = ?').run(guest.id);
    for (const [ip, owner] of this.bannedIps) if (owner === publicId) this.bannedIps.delete(ip);
    return { ...guest, banned: false };
  }

  bannedList(): GuestTag[] {
    const rows = this.db
      .prepare('SELECT public_id, name FROM guests WHERE banned = 1 ORDER BY created_at')
      .all() as { public_id: string; name: string | null }[];
    return rows.map((r) => ({ publicId: r.public_id, name: r.name ?? 'Guest' }));
  }

  private byPublicId(publicId: string): Guest | undefined {
    const row = this.db.prepare('SELECT id, public_id, name, banned FROM guests WHERE public_id = ?').get(publicId) as
      | GuestRow
      | undefined;
    return row && toGuest(row);
  }
}

function toGuest(row: GuestRow): Guest {
  return { id: row.id, publicId: row.public_id, name: row.name, banned: row.banned === 1 };
}
