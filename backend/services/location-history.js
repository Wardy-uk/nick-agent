'use strict';

/**
 * Location History — persistent visit tracking with smart place detection.
 *
 * Stores every meaningful dwell (20+ min) to location_visits table.
 * Matches dwells against:
 *   1. Saved places (exact match, radius-based)
 *   2. Previously visited coordinates (500m fuzzy match)
 *   3. Reverse geocode (Nominatim) for new locations
 *
 * Smart features:
 *   - Shopping centre problem: 500m radius groups nearby GPS points as "same place"
 *   - Auto-learns: frequently visited unnamed locations get flagged for naming
 *   - Place inference: if you're near a known place, it's assumed to be that place
 */

const db = require('../db/database');
const location = require('./location');

// Wider radius for "same place" matching (handles shopping centres, campuses, etc.)
const PLACE_MATCH_RADIUS_M = 500;

/**
 * Process today's dwells and store them in location_visits.
 * Called periodically (e.g. every 30 min during active hours, or at EOD).
 * Idempotent — won't duplicate visits for the same arrival time.
 */
async function recordTodaysDwells() {
  if (!location.isConfigured()) return { recorded: 0 };

  const dwells = await location.getTodayDwells();
  if (dwells.length === 0) return { recorded: 0 };

  const dateKey = new Date().toISOString().split('T')[0];
  const existing = db.getLocationVisits(dateKey, dateKey, 100);
  const existingArrivals = new Set(existing.map(v => v.arrival));

  let recorded = 0;

  for (const dwell of dwells) {
    // Skip if already recorded (idempotent by arrival time)
    if (existingArrivals.has(dwell.arrivalTime)) continue;

    // Smart place matching
    const placeName = await _resolvePlaceName(dwell.lat, dwell.lng, dwell.placeName);
    const placeId = _getPlaceId(dwell.lat, dwell.lng);

    db.saveLocationVisit(
      dateKey,
      placeName,
      dwell.lat,
      dwell.lng,
      dwell.arrivalTime,
      dwell.departureTime,
      dwell.durationMinutes,
      // Which feed this visit actually came from. It was hardcoded 'owntracks'
      // — harmless while nothing was ever recorded, and a lie the moment a
      // second source exists.
      location.lastSource() || 'unknown',
      placeId
    );
    recorded++;
  }

  if (recorded > 0) {
    console.log(`[LocationHistory] Recorded ${recorded} visits for ${dateKey}`);
  }

  return { recorded, total: dwells.length };
}

/**
 * Resolve the best place name for a coordinate.
 *
 * Priority:
 *   1. Saved place (user-named, within radius)
 *   2. Previously visited same spot (within 500m) — reuse that name
 *   3. Reverse geocode result from Nominatim
 */
async function _resolvePlaceName(lat, lng, geocodedName) {
  // 1. Check saved places
  const savedPlaces = _getSavedPlaces();
  const savedMatch = _findNearestPlace(savedPlaces, lat, lng, PLACE_MATCH_RADIUS_M);
  if (savedMatch) return savedMatch.name;

  // 2. Check recent visits — reuse name if we've been here before
  const recentVisits = db.getLocationVisits(
    new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0],
    new Date().toISOString().split('T')[0],
    500
  );

  for (const visit of recentVisits) {
    if (visit.place_name && visit.lat && visit.lng) {
      const dist = _distanceMetres(lat, lng, visit.lat, visit.lng);
      if (dist <= PLACE_MATCH_RADIUS_M) {
        return visit.place_name; // Same place as before
      }
    }
  }

  // 3. Use the geocoded name from Nominatim (already provided by dwell processing)
  return geocodedName || 'Unknown location';
}

/**
 * Generate a stable place ID from coordinates (rounded to ~50m grid).
 * Used for grouping visits to the same location.
 */
function _getPlaceId(lat, lng) {
  // Round to 3 decimal places (~111m precision) — good enough for place identity
  const rLat = Math.round(lat * 1000) / 1000;
  const rLng = Math.round(lng * 1000) / 1000;
  return `${rLat},${rLng}`;
}

/**
 * Get locations visited frequently but never named by the user.
 * These are candidates for "Would you like to name this place?" prompts.
 */
function getUnnamedFrequentLocations(minVisits = 3) {
  const frequent = db.getFrequentLocations(30, minVisits);
  const savedPlaces = _getSavedPlaces();

  return frequent.filter(loc => {
    // Skip if this matches a saved place
    const match = _findNearestPlace(savedPlaces, loc.avg_lat, loc.avg_lng, PLACE_MATCH_RADIUS_M);
    if (match) return false;

    // Skip generic names
    const name = (loc.place_name || '').toLowerCase();
    if (name === 'unknown location' || name.length < 3) return true;

    return true;
  }).map(loc => ({
    name: loc.place_name,
    lat: loc.avg_lat,
    lng: loc.avg_lng,
    visitCount: loc.visit_count,
    totalMinutes: loc.total_minutes,
    lastVisit: loc.last_visit,
  }));
}

/**
 * Get a human-readable location history summary for a date range.
 */
function getHistorySummary(daysBack = 7) {
  const from = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const to = new Date().toISOString().split('T')[0];
  const visits = db.getLocationVisits(from, to, 500);

  // Group by date
  const byDate = {};
  for (const v of visits) {
    if (!byDate[v.date_key]) byDate[v.date_key] = [];
    byDate[v.date_key].push(v);
  }

  return {
    from,
    to,
    totalVisits: visits.length,
    days: Object.entries(byDate).map(([date, dayVisits]) => ({
      date,
      visits: dayVisits.map(v => ({
        place: v.place_name,
        arrival: v.arrival,
        departure: v.departure,
        duration: v.duration_minutes,
      })),
    })),
    frequentPlaces: db.getFrequentLocations(daysBack, 2),
  };
}


// ── Helpers ──

function _getSavedPlaces() {
  try {
    const raw = db.getState('saved_places');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function _findNearestPlace(places, lat, lng, maxRadius) {
  let nearest = null;
  let nearestDist = Infinity;

  for (const place of places) {
    const dist = _distanceMetres(lat, lng, place.lat, place.lng);
    if (dist <= (maxRadius || place.radius || 200) && dist < nearestDist) {
      nearest = place;
      nearestDist = dist;
    }
  }
  return nearest;
}

function _distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = {
  recordTodaysDwells,
  getUnnamedFrequentLocations,
  getHistorySummary,
};
