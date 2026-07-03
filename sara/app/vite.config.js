import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// This app is a SARA surface but it talks to the NEURO *brain* (capture, focus, chat,
// calendar, vault-hygiene all live on the NEURO backend).
//   Dev:  Vite proxies /api → the NEURO backend so we develop against the real brain.
//   Prod: static build on Netlify; VITE_API_URL points at the NEURO backend's
//         Tailscale Serve HTTPS URL (tailnet-only). See the "NEURO & SARA" vault note.
const BRAIN = process.env.NEURO_BACKEND_URL || 'http://localhost:3001';

export default defineConfig({
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
        name: 'SARA',
        short_name: 'SARA',
        description: 'SARA — light-touch interface to the NEURO brain',
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
