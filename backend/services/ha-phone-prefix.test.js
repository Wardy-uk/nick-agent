'use strict';

/**
 * Which HA entities are the phone.
 *
 * The bug (31 Aug 2026): the Companion app re-registered, HA created a second
 * device, and every sensor moved to a `_2` suffix. `sensor.nicks_iphone_*` and
 * `device_tracker.nicks_iphone` stopped EXISTING — measured live, the only two
 * unsuffixed matches were `unavailable` camera entities — so every read in
 * ha.js resolved to nothing and returned null for five weeks while 28 suffixed
 * entities updated normally. NEURO reported "presence: could not read" and the
 * code blamed the phone.
 *
 * `resolvePhonePrefix` is PURE, so the rule pins without HA, a network or a
 * clock (the pi-health.assess() split). These are the cases that matter, and the
 * negative ones are the point: a resolver that guesses is how the same failure
 * comes back silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePhonePrefix } = require('./ha');

const at = iso => iso;
const battery = (prefix, state, when) => ({
  entity_id: `sensor.${prefix}_battery_level`,
  state: String(state),
  last_updated: at(when),
});

test('the family that is actually reporting wins, whatever it is called', () => {
  // The live shape: the configured name is gone, `_2` is current.
  const r = resolvePhonePrefix([
    battery('nicks_iphone_2', 50, '2026-08-30T18:56:05Z'),
    { entity_id: 'sensor.nicks_iphone_camera_stream', state: 'unavailable', last_updated: '2026-08-25T19:16:00Z' },
  ], 'nicks_iphone');

  assert.equal(r.prefix, 'nicks_iphone_2');
  assert.equal(r.source, 'discovered', 'and it says it had to go looking');
  assert.equal(r.reportingAt, '2026-08-30T18:56:05.000Z');
});

test('an unchanged install still resolves to the configured name, reported as such', () => {
  const r = resolvePhonePrefix([battery('nicks_iphone', 72, '2026-08-31T08:00:00Z')], 'nicks_iphone');
  assert.equal(r.prefix, 'nicks_iphone');
  assert.equal(r.source, 'configured');
});

test('a THIRD registration self-heals — this must not need another code change', () => {
  const r = resolvePhonePrefix([
    battery('nicks_iphone', 72, '2026-07-22T10:00:00Z'),
    battery('nicks_iphone_2', 50, '2026-08-30T18:56:05Z'),
    battery('nicks_iphone_3', 88, '2026-09-14T07:10:00Z'),
  ], 'nicks_iphone');
  assert.equal(r.prefix, 'nicks_iphone_3');
  assert.equal(r.candidates.length, 3, 'and the others stay visible rather than being discarded');
});

test('an UNAVAILABLE battery is not a reporting phone', () => {
  // The exact trap: HA serves a dead entity's last known value identically to a
  // live one, so "it exists" is not "it is reporting".
  const r = resolvePhonePrefix([
    battery('nicks_iphone_2', 'unavailable', '2026-08-31T09:00:00Z'),
    battery('nicks_iphone', 40, '2026-08-30T18:00:00Z'),
  ], 'nicks_iphone');
  assert.equal(r.prefix, 'nicks_iphone');
});

test('someone else\'s phone is never adopted', () => {
  const r = resolvePhonePrefix([
    battery('sarahs_iphone', 90, '2026-08-31T09:00:00Z'),
    battery('nicks_iphone_2', 50, '2026-08-30T18:56:05Z'),
  ], 'nicks_iphone');
  assert.equal(r.prefix, 'nicks_iphone_2', 'a newer battery on a different device must not win');
});

test('a name that merely STARTS THE SAME is not a suffixed re-registration', () => {
  // `nicks_iphonex` is a different device. Only `<base>` or `<base>_...` count.
  const r = resolvePhonePrefix([battery('nicks_iphonex', 90, '2026-08-31T09:00:00Z')], 'nicks_iphone');
  assert.equal(r.source, 'none');
  assert.equal(r.prefix, 'nicks_iphone', 'and it falls back to the configured name rather than to nothing');
});

test('finding nothing is its own answer, never a quiet default', () => {
  const r = resolvePhonePrefix([], 'nicks_iphone');
  assert.equal(r.source, 'none');
  assert.equal(r.reportingAt, null);
  assert.deepEqual(r.candidates, []);
});
