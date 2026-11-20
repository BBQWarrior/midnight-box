import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { type Db, kvGet, kvDelete } from '../db.js';

const argon2Async = promisify(argon2);

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const PASSWORD_KEY = 'host_password';
/** OWASP's recommended argon2id settings: 19 MiB, 2 passes. */
const DEFAULTS = { memory: 19_456, passes: 2, parallelism: 1 };
const TAG_LENGTH = 32;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/**
 * The host's password and login sessions. The password is set once from the host computer,
 * hashed with argon2id and stored in the local database; it never goes near .env or git.
 */
export class HostAuth {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  hasPassword(): boolean {
    return kvGet(this.db, PASSWORD_KEY) !== undefined;
  }

  /** First-run setup. Returns false if a password already exists (it is never overwritten here). */
  async setInitialPassword(password: string): Promise<boolean> {
    const hash = await hashPassword(password);
    const result = this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run(PASSWORD_KEY, hash);
    return Number(result.changes) === 1;
  }

  async verify(password: string): Promise<boolean> {
    const stored = kvGet(this.db, PASSWORD_KEY);
    return stored ? verifyPassword(password, stored) : false;
  }

  createSession(): { token: string; expiresAt: number } {
    const now = this.now();
    this.db.prepare('DELETE FROM host_sessions WHERE expires_at <= ?').run(now);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_TTL_MS;
    this.db
      .prepare('INSERT INTO host_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), now, expiresAt);
    return { token, expiresAt };
  }

  isValid(token: string | undefined): boolean {
    if (!token || token.length > 64) return false;
    const row = this.db.prepare('SELECT expires_at FROM host_sessions WHERE token_hash = ?').get(sha256(token)) as
      | { expires_at: number }
      | undefined;
    return row !== undefined && row.expires_at > this.now();
  }

  revoke(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM host_sessions WHERE token_hash = ?').run(sha256(token));
  }

  /** `--reset-host-password`: forget the password and log every session out. */
  reset(): void {
    kvDelete(this.db, PASSWORD_KEY);
    this.db.prepare('DELETE FROM host_sessions').run();
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const tag = await argon2Async('argon2id', { message: password, nonce: salt, tagLength: TAG_LENGTH, ...DEFAULTS });
  const { memory, passes, parallelism } = DEFAULTS;
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = PHC.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64');
  const tag = await argon2Async('argon2id', {
    message: password,
    nonce: Buffer.from(m[4]!, 'base64'),
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return tag.length === expected.length && timingSafeEqual(tag, expected);
}
