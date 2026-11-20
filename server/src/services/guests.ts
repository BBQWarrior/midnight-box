import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';

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
}

function toGuest(row: GuestRow): Guest {
  return { id: row.id, publicId: row.public_id, name: row.name, banned: row.banned === 1 };
}
