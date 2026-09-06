'use strict';

/**
 * location-points — the device-pushed position feed.
 *
 * NEURO has always POLLED for position: OwnTracks publishes over MQTT to a
 * Recorder and `services/location.js` reads the Recorder's HTTP API. That works
 * only because three pieces of other people's software are running. A native
 * iOS app is the phone itself and has nowhere to put a point, so this module is
 * the door — and the OwnTracks chain (app + Mosquitto + Recorder) becomes
 * retirable rather than load-bearing.
 *
 * Two halves, deliberately split:
 *   • VALIDATION is pure — no DB, no clock, no network — so the wire contract
 *     pins without a database (the `pi-health.assess()` split, and the same
 *     reason `apple-health.parsePayload` is pure).
 *   • Storage and freshness live in `store()` / `freshness()` below.
 *
 * ⚠ THE POINT SHAPE IS OWNTRACKS'. `{lat, lon, tst}` with `tst` in unix SECONDS.
 * `clusterPoints()` in `services/location.js` subtracts `tst` values to get a
 * dwell duration, and every consumer downstream reads `lon` not `lng`. Emitting
 * a different shape here would mean a second clustering path, which is how the
 * two would drift.
 *
 * ⚠ NOTHING HERE REJECTS AN OLD POINT. The phone keeps an offline queue for the
 * hours it spends off the tailnet, so a batch arriving three days late is the
 * feature working, not a fault. Only the FUTURE is bounded (clock skew).
 *
 * ⚠ THE DATABASE IS REQUIRED LAZILY, INSIDE the functions that touch it, and
 * that is deliberate rather than untidy. `apple-health.js` requires nothing at
 * all, which is the only reason its wire-contract test runs without a database,
 * a network or a phone. A top-level `require('../db/database')` here would drag
 * `better-sqlite3` into the pure half and make the same claim untrue of this
 * one — the validation rules would then only pin where a compiled native module
 * is installed.
 */

/** Where a point came from, when the device does not say. */
const DEFAULT_SOURCE = 'ios';

/**
 * Accuracy ceiling in metres.
 *
 * Matches the gate the Home Assistant path already applies
 * (`services/ha.js` drops `gps_accuracy > 500`), so the two feeds cannot
 * disagree about what counts as a fix. A 2km-accurate point is a cell-tower
 * guess; clustered at a 200m radius it invents a place Nick has never been.
 */
const ACCURACY_CEILING_M = 500;

/**
 * How far into the future a timestamp may sit before it is refused, in seconds.
 *
 * Phones drift and a batch is stamped when it was RECORDED, not when it was
 * sent, so a little skew is normal. A point an hour ahead is a broken clock,
 * and storing it means `getTodayPoints()` returns tomorrow's position today.
 */
const MAX_FUTURE_SKEW_SECONDS = 300;

/**
 * Above this, a `tst` is milliseconds rather than seconds.
 *
 * ⚠ This is the single most damaging thing a client can get wrong, and it is
 * SILENT: unix milliseconds for any date after 1973 exceeds 1e11, and if stored
 * as seconds every duration computed from it is ~1000x too large. A 40-second
 * drive past a supermarket clears the 20-minute dwell floor and is recorded as
 * a visit. Refused loudly, by name, rather than clamped or divided — a client
 * sending the wrong unit needs to be told, not quietly corrected.
 */
const MILLISECONDS_THRESHOLD = 1e11;

/** Batch ceiling. An offline queue drains in chunks; it does not arrive at once. */
const MAX_POINTS_PER_REQUEST = 500;

// ── Pure validation ──────────────────────────────────────────────────────────

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate one point. PURE.
 *
 * `nowSeconds` is passed in rather than read from the clock so the future-skew
 * rule is testable without freezing time.
 *
 * Returns `{ ok: true, point }` with a normalised point, or
 * `{ ok: false, reason }`. The reason is returned to the device verbatim,
 * because a rejection the app cannot explain is a point that silently stops
 * being sent with no visible cause (`mobile-sync`'s rule).
 */
function validatePoint(raw, nowSeconds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'point must be an object' };
  }

  // Accept `lon` (OwnTracks) or `lng` (the rest of NEURO's own tables). Both
  // spellings exist in this codebase already and a client should not have to
  // know which side of the fence it is on.
  const lat = raw.lat;
  const lon = raw.lon !== undefined ? raw.lon : raw.lng;

  if (!isFiniteNumber(lat)) return { ok: false, reason: 'lat must be a finite number' };
  if (!isFiniteNumber(lon)) return { ok: false, reason: 'lon must be a finite number' };
  if (lat < -90 || lat > 90) return { ok: false, reason: 'lat out of range' };
  if (lon < -180 || lon > 180) return { ok: false, reason: 'lon out of range' };

  // ⚠ 0,0 is Null Island — the shape of a fix that failed, not a place. Both
  // CoreLocation and a half-initialised struct produce it, and it clusters
  // happily into a "visit" in the Gulf of Guinea.
  if (lat === 0 && lon === 0) return { ok: false, reason: 'null island (0,0) is not a fix' };

  if (!isFiniteNumber(raw.tst)) return { ok: false, reason: 'tst must be a finite number' };
  if (!Number.isInteger(raw.tst)) return { ok: false, reason: 'tst must be an integer' };
  if (raw.tst <= 0) return { ok: false, reason: 'tst must be positive' };
  if (raw.tst >= MILLISECONDS_THRESHOLD) {
    return { ok: false, reason: 'tst looks like milliseconds — it must be unix SECONDS' };
  }
  if (nowSeconds != null && raw.tst > nowSeconds + MAX_FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: 'tst is in the future' };
  }

  // Accuracy is optional — a point without one is not assumed bad, because the
  // OwnTracks feed does not always carry it either. Present and too coarse is a
  // different fact from absent, and only the first is refused.
  let accuracy = null;
  if (raw.acc !== undefined || raw.accuracy !== undefined) {
    const a = raw.acc !== undefined ? raw.acc : raw.accuracy;
    if (!isFiniteNumber(a)) return { ok: false, reason: 'acc must be a finite number' };
    if (a < 0) return { ok: false, reason: 'acc must not be negative' };
    if (a > ACCURACY_CEILING_M) {
      return { ok: false, reason: `acc ${Math.round(a)}m exceeds the ${ACCURACY_CEILING_M}m ceiling` };
    }
    accuracy = a;
  }

  return { ok: true, point: { lat, lon, tst: raw.tst, accuracy } };
}

/**
 * Validate a whole batch. PURE.
 *
 * ⚠ A bad point does NOT fail the batch. The phone cannot repair a fix it has
 * already taken, so refusing all 200 because one carried a coarse accuracy
 * means the queue never drains and the day has no position at all. Each point
 * is judged on its own and the rejections are NAMED — the same choice
 * `apple-health` makes with `rejectedReasons`, and for the same reason: a
 * client that cannot see why it was refused cannot be fixed.
 */
function validateBatch({ deviceId, points, nowSeconds } = {}) {
  if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 200) {
    return { ok: false, reason: 'deviceId is required' };
  }
  if (!Array.isArray(points)) {
    return { ok: false, reason: 'points must be an array' };
  }
  if (points.length > MAX_POINTS_PER_REQUEST) {
    return { ok: false, reason: `too many points — max ${MAX_POINTS_PER_REQUEST} per request` };
  }

  const accepted = [];
  const rejectedReasons = {};
  let rejected = 0;

  for (const raw of points) {
    const v = validatePoint(raw, nowSeconds);
    if (v.ok) {
      accepted.push(v.point);
    } else {
      rejected++;
      rejectedReasons[v.reason] = (rejectedReasons[v.reason] || 0) + 1;
    }
  }

  return {
    ok: true,
    deviceId: deviceId.trim(),
    accepted,
    rejected,
    rejectedReasons,
    received: points.length,
  };
}

// ── Freshness ────────────────────────────────────────────────────────────────

/**
 * How long the phone may go quiet before the feed is called stale, in minutes.
 *
 * Significant-location-change only fires on real movement, so a quiet evening
 * at home is legitimately hours of silence. Six hours is long enough not to cry
 * wolf over a still day and short enough to catch a dead feed within one.
 */
const STALE_AFTER_MINUTES = 360;

/**
 * Assess the feed's freshness. PURE — `latest` and `now` are both passed in.
 *
 * ⚠ THIS IS THE 7-DAY ALARM. On free Apple provisioning the app's signature
 * expires weekly and iOS stops launching it — background location dies with no
 * error, no crash and no notification. The feed simply goes quiet, and quiet is
 * indistinguishable from a day spent at home. Nick asked for that failure to be
 * LOUD rather than silent, and this is where it gets noticed.
 *
 * Three outcomes that must stay distinct, because collapsing them is how a dead
 * tracker reads as a calm week:
 *   • `known: false`  — no point has EVER arrived. Not stale; never started.
 *   • `stale: true`   — points exist but the newest is older than the window.
 *   • `stale: false`  — the feed is live.
 *
 * `known:false` deliberately does NOT report an age. "Nothing has ever arrived"
 * has no age, and rendering it as 0 minutes would read as perfectly fresh.
 */
function assessFreshness(latest, now = new Date(), staleAfterMinutes = STALE_AFTER_MINUTES) {
  if (!latest || !isFiniteNumber(latest.tst)) {
    return {
      known: false,
      why: 'no position has ever been received from a device',
      stale: null,
      ageMinutes: null,
      lastAt: null,
      deviceId: null,
      staleAfterMinutes,
    };
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  // A future point would give a negative age, which renders as "-3 minutes ago".
  // Clamped at zero: the skew rule above already refuses anything meaningful.
  const ageMinutes = Math.max(0, Math.round((nowSeconds - latest.tst) / 60));

  return {
    known: true,
    stale: ageMinutes > staleAfterMinutes,
    ageMinutes,
    lastAt: new Date(latest.tst * 1000).toISOString(),
    deviceId: latest.device_id || null,
    staleAfterMinutes,
    why: ageMinutes > staleAfterMinutes
      ? `no position for ${ageMinutes} minutes — the device may have stopped reporting`
      : null,
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────

/**
 * Persist an already-validated batch.
 *
 * Idempotent via UNIQUE(device_id, tst) — `insertLocationPoints` uses
 * INSERT OR IGNORE, so `stored` counts genuinely new rows and `duplicate` is
 * the replay. Both are reported: a device whose every point is a duplicate is
 * re-sending a queue it is failing to clear, which looks identical to a healthy
 * device if only `received` is returned.
 */
function store(deviceId, accepted, source = DEFAULT_SOURCE) {
  if (!accepted || !accepted.length) return { stored: 0, duplicate: 0 };
  const db = require('../db/database');
  const stored = db.insertLocationPoints(
    accepted.map((p) => ({
      deviceId,
      lat: p.lat,
      lng: p.lon,
      tst: p.tst,
      accuracy: p.accuracy,
      source,
    }))
  );
  return { stored, duplicate: accepted.length - stored };
}

/** The newest point from any device, or null. Used only by `freshness()`. */
function latestPoint() {
  try {
    return require('../db/database').getLatestLocationPoint();
  } catch {
    return null;
  }
}

/**
 * The freshness of the live feed.
 *
 * ⚠ A READ FAILURE IS NOT AN EMPTY FEED. If the table cannot be read at all,
 * that is reported as its own state rather than folded into `known:false` —
 * "I could not look" and "nothing has ever arrived" send you to different
 * fixes (a broken database vs a phone that was never set up).
 */
function freshness(now = new Date()) {
  let latest;
  try {
    latest = require('../db/database').getLatestLocationPoint();
  } catch (e) {
    return {
      known: false,
      readable: false,
      why: `could not read the position store: ${e.message}`,
      stale: null,
      ageMinutes: null,
      lastAt: null,
      deviceId: null,
      staleAfterMinutes: STALE_AFTER_MINUTES,
    };
  }
  return { readable: true, ...assessFreshness(latest, now) };
}

/**
 * Has a device EVER pushed a point?
 *
 * ⚠ Asks the store, never an env var. `location.isConfigured()` carries the
 * scar from checking `!!OWNTRACKS_RECORDER_URL` — the variable being set, never
 * the recorder answering — which kept 65 days of dwell caches empty. There is
 * no env var to get wrong here, and there should not be one: the phone is
 * "configured" exactly when it has sent something.
 */
function hasAnyPoints() {
  try {
    return !!require('../db/database').getLatestLocationPoint();
  } catch {
    return false;
  }
}

/**
 * Points between two unix-second bounds, in the OwnTracks shape.
 *
 * Returns `{lat, lon, tst}` — `lng` is the column name, `lon` is the contract,
 * and this is the one place that translates between them.
 */
function pointsBetween(fromTst, toTst) {
  try {
    return require('../db/database').getLocationPointsBetween(fromTst, toTst).map((r) => ({
      lat: r.lat,
      lon: r.lng,
      tst: r.tst,
    }));
  } catch (e) {
    console.warn('[LocationPoints] range read failed:', e.message);
    return [];
  }
}

module.exports = {
  ACCURACY_CEILING_M,
  MAX_FUTURE_SKEW_SECONDS,
  MAX_POINTS_PER_REQUEST,
  MILLISECONDS_THRESHOLD,
  STALE_AFTER_MINUTES,
  DEFAULT_SOURCE,
  validatePoint,
  validateBatch,
  assessFreshness,
  store,
  latestPoint,
  freshness,
  hasAnyPoints,
  pointsBetween,
};
