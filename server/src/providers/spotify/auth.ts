import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { type Db, kvDelete, kvGet, kvSet } from '../../db.js';
import { ProviderError, ProviderNotReadyError } from '../types.js';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing'];
const TOKENS_KEY = 'spotify_tokens';
const LOGIN_TTL_MS = 10 * 60_000;
/** Refresh a bit before expiry so in-flight requests never carry a stale token. */
const EXPIRY_MARGIN_MS = 60_000;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const StoredTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});
type StoredTokens = z.infer<typeof StoredTokens>;

/**
 * Spotify OAuth using Authorization Code + PKCE.
 * PKCE means no client secret exists anywhere: the only credentials are the tokens,
 * which live in the local SQLite database and never reach a browser.
 */
export class SpotifyAuth {
  private tokens: StoredTokens | null;
  private readonly pendingLogins = new Map<string, { verifier: string; expiresAt: number }>();
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly clientId: string,
    private readonly redirectUri: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.tokens = this.load();
  }

  isConnected(): boolean {
    return this.tokens !== null;
  }

  /** Starts a login: returns the Spotify consent URL to redirect the host to. */
  createAuthorizeUrl(): string {
    const now = Date.now();
    for (const [state, entry] of this.pendingLogins) {
      if (entry.expiresAt < now) this.pendingLogins.delete(state);
    }
    if (this.pendingLogins.size > 20) this.pendingLogins.clear();

    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');
    this.pendingLogins.set(state, { verifier, expiresAt: now + LOGIN_TTL_MS });

    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      scope: SCOPES.join(' '),
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  /** Completes a login from the redirect's query parameters. Throws with a host-readable message. */
  async handleCallback(query: { code?: string; state?: string; error?: string }): Promise<void> {
    if (query.error) throw new ProviderError(`Spotify login was cancelled (${query.error}).`);

    const pending = query.state ? this.pendingLogins.get(query.state) : undefined;
    if (query.state) this.pendingLogins.delete(query.state);
    if (!pending || pending.expiresAt < Date.now() || !query.code) {
      throw new ProviderError('This login link expired or was already used. Try connecting again.');
    }

    const token = await this.tokenRequest(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: pending.verifier,
      }),
    );
    if (!token.refresh_token) throw new ProviderError('Spotify did not return a refresh token.');

    this.save({
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    });
  }

  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new ProviderNotReadyError();
    if (this.tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return this.tokens.accessToken;
    return this.refresh();
  }

  /** Refreshes the access token. Concurrent callers share one request. */
  refresh(): Promise<string> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  disconnect(): void {
    this.tokens = null;
    kvDelete(this.db, TOKENS_KEY);
  }

  private async doRefresh(): Promise<string> {
    const current = this.tokens;
    if (!current) throw new ProviderNotReadyError();
    let token: z.infer<typeof TokenResponse>;
    try {
      token = await this.tokenRequest(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: this.clientId,
        }),
      );
    } catch (err) {
      if (err instanceof ProviderError && err.message.includes('invalid_grant')) {
        // Access was revoked in the Spotify account settings: require a fresh login.
        this.disconnect();
        throw new ProviderNotReadyError('Spotify access was revoked. The host needs to connect again.');
      }
      throw err;
    }
    this.save({
      accessToken: token.access_token,
      // PKCE refresh tokens may rotate; keep the old one if Spotify didn't send a new one.
      refreshToken: token.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000,
    });
    return token.access_token;
  }

  private async tokenRequest(body: URLSearchParams): Promise<z.infer<typeof TokenResponse>> {
    let res: Response;
    try {
      res = await this.fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ProviderError('Could not reach Spotify. Check the internet connection.');
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code = z.object({ error: z.string() }).safeParse(json);
      throw new ProviderError(
        `Spotify token request failed (${res.status}${code.success ? `: ${code.data.error}` : ''}).`,
        res.status,
      );
    }
    const parsed = TokenResponse.safeParse(json);
    if (!parsed.success) throw new ProviderError('Spotify returned an unexpected token response.');
    return parsed.data;
  }

  private load(): StoredTokens | null {
    const raw = kvGet(this.db, TOKENS_KEY);
    if (!raw) return null;
    try {
      return StoredTokens.parse(JSON.parse(raw));
    } catch {
      kvDelete(this.db, TOKENS_KEY);
      return null;
    }
  }

  private save(tokens: StoredTokens): void {
    this.tokens = tokens;
    kvSet(this.db, TOKENS_KEY, JSON.stringify(tokens));
  }
}
