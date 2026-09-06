'use strict';

/**
 * device-status — what the phone says about ITSELF.
 *
 * Battery, CoreMotion activity, step count, connectivity, focus. Every one of
 * these is a sensor the phone already owns, and NEURO currently learns about
 * them by asking Home Assistant, which learns about them from the HA iOS
 * Companion app. A native app removes the two middlemen; HA is then kept for
 * smart-home ACTUATION, which is the only thing it is uniquely able to do.
 *
 * ⚠ THIS DOES NOT REPLACE `ha.getPhoneStatus()` — it FEEDS it. Two fields have
 * no native equivalent Nick can currently ship: `ssid` needs the Access WiFi
 * Information entitlement (paid account only), and `audioOutput` has no
 * third-party API at all. Cutting HA out wholesale would silently drop them, so
 * `merge()` below is a field-level fallback rather than a swap.
 *
 * ⚠ A STALE DEVICE REPORT MUST NOT WIN. A phone whose signature expired three
 * days ago still has a row in this table saying `Walking`, and that row is worse
 * than Home Assistant's current answer — it is confidently wrong rather than
 * merely absent. Freshness gates the whole device side in `merge()`.
 *
 * Validation is pure and the database is required lazily, for the same reason
 * as `location-points`: the wire contract should pin without a compiled native
 * module installed.
 */

/**
 * How long a self-report stays authoritative, in minutes.
 *
 * Shorter than the location feed's six hours because these answer "what is he
 * doing NOW". Battery and activity are reported on a timer rather than on
 * movement, so a healthy phone refreshes them well inside this; going quiet for
 * half an hour means the app is not running.
 */
const STALE_AFTER_MINUTES = 30;

/**
 * The CoreMotion activity vocabulary, which is also Home Assistant's.
 *
 * ⚠ Kept identical to the strings the Companion app already reports, because
 * `getPhoneStatus()` consumers switch on them. A native app inventing
 * `driving` where HA said `Automotive` would silently miss every branch.
 */
const ACTIVITIES = ['Still', 'Walking', 'Running', 'Cycling', 'Automotive', 'Unknown'];

const BATTERY_STATES = ['charging', 'discharging', 'full', 'unplugged', 'unknown'];

/** Fields the device may report. Anything else is kept in `payload`, not dropped. */
const MODELLED_FIELDS = [
  'batteryLevel', 'batteryState', 'connectionType', 'ssid', 'geocodedLocation',
  'activity', 'activitySince', 'steps', 'distanceM', 'floorsAscended', 'focusMode',
];

// ── Pure validation ──────────────────────────────────────────────────────────

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isIsoish(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/**
 * Validate a self-report. PURE.
 *
 * ⚠ ABSENT IS NOT ZERO, anywhere in here. A report that omits `steps` means the
 * app could not read the pedometer; a report with `steps: 0` means he has not
 * moved. Defaulting the first to the second is how a broken sensor comes to
 * read as a sedentary day — the same distinction `getPhoneStatus()` already
 * protects by nulling rather than substituting.
 *
 * A field that is present but malformed is REJECTED BY NAME rather than
 * dropped, so a client bug is visible instead of looking like a quiet sensor.
 */
function validate(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'body must be an object' };
  }

  const deviceId = raw.deviceId;
  if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 200) {
    return { ok: false, reason: 'deviceId is required' };
  }

  // `reportedAt` is when the DEVICE observed this, and it is mandatory. Without
  // it the Pi would have to stamp arrival time, which erases the difference
  // between a live report and one that sat in an offline queue for four hours.
  if (!isIsoish(raw.reportedAt)) {
    return { ok: false, reason: 'reportedAt is required and must be an ISO timestamp' };
  }
  // Clock skew, same rule as the position feed. A report from the future would
  // outrank every real one for ever, because the write is guarded on
  // `reported_at` moving forward.
  if (Date.parse(raw.reportedAt) > nowMs + 5 * 60 * 1000) {
    return { ok: false, reason: 'reportedAt is in the future' };
  }

  const out = { deviceId: deviceId.trim(), reportedAt: new Date(Date.parse(raw.reportedAt)).toISOString() };

  if (raw.batteryLevel != null) {
    if (!isFiniteNumber(raw.batteryLevel)) return { ok: false, reason: 'batteryLevel must be a number' };
    // iOS reports 0.0–1.0; Home Assistant reports 0–100. Accept the iOS shape
    // and convert, because the value that reaches consumers must match what HA
    // has always given them — a 0.42 rendered as "42%" is a one-character bug
    // nobody would see until the battery warning never fired.
    const pct = raw.batteryLevel <= 1 ? raw.batteryLevel * 100 : raw.batteryLevel;
    if (pct < 0 || pct > 100) return { ok: false, reason: 'batteryLevel out of range' };
    out.batteryLevel = Math.round(pct * 10) / 10;
  } else out.batteryLevel = null;

  if (raw.batteryState != null) {
    const s = String(raw.batteryState).toLowerCase();
    if (!BATTERY_STATES.includes(s)) return { ok: false, reason: `batteryState must be one of ${BATTERY_STATES.join(', ')}` };
    out.batteryState = s;
  } else out.batteryState = null;

  if (raw.activity != null) {
    // Case-insensitive in, canonical out — the app should not have to know that
    // HA capitalises, but consumers switching on the value must see one casing.
    const match = ACTIVITIES.find((a) => a.toLowerCase() === String(raw.activity).toLowerCase());
    if (!match) return { ok: false, reason: `activity must be one of ${ACTIVITIES.join(', ')}` };
    out.activity = match;
  } else out.activity = null;

  if (raw.activitySince != null) {
    if (!isIsoish(raw.activitySince)) return { ok: false, reason: 'activitySince must be an ISO timestamp' };
    out.activitySince = new Date(Date.parse(raw.activitySince)).toISOString();
  } else out.activitySince = null;

  for (const [key, label] of [['steps', 'steps'], ['distanceM', 'distanceM'], ['floorsAscended', 'floorsAscended']]) {
    if (raw[key] != null) {
      if (!isFiniteNumber(raw[key])) return { ok: false, reason: `${label} must be a number` };
      if (raw[key] < 0) return { ok: false, reason: `${label} must not be negative` };
      out[key] = raw[key];
    } else out[key] = null;
  }

  for (const key of ['connectionType', 'ssid', 'geocodedLocation']) {
    if (raw[key] != null) {
      if (typeof raw[key] !== 'string' || raw[key].length > 500) {
        return { ok: false, reason: `${key} must be a string` };
      }
      out[key] = raw[key].trim() || null;
    } else out[key] = null;
  }

  if (raw.focusMode != null) {
    if (typeof raw.focusMode !== 'boolean') return { ok: false, reason: 'focusMode must be a boolean' };
    out.focusMode = raw.focusMode;
  } else out.focusMode = null;

  // Anything the app sends that NEURO does not yet model is KEPT rather than
  // discarded, so a sensor can ship on the phone before the Pi learns to read
  // it. Named explicitly so this cannot become a dumping ground for the
  // modelled fields under a second spelling.
  const extras = {};
  for (const k of Object.keys(raw)) {
    if (k === 'deviceId' || k === 'reportedAt') continue;
    if (MODELLED_FIELDS.includes(k)) continue;
    extras[k] = raw[k];
  }
  out.payload = Object.keys(extras).length ? extras : null;

  return { ok: true, status: out };
}

// ── Freshness ────────────────────────────────────────────────────────────────

/**
 * How old a report is, and whether it still counts. PURE.
 *
 * Same three-state discipline as the position feed: `known:false` (nothing has
 * ever arrived — and therefore NO age, because rendering "never" as 0 minutes
 * reads as perfectly fresh), stale, or live.
 */
function assessFreshness(row, now = new Date(), staleAfterMinutes = STALE_AFTER_MINUTES) {
  if (!row || !row.reported_at) {
    return {
      known: false,
      why: 'no device has ever reported its status',
      stale: null,
      ageMinutes: null,
      reportedAt: null,
      deviceId: null,
      staleAfterMinutes,
    };
  }
  const ageMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(row.reported_at)) / 60000));
  return {
    known: true,
    stale: ageMinutes > staleAfterMinutes,
    ageMinutes,
    reportedAt: row.reported_at,
    deviceId: row.device_id || null,
    staleAfterMinutes,
    why: ageMinutes > staleAfterMinutes
      ? `the device has not reported for ${ageMinutes} minutes`
      : null,
  };
}

// ── The merge ────────────────────────────────────────────────────────────────

/** Turn a stored row into the camelCase shape `getPhoneStatus()` speaks. */
function rowToStatus(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    reportedAt: row.reported_at,
    batteryLevel: row.battery_level,
    batteryState: row.battery_state,
    connectionType: row.connection_type,
    ssid: row.ssid,
    geocodedLocation: row.geocoded_location,
    activity: row.activity,
    activitySince: row.activity_since,
    steps: row.steps,
    distanceM: row.distance_m,
    floorsAscended: row.floors_ascended,
    focusMode: row.focus_mode == null ? null : row.focus_mode === 1,
  };
}

/**
 * Field-level merge of the device's own report over Home Assistant's. PURE.
 *
 * The device wins where it has an answer; HA fills the rest. That ordering is
 * the point of the whole exercise — the phone is the ORIGIN of every one of
 * these readings, and HA is a relay that adds latency and a dependency.
 *
 * Three rules, each of which is a way this could quietly go wrong:
 *
 *  1. ⚠ A STALE DEVICE REPORT IS IGNORED ENTIRELY, not merged. A phone whose
 *     signature lapsed three days ago still has a row saying `Walking`; letting
 *     it win makes NEURO confidently wrong, which is worse than the absence it
 *     is covering for. Below the freshness line the device contributes nothing.
 *  2. ⚠ NULL FROM THE DEVICE MEANS "I COULD NOT READ IT", so it falls through
 *     to HA rather than overriding a good HA value with nothing. This is why
 *     the merge is per-field and not per-payload: `ssid` and `audioOutput` have
 *     no native source Nick can ship today, and a wholesale swap would drop
 *     them without a word.
 *  3. Every field's origin is reported in `sources`. A caller that cannot tell
 *     which feed answered cannot tell a live phone from a stale relay, and this
 *     repo has already lost five weeks to exactly that ambiguity.
 */
function merge({ device, ha, now = new Date(), staleAfterMinutes = STALE_AFTER_MINUTES } = {}) {
  const base = ha ? { ...ha } : {};
  const sources = {};

  const freshness = assessFreshness(
    device ? { reported_at: device.reportedAt, device_id: device.deviceId } : null,
    now,
    staleAfterMinutes
  );
  const deviceUsable = freshness.known && !freshness.stale;

  const FIELDS = [
    'batteryLevel', 'batteryState', 'connectionType', 'ssid', 'geocodedLocation',
    'activity', 'activitySince', 'steps', 'distanceM', 'floorsAscended', 'focusMode',
  ];

  for (const f of FIELDS) {
    const dv = deviceUsable && device ? device[f] : null;
    if (dv != null) {
      base[f] = dv;
      sources[f] = 'device';
    } else if (base[f] != null) {
      sources[f] = 'home-assistant';
    } else {
      // Neither feed had it. Named so a consumer can say "not read" rather than
      // rendering a null as a fact.
      base[f] = null;
      sources[f] = null;
    }
  }

  // The device knows when IT last spoke; HA knows when the Companion app last
  // did. The newest of the two is the honest answer to "is this phone alive".
  const candidates = [base.lastReportAt, deviceUsable && device ? device.reportedAt : null]
    .filter(Boolean)
    .sort();
  base.lastReportAt = candidates.length ? candidates[candidates.length - 1] : null;

  base.sources = { ...(ha && ha.source ? { ha: ha.source } : {}), fields: sources, device: freshness };
  return base;
}

// ── Storage ──────────────────────────────────────────────────────────────────

/**
 * Persist a validated report.
 *
 * Returns `{ stored }` — false when an OLDER report was correctly ignored. The
 * device is told, because a phone whose every report is superseded is draining
 * a queue in the wrong order and that is invisible from a 200 alone.
 */
function store(status) {
  const db = require('../db/database');
  return { stored: db.saveDeviceStatus(status) };
}

/** The latest self-report as a camelCase status, or null. */
function latest() {
  try {
    return rowToStatus(require('../db/database').getLatestDeviceStatus());
  } catch {
    return null;
  }
}

/**
 * Freshness of the device self-report feed.
 *
 * ⚠ A read failure is reported as `readable:false` rather than folded into
 * `known:false` — "the database would not answer" and "the phone has never
 * reported" send you to different fixes.
 */
function freshness(now = new Date()) {
  let row;
  try {
    row = require('../db/database').getLatestDeviceStatus();
  } catch (e) {
    return {
      readable: false,
      known: false,
      why: `could not read the device status store: ${e.message}`,
      stale: null,
      ageMinutes: null,
      reportedAt: null,
      deviceId: null,
      staleAfterMinutes: STALE_AFTER_MINUTES,
    };
  }
  return { readable: true, ...assessFreshness(row, now) };
}

module.exports = {
  ACTIVITIES,
  BATTERY_STATES,
  MODELLED_FIELDS,
  STALE_AFTER_MINUTES,
  validate,
  assessFreshness,
  rowToStatus,
  merge,
  store,
  latest,
  freshness,
};
