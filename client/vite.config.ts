import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
