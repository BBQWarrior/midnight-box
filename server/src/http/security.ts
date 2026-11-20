import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The real client IP. X-Forwarded-For is only honoured when the TCP peer is this machine
 * (our own Vite dev proxy), and then only its last hop, which that proxy appended itself.
 * A device on the network can't spoof it: its TCP peer address is never loopback.
 */
export function clientIp(req: FastifyRequest): string {
  const peer = req.socket.remoteAddress ?? '';
  if (LOOPBACK_IPS.has(peer)) {
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
 * True only for requests made on the host machine itself, addressed to a loopback hostname.
 * The Host check also blocks DNS-rebinding attacks and stops the admin panel from leaking
 * through a tunnel or reverse proxy that forwards from localhost.
 */
export function isHostRequest(req: FastifyRequest): boolean {
  return LOOPBACK_IPS.has(clientIp(req)) && LOOPBACK_HOSTNAMES.has(hostnameOf(req.headers.host) ?? '');
}

export async function requireHost(req: FastifyRequest): Promise<void> {
  if (!isHostRequest(req)) {
    throw new HttpError(403, 'forbidden', 'Admin controls are only available on the host computer.');
  }
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
