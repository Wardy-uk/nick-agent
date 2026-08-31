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
