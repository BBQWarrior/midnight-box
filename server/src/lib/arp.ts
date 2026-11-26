import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

/** Looks up the Wi-Fi/Ethernet hardware address behind a LAN IP, or null. */
export type MacLookup = (ip: string) => Promise<string | null>;

const TIMEOUT_MS = 2_000;
// Octets may lack their leading zero (macOS prints "0:1c:42:...").
const MAC = /(?<![0-9a-f])([0-9a-f]{1,2})[:-]([0-9a-f]{1,2})[:-]([0-9a-f]{1,2})[:-]([0-9a-f]{1,2})[:-]([0-9a-f]{1,2})[:-]([0-9a-f]{1,2})(?![0-9a-f])/i;

/** "::ffff:192.168.1.5" -> "192.168.1.5". */
export function plainIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Private and link-local IPv4: the only addresses that can be in this computer's neighbour table. */
function isLanIpv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Finds the hardware address for `ip` in `arp` or /proc/net/arp output. Lower case, colon separated. */
export function parseMac(text: string, ip: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.split(/[\s()]+/).includes(ip)) continue;
    const m = MAC.exec(line);
    if (!m) continue;
    const mac = m
      .slice(1, 7)
      .map((o) => o.toLowerCase().padStart(2, '0'))
      .join(':');
    if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') continue;
    return mac;
  }
  return null;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Reads the hardware address of a device on the same network from the operating system's
 * neighbour (ARP) table. The host computer must have talked to the device, which it has while
 * the device is making requests. Phones use a private address per Wi-Fi network, but keep it on
 * that network. Returns null off the LAN (VPN, reverse proxy, another subnet) or on any error.
 */
export const lookupMac: MacLookup = async (rawIp) => {
  const ip = plainIp(rawIp);
  if (!isLanIpv4(ip)) return null;
  try {
    if (process.platform === 'linux') return parseMac(await readFile('/proc/net/arp', 'utf8'), ip);
    return parseMac(await run('arp', process.platform === 'win32' ? ['-a', ip] : ['-n', ip]), ip);
  } catch {
    return null;
  }
};
