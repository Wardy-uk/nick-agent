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

// ── The sustained-room clock ────────────────────────────────────────────────
//
// Found live on 2 Sep 2026: the Pi wall display had been locked as `in-bed`,
// saying "Goodnight.", since Nick left the house that morning. HA knew perfectly
// well he was at the office (`away: true`, zone Office) and the watch was absent
// from all three rooms — but `in-bed` is checked FIRST in `displayState` and the
// clock behind it had been running unbroken from the last confident bedroom
// sighting, because nothing ever cleared it.
const { sustainedClock } = require('../src/routes/presence');

const SURE = (room) => ({ confidence: 'sure', room });
const UNSURE = { confidence: 'unsure', room: null };
const AT = (n) => n * 60_000;

test('a confident room starts the clock, and holding it keeps accumulating', () => {
  const a = sustainedClock(null, { inferred: SURE('bedroom'), arbitration: { status: 'present' }, home: { away: false }, now: AT(0) });
  assert.equal(a.room, 'bedroom');
  assert.equal(a.sustained.ms, 0);
  const b = sustainedClock(a, { inferred: SURE('bedroom'), arbitration: { status: 'present' }, home: { away: false }, now: AT(40) });
  assert.equal(b.sustained.ms, AT(40), 'staying put must extend the clock, not restart it');
});

test('an unsure moment neither resets the clock nor extends it', () => {
  // A deaf poll is not evidence he got up — the original rule, unchanged.
  const a = sustainedClock(null, { inferred: SURE('bedroom'), arbitration: { status: 'present' }, home: { away: false }, now: AT(0) });
  const b = sustainedClock(a, { inferred: UNSURE, arbitration: { status: 'unreadable' }, home: { away: false }, now: AT(45) });
  assert.equal(b.room, 'bedroom');
  assert.equal(b.sustained.ms, AT(45), 'the clock still runs from the last CONFIDENT sighting');
});

test('⚠ absent everywhere AND away clears it — the "Goodnight at 1pm" bug', () => {
  const inBed = sustainedClock(null, { inferred: SURE('bedroom'), arbitration: { status: 'present' }, home: { away: false }, now: AT(0) });
  const gone = sustainedClock(inBed, {
    inferred: UNSURE,
    arbitration: { status: 'absent' },
    home: { away: true },
    now: AT(345), // he has been at the office nearly six hours
  });
  assert.equal(gone.room, null);
  assert.equal(gone.sustained, null, 'a lock reason cannot outlive the evidence for it');
});

test('⚠ BOTH halves are load-bearing — neither alone may clear it', () => {
  const inBed = sustainedClock(null, { inferred: SURE('bedroom'), arbitration: { status: 'present' }, home: { away: false }, now: AT(0) });

  // A flat watch battery at 3am. Absent from every room, but HA says he is home
  // — clearing here would trade an in-bed lock for a lit clock screen at 3am.
  const flatWatch = sustainedClock(inBed, { inferred: UNSURE, arbitration: { status: 'absent' }, home: { away: false }, now: AT(200) });
  assert.equal(flatWatch.room, 'bedroom', 'absent alone must not clear the clock');

  // Away, but the watch is still audible in the house — so `away` is the thing
  // in doubt, not his position. Unreadable is never treated as absent.
  const noisyGeofence = sustainedClock(inBed, { inferred: UNSURE, arbitration: { status: 'unreadable' }, home: { away: true }, now: AT(200) });
  assert.equal(noisyGeofence.room, 'bedroom', 'away alone, on an unreadable radio, must not clear the clock');
});
