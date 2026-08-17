require('dotenv').config();

// Prevent EPIPE errors from crashing the process
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    console.error(`[Server] Ignored ${err.code}:`, err.message);
    return;
  }
  console.error('[Server] Uncaught exception:', err);
  process.exit(1);
});

const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./db/database');
const scheduler = require('./services/scheduler');

const chatRoutes = require('./routes/chat');
const ttsRoutes = require('./routes/tts');
const obsidianRoutes = require('./routes/obsidian');
const standupRoutes = require('./routes/standup');
const nudgeRoutes = require('./routes/nudges');
const todoRoutes = require('./routes/todos');
const doNextRoutes = require('./routes/do-next');
const microsoftRoutes = require('./routes/microsoft');
const n8nRoutes = require('./routes/n8n');
const vaultRoutes = require('./routes/vault');
const vaultHygieneRoutes = require('./routes/vault-hygiene');
const contextRoutes = require('./routes/context');
const qaRoutes = require('./routes/qa');
const pushRoutes = require('./routes/push');
const importsRoutes = require('./routes/imports');
const captureRoutes = require('./routes/capture');
const featureRoutes = require('./routes/features');
const journalRoutes = require('./routes/journal');
const stravaRoutes = require('./routes/strava');
const healthRoutes = require('./routes/health');
const appleHealthRoutes = require('./routes/apple-health');
const locationRoutes = require('./routes/location');
const jiraRoutes = require('./routes/jira');
const queueRoutes = require('./routes/queue');
const escalationRoutes = require('./routes/escalation');
const focusRoutes = require('./routes/focus');
const timeRoutes = require('./routes/time');
const briefingRoutes = require('./routes/briefing');
const actionsRoutes = require('./routes/actions');
const haRoutes = require('./routes/ha');
const plaudRoutes = require('./routes/plaud');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// App-level auth — PIN required for all API access, OR NEURO_API_TOKEN for
// machine-to-machine callers (n8n, scheduled jobs). Set NEURO_PIN / NEURO_API_TOKEN
// in .env. If neither is set, auth is disabled (dev mode).
app.use('/api', (req, res, next) => {
  const expectedPin = process.env.NEURO_PIN;
  const expectedApiToken = process.env.NEURO_API_TOKEN;
  if (!expectedPin && !expectedApiToken) return next(); // no auth configured = open access

  // Allow auth check endpoint without PIN
  if (req.path === '/auth/check' || req.path === '/auth/login') return next();

  // Allow push subscription endpoint (service worker can't send custom headers)
  if (req.path.startsWith('/push/')) return next();

  // Allow SSE streams (nudges/stream) — they use EventSource which can't set headers
  if (req.path === '/nudges/stream') return next();

  // Allow Strava OAuth flow (browser redirects can't send PIN header)
  if (req.path === '/strava/auth' || req.path === '/strava/callback') return next();

  // Allow the FreeReps iOS app's wire API (#40). Same reason as the exemptions
  // above — the client cannot send a header. This one is not a limitation of the
  // browser but of the app: its config model has no credential field at all, so
  // there is nothing to send. The routes enforce their own guard (tailnet source
  // only) and can write to exactly one table. See routes/apple-health.js.
  if (req.path.startsWith('/v1/')) return next();

  const providedPin = req.headers['x-neuro-pin'] || req.query.pin;
  const providedApiToken = req.headers['x-neuro-api-token'] || req.query.api_token;

  if (expectedApiToken && providedApiToken && providedApiToken === expectedApiToken) {
    // Machine client authenticated — tag the request so routes can enforce
    // API-only mode or audit which caller wrote.
    req.apiClient = 'n8n';
    return next();
  }

  if (expectedPin && providedPin && providedPin === expectedPin) {
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
});

// Helper for routes that should ONLY be callable by machine clients
// (rejects interactive/PIN auth). Use: router.post('/x', requireApiClient, handler).
app.locals.requireApiClient = (req, res, next) => {
  if (!req.apiClient) {
    return res.status(403).json({ ok: false, error: 'API token required' });
  }
  next();
};

// Auth endpoints (outside PIN middleware)
app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  const expected = process.env.NEURO_PIN;
  if (!expected) return res.json({ ok: true }); // no PIN = always ok
  if (pin === expected) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Wrong PIN' });
});

app.get('/api/auth/check', (req, res) => {
  const expected = process.env.NEURO_PIN;
  if (!expected) return res.json({ required: false });
  const provided = req.headers['x-neuro-pin'] || req.query.pin;
  res.json({ required: true, authenticated: provided === expected });
});

// API routes
app.use('/api/chat', chatRoutes);
app.use('/api/tts', ttsRoutes);
app.use('/api/obsidian', obsidianRoutes);
app.use('/api/standup', standupRoutes);
app.use('/api/nudges', nudgeRoutes);
app.use('/api/todos', todoRoutes);
app.use('/api/do-next', doNextRoutes);
app.use('/api/microsoft', microsoftRoutes);
app.use('/api/n8n', n8nRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/vault-hygiene', vaultHygieneRoutes);
app.use('/api/context', contextRoutes);
app.use('/api/qa', qaRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/imports', importsRoutes);
app.use('/api/capture', captureRoutes);
app.use('/api/features', featureRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/strava', stravaRoutes);
app.use('/api/health', healthRoutes);
// Mounted at /api/v1 because the iOS app hard-codes that path — see
// routes/apple-health.js. Exempt from the PIN middleware above, guarded by
// source address instead.
app.use('/api/v1', appleHealthRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/escalation', escalationRoutes);
app.use('/api/focus', focusRoutes);
app.use('/api/session', require('./routes/focus-session'));
app.use('/api/time', timeRoutes);
app.use('/api/briefing', briefingRoutes);
app.use('/api/actions', actionsRoutes);
app.use('/api/ha', haRoutes);
app.use('/api/plaud', plaudRoutes);
app.use('/api/ai/settings', require('./routes/ai-settings'));
app.use('/api/meeting-prep', require('./routes/meeting-prep-view'));
app.use('/api/person', require('./routes/person-detail'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/1to1', require('./routes/one-to-one'));
app.use('/api/vault-actions', require('./routes/vault-actions'));
app.use('/api/development-plan', require('./routes/development-plan'));
app.use('/api/training', require('./routes/training-sync'));
app.use('/api/nova-signals', require('./routes/nova-signals'));
app.use('/api/team-health', require('./routes/team-health'));
app.use('/api/person-profile', require('./routes/person-profile'));
app.use('/api/people-gap', require('./routes/people-gap'));
app.use('/api/evidence', require('./routes/evidence-register'));
app.use('/api/checkpoint', require('./routes/checkpoint'));
app.use('/api/weekly-summary', require('./routes/weekly-summary'));
app.use('/api/knowledge-gaps', require('./routes/knowledge-gaps'));
app.use('/api/knowledge-memory', require('./routes/knowledge-memory'));
app.use('/api/kb-article', require('./routes/kb-article'));
app.use('/api/email', require('./routes/email-triage'));
app.use('/api/pi-health', require('./routes/pi-health'));
app.use('/api/state-of-play', require('./routes/state-of-play'));
app.use('/api/weekly-risk', require('./routes/weekly-risk'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/adhd', require('./routes/adhd'));
app.use('/api/standup-session', require('./routes/standup-session'));
app.use('/api/outcomes', require('./routes/outcomes'));
app.use('/api/waiting-on', require('./routes/waiting-on'));

// Health / status endpoint
app.get('/api/status', async (req, res) => {
  const jiraService = require('./services/jira');
  const obsidianService = require('./services/obsidian');
  const microsoftService = require('./services/microsoft');
  const aiRouting = require('./services/ai-routing');

  const n8nService = require('./services/n8n');
  const msConfigured = microsoftService.isConfigured();
  const msAuthenticated = msConfigured ? await microsoftService.isAuthenticated() : false;
  const ollamaReachable = await aiRouting.checkOllama();

  res.json({
    agent: 'NUERO',
    version: '1.0.0',
    uptime: process.uptime(),
    jira: {
      configured: jiraService.isConfigured(),
      status: db.getState('jira_status') || 'unknown',
      last_sync: db.getState('jira_last_sync'),
      last_error: db.getState('jira_last_error')
    },
    ai: aiRouting.getStatus(),
    ollamaReachable,
    obsidian: {
      configured: obsidianService.isConfigured()
    },
    microsoft: {
      configured: msConfigured,
      authenticated: msAuthenticated,
      bridge: microsoftService.isBridgeConfigured(),
      source: msAuthenticated ? 'msal' : microsoftService.isBridgeConfigured() ? 'nova-bridge' : 'none'
    },
    n8n: {
      configured: n8nService.isConfigured()
    },
    plaud: require('./services/plaud-sync').getStatus(),
    push: {
      configured: require('./services/webpush').isConfigured(),
      subscriptions: db.getAllPushSubscriptions().length
    },
    strava: {
      configured: require('./services/strava').isConfigured(),
      authenticated: require('./services/strava').isAuthenticated()
    },
    health: {
      hasToday: (() => {
        try {
          return require('./services/health').getTodayData() !== null;
        } catch { return false; }
      })(),
      latestDate: (() => {
        try {
          const raw = require('./db/database').getState('health_latest');
          return raw ? JSON.parse(raw).date : null;
        } catch { return null; }
      })()
    },
    location: {
      configured: require('./services/location').isConfigured(),
      recorderUrl: process.env.OWNTRACKS_RECORDER_URL || null
    },
    homeAssistant: {
      configured: require('./services/ha').isConfigured(),
      url: process.env.HA_URL || null
    },
    vaultSync: {
      enabled: true,
      mode: "syncthing",
      note: "Managed externally via Syncthing over Tailscale"
    }
  });
});

// Serve frontend static files (production — built frontend alongside backend)
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
// Hashed assets (js/css) — long cache. Everything else — no cache.
app.use('/assets', express.static(path.join(frontendDist, 'assets'), { maxAge: '1y', immutable: true }));
app.use(express.static(frontendDist, { maxAge: 0, etag: false }));
// SPA fallback — any non-API route serves index.html with no-cache
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// Initialize database then start
async function start() {
  await db.init();
  db.setState('imports_sweep_running', 'false');

  // Lift waiting-on out of the KV blob into its table. No-ops once done, and
  // leaves the KV copy in place as the rollback path.
  try { require('./services/waiting-on').migrateFromState(); }
  catch (e) { console.warn('[waiting-on] migration skipped:', e.message); }

  // Bootstrap admin-panel AI settings from DB into process.env
  require('./routes/ai-settings').bootstrap();

  // Seed Strava tokens from env if not already in DB
  require('./services/strava').seedTokensFromEnv();

  const webpushService = require('./services/webpush');
  webpushService.init();

  const inboxScanner = require('./services/inbox-scanner');
  inboxScanner.start();

  scheduler.start();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] NUERO running on 0.0.0.0:${PORT}`);
  });
}

start().catch(err => {
  console.error('[Server] Fatal:', err);
  process.exit(1);
});
