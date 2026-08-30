// NEURO chat bridge — bounded transport seam into the existing NEURO backend.
//
// WS gap-bridge slice:
// - Keep SARA's runtime and shared-state work intact.
// - Reuse the existing NEURO backend for conversation instead of inventing a second AI.
// - Stay honest when the upstream is not configured or unavailable.
//
// CommonJS only — matches the NEURO backend convention (no ESM).

const DEFAULT_CHAT_PATH = '/api/chat';
const DEFAULT_NUDGE_PATH = '/api/nudges/stream';
const neuroConfig = require('./neuroConfig');

function getConfig(env = process.env) {
  return {
    // No default base URL. See neuroConfig — an implicit remote dependency is how
    // an unconfigured SARA came to be silently talking to a public host.
    baseUrl: neuroConfig.getBaseUrl(env),
    pin: neuroConfig.getPin(env),
    chatPath: env.NEURO_CHAT_PATH || DEFAULT_CHAT_PATH,
    nudgesPath: env.NEURO_NUDGES_PATH || DEFAULT_NUDGE_PATH,
  };
}

function getAvailability(env = process.env) {
  const cfg = getConfig(env);
  const readiness = neuroConfig.readiness(env);
  if (!readiness.ready) {
    return {
      available: false,
      reason: 'not-configured',
      detail: readiness.problems.join(' '),
      config: cfg,
    };
  }
  return {
    available: true,
    reason: null,
    detail: null,
    config: cfg,
  };
}

function buildUrl(baseUrl, path) {
  return new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`).toString();
}

async function proxyChat(body, options = {}) {
  const availability = getAvailability(options.env);
  if (!availability.available) {
    const err = new Error(availability.detail);
    err.code = availability.reason;
    err.availability = availability;
    throw err;
  }

  const { config } = availability;
  return fetch(buildUrl(config.baseUrl, config.chatPath), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      ...neuroConfig.authHeaders(options.env || process.env),
    },
    body: JSON.stringify(body || {}),
    signal: options.signal,
  });
}

module.exports = {
  DEFAULT_CHAT_PATH,
  DEFAULT_NUDGE_PATH,
  buildUrl,
  getAvailability,
  getConfig,
  proxyChat,
};
