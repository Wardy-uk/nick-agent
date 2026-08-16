import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// This app is a SARA surface but it talks to the NEURO *brain* (capture, focus, chat,
// calendar, vault-hygiene all live on the NEURO backend).
//   Dev:  Vite proxies /api → the NEURO backend so we develop against the real brain.
//   Prod: static build on Netlify; VITE_API_URL points at the NEURO backend's
//         Tailscale Serve HTTPS URL (tailnet-only). See the "NEURO & SARA" vault note.
const BRAIN = process.env.NEURO_BACKEND_URL || 'http://localhost:3001';

// #110 — which bundle is the phone actually running?
//
// The tracker recorded this as "VITE_BUILD_LABEL is unset". It is not: it is set
// in the committed `.env.production` to the literal `prod-mobile`, which Netlify
// does read. The problem is that the value is the SAME ON EVERY BUILD, so it can
// never answer the question it exists for — and setting it in the Netlify UI
// instead would have been just as static.
//
// So derive it. Netlify exposes COMMIT_REF at build time; locally we fall back to
// the working commit, then to 'dev'. A label that changes per deploy is what turns
// "which build is this" from an inference into something readable off the screen —
// the evening lost on 15 Aug went on exactly that inference, with a stale service
// worker serving an old bundle while the code being debugged was already fixed.
function resolveBuildLabel() {
  if (process.env.VITE_BUILD_LABEL) return process.env.VITE_BUILD_LABEL;
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7);
  try {
    return `dev-${execSync('git rev-parse --short HEAD').toString().trim()}`;
  } catch {
    return 'dev';
  }
}
const BUILD_LABEL = resolveBuildLabel();

export default defineConfig({
  define: {
    // Beats the static value in .env.production, which is left in place only as a
    // local-dev default.
    'import.meta.env.VITE_BUILD_LABEL': JSON.stringify(BUILD_LABEL),
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      },
      manifest: {
        name: 'SARA Mobile',
        short_name: 'SARA Mobile',
        description: 'SARA mobile — SARA on the go, backed by the NEURO brain',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0b0f14',
        theme_color: '#0b0f14',
        icons: [
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    host: true, // reachable over Tailscale
    port: 5175, // 5173 = NEURO frontend, 5174 = SARA kiosk frontend, 5175 = this
    proxy: {
      '/api': { target: BRAIN, changeOrigin: true },
    },
  },
});
