// WS3-WP1 Home Assistant telemetry bridge tests. Zero deps — Node's built-in runner.
//   run: npm test   (from sara/backend)
//
// These prove the bridge in isolation: honest unavailability when not configured, and
// correct normalisation of raw HA states into the bounded telemetry signal shape.
// No live Home Assistant is required — the mapping is a pure function.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ha = require('../src/telemetry/homeAssistant');

test('unconfigured bridge reports honest unavailable telemetry (no invented data)', () => {
  // The test process has no SARA_HA_* env set, so the bridge must be idle and honest.
  assert.equal(ha.isConfigured(), false);
  const t = ha.getTelemetry();
  assert.equal(t.source, 'home-assistant');
  assert.equal(t.available, false);
  assert.equal(t.reason, 'not-configured');
  assert.deepEqual(t.signals, { location: null, presence: null, environment: null, proximity: null });
});

test('maps a full set of HA states into the three bounded signals', () => {
  const cfg = { entities: { location: 'person.nick', presence: 'binary_sensor.occ', environment: 'sensor.temp' } };
  const states = {
    location: { entity_id: 'person.nick', state: 'home', attributes: {} },
    presence: { entity_id: 'binary_sensor.occ', state: 'on', attributes: { friendly_name: 'Office occupancy' } },
    environment: { entity_id: 'sensor.temp', state: '21.4', attributes: { friendly_name: 'Office temp', unit_of_measurement: '°C' } },
  };
  const t = ha.mapStatesToTelemetry(states, cfg, '2026-05-31T10:00:00.000Z');
  assert.equal(t.available, true);
  assert.equal(t.reason, null);
  assert.equal(t.polledAt, '2026-05-31T10:00:00.000Z');
  assert.equal(t.signals.location.zone, 'home');
  assert.equal(t.signals.location.label, 'Home');
  assert.equal(t.signals.presence.present, true);
  assert.equal(t.signals.environment.label, 'Office temp: 21.4°C');
});

test('partial reach is surfaced honestly as "partial", not hidden', () => {
  const cfg = { entities: { location: 'person.nick', presence: 'binary_sensor.occ', environment: 'sensor.temp' } };
  // HA up, but only the location entity could be read this poll.
  const states = { location: { entity_id: 'person.nick', state: 'not_home', attributes: {} }, presence: null, environment: null };
  const t = ha.mapStatesToTelemetry(states, cfg, '2026-05-31T10:00:00.000Z');
  assert.equal(t.available, true);
  assert.equal(t.reason, 'partial');
  assert.equal(t.signals.location.label, 'Away');
  assert.equal(t.signals.presence, null);
});

test('no signals at all yields available:false with reason "no-signals"', () => {
  const cfg = { entities: { location: 'person.nick' } };
  const t = ha.mapStatesToTelemetry({ location: null }, cfg, '2026-05-31T10:00:00.000Z');
  assert.equal(t.available, false);
  assert.equal(t.reason, 'no-signals');
});

test('presence mapping treats away/off as not present', () => {
  assert.equal(ha.mapPresence({ entity_id: 'person.nick', state: 'not_home', attributes: {} }).present, false);
  assert.equal(ha.mapPresence({ entity_id: 'binary_sensor.occ', state: 'off', attributes: {} }).present, false);
  assert.equal(ha.mapPresence({ entity_id: 'person.nick', state: 'home', attributes: {} }).present, true);
});

test('location mapping keeps a custom zone name as its label', () => {
  const loc = ha.mapLocation({ entity_id: 'person.nick', state: 'Work', attributes: { friendly_name: 'Nick' } });
  assert.equal(loc.zone, 'Work');
  assert.equal(loc.label, 'Work');
});
