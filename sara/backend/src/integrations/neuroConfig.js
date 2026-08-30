// Where NEURO is, and how SARA authenticates to it — the ONE place that decides.
//
// NEURO is the canonical brain. SARA is a manifestation layer: it reads from NEURO
// and hands writes back to NEURO. That makes the NEURO connection a hard dependency,
// and a hard dependency must be EXPLICIT. It used to be implicit: neuroSnapshot.js
// and neuroChat.js each carried their own copy of `https://nuero.nickward.co.uk` as a
// default, so an unconfigured SARA silently reached a public host over the open
// internet and looked configured while doing it. There is no default any more — an
// unset NEURO_BASE_URL is reported as not-configured, loudly, at startup and on
// /api/health.
//
// Nothing here logs or returns a PIN or a token. `readiness()` is the non-sensitive
// view: it says WHETHER a credential is set and where it came from, never what it is.
//
// CommonJS only — matches the NEURO backend convention (no ESM).

let overridePin = null;

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * The NEURO base URL. No default: an unconfigured SARA must say so rather than
 * guess at a remote host.
 * @returns {string} the configured base URL, or '' when unset.
 */
function getBaseUrl(env = process.env) {
  return trimSlash(env.NEURO_BASE_URL);
}

function getPin(env = process.env) {
  return overridePin || String(env.NEURO_PIN || '').trim();
}

/**
 * The machine-client credential. NEURO accepts `X-NEURO-API-TOKEN` in place of the
 * PIN; SARA is a machine client, so this is the better credential where one is
 * issued. The PIN stays supported because the kiosk can be given one at runtime.
 */
function getApiToken(env = process.env) {
  return String(env.NEURO_API_TOKEN || '').trim();
}

function setPin(pin) {
  overridePin = String(pin || '').trim() || null;
}

function clearPin() {
  overridePin = null;
}

function hasOverride() {
  return Boolean(overridePin);
}

/** Where the credential came from — for display, never the credential itself. */
function pinSource(env = process.env) {
  if (overridePin) return 'session';
  if (String(env.NEURO_PIN || '').trim()) return 'env';
  return 'none';
}

/**
 * Auth headers for an upstream NEURO call. API token first (SARA is a machine
 * client), PIN second. Returns {} when nothing is configured — the caller is
 * expected to have checked `readiness()` and refused rather than firing blind.
 */
function authHeaders(env = process.env) {
  const token = getApiToken(env);
  if (token) return { 'x-neuro-api-token': token };
  const pin = getPin(env);
  if (pin) return { 'x-neuro-pin': pin };
  return {};
}

/**
 * Demo mode — the ONLY route by which seeded, invented content may reach a screen.
 * It must be asked for explicitly, and it is refused outright under NODE_ENV=production
 * so a stray env var on the Pi cannot dress fiction up as Nick's day.
 */
function isDemoMode(env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') return false;
  return String(env.SARA_DEMO_MODE || '').toLowerCase() === 'true';
}

/**
 * Non-sensitive readiness. Says what is configured and what is missing, and never
 * carries a credential. This is what /api/health and the UI status indicator read.
 */
function readiness(env = process.env) {
  const baseUrl = getBaseUrl(env);
  const hasCredential = Boolean(getApiToken(env) || getPin(env));
  const problems = [];
  if (!baseUrl) problems.push('NEURO_BASE_URL is not set — SARA does not know where NEURO is.');
  if (!hasCredential) problems.push('Neither NEURO_API_TOKEN nor NEURO_PIN is set — NEURO will refuse SARA.');

  return {
    baseUrl: baseUrl || null,
    baseUrlConfigured: Boolean(baseUrl),
    credentialConfigured: hasCredential,
    credentialKind: getApiToken(env) ? 'api-token' : getPin(env) ? 'pin' : 'none',
    pinSource: pinSource(env),
    demoMode: isDemoMode(env),
    ready: problems.length === 0,
    problems,
  };
}

/**
 * Startup validation. Never throws — SARA staying up and saying it cannot reach the
 * brain is strictly better than SARA refusing to boot, because the kiosk is also how
 * a PIN gets entered. It logs the reason so the failure is visible in `pm2 logs`.
 */
function logStartupValidation(env = process.env, log = console) {
  const r = readiness(env);
  if (r.demoMode) {
    log.warn('[SARA NEURO] DEMO MODE — screens may show seeded, invented content. Never enable this in production.');
  }
  if (r.ready) {
    log.log(`[SARA NEURO] configured — ${r.baseUrl} (auth: ${r.credentialKind}).`);
  } else {
    for (const p of r.problems) log.error(`[SARA NEURO] NOT CONFIGURED — ${p}`);
    log.error('[SARA NEURO] SARA will report NEURO as unavailable and will refuse to accept captures.');
  }
  return r;
}

module.exports = {
  getBaseUrl,
  getPin,
  getApiToken,
  setPin,
  clearPin,
  hasOverride,
  pinSource,
  authHeaders,
  isDemoMode,
  readiness,
  logStartupValidation,
  trimSlash,
};
