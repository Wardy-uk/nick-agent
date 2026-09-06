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

/**
 * The cached states, WITHOUT a network call. For the status page, which renders
 * a row per sense and must not add an HTTP round trip per render. Returns null
 * when nothing has been fetched yet — "not cached" and "no entities" are
 * different facts and the caller says so.
 */
function cachedStates() {
  return _cache.states && _cache.states.length ? _cache.states : null;
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

/**
 * When the entity last CHANGED VALUE, which is a different question from when
 * it last reported. HA keeps both, and the difference is the whole answer to
 * "how long has he been sitting still": `last_updated` moves on every report,
 * `last_changed` only when Still stopped being Walking.
 */
function pickChangedAt(states, entityId) {
  const e = states.find(s => s.entity_id === entityId);
  return e ? (e.last_changed || e.last_updated || null) : null;
}

function isUsable(v) {
  return v && !['unavailable', 'unknown', 'none'].includes(String(v).toLowerCase());
}

// --- Which entities are actually the phone? -------------------------------
//
// ⚠ The Companion app did NOT stop reporting (31 Aug 2026). It re-registered,
// HA created a SECOND set of entities, and Home Assistant disambiguated them by
// appending `_2` to the ENTITY ID — not to the device prefix:
//
//     sensor.nicks_iphone_battery_level    ->  sensor.nicks_iphone_battery_level_2
//     sensor.nicks_iphone_activity         ->  sensor.nicks_iphone_activity_2
//     device_tracker.nicks_iphone          ->  device_tracker.nicks_iphone_2
//
// Measured live: of everything matching `nicks_iphone`, exactly TWO entities
// carry no suffix and both are `unavailable` camera entities, while 28 suffixed
// ones update normally. So the entities this file asked for did not merely hold
// stale values, they did not EXIST — every read returned null for five weeks
// while the data sat in HA, and the comment above `pickUpdatedAt` blamed the
// phone. That staleness detection is GOOD and stays: it was right that the old
// entities were frozen and wrong about why.
//
// ⚠ Note `device_tracker.nicks_iphone_2` — for the tracker, whose entity id IS
// the device name, the suffix looks exactly like a longer prefix. That is what
// makes "just set HA_PHONE_PREFIX=nicks_iphone_2" so tempting, and it is wrong:
// it resolves the tracker and breaks every sensor, because those want
// `sensor.nicks_iphone_battery_level_2`, not `sensor.nicks_iphone_2_battery_level`.
// The Pi's .env had been set that way, which is why presence still answered
// while battery, wifi and location stayed null.
//
// So what is resolved is a SUFFIX, decided once from the battery anchor and
// applied to every entity — resolving per sensor would let two registrations
// mix on one payload. Discovery rather than a hardcoded `_2`, because the next
// re-registration would break it again and would do so just as silently.

// Every entity id that belongs to THIS phone, so `phoneEntity` can resolve the
// suffix PER KEY rather than assuming one holds device-wide. Scoped to the base
// deliberately: a set carrying every entity in HA would pull other people's
// devices into this object, which is both wrong and noisy to log.
function _phoneEntityIds(states, base) {
  const esc = String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The boundary matters — `nicks_iphonex_*` is a different device.
  const re = new RegExp(`^[a-z_]+\\.${esc}(?:_.+)?$`);
  const out = new Set();
  for (const e of states) {
    if (!e || typeof e.entity_id !== 'string') continue;
    if (re.test(e.entity_id)) out.add(e.entity_id);
  }
  return out;
}

// PURE. Returns the suffix to append to every phone entity id, and how that was
// decided. No network, no clock beyond the timestamps in the data.
function resolvePhoneEntities(states = [], configured = PHONE_PREFIX) {
  // Tolerate an .env already pointing at a suffixed name: `nicks_iphone_2` is a
  // reasonable thing for a person to have set, and it is the wrong shape rather
  // than a typo, so it is corrected instead of refused.
  const base = String(configured || '').replace(/_\d+$/, '');

  // Which ids actually exist, so `phoneEntity` can decide per key.
  const ids = _phoneEntityIds(states, base);

  // `_battery_level` is the anchor: every Companion install reports it, it is
  // never `unavailable` on a live phone, and it cannot collide with an
  // unrelated entity the way a bare device_tracker can.
  const re = new RegExp(`^sensor\\.${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_battery_level(_\\d+)?$`);

  const found = [];
  for (const e of states) {
    if (!e || typeof e.entity_id !== 'string') continue;
    const m = re.exec(e.entity_id);
    if (!m) continue;
    // HA serves a dead entity's last known value identically to a live one, so
    // "it exists" is not "it is reporting".
    if (!isUsable(e.state)) continue;
    found.push({
      suffix: m[1] || '',
      at: Date.parse(e.last_updated || e.last_changed || '') || 0,
      entityId: e.entity_id,
    });
  }

  if (!found.length) {
    // "We could not find the phone" must not read the same as "the phone is
    // quiet". Fall back to the bare base so behaviour is the historical one.
    return { base, suffix: '', source: 'none', reportingAt: null, candidates: [], ids };
  }

  found.sort((a, b) => b.at - a.at);
  const best = found[0];
  return {
    base,
    suffix: best.suffix,
    source: best.suffix === '' && base === configured ? 'configured' : 'discovered',
    reportingAt: best.at ? new Date(best.at).toISOString() : null,
    candidates: found.map(f => ({ entityId: f.entityId, at: f.at ? new Date(f.at).toISOString() : null })),
    ids,
  };
}

/**
 * The full entity id for one phone sensor.
 *
 * ⚠ The suffix is resolved PER KEY, not device-wide (3 Sep 2026). When the
 * Companion app gained Apple Health sensors, HA created them with NO suffix —
 * `sensor.nicks_iphone_heart_rate` — while every pre-existing entity kept `_2`,
 * because the health keys had never existed under the first registration and so
 * collided with nothing. A device-wide suffix therefore asked for
 * `sensor.nicks_iphone_heart_rate_2`, which does not exist, and every health read
 * returned null — silently, and for the same reason as the five-week outage
 * above: the entity was not stale, it was absent.
 *
 * So `suffix` is a DEFAULT and the entity set is the arbiter: prefer the suffixed
 * id where it exists, fall back to the bare one, and only guess the suffixed form
 * when neither is present — which keeps the historical behaviour for an empty or
 * unreadable state list.
 */
function phoneEntity(resolved, domain, name) {
  const stem = name ? `${resolved.base}_${name}` : resolved.base;
  const suffixed = `${domain}.${stem}${resolved.suffix}`;
  const ids = resolved && resolved.ids;
  if (!ids || !ids.size) return suffixed;
  if (ids.has(suffixed)) return suffixed;
  const bare = `${domain}.${stem}`;
  if (ids.has(bare)) return bare;
  return suffixed;
}

// Logged once per changed answer rather than per call — this runs on every chat
// turn and every context read, and a line per call would bury it.
let _lastResolutionLogged = null;
function phoneResolution(states) {
  const r = resolvePhoneEntities(states);
  const key = `${r.base}${r.suffix}:${r.source}`;
  if (key !== _lastResolutionLogged) {
    _lastResolutionLogged = key;
    if (r.source === 'discovered') {
      console.log(`[HA] Phone entities resolved to "${r.base}*${r.suffix}" (configured "${PHONE_PREFIX}") — ${r.candidates.length} candidate(s), newest ${r.reportingAt}`);
    } else if (r.source === 'none') {
      console.warn(`[HA] No reporting phone entities found for "${PHONE_PREFIX}" — phone sensors will read null`);
    }
  }
  return r;
}

// --- Convenience views ----------------------------------------------------

// Phone + presence snapshot — the data the Companion app actually reports.
/**
 * The phone's status, preferring what the phone said about ITSELF.
 *
 * ⚠ The device half is a FIELD-LEVEL fallback, not a swap. Two readings here
 * have no native equivalent that can ship on free provisioning — `ssid` needs
 * the Access WiFi Information entitlement, `audioOutput` has no third-party API
 * at all — so a wholesale cutover would drop them silently. See
 * `services/device-status.js merge()` for the three rules, the important one
 * being that a STALE device report is ignored rather than merged: a phone whose
 * signature lapsed still has a row saying `Walking`, and confidently wrong is
 * worse than absent.
 *
 * ⚠ HA being unreachable is no longer fatal to this read. It used to return
 * null the moment `states` was empty, which meant a working phone reporting
 * directly still looked like no phone at all.
 */
async function getPhoneStatus() {
  const deviceStatus = require('./device-status');
  const device = deviceStatus.latest();

  const states = await getStates();
  if (!states.length) {
    // No HA, but the phone may still be reporting. Merge over an empty base so
    // every field carries its provenance exactly as it would otherwise.
    return device ? deviceStatus.merge({ device, ha: null }) : null;
  }
  return deviceStatus.merge({ device, ha: await _haPhoneStatus(states) });
}

async function _haPhoneStatus(states) {

  const resolved = phoneResolution(states);
  const E = (domain, name) => phoneEntity(resolved, domain, name);

  const presence = pick(states, `person.${PERSON_ID}`)
    || pick(states, E('device_tracker', null));
  const battery = pick(states, E('sensor', 'battery_level'));
  const batteryState = pick(states, E('sensor', 'battery_state'));
  const ssid = pick(states, E('sensor', 'ssid'));
  const connection = pick(states, E('sensor', 'connection_type'));
  const geocoded = pick(states, E('sensor', 'geocoded_location'));

  // Sensors the Companion app has always reported and NEURO has never read.
  // `activity` is the CoreMotion classification — Still / Walking / Running /
  // Automotive / Cycling — the accelerometer-derived answer to "what is he
  // physically doing", and the input half of what SARA needs to speak up at the
  // right moment. Read here, consumed NOWHERE yet: plumbing first, behaviour as
  // its own decision, or this becomes a nudge machine on an unverified feed.
  const activity = pick(states, E('sensor', 'activity'));
  const steps = pick(states, E('sensor', 'steps'));
  const distance = pick(states, E('sensor', 'distance'));
  const floors = pick(states, E('sensor', 'floors_ascended'));
  const audioOutput = pick(states, E('sensor', 'audio_output'));
  // Focus mode — Nick has explicitly told the phone to leave him alone, which is
  // stronger and more current than any inference SARA could make.
  const focus = pick(states, E('binary_sensor', 'focus'));

  // How old the presence reading is. Reported, never enforced here — what
  // counts as "too old" depends on the question being asked, so the caller
  // decides. This module's job is to stop pretending it doesn't matter.
  const presenceUpdatedAt = pickUpdatedAt(states, `person.${PERSON_ID}`)
    || pickUpdatedAt(states, E('device_tracker', null));
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
    activityUpdatedAt: pickUpdatedAt(states, E('sensor', 'activity')),
    steps: isUsable(steps) ? Number(steps) : null,
    distanceM: isUsable(distance) ? Number(distance) : null,
    floorsAscended: isUsable(floors) ? Number(floors) : null,
    audioOutput: isUsable(audioOutput) ? audioOutput : null,
    focusMode: isUsable(focus) ? focus === 'on' : null,

    // How long the CURRENT activity has been the current activity. Null when the
    // sensor is absent — a duration of zero would read as "he just sat down".
    activitySince: pickChangedAt(states, E('sensor', 'activity')),

    // ⚠ When ANY phone entity last reported, which is the liveness signal a
    // sedentary read cannot work without: a phone that is off and a phone
    // reporting `Still` look identical if you only read the activity value.
    // Battery is included deliberately — it reports on a timer rather than on
    // movement, so it keeps ticking while he genuinely is not moving.
    lastReportAt: [
      pickUpdatedAt(states, E('sensor', 'battery_level')),
      pickUpdatedAt(states, E('sensor', 'activity')),
      pickUpdatedAt(states, E('sensor', 'steps')),
      pickUpdatedAt(states, E('device_tracker', null)),
    ].filter(Boolean).sort().pop() || null,

    // Which entity family answered, and when it last said anything. Carried on
    // the payload so a caller can tell a quiet phone from a phone NEURO cannot
    // find — the distinction that hid this bug for five weeks.
    source: {
      base: resolved.base,
      suffix: resolved.suffix,
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
  const entity = phoneEntity(phoneResolution(await getStates()), 'device_tracker', null);
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
  cachedStates,
  resolvePhoneEntities,
  phoneEntity,
  getStates,
  getEntity,
  getPhoneStatus,
  getLocationPoints,
  getHaContextBlock,
};
