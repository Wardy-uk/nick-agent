'use strict';

/**
 * Which HA entities are the phone.
 *
 * The bug (31 Aug 2026): the Companion app re-registered, HA created a second
 * set of entities, and it disambiguated them by appending `_2` to the ENTITY ID
 * — `sensor.nicks_iphone_battery_level_2`, NOT
 * `sensor.nicks_iphone_2_battery_level`. Measured live, the only two unsuffixed
 * matches were `unavailable` camera entities while 28 suffixed ones updated
 * normally, so every phone read in ha.js returned null for five weeks and the
 * code blamed the phone for going quiet.
 *
 * ⚠ Every entity id below is COPIED FROM THE LIVE HA DUMP, and that is the
 * point. The first version of this fix modelled the suffix as part of the device
 * prefix, wrote its fixtures to match, and passed seven green tests over a shape
 * that does not exist anywhere — the same species as the `sleep_core_hours`
 * metric name (#122) and the `meeting_alert` push type: a test over an invented
 * identifier is green and proves nothing. Do not hand-write ids in here.
 *
 * `resolvePhoneEntities` is PURE, so the rule pins without HA, a network or a
 * clock (the pi-health.assess() split).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePhoneEntities, phoneEntity } = require('./ha');

// Verbatim from `GET /api/states` on the Pi, 31 Aug 2026.
const LIVE = [
  { entity_id: 'sensor.nicks_iphone_battery_level_2', state: '50', last_updated: '2026-08-30T18:56:05.236887+00:00' },
  { entity_id: 'sensor.nicks_iphone_activity_2', state: 'Walking', last_updated: '2026-08-30T18:46:00.000000+00:00' },
  { entity_id: 'device_tracker.nicks_iphone_2', state: 'home', last_updated: '2026-08-30T18:56:04.288043+00:00' },
  { entity_id: 'binary_sensor.nicks_iphone_focus_2', state: 'on', last_updated: '2026-08-25T19:17:28.683993+00:00' },
  { entity_id: 'sensor.nicks_iphone_camera_stream', state: 'unavailable', last_updated: '2026-08-25T19:16:00.000000+00:00' },
  { entity_id: 'binary_sensor.nicks_iphone_camera_motion', state: 'unavailable', last_updated: '2026-08-25T19:16:00.000000+00:00' },
];

test('the suffix is on the ENTITY ID, not the device prefix', () => {
  const r = resolvePhoneEntities(LIVE, 'nicks_iphone');
  assert.equal(r.base, 'nicks_iphone');
  assert.equal(r.suffix, '_2');
  assert.equal(r.source, 'discovered');

  // The three shapes that actually exist in HA. Getting any of these wrong is
  // the bug, and it fails by returning null rather than by throwing.
  assert.equal(phoneEntity(r, 'sensor', 'battery_level'), 'sensor.nicks_iphone_battery_level_2');
  assert.equal(phoneEntity(r, 'device_tracker', null), 'device_tracker.nicks_iphone_2');
  assert.equal(phoneEntity(r, 'binary_sensor', 'focus'), 'binary_sensor.nicks_iphone_focus_2');
});

test('an .env already set to the suffixed name is CORRECTED, not obeyed', () => {
  // The Pi was configured `HA_PHONE_PREFIX=nicks_iphone_2`, which resolves
  // device_tracker.nicks_iphone_2 correctly and every sensor wrongly — presence
  // answered while battery, wifi and location stayed null. That is exactly how
  // the real bug presented, so it is pinned.
  const r = resolvePhoneEntities(LIVE, 'nicks_iphone_2');
  assert.equal(r.base, 'nicks_iphone');
  assert.equal(phoneEntity(r, 'sensor', 'battery_level'), 'sensor.nicks_iphone_battery_level_2');
  assert.notEqual(phoneEntity(r, 'sensor', 'battery_level'), 'sensor.nicks_iphone_2_battery_level');
});

test('an unchanged install resolves to no suffix, reported as configured', () => {
  const r = resolvePhoneEntities(
    [{ entity_id: 'sensor.nicks_iphone_battery_level', state: '72', last_updated: '2026-08-31T08:00:00Z' }],
    'nicks_iphone',
  );
  assert.equal(r.suffix, '');
  assert.equal(r.source, 'configured');
  assert.equal(phoneEntity(r, 'sensor', 'steps'), 'sensor.nicks_iphone_steps');
});

test('a THIRD registration self-heals — this must not need another code change', () => {
  const r = resolvePhoneEntities([
    { entity_id: 'sensor.nicks_iphone_battery_level', state: '72', last_updated: '2026-07-22T10:00:00Z' },
    { entity_id: 'sensor.nicks_iphone_battery_level_2', state: '50', last_updated: '2026-08-30T18:56:05Z' },
    { entity_id: 'sensor.nicks_iphone_battery_level_3', state: '88', last_updated: '2026-09-14T07:10:00Z' },
  ], 'nicks_iphone');
  assert.equal(r.suffix, '_3');
  assert.equal(r.candidates.length, 3, 'the others stay visible rather than being discarded');
});

test('an UNAVAILABLE entity is not a reporting phone', () => {
  // The exact trap: HA serves a dead entity's last known value identically to a
  // live one, so "it exists" is not "it is reporting".
  const r = resolvePhoneEntities([
    { entity_id: 'sensor.nicks_iphone_battery_level_2', state: 'unavailable', last_updated: '2026-08-31T09:00:00Z' },
    { entity_id: 'sensor.nicks_iphone_battery_level', state: '40', last_updated: '2026-08-30T18:00:00Z' },
  ], 'nicks_iphone');
  assert.equal(r.suffix, '');
});

test('another person\'s phone is never adopted, however fresh', () => {
  const r = resolvePhoneEntities([
    { entity_id: 'sensor.sarahs_iphone_battery_level', state: '90', last_updated: '2026-08-31T09:00:00Z' },
    ...LIVE,
  ], 'nicks_iphone');
  assert.equal(r.suffix, '_2');
  assert.ok(!JSON.stringify(r).includes('sarahs'));
});

test('a name that merely starts the same is not a re-registration', () => {
  const r = resolvePhoneEntities(
    [{ entity_id: 'sensor.nicks_iphonex_battery_level', state: '90', last_updated: '2026-08-31T09:00:00Z' }],
    'nicks_iphone',
  );
  assert.equal(r.source, 'none');
});

test('finding nothing is its own answer, never a quiet default', () => {
  const r = resolvePhoneEntities([], 'nicks_iphone');
  assert.equal(r.source, 'none');
  assert.equal(r.reportingAt, null);
  assert.deepEqual(r.candidates, []);
  // Falls back to the historical behaviour rather than to a broken id.
  assert.equal(phoneEntity(r, 'sensor', 'battery_level'), 'sensor.nicks_iphone_battery_level');
});

// ── Per-key suffix (3 Sep 2026) ──────────────────────────────────────────────
//
// The Companion app gained Apple Health sensors (official `mobile_app` platform,
// app 2026.9.0). HA created them with NO suffix, because those keys had never
// existed under the first registration and so collided with nothing — while every
// pre-existing entity kept `_2`. One device-wide suffix therefore asked for
// `sensor.nicks_iphone_heart_rate_2`, which does not exist, and every health read
// returned null. Silently, and for the same reason as the outage above: the
// entity was not stale, it was ABSENT.
//
// ⚠ Verbatim from `GET /api/states` on the Pi, 3 Sep 2026 12:56Z. Not hand-written
// — the whole point of the header rule at the top of this file.
const LIVE_MIXED = [
  { entity_id: 'binary_sensor.nicks_iphone_focus_2', state: 'on', last_updated: '2026-08-31T19:20:30.860403+00:00' },
  { entity_id: 'device_tracker.nicks_iphone_2', state: 'Office', last_updated: '2026-09-03T12:56:19.198801+00:00' },
  { entity_id: 'sensor.nicks_iphone_activity_2', state: 'Stationary', last_updated: '2026-09-03T12:56:12.887577+00:00' },
  { entity_id: 'sensor.nicks_iphone_battery_level_2', state: '80', last_updated: '2026-09-03T12:40:32.489164+00:00' },
  { entity_id: 'sensor.nicks_iphone_health_steps', state: '784', last_updated: '2026-09-03T12:55:15.207695+00:00' },
  { entity_id: 'sensor.nicks_iphone_weight', state: '101.2', last_updated: '2026-09-03T10:55:11.538397+00:00' },
  { entity_id: 'sensor.nicks_iphone_heart_rate', state: '97', last_updated: '2026-09-03T12:55:15.208853+00:00' },
  { entity_id: 'sensor.nicks_iphone_resting_heart_rate', state: '71', last_updated: '2026-09-03T10:55:11.538985+00:00' },
  { entity_id: 'sensor.nicks_iphone_heart_rate_variability', state: '17.1', last_updated: '2026-09-03T11:48:18.544320+00:00' },
];

test('one device carries BOTH shapes at once, and each key resolves its own', () => {
  const r = resolvePhoneEntities(LIVE_MIXED, 'nicks_iphone_2');
  assert.equal(r.base, 'nicks_iphone');
  assert.equal(r.suffix, '_2', 'the battery anchor still sets the default');

  assert.equal(phoneEntity(r, 'sensor', 'battery_level'), 'sensor.nicks_iphone_battery_level_2');
  assert.equal(phoneEntity(r, 'sensor', 'activity'), 'sensor.nicks_iphone_activity_2');
  assert.equal(phoneEntity(r, 'device_tracker', null), 'device_tracker.nicks_iphone_2');
  assert.equal(phoneEntity(r, 'binary_sensor', 'focus'), 'binary_sensor.nicks_iphone_focus_2');

  // Health entities: bare, on the SAME device, in the SAME payload.
  assert.equal(phoneEntity(r, 'sensor', 'heart_rate'), 'sensor.nicks_iphone_heart_rate');
  assert.equal(phoneEntity(r, 'sensor', 'heart_rate_variability'), 'sensor.nicks_iphone_heart_rate_variability');
  assert.equal(phoneEntity(r, 'sensor', 'resting_heart_rate'), 'sensor.nicks_iphone_resting_heart_rate');
  assert.equal(phoneEntity(r, 'sensor', 'weight'), 'sensor.nicks_iphone_weight');
});

test('the exact id that returned null for every health read is NEGATIVE', () => {
  const r = resolvePhoneEntities(LIVE_MIXED);
  for (const key of ['heart_rate', 'heart_rate_variability', 'resting_heart_rate', 'health_steps', 'weight']) {
    assert.notEqual(
      phoneEntity(r, 'sensor', key),
      `sensor.nicks_iphone_${key}_2`,
      `${key} must not be asked for under the device-wide suffix`,
    );
  }
});

test('the id set is scoped to THIS phone', () => {
  const r = resolvePhoneEntities([
    { entity_id: 'sensor.sarahs_iphone_heart_rate', state: '65', last_updated: '2026-09-03T12:00:00Z' },
    { entity_id: 'sensor.nicks_iphonex_heart_rate', state: '66', last_updated: '2026-09-03T12:00:00Z' },
    ...LIVE_MIXED,
  ], 'nicks_iphone');
  assert.ok(!r.ids.has('sensor.sarahs_iphone_heart_rate'), "another person's phone is not in the set");
  assert.ok(!r.ids.has('sensor.nicks_iphonex_heart_rate'), 'a name that merely starts the same is a different device');
  assert.ok(r.ids.has('sensor.nicks_iphone_heart_rate'));
});

test('when a key exists in BOTH shapes the suffixed one wins', () => {
  // The next re-registration will suffix the health keys too, because by then
  // they WILL collide. That must need no code change.
  const r = resolvePhoneEntities([
    ...LIVE_MIXED,
    { entity_id: 'sensor.nicks_iphone_heart_rate_2', state: '98', last_updated: '2026-09-03T12:59:00Z' },
  ], 'nicks_iphone');
  assert.equal(phoneEntity(r, 'sensor', 'heart_rate'), 'sensor.nicks_iphone_heart_rate_2');
});

test('an unreadable state list keeps the historical guess, never a bare id', () => {
  // "We could not look" must not silently change which entity is asked for.
  const r = resolvePhoneEntities([], 'nicks_iphone_2');
  assert.equal(r.ids.size, 0);
  assert.equal(phoneEntity(r, 'sensor', 'heart_rate'), 'sensor.nicks_iphone_heart_rate');
});
