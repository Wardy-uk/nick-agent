// SARA runtime backend — WS0-WP1 foundation.
//
// Responsibilities in WS0 (deliberately small):
//   1. Boot cleanly under PM2 on the Pi 5.
//   2. Expose the shared state model over /api (the defined runtime path).
//   3. In production, serve the built frontend so the whole runtime is one
//      process on one port (clean for PM2 + "one SARA").
//
// CommonJS only — matches the NEURO backend convention (no ESM).

const path = require('path');
const fs = require('fs');
const express = require('express');

// Minimal .env loader (no dependency) — loads sara/backend/.env into process.env so the
// NEURO connection (NEURO_BASE_URL / NEURO_PIN / NEURO_VAULT_KEY) survives restarts. The .env
// is gitignored; secrets never enter the repo.
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* keep defaults */ }
})();

const healthRoute = require('./src/routes/health');
const stateRoute = require('./src/routes/state');
const chatRoute = require('./src/routes/chat');
const focusRoute = require('./src/routes/focus');
const actionsRoute = require('./src/routes/actions');
const emailRoute = require('./src/routes/email');
const jiraRoute = require('./src/routes/jira');
const neuroAuthRoute = require('./src/routes/neuroAuth');
const telemetryRoute = require('./src/routes/telemetry');
const inferenceRoute = require('./src/routes/inference');
const kioskRoute = require('./src/routes/kiosk');
const presenceRoute = require('./src/routes/presence');
const locationRoute = require('./src/routes/location');
const cognitionGraphRoute = require('./src/routes/cognitionGraph');
const captureRoute = require('./src/routes/capture');
const attentionRoute = require('./src/routes/attention');
const { RUNTIME_LABEL } = require('./src/state/stateEngine');
const ha = require('./src/telemetry/homeAssistant');
const neuro = require('./src/integrations/neuroSnapshot');
const neuroConfig = require('./src/integrations/neuroConfig');
const nova = require('./src/integrations/novaSnapshot');
const vaultGraph = require('./src/integrations/vaultGraph');

const app = express();
const PORT = process.env.SARA_PORT || 3005;

app.use(express.json());

// --- API (the defined frontend <-> backend runtime path) ---
app.use('/api/health', healthRoute);
app.use('/api/state', stateRoute);
app.use('/api/chat', chatRoute);
app.use('/api/focus', focusRoute);
app.use('/api/actions', actionsRoute);
app.use('/api/email', emailRoute);
app.use('/api/jira', jiraRoute);
app.use('/api/neuro-auth', neuroAuthRoute);
app.use('/api/telemetry', telemetryRoute);
app.use('/api/inference', inferenceRoute);
app.use('/api/kiosk', kioskRoute);
app.use('/api/presence', presenceRoute);
app.use('/api/location', locationRoute);
app.use('/api/cognition/graph', cognitionGraphRoute);
// The capture bridge. SARA's frontend has always POSTed here; nothing was mounted, so
// every capture made at the kiosk 404'd. It forwards to NEURO's canonical capture
// routes and stores nothing of its own — see src/integrations/neuroCapture.js.
app.use('/api/capture', captureRoute);
// Gate 2 — a read-only passthrough to NEURO's attention feed. It stores nothing
// and ranks nothing; NEURO owns the attention decision (docs/attention-contract.md).
app.use('/api/attention', attentionRoute);

// --- Static frontend (production) ---
// Vite builds to ../frontend/dist. If it exists, serve it with SPA fallback so
// the runtime is a single process. In dev the Vite server handles the frontend
// and proxies /api here instead (see frontend/vite.config.js).
const distDir = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('text').send(
      `SARA backend (${RUNTIME_LABEL}) is up on port ${PORT}.\n` +
        `Frontend build not found at ${distDir}.\n` +
        `Run the frontend dev server, or build it for production.\n` +
        `API: GET /api/health , GET /api/state , GET /api/chat , GET /api/focus , GET /api/neuro-auth , GET /api/telemetry , GET /api/inference\n`
    );
  });
}

app.listen(PORT, () => {
  console.log(`[SARA ${RUNTIME_LABEL}] backend listening on http://0.0.0.0:${PORT}`);
  // Validate the NEURO dependency FIRST and say so out loud. SARA is a manifestation
  // layer over NEURO: an unconfigured connection is not a detail, it is the whole
  // runtime being unable to do its job. It never exits on failure — the kiosk is also
  // where a PIN gets entered, so a SARA that refuses to boot cannot be repaired from
  // the device in front of you.
  neuroConfig.logStartupValidation();
  // Start the Home Assistant telemetry poller. No-op (and logs why) when HA is not
  // configured — the runtime stays up and screens fall back honestly.
  ha.start();
  // Start the bounded NEURO snapshot poller. It feeds real queue/focus/todo/context
  // data into the shared model when the upstream is reachable, and falls back
  // honestly when it is not.
  neuro.start();
  // Start the bounded NOVA snapshot poller. Feeds approvals/overdue/exception signals
  // into model.nova for the "At Work" view. Idle (and logs why) until NOVA_BASE_URL is
  // set, so the runtime stays up and the view falls back honestly.
  nova.start();
  // Start the bounded vault cognition-graph poller — real backlinks/related + knowledge gaps
  // for the Cognitive Convergence Graph. Idle/honest when NEURO is unreachable.
  vaultGraph.start();
});
