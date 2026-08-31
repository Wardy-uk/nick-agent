'use strict';

/**
 * One phrase for where Nick is, whichever scale the answer happens to be at.
 *
 * The room sensors answer at house scale; Home Assistant's zones answer at town
 * scale. They are not competing readings — they are the same question at
 * different resolutions — so this picks the finest one that is actually known
 * and says which it used.
 *
 * `describe()` is PURE (takes the two reads, no I/O, no clock), so the rules pin
 * without a house or a Home Assistant.
 *
 * ── Why `home` is deliberately NOT rendered ─────────────────────────────────
 *
 * ⚠ THE HOME GEOFENCE IS MEASURABLY BROKEN and must not be used to say anything.
 * Measured 31 Aug 2026: `zone.home` is a 100m circle whose centre is 90m from
 * where Nick actually sits, so he lives on its edge and ordinary GPS jitter
 * reports `not_home` while he is at home — with the phone on the home wifi and
 * geocoded to his own address. Rendering "Out" from that would tell his family
 * he had left the house while he sat in the living room.
 *
 * So: a named zone that is NOT home is trustworthy (the office zone is 150m
 * wide and twenty miles away — no boundary problem), and `home` / `not_home`
 * are treated as no answer at all. That asymmetry is not tidiness, it is the
 * only honest reading of the evidence.
 *
 * ⚠ And silence beats a hedge. Everything unknown returns `known: false` with a
 * reason, and every surface renders NOTHING rather than "unknown" — a banner
 * that permanently says it does not know is one nobody reads by week two.
 *
 * CommonJS — NEURO backend convention.
 */

// Zones whose name is not what a person would say out loud. Anything not listed
// renders as "At <Zone>", which is why the map is small and stays small.
const ZONE_PHRASING = {
  office: 'At Work',
  work: 'At Work',
};

// Not places. HA uses these for "in the home zone" and "in no zone at all", and
// both are unusable here for the reason above.
const NON_PLACES = new Set(['home', 'not_home', 'unknown', 'unavailable', '']);

/** "living-room" is a sensor id; a person reads "Living Room". */
function roomLabel(room) {
  if (!room) return null;
  return String(room)
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function zoneLabel(zone) {
  const key = String(zone || '').trim().toLowerCase();
  if (!key || NON_PLACES.has(key)) return null;
  if (ZONE_PHRASING[key]) return ZONE_PHRASING[key];
  // Title-case whatever the zone is actually called, so a zone Nick adds later
  // works without a code change.
  return `At ${key.charAt(0).toUpperCase() + key.slice(1)}`;
}

/**
 * @param {object} room  `room-presence.read()` shape — `{ known, room, why }`
 * @param {string} zone  the HA zone name, or null
 * @returns {{known, label, kind, room, subject, why}}
 *   kind: 'room' | 'zone' | null
 */
function describe(room, zone) {
  // Finest first. A room reading beats a zone because being in the kitchen is
  // strictly more informative than being at home, and the room sensors cannot
  // hear him at all unless he is in the house.
  if (room && room.known && room.room) {
    return {
      known: true,
      label: roomLabel(room.room),
      kind: 'room',
      room: room.room,
      // ⚠ It measured the WATCH. Carried so nothing downstream can quietly
      // promote it to a claim about where the man is.
      subject: room.subject || 'watch',
      why: null,
    };
  }

  const zl = zoneLabel(zone);
  if (zl) {
    return { known: true, label: zl, kind: 'zone', room: null, subject: 'phone', why: null };
  }

  return {
    known: false,
    label: null,
    kind: null,
    room: null,
    subject: null,
    // The room reader's own words where it has them — it knows whether it was
    // uncalibrated, unsure, or unable to reach SARA.
    why: (room && room.why) || 'no location signal',
  };
}

module.exports = { describe, roomLabel, zoneLabel, ZONE_PHRASING, NON_PLACES };
