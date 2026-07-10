// NEURO snapshot bridge — bounded read-only seam into the real NUERO backend.
//
// Purpose:
// - Replace SARA's seeded placeholder domains/presentation with real data where a
//   matching NEURO endpoint already exists.
// - Keep the SARA State Engine as the sole producer of the shared model.
// - Stay honest when the upstream is absent, unauthenticated, or partially failing.
//
// This module does NO decision-making and owns NO shared state. It only polls a
// bounded set of NEURO endpoints, caches the latest successful payloads, and exposes
// the snapshot synchronously for the State Engine to fold in.

const NEURO_SOURCE = 'neuro';
const DEFAULT_BASE_URL = 'https://nuero.nickward.co.uk';
const neuroConfig = require('./neuroConfig');

const ENDPOINTS = {
  focus: '/api/focus',
  todos: '/api/todos',
  context: '/api/context',
  team: '/api/team-health?severity=all',
  capture: '/api/capture/recent',
  email: '/api/email/triage',
};

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function config(env = process.env) {
  return {
    baseUrl: trimSlash(env.NEURO_BASE_URL || DEFAULT_BASE_URL),
    pin: neuroConfig.getPin(env),
    pollMs: Number(env.SARA_NEURO_POLL_MS) || 30000,
    timeoutMs: Number(env.SARA_NEURO_TIMEOUT_MS) || 5000,
  };
}

function isConfigured(cfg = config()) {
  return Boolean(cfg.baseUrl);
}

function unavailable(reason, detail) {
  return {
    source: NEURO_SOURCE,
    available: false,
    reason,
    detail: detail || null,
    polledAt: null,
    data: {
      queue: null,
      focus: null,
      todos: null,
      context: null,
      team: null,
      capture: null,
      email: null,
    },
    errors: {},
  };
}

let snapshot = unavailable(isConfigured() ? 'awaiting-first-poll' : 'not-configured');

function getSnapshot() {
  return snapshot;
}

function buildUrl(baseUrl, path) {
  return new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`).toString();
}

async function fetchJson(cfg, path) {
  const headers = { Accept: 'application/json' };
  if (cfg.pin) headers['x-neuro-pin'] = cfg.pin;
  const res = await fetch(buildUrl(cfg.baseUrl, path), {
    headers,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

async function refresh() {
  const cfg = config();
  if (!isConfigured(cfg)) {
    snapshot = unavailable('not-configured', 'NEURO_BASE_URL is not configured.');
    return snapshot;
  }

  const entries = Object.entries(ENDPOINTS);
  const data = {
    queue: null,
    focus: null,
    todos: null,
    context: null,
    team: null,
    capture: null,
    email: null,
  };
  const errors = {};

  await Promise.all(
    entries.map(async ([key, path]) => {
      try {
        data[key] = await fetchJson(cfg, path);
      } catch (error) {
        errors[key] = error.message;
      }
    })
  );

  const successes = Object.values(data).filter(Boolean).length;
  if (!successes) {
    snapshot = unavailable('unreachable', Object.values(errors)[0] || `No NEURO endpoint could be read from ${cfg.baseUrl}`);
    snapshot.errors = errors;
    return snapshot;
  }

  snapshot = {
    source: NEURO_SOURCE,
    available: true,
    reason: successes < entries.length ? 'partial' : null,
    detail: successes < entries.length ? `${entries.length - successes} endpoint(s) unavailable.` : null,
    polledAt: new Date().toISOString(),
    data,
    errors,
  };
  return snapshot;
}

let timer = null;

function start() {
  if (timer) return true;
  const cfg = config();
  if (!isConfigured(cfg)) {
    console.log('[SARA NEURO] snapshot bridge idle — not configured.');
    return false;
  }
  refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), cfg.pollMs);
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
}

module.exports = {
  NEURO_SOURCE,
  ENDPOINTS,
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
