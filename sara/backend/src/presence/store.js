// The last reading from each room sensor. In-memory, deliberately.
//
// These are readings about RIGHT NOW with a ~3 second cadence and a 30 second
// shelf life. Persisting them would create a store whose whole content is stale
// the moment it is read back — and a stale reading that survives a restart is
// worse than no reading, because `resolveRoom` would have to distinguish
// "reported 3 seconds ago" from "reported before the last deploy" and the only
// honest answer to the second is the same as having nothing. Losing the lot on a
// restart is correct: the sensors re-report within seconds, and until they do
// the arbitration says `unknown`, which is true.
//
// ⚠ Nothing here validates that a room is one we expected. A sensor names its
// own room; an unknown name shows up as an unknown room rather than being
// dropped, because a sensor reporting under a name nobody recognises is a
// misconfiguration worth SEEING, and silently discarding it is how a Pi sits in
// a bedroom for a fortnight reporting into a hole.

'use strict';

// A cap purely so a misconfigured fleet cannot grow this without bound.
const MAX_ROOMS = 32;

const reports = new Map();

/** Accept a reading. Returns `{ ok, reason }` — never throws on bad input. */
function record(body, now = new Date()) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'no body' };
  const room = typeof body.room === 'string' ? body.room.trim() : '';
  if (!room) return { ok: false, reason: 'a reading with no room cannot be placed' };
  if (!reports.has(room) && reports.size >= MAX_ROOMS) {
    return { ok: false, reason: 'too many rooms' };
  }

  const status = ['present', 'absent', 'unknown'].includes(body.status) ? body.status : 'unknown';

  reports.set(room, {
    room,
    status,
    // `healthy` is the sensor's own "I can hear the background" flag and is the
    // difference between an empty room and a deaf radio. Absent means NOT
    // healthy: a sensor too old to send it is one we cannot vouch for.
    healthy: body.healthy === true,
    rate: Number.isFinite(body.rate) ? body.rate : null,
    rssiMedian: Number.isFinite(body.rssiMedian) ? body.rssiMedian : null,
    backgroundDevices: Number.isFinite(body.backgroundDevices) ? body.backgroundDevices : null,
    why: typeof body.why === 'string' ? body.why : null,
    // ⚠ The RECEIVED time, not the sensor's own. A sensor with a wrong clock
    // would otherwise be permanently stale or permanently fresh, and the thing
    // being measured here is "did this Pi speak to us recently", which is ours
    // to observe. The sensor's own stamp is kept alongside for diagnosis.
    at: now.toISOString(),
    sensorAt: typeof body.at === 'string' ? body.at : null,
    resets: Number.isFinite(body.resets) ? body.resets : null,
  });
  return { ok: true, room };
}

/** Everything we hold, as a plain room -> reading map. */
function all() {
  return Object.fromEntries(reports);
}

function reset() {
  reports.clear();
}

module.exports = { record, all, reset, MAX_ROOMS };
