'use strict';

/**
 * #66 — a device code has a life, and nothing used to track it.
 *
 * `startDeviceCodeFlow` returned the cached `deviceCodeInfo` whenever a flow was
 * pending, with no record of when the code was issued. After the admin-approval
 * wait, asking for a fresh code handed back the long-dead one — twice — and the
 * only escape was restarting the backend.
 *
 * Deliberately unit-tested rather than exercised live: triggering a real flow
 * means asking Microsoft for a code nobody will type in, and the bug only bites
 * at the exact moment Nick is locked out. Expiry is a pure function of issue
 * time, so it is testable as one.
 */

const test = require('node:test');
const assert = require('node:assert');

const microsoft = require('./microsoft');
const { isDeviceCodeUsable } = microsoft;

const MIN = 60 * 1000;
const T0 = 1_755_000_000_000; // fixed instant — never the wall clock

function code(overrides = {}) {
  return {
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://microsoft.com/devicelogin',
    message: 'enter ABCD-EFGH',
    issuedAt: T0,
    expiresInMs: 15 * MIN,
    ...overrides,
  };
}

test('a code issued moments ago is usable', () => {
  assert.equal(isDeviceCodeUsable(code(), T0 + 10 * 1000), true);
});

test('a code well inside its life is usable', () => {
  assert.equal(isDeviceCodeUsable(code(), T0 + 10 * MIN), true);
});

test('a code past its life is NOT usable — the whole bug', () => {
  assert.equal(isDeviceCodeUsable(code(), T0 + 16 * MIN), false);
});

test('a code hours old is not usable — the admin-approval wait', () => {
  assert.equal(isDeviceCodeUsable(code(), T0 + 4 * 60 * MIN), false);
});

test('the 30s margin retires a code about to die mid-typing', () => {
  // 14m40s in: still technically alive, but not worth handing to someone who
  // has to read it across to a browser.
  assert.equal(isDeviceCodeUsable(code(), T0 + 14 * MIN + 40 * 1000), false);
  assert.equal(isDeviceCodeUsable(code(), T0 + 14 * MIN), true);
});

test("the issuer's own expiresIn wins over the 15-minute default", () => {
  // A tenant may issue a SHORTER life. Believing in a code for longer than the
  // issuer does is the same class of bug this fixes.
  const short = code({ expiresInMs: 5 * MIN });
  assert.equal(isDeviceCodeUsable(short, T0 + 3 * MIN), true);
  assert.equal(isDeviceCodeUsable(short, T0 + 6 * MIN), false);
});

test('a missing or malformed expiresInMs falls back to the 15-minute default', () => {
  for (const bad of [undefined, null, 0, -1, 'soon', NaN]) {
    const c = code({ expiresInMs: bad });
    assert.equal(isDeviceCodeUsable(c, T0 + 10 * MIN), true, `usable at 10m for ${String(bad)}`);
    assert.equal(isDeviceCodeUsable(c, T0 + 16 * MIN), false, `expired at 16m for ${String(bad)}`);
  }
});

test('nothing cached is not usable — a pending flow with no code yet', () => {
  // `deviceCodePending` flips true before the callback fires, so there is a real
  // window where the flow is pending and `deviceCodeInfo` is still null. That
  // must read as "no code", never as a stale one.
  assert.equal(isDeviceCodeUsable(null), false);
  assert.equal(isDeviceCodeUsable(undefined), false);
  assert.equal(isDeviceCodeUsable({}), false);
});

test('a code with no issuedAt is not usable — the pre-fix shape', () => {
  // Exactly what the old code cached: a code with no stamp. It must not be
  // trusted by default, or the fix would no-op on anything already in memory
  // across a hot reload.
  const legacy = { userCode: 'ABCD-EFGH', verificationUri: 'x', message: 'y' };
  assert.equal(isDeviceCodeUsable(legacy, T0), false);
});

test('a code with no userCode is not usable', () => {
  assert.equal(isDeviceCodeUsable(code({ userCode: '' }), T0), false);
});

test('the flow stamps issuedAt and expiresAt, and exports the guard', () => {
  // Pins the contract the route reads: a bare code with no stated deadline is
  // how the stale one went unnoticed twice.
  assert.equal(typeof microsoft.isDeviceCodeUsable, 'function');
  assert.equal(typeof microsoft.startDeviceCodeFlow, 'function');

  const src = require('fs').readFileSync(require('path').join(__dirname, 'microsoft.js'), 'utf-8');
  assert.ok(/issuedAt:\s*Date\.now\(\)/.test(src), 'the callback must stamp issuedAt');
  assert.ok(/expiresAt:/.test(src), 'the callback must publish a deadline');
  assert.ok(
    /if\s*\(deviceCodePending\)\s*\{[\s\S]{0,400}isDeviceCodeUsable\(deviceCodeInfo\)/.test(src),
    'the pending branch must gate on the expiry guard, not return unconditionally'
  );
});
