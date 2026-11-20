import type { FastifyRequest } from 'fastify';
import { isLoopbackIp } from '../lib/net.js';
import type { HostAuth } from '../services/host-auth.js';
import { HttpError } from './errors.js';

export const HOST_COOKIE = 'mb_host';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The real client IP. X-Forwarded-For is only honoured when the TCP peer is this machine
 * (our own Vite dev proxy), and then only its last hop, which that proxy appended itself.
 * A device on the network can't spoof it: its TCP peer address is never loopback.
 */
export function clientIp(req: FastifyRequest): string {
  const peer = req.socket.remoteAddress ?? '';
  if (isLoopbackIp(peer)) {
    const header = req.headers['x-forwarded-for'];
    const hops = (Array.isArray(header) ? header.join(',') : (header ?? ''))
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const last = hops.at(-1);
    if (last) return last;
  }
  return peer;
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/**
 * True only for requests made on the host computer itself, addressed to a loopback hostname.
 * The Host check also blocks DNS-rebinding attacks and stops host-only routes from leaking
 * through a tunnel or reverse proxy that forwards from localhost.
 */
export function isHostRequest(req: FastifyRequest): boolean {
  return isLoopbackIp(clientIp(req)) && LOOPBACK_HOSTNAMES.has(hostnameOf(req.headers.host) ?? '');
}

/** For first-run setup and Spotify login, which must happen on the host computer. */
export async function requireHost(req: FastifyRequest): Promise<void> {
  if (!isHostRequest(req)) {
    throw new HttpError(403, 'forbidden', 'This is only available on the host computer.');
  }
}

/** preHandler for host-panel routes: a valid host session cookie, from any device. */
export function makeRequireAdmin(auth: HostAuth) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!auth.isValid(req.cookies[HOST_COOKIE])) {
      throw new HttpError(401, 'unauthorized', 'Log in as the host first.');
    }
  };
}

/** Rejects state-changing requests sent from another website (CSRF). */
export async function blockCrossSite(req: FastifyRequest): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'forbidden', 'Cross-site request blocked.');
  }
  const origin = req.headers.origin;
  if (!origin) return;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(origin).host === req.headers.host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) throw new HttpError(403, 'forbidden', 'Cross-site request blocked.');
}
