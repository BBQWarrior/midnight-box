// Regenerates the README screenshots (docs/screenshots/*.png) from demo mode.
// Usage: npm run screenshots   (builds first; needs `npx playwright install chromium` once)
//
// Runs the production build on a spare port with a throwaway database, seeds a few guests
// through the public API, then captures the guest and host views at phone size.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const dataDir = mkdtempSync(path.join(tmpdir(), 'midnight-box-shots-'));
const server = spawn(process.execPath, ['server/dist/index.js', '--demo'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    // A made-up LAN address, so the QR code in the screenshots doesn't show your real one.
    PUBLIC_URL: `http://192.168.1.50:${PORT}/`,
  },
  stdio: 'ignore',
});

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not start. Did `npm run build` succeed?');
}

/** A guest with their own cookies, named and ready to queue. */
async function guest(browser, name) {
  const context = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
  await context.request.get(`${BASE}/api/me`);
  await context.request.put(`${BASE}/api/me`, { data: { name } });
  return context;
}

async function trackId(context, query) {
  const res = await context.request.get(`${BASE}/api/search?q=${encodeURIComponent(query)}`);
  const { results } = await res.json();
  if (!results[0]) throw new Error(`No demo track matches "${query}"`);
  return results[0].track.id;
}

async function queue(context, ...queries) {
  const trackIds = [];
  for (const q of queries) trackIds.push(await trackId(context, q));
  const res = await context.request.post(`${BASE}/api/queue`, { data: { trackIds } });
  const body = await res.json();
  if (!res.ok() || body.rejected.length > 0) throw new Error(`Queueing failed: ${JSON.stringify(body)}`);
}

async function main() {
  await waitForServer();
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    // A small party: fair-queue order will be Maya, Leo, Priya, Maya, Leo.
    await queue(await guest(browser, 'Maya'), 'gravity waltz', 'cardboard rocket');
    await queue(await guest(browser, 'Leo'), 'north of never', 'last stop');
    await queue(await guest(browser, 'Priya'), 'magnetic north');

    // Guest view.
    const sam = await guest(browser, 'Sam');
    const page = await sam.newPage();
    await page.goto(BASE);
    await page.getByText('Afterglow Avenue').first().waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, 'guest.png') });

    // Search: shows what's resting (the playing artist) next to what's free.
    await page.getByRole('tab', { name: /add songs/i }).click();
    const search = page.getByPlaceholder(/search/i).first();
    await search.fill('neon');
    await search.press('Enter');
    await page.getByText('Feathers & Neon').first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, 'search.png') });

    // Host panel, logged in (first-run setup is allowed because this is the host computer).
    const host = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
    const setup = await host.request.post(`${BASE}/api/admin/setup`, { data: { password: 'screenshot-demo-pass' } });
    if (setup.status() !== 204) throw new Error(`Host setup failed: ${setup.status()}`);
    const admin = await host.newPage();
    await admin.goto(`${BASE}/admin`);
    await admin.getByText('Gravity Waltz').first().waitFor();
    // Skip past playback and the QR code to the queue, guest and cooldown controls.
    await admin.getByRole('heading', { name: 'Queue' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await admin.waitForTimeout(500);
    await admin.screenshot({ path: path.join(OUT_DIR, 'host.png') });

    console.log(`Screenshots saved to ${path.relative(ROOT, OUT_DIR)}`);
  } finally {
    await browser.close();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    server.once('exit', () => rmSync(dataDir, { recursive: true, force: true }));
  });
