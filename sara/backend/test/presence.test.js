// Auto-lock presence source tests. Zero deps — Node's built-in runner.
//   run: npm test   (from sara/backend)
//
// `homePresence` is the whole of the house-level rule, and it is pure, so it pins
// without a live Home Assistant. The property that matters most is the NEGATIVE one:
// nothing we cannot read is ever reported as away, because away is what locks the
// display Nick is standing in front of.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { homePresence, presenceSource } = require('../src/routes/presence');

function telemetry(signals, extra = {}) {
  return {
    source: 'home-assistant',
    available: true,
    reason: null,
    polledAt: '2026-08-30T10:00:00.000Z',
    signals: { location: null, presence: null, environment: null, proximity: null, ...signals },
    ...extra,
  };
}

test('default source is home; only the literal "watch" value goes back to BLE', () => {
  const prev = process.env.SARA_PRESENCE_SOURCE;
  try {
    delete process.env.SARA_PRESENCE_SOURCE;
    assert.equal(presenceSource(), 'home', 'unset must mean home — the deployed default');
    process.env.SARA_PRESENCE_SOURCE = 'WATCH';
    assert.equal(presenceSource(), 'watch');
    process.env.SARA_PRESENCE_SOURCE = 'geo';
    assert.equal(presenceSource(), 'home', 'an unrecognised value falls back to the default');
  } finally {
    if (prev === undefined) delete process.env.SARA_PRESENCE_SOURCE;
    else process.env.SARA_PRESENCE_SOURCE = prev;
  }
});

test('home zone is present', () => {
  const r = homePresence(telemetry({ location: { zone: 'home', state: 'home' } }));
  assert.equal(r.away, false);
  assert.equal(r.basis, 'ha-location');
});

test('not_home is away', () => {
  const r = homePresence(telemetry({ location: { zone: 'not_home', state: 'not_home' } }));
  assert.equal(r.away, true);
});

test('a custom zone is NOT home — only the home zone is home', () => {
  const r = homePresence(telemetry({ location: { zone: 'Office', state: 'Office' } }));
  assert.equal(r.away, true);
  assert.equal(r.zone, 'Office');
});

test('an unreadable zone is unknown, never away (unknown must not lock)', () => {
  for (const zone of ['unknown', 'unavailable', '']) {
    const r = homePresence(telemetry({ location: { zone, state: zone } }));
    assert.equal(r.away, null, `zone "${zone}" must not resolve to away`);
  }
});

test('HA unavailable is unknown and carries its reason, not away', () => {
  const r = homePresence({ source: 'home-assistant', available: false, reason: 'unreachable', signals: {} });
  assert.equal(r.away, null);
  assert.equal(r.reason, 'unreachable');
});

test('no telemetry at all is unknown, not away', () => {
  assert.equal(homePresence(null).away, null);
  assert.equal(homePresence(undefined).away, null);
});

test('falls back to the proximity slot when no location entity is configured', () => {
  const r = homePresence(telemetry({ proximity: { away: true, state: 'not_home' } }));
  assert.equal(r.away, true);
  assert.equal(r.basis, 'ha-proximity');
});

test('proximity that cannot decide stays unknown', () => {
  const r = homePresence(telemetry({ proximity: { away: null, state: 'weird' } }));
  assert.equal(r.away, null);
  assert.equal(r.reason, 'no-location-signal');
});

test('a live location slot wins over proximity, so leaving the desk at home stays present', () => {
  // The desk-level signal says away; the house-level one says home. In home mode the
  // house wins — that is the entire point of the mode.
  const r = homePresence(
    telemetry({
      location: { zone: 'home', state: 'home' },
      proximity: { away: true, state: 'not_home' },
    })
  );
  assert.equal(r.away, false);
  assert.equal(r.basis, 'ha-location');
});
