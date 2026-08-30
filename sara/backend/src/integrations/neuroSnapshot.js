// NEURO snapshot bridge — bounded read-only seam into the canonical NEURO backend.
//
// Purpose:
// - Feed the SARA State Engine with REAL data from NEURO where a matching endpoint exists.
// - Keep the SARA State Engine as the sole producer of the shared model.
// - Stay honest when the upstream is absent, unauthenticated, or partially failing.
//
// This module does NO decision-making and owns NO shared state. It polls a bounded set
// of NEURO endpoints, caches the latest successful payloads, and exposes the snapshot
// synchronously for the State Engine to fold in.
//
// ⚠ Freshness is a FIRST-CLASS fact here, not a detail. A poll that fails does not
// throw the last good payload away — data Nick saw thirty seconds ago is still worth
// showing — but it is marked `state: 'stale'` and carries the age and the reason, so a
// screen can say "this is from four minutes ago, NEURO is not answering" instead of
// either lying about it or blanking. The four states a consumer must keep apart are
// `live`, `stale`, `unavailable` and `not-configured`; each licenses different words.
//
// CommonJS only — matches the NEURO backend convention (no ESM).

const NEURO_SOURCE = 'neuro';
const neuroConfig = require('./neuroConfig');

// How old a cached payload may be before it stops being worth showing at all. Beyond
// this it degrades from `stale` to `unavailable`: an hour-old queue read presented as
// the current state is worse than an honest blank.
const MAX_STALE_MS = 15 * 60 * 1000;

// The bounded read set. `optional: true` means a failure here does NOT count against
// reach — the endpoint is known not to exist on every NEURO, so counting it would
// pin the snapshot at "partial" for ever and make that word meaningless.
//
// ⚠ `queue` is one of those: NEURO DELETED its Jira queue feature (commit 48e6481,
// and the readers were finally removed on 27 Aug 2026), so /api/queue/summary is gone.
// It is still asked for, because a future NEURO may serve it again and the SARA queue
// domain degrades honestly without it — but its absence is normal, not a fault.
const ENDPOINTS = {
  queue: { path: '/api/queue/summary', optional: true },
  focus: { path: '/api/focus' },
  todos: { path: '/api/todos' },
  context: { path: '/api/context' },
  team: { path: '/api/team-health?severity=all' },
  capture: { path: '/api/capture/recent' },
  email: { path: '/api/email/triage' },
};

const DATA_KEYS = Object.keys(ENDPOINTS);

function emptyData() {
  return DATA_KEYS.reduce((acc, key) => ({ ...acc, [key]: null }), {});
}

function config(env = process.env) {
  return {
    baseUrl: neuroConfig.getBaseUrl(env),
    pollMs: Number(env.SARA_NEURO_POLL_MS) || 30000,
    timeoutMs: Number(env.SARA_NEURO_TIMEOUT_MS) || 5000,
  };
}

function isConfigured(env = process.env) {
  return neuroConfig.readiness(env).ready;
}

/**
 * A snapshot carrying no usable data. `state` says WHY, because "we have never been
 * told where NEURO is" and "NEURO is not answering" are different problems with
 * different fixes and must never render as the same sentence.
 */
function unavailable(reason, detail) {
  return {
    source: NEURO_SOURCE,
    state: reason === 'not-configured' ? 'not-configured' : 'unavailable',
    available: false,
    stale: false,
    reason,
    detail: detail || null,
    polledAt: null,
    ageMs: null,
    lastAttemptAt: null,
    data: emptyData(),
    errors: {},
  };
}

let snapshot = unavailable(isConfigured() ? 'awaiting-first-poll' : 'not-configured');
// The last poll that actually returned something. Kept separately from `snapshot` so a
// failed refresh can degrade to stale rather than to blank.
let lastGood = null;

function withAge(snap, now = Date.now()) {
  if (!snap || !snap.polledAt) return snap;
  return { ...snap, ageMs: now - Date.parse(snap.polledAt) };
}

function getSnapshot() {
  return withAge(snapshot);
}

function buildUrl(baseUrl, path) {
  return new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`).toString();
}

async function fetchJson(cfg, path, env) {
  const headers = { Accept: 'application/json', ...neuroConfig.authHeaders(env) };
  const res = await fetch(buildUrl(cfg.baseUrl, path), {
    headers,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

/**
 * Degrade to the last good payload rather than to nothing — but only while it is
 * young enough to still describe the present.
 */
function degradeToStale(reason, detail, errors, now = Date.now()) {
  if (!lastGood) return null;
  const ageMs = now - Date.parse(lastGood.polledAt);
  if (!Number.isFinite(ageMs) || ageMs > MAX_STALE_MS) return null;
  return {
    ...lastGood,
    state: 'stale',
    available: true,
    stale: true,
    reason,
    detail,
    ageMs,
    lastAttemptAt: new Date(now).toISOString(),
    errors,
  };
}

async function refresh(options = {}) {
  const env = options.env || process.env;
  const cfg = config(env);
  const readiness = neuroConfig.readiness(env);
  const attemptedAt = new Date().toISOString();

  if (!readiness.ready) {
    // Not knowing where NEURO is is not an outage, and stale data must not paper
    // over it — the configuration is gone, so the data has no provenance any more.
    lastGood = null;
    snapshot = unavailable('not-configured', readiness.problems.join(' '));
    snapshot.lastAttemptAt = attemptedAt;
    return snapshot;
  }

  const data = emptyData();
  const errors = {};

  await Promise.all(
    Object.entries(ENDPOINTS).map(async ([key, spec]) => {
      try {
        data[key] = await fetchJson(cfg, spec.path, env);
      } catch (error) {
        errors[key] = error.message;
      }
    })
  );

  const successes = Object.values(data).filter(Boolean).length;
  if (!successes) {
    const detail = Object.values(errors)[0] || `No NEURO endpoint could be read from ${cfg.baseUrl}`;
    const stale = degradeToStale('unreachable', detail, errors);
    if (stale) {
      snapshot = stale;
      return snapshot;
    }
    snapshot = unavailable('unreachable', detail);
    snapshot.errors = errors;
    snapshot.lastAttemptAt = attemptedAt;
    return snapshot;
  }

  // Only the required endpoints count towards reach — see ENDPOINTS above.
  const requiredKeys = DATA_KEYS.filter((key) => !ENDPOINTS[key].optional);
  const missingRequired = requiredKeys.filter((key) => !data[key]);

  snapshot = {
    source: NEURO_SOURCE,
    state: 'live',
    available: true,
    stale: false,
    reason: missingRequired.length ? 'partial' : null,
    detail: missingRequired.length ? `${missingRequired.length} endpoint(s) unavailable: ${missingRequired.join(', ')}.` : null,
    polledAt: attemptedAt,
    ageMs: 0,
    lastAttemptAt: attemptedAt,
    data,
    errors,
  };
  lastGood = snapshot;
  return snapshot;
}

let timer = null;

function start(options = {}) {
  if (timer) return true;
  const env = options.env || process.env;
  const cfg = config(env);
  if (!isConfigured(env)) {
    console.log('[SARA NEURO] snapshot bridge idle — NEURO connection is not configured.');
    return false;
  }
  refresh(options).catch(() => {});
  timer = setInterval(() => refresh(options).catch(() => {}), cfg.pollMs);
  if (timer.unref) timer.unref();
  console.log(`[SARA NEURO] snapshot polling every ${cfg.pollMs}ms against ${cfg.baseUrl}`);
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function _setSnapshotForTest(next) {
  snapshot = next || unavailable('not-configured');
  lastGood = next && next.available && !next.stale ? next : null;
}

module.exports = {
  NEURO_SOURCE,
  ENDPOINTS,
  MAX_STALE_MS,
  config,
  isConfigured,
  getSnapshot,
  refresh,
  start,
  stop,
  unavailable,
  buildUrl,
  _setSnapshotForTest,
};
