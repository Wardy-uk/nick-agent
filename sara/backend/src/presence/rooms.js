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

// How much louder a challenger must be before it takes the room off the
// incumbent. MEASURED, not picked (31 Aug 2026, Nick sat in the living room):
//
//   living-room -68..-74, kitchen -73..-76   -> gap 1-5 dB, and the WINNER
//                                               FLIPPED to the kitchen once
//   Nick actually near the kitchen           -> kitchen -66, living -83 = 17 dB
//
// So the noise between two rooms with him in one of them reaches 5 dB, while
// genuinely walking to the other room is worth 17. Six sits in that gap. Without
// it the screen alternates between full SARA and the clock while he sits still -
// the flapping the sensor layer was rebuilt to remove, reappearing one floor up
// because two medians a decibel apart is a coin toss.
const SWITCH_MARGIN_DB = 6;

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
function resolveRoom(reports = {}, now = new Date(), {
  staleMs = SENSOR_STALE_MS,
  previousRoom = null,
  switchMarginDb = SWITCH_MARGIN_DB,
} = {}) {
  const rooms = [];
  const unreadable = [];

  for (const [room, report] of Object.entries(reports || {})) {
    const ageMs = ageOf(report, now);
    const row = {
      room,
      status: report && report.status ? report.status : 'unknown',
      inRoom: report && typeof report.inRoom === 'boolean' ? report.inRoom : null,
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

  // Hysteresis. The incumbent keeps the room unless beaten by a real margin —
  // and only while it can still hear him at all, so this can never pin the
  // answer to a room he has left.
  const incumbent = previousRoom ? present.find(r => r.room === previousRoom) : null;
  if (incumbent && best.room !== incumbent.room
      && incumbent.rssi !== null && best.rssi !== null
      && best.rssi < incumbent.rssi + switchMarginDb) {
    return { room: incumbent.room, status: 'present', why: null, held: true, rooms, unreadable };
  }

  return { room: best.room, status: 'present', why: null, held: false, rooms, unreadable };
}

/**
 * What a screen in `thisRoom` should show. PURE.
 *
 * `home` is `homePresence()`'s shape: `{ away: true|false|null }`. Only a
 * literal `true` — HA read a zone and it was not home — can lock.
 */
function displayState(thisRoom, arbitration, home, inferred = null) {
  const away = home && home.away;
  // ⚠ "Audible somewhere" is too weak to overrule geolocation. Caught the
  // moment Nick left the house: every sensor had lost him except the bedroom,
  // which still heard a faint -87 — enough for `status: present`, and the lock
  // was refused for a man who had gone out. Refusing a lock is a claim that he
  // is HERE, so it takes a sensor willing to say he is in ITS room.
  const heard = !!(arbitration && arbitration.rooms
    && arbitration.rooms.some(r => r.readable && r.inRoom === true));

  // ⚠ THIS ROOM'S OWN SENSOR DECIDES WHETHER HE IS IN THIS ROOM. Not the
  // arbitration, which ranks rooms by RSSI and therefore compares different
  // radios through a body — measured 31 Aug 2026, the kitchen out-read the
  // living room by 9 dB with Nick sat still in the living room, because his
  // watch was on the shielded arm. It is also Nick's original spec: "if it sees
  // the watch, SARA is visible; if not, just the clock." Arbitration survives
  // only to WORD the clock ("In the kitchen"), where being wrong costs nothing.
  const own = arbitration && arbitration.rooms
    ? arbitration.rooms.find(r => r.room === thisRoom)
    : null;
  // null (no sensor here, or it could not answer) is NOT false. A room with no
  // sensor falls through to the arbitration rather than being declared empty.
  const byOwnSensor = own && own.readable ? own.inRoom : null;

  // ⚠ THE FINGERPRINT WINS WHEN IT IS SURE, and only then. Measured on a walk
  // from the bedroom to the living room (31 Aug 2026): it tracked every leg,
  // caught the kitchen in passing, then held `living-room / sure` for sixteen
  // consecutive polls at 0.36-0.83 against 3.1 and 4.5. The threshold it
  // replaces is a hand-picked number that has now been wrong twice.
  //
  // `unsure` and `none` fall back to this room's own sensor, so an uncalibrated
  // house, a new room, or a genuinely ambiguous moment behaves exactly as it did
  // before — this can only ever be better than the threshold, never worse.
  const sureRoom = inferred && inferred.confidence === 'sure' ? inferred.room : null;
  const hereByOwnSensor = sureRoom ? (sureRoom === thisRoom) : byOwnSensor;
  const decidedBy = sureRoom ? 'fingerprint' : (byOwnSensor === null ? 'ranking' : 'threshold');

  if (away === true) {
    // ⚠ GEOLOCATION DOES NOT GET TO LOCK A SCREEN A SENSOR CAN HEAR HIM AT.
    //
    // Measured 31 Aug 2026: `zone.home` is a 100m circle whose centre is 90m
    // from where Nick actually sits, so he lives on its edge and ordinary GPS
    // jitter flips him to `not_home` while he is at home — HA said `not_home`
    // with the phone on the home wifi, geocoded to his own address, and both
    // room sensors hearing the watch. Without this rule the display blanks
    // while he is sitting in front of it, which IS the original complaint,
    // moved from BLE to GPS.
    //
    // A watch heard at -68 dB in this house is better evidence of being home
    // than a boundary fix, so the two sensors are resolved towards NOT doing
    // the harmful thing. The cost is stated rather than hidden: a watch left
    // at home on charge holds the screen unlocked while Nick is out. He wears
    // it overnight, so it leaves when he does.
    //
    // The lock still works for the case it exists for — actually leaving, with
    // the watch on the wrist, so both sensors agree. And a watch that cannot be
    // heard (absent, or every sensor deaf) does NOT rescue it: `not_home` is a
    // positive statement, where a deaf sensor is only ever an absence of one.
    if (heard) {
      const here = hereByOwnSensor === true
        || (hereByOwnSensor === null && arbitration.room === thisRoom);
      return {
        state: here ? 'full' : 'clock',
        reason: 'home-contradicted',
        say: here ? null : `In the ${sureRoom || arbitration.room}.`,
        contradiction: `Home Assistant says not home, but the watch is audible in the ${arbitration.room}. Trusting the watch.`,
      };
    }
    return {
      state: 'locked',
      reason: 'not-home',
      say: 'Away from home — screen off.',
      decidedBy,
    };
  }

  if (hereByOwnSensor === true) {
    return { state: 'full', reason: 'watch-in-room', say: null, decidedBy };
  }
  // No sensor in this room, or it could not answer: fall back to the ranking
  // rather than assert he is absent from a room nothing is watching.
  if (hereByOwnSensor === null && arbitration && arbitration.room === thisRoom) {
    return { state: 'full', reason: 'watch-in-room-by-ranking', say: null, decidedBy };
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
      decidedBy,
    };
  }
  if (arbitration.status === 'absent') {
    return { state: 'clock', reason: 'watch-not-here', say: arbitration.why, decidedBy };
  }
  return {
    state: 'clock',
    reason: 'watch-in-another-room',
    say: `In the ${sureRoom || arbitration.room}.`,
    decidedBy,
  };
}

module.exports = { resolveRoom, displayState, SENSOR_STALE_MS, SWITCH_MARGIN_DB };
