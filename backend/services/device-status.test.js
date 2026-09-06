'use strict';

/**
 * The device self-report wire contract and the merge over Home Assistant.
 *
 * Both halves are pure, so what the iOS app may send — and which feed wins when
 * both have an answer — pins without a database, a network or a phone.
 *
 * ⚠ Every negative assertion is PAIRED with a positive one (31 Aug: VESTA's
 * task path had never worked behind a green suite, because every assertion was
 * also true of the empty array the broken path returned).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ds = require('./device-status');

const NOW = Date.parse('2026-09-05T14:00:00.000Z');
const REPORT = {
  deviceId: 'nick-iphone',
  reportedAt: '2026-09-05T13:59:30.000Z',
  batteryLevel: 0.42,
  batteryState: 'discharging',
  activity: 'walking',
  steps: 4200,
};

test('a well-formed report is accepted and canonicalised', () => {
  const r = ds.validate(REPORT, NOW);
  assert.equal(r.ok, true);
  // iOS reports 0.0-1.0, Home Assistant reports 0-100, and consumers have
  // always seen HA's shape. A 0.42 rendered as "42%" is a one-character bug
  // that would only surface as a battery warning that never fires.
  assert.equal(r.status.batteryLevel, 42);
  // Case-insensitive in, canonical out — consumers switch on HA's capitalisation.
  assert.equal(r.status.activity, 'Walking');
  assert.equal(r.status.steps, 4200);
});

test('a battery already in percent is not multiplied again', () => {
  // Paired with the conversion above: the rule must not turn 85% into 8500%.
  assert.equal(ds.validate({ ...REPORT, batteryLevel: 85 }, NOW).status.batteryLevel, 85);
  // And the boundary between the two conventions resolves to the iOS reading.
  assert.equal(ds.validate({ ...REPORT, batteryLevel: 1 }, NOW).status.batteryLevel, 100);
  assert.equal(ds.validate({ ...REPORT, batteryLevel: 0 }, NOW).status.batteryLevel, 0);
});

test('an OMITTED sensor is null, and zero is kept as zero', () => {
  // THE distinction this whole module protects. Omitted means "I could not read
  // the pedometer" and falls through to HA; zero means "I read it and he has
  // not moved". Defaulting the first into the second is how a dead sensor
  // renders as a sedentary day.
  const omitted = ds.validate({ deviceId: 'p', reportedAt: REPORT.reportedAt }, NOW);
  assert.equal(omitted.ok, true);
  assert.equal(omitted.status.steps, null);
  assert.equal(omitted.status.batteryLevel, null);
  // Paired positive: an explicit zero survives as a real reading.
  const zero = ds.validate({ ...REPORT, steps: 0 }, NOW);
  assert.equal(zero.status.steps, 0);
  assert.notEqual(zero.status.steps, null);
});

test('reportedAt is mandatory and may not be in the future', () => {
  assert.equal(ds.validate({ deviceId: 'p' }, NOW).ok, false);
  assert.equal(ds.validate({ deviceId: 'p', reportedAt: 'never' }, NOW).ok, false);
  const future = ds.validate({ deviceId: 'p', reportedAt: '2026-09-05T15:00:00Z' }, NOW);
  assert.equal(future.ok, false);
  assert.match(future.reason, /future/);
  // Paired positive: an OLD report is fine — that is the offline queue draining,
  // and the store decides whether it supersedes what it already holds.
  assert.equal(ds.validate({ deviceId: 'p', reportedAt: '2026-09-02T09:00:00Z' }, NOW).ok, true);
});

test('a malformed field is refused by name rather than dropped', () => {
  // Dropping it would make a client bug look like a quiet sensor.
  assert.match(ds.validate({ ...REPORT, activity: 'Driving' }, NOW).reason, /activity must be one of/);
  assert.match(ds.validate({ ...REPORT, batteryState: 'flat' }, NOW).reason, /batteryState must be one of/);
  assert.match(ds.validate({ ...REPORT, steps: -5 }, NOW).reason, /negative/);
  assert.match(ds.validate({ ...REPORT, focusMode: 'on' }, NOW).reason, /boolean/);
  // Paired positive: the vocabulary NEURO actually uses is accepted, including
  // the CoreMotion value HA spells `Automotive`.
  assert.equal(ds.validate({ ...REPORT, activity: 'Automotive' }, NOW).status.activity, 'Automotive');
  assert.equal(ds.validate({ ...REPORT, focusMode: true }, NOW).status.focusMode, true);
});

test('an unmodelled sensor is kept in payload, not thrown away', () => {
  // So a reading can ship on the phone before the Pi learns to model it.
  const r = ds.validate({ ...REPORT, wristTemperature: 33.1 }, NOW);
  assert.equal(r.status.payload.wristTemperature, 33.1);
  // Paired negative: a modelled field never leaks into payload under a second
  // spelling, or it would be stored twice and read from the wrong one.
  assert.equal(r.status.payload.steps, undefined);
});

// ── The merge ────────────────────────────────────────────────────────────────

const HA = {
  presence: 'home',
  batteryLevel: 88,
  batteryState: 'charging',
  ssid: 'Ward-5G',
  audioOutput: 'Speaker',
  activity: 'Still',
  steps: 100,
  focusMode: false,
  lastReportAt: '2026-09-05T13:50:00.000Z',
};

const DEVICE = {
  deviceId: 'nick-iphone',
  reportedAt: '2026-09-05T13:59:30.000Z',
  batteryLevel: 42,
  batteryState: 'discharging',
  activity: 'Walking',
  steps: 4200,
  ssid: null,          // no Access WiFi Information entitlement on free provisioning
  focusMode: null,     // not readable
};

test('the device wins where it has an answer', () => {
  const m = ds.merge({ device: DEVICE, ha: HA, now: new Date(NOW) });
  assert.equal(m.batteryLevel, 42);
  assert.equal(m.activity, 'Walking');
  assert.equal(m.steps, 4200);
  assert.equal(m.sources.fields.activity, 'device');
});

test('a field the device cannot read falls through to HA, never overrides it', () => {
  // The reason the merge is per-FIELD and not per-payload: ssid needs a paid
  // entitlement and audioOutput has no third-party API at all, so a wholesale
  // swap would drop both without a word.
  const m = ds.merge({ device: DEVICE, ha: HA, now: new Date(NOW) });
  assert.equal(m.ssid, 'Ward-5G');
  assert.equal(m.sources.fields.ssid, 'home-assistant');
  assert.equal(m.audioOutput, 'Speaker');       // untouched, HA-only
  assert.equal(m.presence, 'home');             // untouched, HA-only
  // focusMode false from HA survives a null from the device — and false is a
  // real answer, so this also pins that null-vs-false is not confused.
  assert.equal(m.focusMode, false);
  assert.equal(m.sources.fields.focusMode, 'home-assistant');
});

test('a STALE device report is ignored entirely, not merged', () => {
  // A phone whose signature lapsed three days ago still has a row saying
  // `Walking`. Confidently wrong is worse than absent.
  const stale = { ...DEVICE, reportedAt: '2026-09-02T09:00:00.000Z' };
  const m = ds.merge({ device: stale, ha: HA, now: new Date(NOW) });
  assert.equal(m.batteryLevel, 88);             // HA's, not the phone's
  assert.equal(m.activity, 'Still');
  assert.equal(m.sources.fields.activity, 'home-assistant');
  assert.equal(m.sources.device.stale, true);
  // Paired positive: the same report inside the window does win.
  const fresh = ds.merge({ device: DEVICE, ha: HA, now: new Date(NOW) });
  assert.equal(fresh.activity, 'Walking');
  assert.equal(fresh.sources.device.stale, false);
});

test('a field neither feed has is null and SAYS it was not read', () => {
  const m = ds.merge({ device: null, ha: { presence: 'home' }, now: new Date(NOW) });
  assert.equal(m.batteryLevel, null);
  assert.equal(m.sources.fields.batteryLevel, null);
  // Paired positive: the one field that WAS available is untouched and the
  // device feed is honestly described as never having started.
  assert.equal(m.presence, 'home');
  assert.equal(m.sources.device.known, false);
  assert.equal(m.sources.device.ageMinutes, null);
});

test('the phone reporting with HA down is still a working phone', () => {
  // getPhoneStatus() used to return null the moment HA had no states, which
  // made a directly-reporting phone look like no phone at all.
  const m = ds.merge({ device: DEVICE, ha: null, now: new Date(NOW) });
  assert.equal(m.batteryLevel, 42);
  assert.equal(m.activity, 'Walking');
  assert.equal(m.sources.fields.batteryLevel, 'device');
  // And what only HA could have supplied is honestly absent rather than invented.
  assert.equal(m.ssid, null);
  assert.equal(m.sources.fields.ssid, null);
});

test('lastReportAt is the newest of the two feeds', () => {
  const m = ds.merge({ device: DEVICE, ha: HA, now: new Date(NOW) });
  assert.equal(m.lastReportAt, DEVICE.reportedAt);   // device spoke more recently
  // Paired: when HA is the more recent voice, it wins.
  const older = { ...DEVICE, reportedAt: '2026-09-05T13:45:00.000Z' };
  assert.equal(ds.merge({ device: older, ha: HA, now: new Date(NOW) }).lastReportAt, HA.lastReportAt);
});

// ── Freshness ────────────────────────────────────────────────────────────────

test('never having reported is not the same as being stale', () => {
  const f = ds.assessFreshness(null);
  assert.equal(f.known, false);
  assert.equal(f.stale, null);
  assert.equal(f.ageMinutes, null);   // "never" rendered as 0 would read as fresh
  const live = ds.assessFreshness({ reported_at: '2026-09-05T13:59:00Z', device_id: 'p' }, new Date(NOW));
  assert.equal(live.known, true);
  assert.equal(live.stale, false);
  assert.equal(live.ageMinutes, 1);
});
