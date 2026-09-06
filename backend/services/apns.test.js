'use strict';

/**
 * The APNs device-token registry.
 *
 * ⚠ There is no sender yet — it needs a paid Apple Developer account — and
 * these tests pin that the absence is REPORTED rather than hidden. A push layer
 * that is silently incapable is the worst version of the false all-clear this
 * codebase keeps guarding against: an app registers successfully, receives
 * nothing for a fortnight, and nothing anywhere says why.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-apns-'));
process.env.NEURO_DB_PATH = path.join(root, 'apns.db');

const db = require('../db/database');
const apns = require('./apns');

const TOKEN = 'a'.repeat(64);

test.before(async () => { await db.init(); });
test.beforeEach(() => { db.run('DELETE FROM apns_tokens', []); });

// ── Validation (pure) ────────────────────────────────────────────────────────

test('a well-formed registration is accepted and normalised', () => {
  const r = apns.validate({ token: TOKEN.toUpperCase(), app: 'SARA', environment: 'Production', deviceId: 'ios-abc' });
  assert.equal(r.ok, true);
  // Lower-cased, because APNs tokens are hex and a case difference would store
  // the same device twice under two rows.
  assert.equal(r.registration.token, TOKEN);
  assert.equal(r.registration.app, 'sara');
  assert.equal(r.registration.environment, 'production');
});

test('a token that could never be sent to is refused', () => {
  assert.match(apns.validate({}).reason, /token is required/);
  assert.match(apns.validate({ token: 'not-hex-at-all' }).reason, /hex/);
  assert.match(apns.validate({ token: 'abc' }).reason, /hex/);
  // Paired positive: the length rule is a RANGE, not an equality. Apple has
  // said tokens may grow, and rejecting a longer one would break the app on a
  // future iOS with no obvious cause.
  assert.equal(apns.validate({ token: 'b'.repeat(100) }).ok, true);
  assert.equal(apns.validate({ token: TOKEN }).ok, true);
});

test('app and environment are closed sets', () => {
  assert.match(apns.validate({ token: TOKEN, app: 'vesta' }).reason, /app must be one of/);
  assert.match(apns.validate({ token: TOKEN, environment: 'staging' }).reason, /environment must be one of/);
  // ⚠ Environment matters and is stored rather than assumed: a sandbox token is
  // INVALID against production, and the failure is a generic BadDeviceToken
  // that reads like a bad token rather than a wrong gateway.
  assert.equal(apns.validate({ token: TOKEN, environment: 'development' }).registration.environment, 'development');
  assert.equal(apns.validate({ token: TOKEN, environment: 'production' }).registration.environment, 'production');
});

test('defaults are sensible, and absent optionals stay null', () => {
  const r = apns.validate({ token: TOKEN });
  assert.equal(r.registration.app, 'neuro');
  assert.equal(r.registration.environment, 'development');
  assert.equal(r.registration.deviceId, null);
  assert.equal(r.registration.bundleId, null);
});

// ── Storage ──────────────────────────────────────────────────────────────────

test('re-registering the same token is a heartbeat, not a duplicate', () => {
  // The app registers on EVERY launch, so an insert-only path would throw on
  // the UNIQUE constraint or duplicate the row.
  apns.register(apns.validate({ token: TOKEN, deviceId: 'ios-1' }).registration);
  apns.register(apns.validate({ token: TOKEN, deviceId: 'ios-1' }).registration);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM apns_tokens').n, 1);
});

test('re-registration CLEARS a previous failure', () => {
  // ⚠ A token that failed last week and is being presented again by a live app
  // is working now. Leaving it marked dead would exclude the device for ever,
  // silently — which is the same class of bug as a stale device report winning.
  apns.register(apns.validate({ token: TOKEN }).registration);
  assert.equal(db.markApnsTokenFailed(TOKEN, 'BadDeviceToken'), true);
  assert.equal(db.get('SELECT failure_reason FROM apns_tokens').failure_reason, 'BadDeviceToken');

  apns.register(apns.validate({ token: TOKEN }).registration);
  const row = db.get('SELECT * FROM apns_tokens');
  assert.equal(row.failure_reason, null);
  assert.equal(row.last_failed_at, null);
});

test('two apps on one phone are two tokens', () => {
  // NEURO and SARA are separate apps and APNs issues a token per app.
  apns.register(apns.validate({ token: 'a'.repeat(64), app: 'neuro', deviceId: 'ios-1' }).registration);
  apns.register(apns.validate({ token: 'c'.repeat(64), app: 'sara', deviceId: 'ios-1' }).registration);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM apns_tokens').n, 2);
  assert.equal(db.getApnsTokens('sara').length, 1);
});

test('the listing never returns a sendable token', () => {
  // ⚠ These routes inherit the PIN exemption written for Web Push, so this
  // mount is reachable without a credential. A device token is the address of a
  // push that bypasses the lock screen.
  apns.register(apns.validate({ token: TOKEN, deviceId: 'ios-1' }).registration);
  const listed = apns.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenPrefix, 'aaaaaaaa…');
  assert.equal(listed[0].token, undefined);
  // Paired positive: enough is returned to tell two devices apart.
  assert.equal(listed[0].deviceId, 'ios-1');
  assert.equal(listed[0].app, 'neuro');
});

test('status says out loud that nothing can be delivered', () => {
  // The point of the whole file. "NEURO has nothing to say" and "NEURO cannot
  // say anything" are different facts.
  apns.register(apns.validate({ token: TOKEN }).registration);
  const s = apns.status();
  assert.equal(s.registered, 1);
  assert.equal(s.readable, true);
  assert.equal(s.canDeliver, false);
  assert.equal(s.senderImplemented, false);
  assert.match(s.blockedBy, /Apple Developer account|not implemented/);
});

test('forgetting a token stops it being a target', () => {
  apns.register(apns.validate({ token: TOKEN }).registration);
  assert.equal(db.deleteApnsToken(TOKEN), true);
  assert.equal(apns.status().registered, 0);
  // Paired negative: deleting something absent is false, not a throw.
  assert.equal(db.deleteApnsToken(TOKEN), false);
});
