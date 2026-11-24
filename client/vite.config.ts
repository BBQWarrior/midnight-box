import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Read PORT from the root .env (server config). This only configures the dev proxy;
  // nothing from the root .env is exposed to the browser bundle (Vite's envDir stays client/,
  // and only VITE_* variables are ever exposed).
  const rootEnv = loadEnv(mode, '..', '');
  const api = `http://127.0.0.1:${rootEnv.PORT || '8080'}`;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      // The dev server is reachable from the whole network, and Vite would otherwise serve any file
      // in the repo, including the database in data/ (Spotify tokens, secrets). Only allow what the
      // app imports; PRIVACY.md is shown by the privacy page.
      fs: {
        allow: ['.', '../shared', '../node_modules', '../PRIVACY.md'].map((p) => path.resolve(here, p)),
        // Vite's defaults, plus the database files.
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/**', '*.db', '*.db-*'],
      },
      // xfwd lets the server see the real client IP behind the dev proxy,
      // so host-only routes stay host-only even in dev.
      proxy: {
        '/api': { target: api, xfwd: true },
        '/auth': { target: api, xfwd: true },
        '/socket.io': { target: api, ws: true, xfwd: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
