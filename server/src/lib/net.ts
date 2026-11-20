import os from 'node:os';

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|wsl|docker|hyper-v|vbox|veth|br-|utun|tailscale|zerotier/i;
const PRIVATE_IPV4 = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackIp(ip: string): boolean {
  return LOOPBACK_IPS.has(ip);
}

/** Best guess at the address phones on the same Wi-Fi can reach this machine on. */
export function lanAddress(): string {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) {
        candidates.push({ name, address: info.address });
      }
    }
  }
  const score = (c: { name: string; address: string }) =>
    (VIRTUAL_ADAPTER.test(c.name) ? 0 : 2) + (PRIVATE_IPV4.test(c.address) ? 1 : 0);
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0]?.address ?? '127.0.0.1';
}
