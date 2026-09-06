'use strict';

/**
 * apns — the device-token registry for the native iOS apps.
 *
 * ⚠ THIS IS THE REGISTRY HALF ONLY. There is no sender here, and that is a
 * deliberate stopping point rather than an unfinished one: sending needs an
 * APNs signing key, which needs a paid Apple Developer account Nick does not
 * have. Registering from day one means the moment the account exists the only
 * missing piece is the key — and, crucially, it means NOTHING IN NEURO CLAIMS A
 * NOTIFICATION WAS DELIVERED in the meantime. `webpush.sendToAll` already
 * records `undeliverable` rather than staying silent when it cannot deliver;
 * this follows the same rule by not pretending to be a transport at all.
 *
 * ⚠ When the sender is written it must go BEHIND the existing gates in
 * `services/webpush.js`, not beside them. Quiet hours, the hourly cap, the
 * content fingerprint that stops a countdown re-notifying, the attention
 * lifecycle and the delivery log are all transport-agnostic and were paid for
 * in real bugs. A second delivery path that skips them would reintroduce every
 * one — the "in 25 min" / "in 10 min" duplicate being the obvious first.
 *
 * Validation is pure so the wire contract pins without a database.
 */

/** Which app a token belongs to. A closed set — see the `mobile-sync` rule. */
const APPS = new Set(['neuro', 'sara']);

/** APNs gateways. A token is only valid against the one that minted it. */
const ENVIRONMENTS = new Set(['development', 'production']);

/**
 * ⚠ An APNs token is 64 hex characters (32 bytes) TODAY, but Apple has said it
 * may grow, so the check is a range rather than an equality. Rejecting a longer
 * token would break the app on a future iOS with no obvious cause; accepting
 * arbitrary junk would fill the table with strings that can never be sent to.
 */
const TOKEN_RE = /^[0-9a-f]{64,200}$/i;

/**
 * Validate a registration. PURE.
 *
 * Returns `{ ok: true, registration }` or `{ ok: false, reason }`. The reason
 * goes back to the device verbatim: a rejection the app cannot explain is a
 * phone that silently never receives anything.
 */
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'body must be an object' };
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return { ok: false, reason: 'token is required' };
  if (!TOKEN_RE.test(token)) {
    return { ok: false, reason: 'token must be hex, 64 characters or more' };
  }

  const app = typeof body.app === 'string' ? body.app.trim().toLowerCase() : 'neuro';
  if (!APPS.has(app)) {
    return { ok: false, reason: `app must be one of ${[...APPS].join(', ')}` };
  }

  const environment = typeof body.environment === 'string'
    ? body.environment.trim().toLowerCase()
    : 'development';
  if (!ENVIRONMENTS.has(environment)) {
    return { ok: false, reason: `environment must be one of ${[...ENVIRONMENTS].join(', ')}` };
  }

  const deviceId = typeof body.deviceId === 'string' && body.deviceId.trim()
    ? body.deviceId.trim().slice(0, 200)
    : null;
  const bundleId = typeof body.bundleId === 'string' && body.bundleId.trim()
    ? body.bundleId.trim().slice(0, 200)
    : null;

  return {
    ok: true,
    registration: { token: token.toLowerCase(), app, environment, deviceId, bundleId },
  };
}

/**
 * Record a token.
 *
 * ⚠ Re-registering the SAME token is a heartbeat, not a new device — the app
 * registers on every launch, so an insert-only path would either fail or
 * duplicate. `last_seen_at` moves and any previous failure is CLEARED: a token
 * that failed last week and is being presented again by a live app is working
 * now, and leaving it marked dead would keep it excluded for ever.
 */
function register(reg) {
  const db = require('../db/database');
  return db.saveApnsToken(reg);
}

/**
 * What is registered, without leaking a sendable credential.
 *
 * ⚠ A device token is not quite a secret, but it is the address of a push that
 * bypasses the lock screen, and this endpoint sits behind the PIN on a
 * personal server. Truncated for the same reason `routes/push.js` truncates a
 * Web Push endpoint in its diagnostic: enough to tell two devices apart, not
 * enough to send to.
 */
function list() {
  const db = require('../db/database');
  return db.getApnsTokens().map((row) => ({
    tokenPrefix: `${String(row.token).slice(0, 8)}…`,
    app: row.app,
    environment: row.environment,
    deviceId: row.device_id,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
    lastFailedAt: row.last_failed_at,
    failureReason: row.failure_reason,
  }));
}

/**
 * Readiness, said honestly.
 *
 * ⚠ Reports that sending is NOT configured, rather than staying quiet about it.
 * "NEURO has nothing to say" and "NEURO cannot say anything" are different
 * facts, and a push layer that is silently incapable is the worst version of
 * the false all-clear this codebase keeps guarding against.
 */
function status() {
  let tokens = [];
  let readable = true;
  let why = null;
  try {
    tokens = list();
  } catch (e) {
    readable = false;
    why = e.message;
  }

  const keyConfigured = !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_KEY_PATH);

  return {
    registered: readable ? tokens.length : null,
    readable,
    why,
    // The sender does not exist yet; this says so rather than implying a
    // capability that is not there.
    senderImplemented: false,
    keyConfigured,
    canDeliver: false,
    blockedBy: keyConfigured
      ? 'the APNs sender is not implemented yet'
      : 'no APNs key configured (needs a paid Apple Developer account)',
    tokens: readable ? tokens : [],
  };
}

module.exports = {
  APPS,
  ENVIRONMENTS,
  TOKEN_RE,
  validate,
  register,
  list,
  status,
};
