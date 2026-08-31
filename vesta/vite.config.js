import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VESTA talks to the NEURO backend's PUBLIC mount, /api/v.
//   Dev:  proxied to the local backend so we develop against the real thing.
//   Prod: VITE_API_URL is the Pi's Tailscale FUNNEL address — the public one.
//         ⚠ Not the tailnet `.ts.net` address SARA uses: her phone is outside
//         the house and has no Tailscale, which is the entire reason /api/v is
//         exempt from the PIN.
const BRAIN = process.env.NEURO_BACKEND_URL || 'http://localhost:3001';

// Which bundle is the phone running? Same reasoning as sara/app: a label that is
// the same on every build cannot answer the question it exists for.
function resolveBuildLabel() {
  if (process.env.VITE_BUILD_LABEL) return process.env.VITE_BUILD_LABEL;
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7);
  try {
    return `dev-${execSync('git rev-parse --short HEAD').toString().trim()}`;
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_LABEL': JSON.stringify(resolveBuildLabel()),
  },
  plugins: [react()],
  server: {
    host: true,
    // 5173 = NEURO frontend, 5174 = SARA kiosk, 5175 = SARA mobile, 5176 = this.
    port: 5176,
    proxy: {
      '/api': { target: BRAIN, changeOrigin: true },
    },
  },
});
