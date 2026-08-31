'use strict';

// Home Assistant integration — reads phone sensors, presence, and environment
// from the HA server running on the Pi (Companion app reports into HA).
// Pattern mirrors services/location.js: env-gated, HTTP pull, cached context block.

const HA_URL = (process.env.HA_URL || 'http://localhost:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';
// Entity prefix for the phone reporting via the Companion app (e.g. nicks_iphone)
const PHONE_PREFIX = process.env.HA_PHONE_PREFIX || 'nicks_iphone';
// person.<id> entity tracked for presence
const PERSON_ID = process.env.HA_PERSON_ID || 'nick';

function isConfigured() {
  return !!(HA_URL && HA_TOKEN);
}

// --- Core API -------------------------------------------------------------

async function fetchStates() {
  const res = await fetch(`${HA_URL}/api/states`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HA API error: ${res.status}`);
  return res.json();
}

// 60s in-memory cache — phone state changes often but chat/journal calls
// can burst, so avoid hammering the HA API within a single interaction.
let _cache = { at: 0, states: null };

async function getStates() {
  if (!isConfigured()) return [];
  if (_cache.states && Date.now() - _cache.at < 60_000) return _cache.states;
  try {
    const states = await fetchStates();
    _cache = { at: Date.now(), states };
    return states;
  } catch (e) {
    console.warn('[HA] Failed to fetch states:', e.message);
    return _cache.states || [];
  }
}

async function getEntity(entityId) {
  const states = await getStates();
  return states.find(e => e.entity_id === entityId) || null;
}

function pick(states, entityId) {
  const e = states.find(s => s.entity_id === entityId);
  return e ? e.state : null;
}

/**
 * When HA last heard from an entity, as an ISO string, or null.
 *
 * ⚠ Load-bearing. A state in `/api/states` is the LAST KNOWN value, not a
 * current one, and HA serves it identically whether it arrived a second ago or
 * a month ago. The Companion app stopped reporting on 22 July 2026 and every
 * `nicks_iphone` entity has sat frozen since — so `person.nick` still answered
 * "Office" with a full GPS fix, 33 days out of date, and anything reading it
 * without this timestamp treats a month-old position as where Nick is standing.
 */
function pickUpdatedAt(states, entityId) {
  const e = states.find(s => s.entity_id === entityId);
  return e ? (e.last_updated || e.last_changed || null) : null;
}

function isUsable(v) {
  return v && !['unavailable', 'unknown', 'none'].includes(String(v).toLowerCase());
}

// --- Which entities are actually the phone? -------------------------------
//
// ⚠ The Companion app did NOT stop reporting (31 Aug 2026). It re-registered,
// HA created a SECOND device, and every sensor moved to a `_2` suffix —
// `sensor.nicks_iphone_battery_level` became `sensor.nicks_iphone_battery_level_2`.
// Measured live: of everything matching `nicks_iphone`, exactly TWO entities
// carry no suffix and both are `unavailable` camera entities, while 28 suffixed
// ones were updating normally (newest reading last night).
//
// So every read in this file resolved to a non-existent entity and returned
// null, for five weeks, while the data sat in HA the whole time. NEURO reported
// "presence: could not read" and the comment above `pickUpdatedAt` blamed the
// phone. The staleness detection it describes is GOOD and stays — it was right
// that the old entities were frozen, and wrong about why.
//
// The fix is discovery, not a new hardcoded guess: `_2` would be wrong again the
// next time the phone re-registers, and it would fail exactly as silently. The
// family that is actually REPORTING is the phone, and which one answered is
// always named (`working-days.status()`'s rule) so a surprise is visible rather
// than absorbed.

// PURE. Takes the states array and the configured base, returns which entity
// family to read and how that was decided. No network, no clock beyond the
// timestamps in the data.
function resolvePhonePrefix(states = [], base = PHONE_PREFIX) {
  const families = new Map();

  for (const e of states) {
    if (!e || typeof e.entity_id !== 'string') continue;
    // `_battery_level` is the anchor: every Companion install reports it, it is
    // never `unavailable` on a live phone, and it cannot collide with an
    // unrelated entity the way a bare device_tracker can.
    const m = /^sensor\.(.+)_battery_level$/.exec(e.entity_id);
    if (!m) continue;
    const prefix = m[1];
    if (prefix !== base && !prefix.startsWith(`${base}_`)) continue;
    if (!isUsable(e.state)) continue;
    const at = Date.parse(e.last_updated || e.last_changed || '') || 0;
    families.set(prefix, Math.max(families.get(prefix) || 0, at));
  }

  if (!families.size) {
    // Nothing matched. Fall back to the configured name so behaviour is exactly
    // what it was, and SAY so — "we could not find the phone" must not read the
    // same as "the phone is quiet".
    return { prefix: base, source: 'none', reportingAt: null, candidates: [] };
  }

  const ranked = [...families.entries()].sort((a, b) => b[1] - a[1]);
  const [prefix, at] = ranked[0];
  return {
    prefix,
    source: prefix === base ? 'configured' : 'discovered',
    reportingAt: at ? new Date(at).toISOString() : null,
    candidates: ranked.map(([name, t]) => ({ prefix: name, at: t ? new Date(t).toISOString() : null })),
  };
}

// Logged once per changed answer rather than per call — this runs on every chat
// turn and every context read, and a line per call would bury it.
let _lastPrefixLogged = null;
function phonePrefix(states) {
  const r = resolvePhonePrefix(states);
  if (r.prefix !== _lastPrefixLogged) {
    _lastPrefixLogged = r.prefix;
    if (r.source === 'discovered') {
      console.log(`[HA] Phone entities resolved to "${r.prefix}" (configured "${PHONE_PREFIX}" is not reporting) — ${r.candidates.length} candidate(s)`);
    } else if (r.source === 'none') {
      console.warn(`[HA] No reporting phone entities found for "${PHONE_PREFIX}" — presence and phone sensors will read null`);
    }
  }
  return r;
}

// --- Convenience views ----------------------------------------------------

// Phone + presence snapshot — the data the Companion app actually reports.
async function getPhoneStatus() {
  const states = await getStates();
  if (!states.length) return null;

  const resolved = phonePrefix(states);
  const P = resolved.prefix;

  const presence = pick(states, `person.${PERSON_ID}`)
    || pick(states, `device_tracker.${P}`);
  const battery = pick(states, `sensor.${P}_battery_level`);
  const batteryState = pick(states, `sensor.${P}_battery_state`);
  const ssid = pick(states, `sensor.${P}_ssid`);
  const connection = pick(states, `sensor.${P}_connection_type`);
  const geocoded = pick(states, `sensor.${P}_geocoded_location`);

  // Sensors the Companion app has always reported and NEURO has never read.
  // `activity` is the CoreMotion classification — Still / Walking / Running /
  // Automotive / Cycling — which is the accelerometer-derived answer to "what is
  // he physically doing", and it is the input half of SARA's examples need.
  // Read here, consumed nowhere yet: plumbing first, behaviour as its own
  // decision, or this becomes a nudge machine built on an unverified feed.
  const activity = pick(states, `sensor.${P}_activity`);
  const steps = pick(states, `sensor.${P}_steps`);
  const distance = pick(states, `sensor.${P}_distance`);
  const floors = pick(states, `sensor.${P}_floors_ascended`);
  const audioOutput = pick(states, `sensor.${P}_audio_output`);
  // Focus mode — Nick has explicitly told the phone to leave him alone, which is
  // a stronger and more current signal than any inference SARA could make.
  const focus = pick(states, `binary_sensor.${P}_focus`);

  // How old the presence reading is. Reported, never enforced here — what
  // counts as "too old" depends on the question being asked, so the caller
  // decides. This module's job is to stop pretending it doesn't matter.
  const presenceUpdatedAt = pickUpdatedAt(states, `person.${PERSON_ID}`)
    || pickUpdatedAt(states, `device_tracker.${P}`);
  const ageMs = presenceUpdatedAt ? Date.now() - new Date(presenceUpdatedAt).getTime() : null;

  return {
    presence: isUsable(presence) ? presence : null,
    presenceUpdatedAt,
    presenceAgeHours: Number.isFinite(ageMs) ? Math.round((ageMs / 3600000) * 10) / 10 : null,
    batteryLevel: isUsable(battery) ? Number(battery) : null,
    batteryState: isUsable(batteryState) ? batteryState : null,
    ssid: isUsable(ssid) ? ssid : null,
    connectionType: isUsable(connection) ? connection : null,
    geocodedLocation: isUsable(geocoded) ? geocoded : null,

    // Motion and attention. Every one is null when absent rather than a
    // stand-in — "we did not read it" and "he is not moving" are opposite facts
    // and only one of them licenses SARA to say anything.
    activity: isUsable(activity) ? activity : null,
    activityUpdatedAt: pickUpdatedAt(states, `sensor.${P}_activity`),
    steps: isUsable(steps) ? Number(steps) : null,
    distanceM: isUsable(distance) ? Number(distance) : null,
    floorsAscended: isUsable(floors) ? Number(floors) : null,
    audioOutput: isUsable(audioOutput) ? audioOutput : null,
    focusMode: isUsable(focus) ? focus === 'on' : null,

    // Which entity family answered, and when it last said anything. Carried on
    // the payload so a caller can tell a quiet phone from a phone NEURO cannot
    // find — the distinction that hid this bug for five weeks.
    source: {
      prefix: resolved.prefix,
      resolvedBy: resolved.source,
      configuredPrefix: PHONE_PREFIX,
      reportingAt: resolved.reportingAt,
    },
  };
}

/**
 * Position history for the phone, as `{ lat, lon, tst }` points.
 *
 * The shape is OwnTracks' on purpose — `location.clusterPoints()` was written
 * against the recorder's API and is good code that has simply never had data.
 * Matching the shape means the clustering, the dwell rules and the whole
 * archive downstream stay untouched: this is a new SOURCE, not a new pipeline.
 *
 * `tst` is epoch SECONDS, again matching OwnTracks — the caller multiplies by
 * 1000 to build dates, so milliseconds here would produce dwells in the year
 * 57000 rather than an obvious error.
 *
 * Returns [] on any failure. That is safe ONLY because the caller treats an
 * empty result as "this source had nothing" and falls through, rather than as
 * "Nick went nowhere" — see location.getTodayPoints.
 */
async function getLocationPoints(fromIso, toIso) {
  if (!isConfigured()) return [];
  // Same resolution as getPhoneStatus, and for the same reason: this asked for
  // `device_tracker.nicks_iphone`, which has not existed since the phone
  // re-registered, so the history call returned an empty series every time and
  // the caller correctly read that as "this source had nothing".
  const entity = `device_tracker.${phonePrefix(await getStates()).prefix}`;
  const url = `${HA_URL}/api/history/period/${encodeURIComponent(fromIso)}`
    + `?filter_entity_id=${encodeURIComponent(entity)}`
    + (toIso ? `&end_time=${encodeURIComponent(toIso)}` : '');
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HA history ${res.status}`);
    const data = await res.json();
    const series = Array.isArray(data) && data.length ? data[0] : [];
    const points = [];
    for (const row of series) {
      const a = row && row.attributes;
      if (!a || typeof a.latitude !== 'number' || typeof a.longitude !== 'number') continue;
      // A fix wider than the clustering radius cannot say which place it was,
      // and one bad reading drags a cluster's centre far enough to invent a
      // visit that never happened. 500m is well outside the 200m cluster radius
      // but still admits ordinary indoor/cell-tower fixes.
      if (typeof a.gps_accuracy === 'number' && a.gps_accuracy > 500) continue;
      const t = Date.parse(row.last_updated || row.last_changed || '');
      if (!Number.isFinite(t)) continue;
      points.push({ lat: a.latitude, lon: a.longitude, tst: Math.floor(t / 1000) });
    }
    return points;
  } catch (e) {
    console.warn('[HA] Location history fetch failed:', e.message);
    return [];
  }
}

// Markdown context block for Claude chat — mirrors location.getLocationContextBlock().
async function getHaContextBlock() {
  if (!isConfigured()) return null;
  try {
    const states = await getStates();
    if (!states.length) return null;

    const phone = await getPhoneStatus();
    const weather = states.find(s => s.entity_id.startsWith('weather.'));

    const lines = [];
    if (phone?.presence) lines.push(`- Presence: ${phone.presence}`);
    if (phone?.batteryLevel != null) {
      const charging = phone.batteryState && phone.batteryState !== 'Not Charging'
        ? ` (${phone.batteryState})` : '';
      lines.push(`- Phone battery: ${phone.batteryLevel}%${charging}`);
    }
    if (phone?.ssid) lines.push(`- Wi‑Fi: ${phone.ssid}`);
    if (phone?.geocodedLocation) lines.push(`- Location: ${phone.geocodedLocation}`);
    if (weather && isUsable(weather.state)) {
      const temp = weather.attributes?.temperature;
      const unit = weather.attributes?.temperature_unit || '°C';
      lines.push(`- Weather: ${weather.state}${temp != null ? `, ${temp}${unit}` : ''}`);
    }

    if (!lines.length) return null;
    return `## Home Assistant\n${lines.join('\n')}`;
  } catch (e) {
    console.warn('[HA] Context block failed:', e.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  resolvePhonePrefix,
  getStates,
  getEntity,
  getPhoneStatus,
  getLocationPoints,
  getHaContextBlock,
};
