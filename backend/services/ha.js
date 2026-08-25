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

// --- Convenience views ----------------------------------------------------

// Phone + presence snapshot — the data the Companion app actually reports.
async function getPhoneStatus() {
  const states = await getStates();
  if (!states.length) return null;

  const presence = pick(states, `person.${PERSON_ID}`)
    || pick(states, `device_tracker.${PHONE_PREFIX}`);
  const battery = pick(states, `sensor.${PHONE_PREFIX}_battery_level`);
  const batteryState = pick(states, `sensor.${PHONE_PREFIX}_battery_state`);
  const ssid = pick(states, `sensor.${PHONE_PREFIX}_ssid`);
  const connection = pick(states, `sensor.${PHONE_PREFIX}_connection_type`);
  const geocoded = pick(states, `sensor.${PHONE_PREFIX}_geocoded_location`);

  // How old the presence reading is. Reported, never enforced here — what
  // counts as "too old" depends on the question being asked, so the caller
  // decides. This module's job is to stop pretending it doesn't matter.
  const presenceUpdatedAt = pickUpdatedAt(states, `person.${PERSON_ID}`)
    || pickUpdatedAt(states, `device_tracker.${PHONE_PREFIX}`);
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
  const entity = `device_tracker.${PHONE_PREFIX}`;
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
  getStates,
  getEntity,
  getPhoneStatus,
  getLocationPoints,
  getHaContextBlock,
};
