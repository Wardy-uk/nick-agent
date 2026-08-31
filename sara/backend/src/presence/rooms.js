// Which room is Nick in, and what should a screen in a given room be showing?
//
// PURE. Takes the reports, the Home Assistant read and a clock; does no I/O and
// holds no state. The `pi-health.assess()` split — the rules are the product, so
// they pin without a live sensor, a live HA, or a wall to stand in front of.
//
// ── The three display states (Nick, 31 Aug 2026) ────────────────────────────
//   full    the watch is in THIS room  -> SARA, everything, on screen
//   clock   he is at home but not here -> just the clock
//   locked  he is not at home at all   -> screen off (backlight to 0)
//
// The shape matters more than it looks. The OLD design had two states and lost
// the watch STRAIGHT INTO A LOCK, which is why it "incorrectly locked SARA": a
// noisy radio cost Nick his display. Here, losing the watch costs him a clock
// face, and only geolocation — slow-moving, and a different sensor entirely —
// can lock. That is what makes the BLE layer allowed to be imperfect.
//
// ── Two rules carried in from everything else that reads a sensor ───────────
//
// ⚠ AN UNREADABLE ROOM IS NAMED, NEVER COUNTED AS EMPTY. A stale report and a
// deaf radio both mean "we could not look there", which is a different fact from
// "he is not there" — and treating them the same is exactly how the old service
// reported `away` for fifteen days from a scan that had died. Every unreadable
// room comes back in `unreadable`, with why.
//
// ⚠ UNKNOWN NEVER LOCKS. Locking is the only irreversible-feeling thing here —
// it blanks a screen Nick may be standing in front of — so it requires a
// CONFIDENT "not at home". No HA, no zone, a stale zone: all render `clock`.
// Failing towards the clock is the whole reason the middle state exists.

'use strict';

// A sensor reports every ~3s. Thirty seconds is ten missed reports: comfortably
// past a hiccup, and well inside the time it takes to walk to another room.
const SENSOR_STALE_MS = 30_000;

function ageOf(report, now) {
  const t = report && report.at ? Date.parse(report.at) : NaN;
  if (!Number.isFinite(t)) return null;
  return now.getTime() - t;
}

/**
 * Fold the per-room reports into one answer.
 *
 * `reports` is a map of room -> the sensor's last posted reading.
 *
 * Ranking among rooms that BOTH say present is by median RSSI, not by advert
 * rate. Deliberate: the rate saturates — measured, the living room and the
 * kitchen both sit at ~2.2-2.8/sec with Nick in one of them — so it separates
 * "heard" from "not heard" and says nothing about which room he is in. RSSI is
 * far too noisy to decide presence (26 dB of spread at a fixed seat) but it is
 * the only signal that discriminates BETWEEN rooms, and comparing two medians
 * taken at the same moment is a fair comparison in a way that comparing one
 * median to a fixed threshold is not.
 */
function resolveRoom(reports = {}, now = new Date(), { staleMs = SENSOR_STALE_MS } = {}) {
  const rooms = [];
  const unreadable = [];

  for (const [room, report] of Object.entries(reports || {})) {
    const ageMs = ageOf(report, now);
    const row = {
      room,
      status: report && report.status ? report.status : 'unknown',
      rate: report && typeof report.rate === 'number' ? report.rate : null,
      rssi: report && typeof report.rssiMedian === 'number' ? report.rssiMedian : null,
      healthy: !!(report && report.healthy),
      ageMs,
    };

    if (ageMs === null || ageMs > staleMs) {
      row.readable = false;
      row.why = ageMs === null
        ? 'no timestamp on the report'
        : `last reported ${Math.round(ageMs / 1000)}s ago — the sensor has gone quiet`;
      unreadable.push({ room, why: row.why });
    } else if (row.status === 'unknown' || !row.healthy) {
      row.readable = false;
      // The sensor's own words. It knows whether it was deaf or merely warming.
      row.why = (report && report.why) || 'the sensor could not answer';
      unreadable.push({ room, why: row.why });
    } else {
      row.readable = true;
      row.why = null;
    }
    rooms.push(row);
  }

  rooms.sort((a, b) => a.room.localeCompare(b.room));

  const readable = rooms.filter(r => r.readable);
  const present = readable.filter(r => r.status === 'present');

  if (!rooms.length) {
    return { room: null, status: 'unknown', why: 'no sensors have reported', rooms, unreadable };
  }
  if (!readable.length) {
    return {
      room: null,
      status: 'unknown',
      why: 'every sensor is stale or deaf — this is not an all-clear',
      rooms,
      unreadable,
    };
  }
  if (!present.length) {
    return {
      room: null,
      status: 'absent',
      // Honest scope: absent from the rooms that ANSWERED, not from the house.
      why: `not in ${readable.map(r => r.room).join(' or ')}`,
      rooms,
      unreadable,
    };
  }

  const best = present.slice().sort((a, b) => {
    if (a.rssi === b.rssi) return (b.rate || 0) - (a.rate || 0);
    if (a.rssi === null) return 1;
    if (b.rssi === null) return -1;
    return b.rssi - a.rssi;   // -64 beats -70
  })[0];

  return { room: best.room, status: 'present', why: null, rooms, unreadable };
}

/**
 * What a screen in `thisRoom` should show. PURE.
 *
 * `home` is `homePresence()`'s shape: `{ away: true|false|null }`. Only a
 * literal `true` — HA read a zone and it was not home — can lock.
 */
function displayState(thisRoom, arbitration, home) {
  const away = home && home.away;

  if (away === true) {
    return {
      state: 'locked',
      reason: 'not-home',
      say: 'Away from home — screen off.',
    };
  }

  if (arbitration && arbitration.room === thisRoom) {
    return { state: 'full', reason: 'watch-in-room', say: null };
  }

  // Everything else is the clock, and the REASON is what keeps the three
  // silences apart — the clock is shown for "you're elsewhere in the house",
  // for "I couldn't see the watch", and for "I couldn't ask HA", and those are
  // not the same fact even though they draw the same screen.
  if (!arbitration || arbitration.status === 'unknown') {
    return {
      state: 'clock',
      reason: 'watch-unreadable',
      say: arbitration ? arbitration.why : 'no sensor readings',
    };
  }
  if (arbitration.status === 'absent') {
    return { state: 'clock', reason: 'watch-not-here', say: arbitration.why };
  }
  return {
    state: 'clock',
    reason: 'watch-in-another-room',
    say: `In the ${arbitration.room}.`,
  };
}

module.exports = { resolveRoom, displayState, SENSOR_STALE_MS };
