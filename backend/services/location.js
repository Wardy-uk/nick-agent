'use strict';

const db = require('../db/database');

const RECORDER_URL = process.env.OWNTRACKS_RECORDER_URL || 'http://localhost:8083';
const OT_USER = process.env.OWNTRACKS_USER || 'nick';
const OT_DEVICE = process.env.OWNTRACKS_DEVICE || 'iphone';

// Minimum dwell time to count as a meaningful location (minutes)
const MIN_DWELL_MINUTES = 20;

/**
 * Is there ANY source of position, not just OwnTracks.
 *
 * ⚠ This guard is what kept the whole archive empty. It read
 * `!!OWNTRACKS_RECORDER_URL` — the env var being SET, never the recorder
 * answering — and `recordTodaysDwells()` returns immediately when it is false.
 * The var was set to a port nothing has ever listened on, so the check passed,
 * the fetch failed, `[]` came back, and 65 days of dwell caches were written
 * holding nothing while `location_visits` stayed at zero rows. Same distinction
 * as #65's "configured is not the same claim as works".
 */
function isConfigured() {
  if (process.env.OWNTRACKS_RECORDER_URL) return true;
  try { return require('./ha').isConfigured(); } catch { return false; }
}

/** Which source last answered — so a visit records where it came from. */
let _lastSource = null;
function lastSource() { return _lastSource; }

/**
 * Today's position points, from whichever source has them.
 *
 * OwnTracks first (it is the higher-fidelity feed when it exists), Home
 * Assistant second. The same live → fallback shape as `working-days`, and
 * `lastSource()` always names which one answered rather than leaving the
 * archive to assume.
 *
 * ⚠ An empty result from one source means "this source had nothing", NOT "Nick
 * went nowhere" — which is exactly why it falls through rather than returning.
 */
async function getTodayPoints() {
  const ot = await _getOwnTracksPoints();
  if (ot.length) { _lastSource = 'owntracks'; return ot; }

  try {
    const ha = require('./ha');
    if (ha.isConfigured()) {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const points = await ha.getLocationPoints(start.toISOString(), now.toISOString());
      if (points.length) { _lastSource = 'home-assistant'; return points; }
    }
  } catch (e) {
    console.warn('[Location] HA fallback failed:', e.message);
  }

  _lastSource = null;
  return [];
}

/**
 * Today's window for the recorder API.
 *
 * ⚠ Two bugs lived in one line here, and both were silent.
 *
 * (1) The date was slash-separated (`2026/08/26`). Slashes are the recorder's
 * STORAGE PATH convention, not its query format — the API answers
 * "impossible date/time ranges" as plain text, `res.json()` throws, the catch
 * returns [] and it reads as "Nick went nowhere". Verified against the live
 * recorder: dashes work, slashes never have. So even once OwnTracks was
 * running, this query could not have returned a single point.
 *
 * (2) It came from `toISOString()`, which is UTC. Through BST that names the
 * wrong day for the hour before midnight — the house rule everywhere else is
 * local getters, never toISOString, and this was the exception.
 *
 * No trailing Z: the timestamps are naive and the recorder reads them in its
 * own timezone, which the container sets to Europe/London to match.
 */
function _todayRange(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return { from: `${d}T00:00:00`, to: `${d}T23:59:59` };
}

// Fetch today's location points from OwnTracks Recorder
async function _getOwnTracksPoints() {
  if (!process.env.OWNTRACKS_RECORDER_URL) return [];
  try {
    const { from, to } = _todayRange();
    const url = `${RECORDER_URL}/api/0/locations?user=${OT_USER}&device=${OT_DEVICE}&from=${from}&to=${to}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Recorder API error: ${res.status}`);
    // The recorder answers errors as PLAIN TEXT with a 200, so a failed parse
    // is a real failure and not a formality — say what came back rather than
    // letting an unparseable body become an empty day.
    const body = await res.text();
    let data;
    try { data = JSON.parse(body); }
    catch { throw new Error(`Recorder returned non-JSON: ${body.slice(0, 80)}`); }
    return Array.isArray(data.data) ? data.data : [];
  } catch (e) {
    console.warn('[Location] Failed to fetch OwnTracks data:', e.message);
    return [];
  }
}

// Group points into clusters (nearby points = same place)
// Uses simple distance threshold — 200m radius counts as same place
function clusterPoints(points) {
  if (!points || points.length === 0) return [];

  // Sort by time
  const sorted = [...points].sort((a, b) => a.tst - b.tst);

  function distanceMetres(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const CLUSTER_RADIUS_M = 200;
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentCluster[currentCluster.length - 1];
    const curr = sorted[i];
    const dist = distanceMetres(prev.lat, prev.lon, curr.lat, curr.lon);

    if (dist <= CLUSTER_RADIUS_M) {
      currentCluster.push(curr);
    } else {
      clusters.push(currentCluster);
      currentCluster = [curr];
    }
  }
  clusters.push(currentCluster);
  return clusters;
}

// Reverse geocode a lat/lng using Nominatim (already used in claude.js)
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NEURO-personal-agent/1.0 (nick.ward@nurtur.tech)' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address || {};

    // Build a human-readable name — prefer specific to general
    const specific = addr.amenity || addr.shop || addr.office || addr.building ||
      addr.leisure || addr.tourism || addr.sport;
    const road = addr.road || addr.pedestrian;
    const area = addr.suburb || addr.neighbourhood || addr.quarter ||
      addr.village || addr.town || addr.city;

    if (specific && area) return `${specific}, ${area}`;
    if (specific) return specific;
    if (road && area) return `${road}, ${area}`;
    if (area) return area;
    return data.display_name?.split(',').slice(0, 2).join(',').trim() || null;
  } catch {
    return null;
  }
}

// Build a dwell summary for today
// Returns array of { placeName, lat, lng, arrivalTime, departureTime, durationMinutes }
async function getTodayDwells() {
  const points = await getTodayPoints();
  if (points.length === 0) return [];

  const clusters = clusterPoints(points);
  const dwells = [];

  for (const cluster of clusters) {
    if (cluster.length < 2) continue; // single point — ignore

    const first = cluster[0];
    const last = cluster[cluster.length - 1];
    const durationMinutes = Math.round((last.tst - first.tst) / 60);

    if (durationMinutes < MIN_DWELL_MINUTES) continue; // brief stop — ignore

    // Use centre of cluster for geocoding
    const avgLat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
    const avgLng = cluster.reduce((s, p) => s + p.lon, 0) / cluster.length;

    const placeName = await reverseGeocode(avgLat, avgLng);

    const arrival = new Date(first.tst * 1000);
    const departure = new Date(last.tst * 1000);
    const arrivalStr = arrival.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const departureStr = departure.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    dwells.push({
      placeName: placeName || `unknown location`,
      lat: avgLat,
      lng: avgLng,
      arrivalTime: arrivalStr,
      departureTime: departureStr,
      durationMinutes
    });
  }

  return dwells;
}

// Cache today's dwells in agent_state (avoid repeated Nominatim calls)
async function getCachedDwells() {
  const todayKey = new Date().toISOString().split('T')[0];
  const cacheKey = `location_dwells_${todayKey}`;
  const cacheTime = `location_dwells_time_${todayKey}`;

  // Use cache if less than 30 minutes old.
  //
  // ⚠ An EMPTY result is never cached and a cached empty is never trusted. The
  // cache exists to avoid repeat Nominatim calls, and an empty day makes no
  // Nominatim calls at all — so caching one buys nothing and costs plenty:
  // a transient source failure became a settled half-hour of "you went
  // nowhere". That is how this table came to hold 65 consecutive days of `[]`
  // with a fresh timestamp on each, which reads as evidence rather than as the
  // absence of it.
  const lastFetch = parseInt(db.getState(cacheTime) || '0', 10);
  if (Date.now() - lastFetch < 30 * 60 * 1000) {
    try {
      const cached = db.getState(cacheKey);
      const parsed = cached ? JSON.parse(cached) : null;
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {}
  }

  const dwells = await getTodayDwells();
  if (!dwells.length) return dwells;
  db.setState(cacheKey, JSON.stringify(dwells));
  db.setState(cacheTime, String(Date.now()));
  return dwells;
}

// Get a plain-English location summary for journal prompts
async function getLocationSummaryForJournal() {
  if (!isConfigured()) return null;
  try {
    const dwells = await getCachedDwells();
    if (dwells.length === 0) return null;

    // Describe each meaningful dwell
    const descriptions = dwells.map(d => {
      const hrs = Math.floor(d.durationMinutes / 60);
      const mins = d.durationMinutes % 60;
      const duration = hrs > 0
        ? `${hrs}h${mins > 0 ? ` ${mins}m` : ''}`
        : `${mins} min`;
      return `${d.placeName} (${d.arrivalTime}–${d.departureTime}, ${duration})`;
    });

    if (descriptions.length === 1) {
      return `Location today: ${descriptions[0]}`;
    }
    return `Locations today: ${descriptions.join('; ')}`;
  } catch (e) {
    console.warn('[Location] Summary failed:', e.message);
    return null;
  }
}

// Get a context block for Claude chat
async function getLocationContextBlock() {
  if (!isConfigured()) return null;
  try {
    const dwells = await getCachedDwells();
    if (dwells.length === 0) return null;

    const lines = dwells.map(d => {
      const hrs = Math.floor(d.durationMinutes / 60);
      const mins = d.durationMinutes % 60;
      const duration = hrs > 0 ? `${hrs}h${mins > 0 ? ` ${mins}m` : ''}` : `${mins}min`;
      return `- ${d.arrivalTime}–${d.departureTime}: ${d.placeName} (${duration})`;
    });

    return `## Today's Locations\n${lines.join('\n')}`;
  } catch (e) {
    return null;
  }
}

module.exports = {
  isConfigured,
  lastSource,
  _todayRange,
  getTodayPoints,
  getTodayDwells,
  getCachedDwells,
  getLocationSummaryForJournal,
  getLocationContextBlock
};
