// GET /api/presence — compact "are you here?" signal for the SARA auto-lock.
//
// The SARA frontend lock logic polls this (small payload) rather than the full
// /api/state, so the wall display can cheaply ask "should I lock?" on a tight interval.
//
// SARA_PRESENCE_SOURCE picks WHICH question this route answers. The two modes are
// different claims, not two ways of measuring one thing, so the mode is named in the
// response rather than left implicit:
//
//   'watch' (default) — "are you AT THE DESK?", desk-level, Apple Watch BLE proximity.
//   'home'            — "are you IN THE HOUSE?", house-level, the phone's Home Assistant
//                       zone. Deliberately WIDER: at home but in another room reads as
//                       present, so SARA stays unlocked while you are anywhere in the
//                       house and locks only once the phone leaves the home zone.
//
// Source priority in 'watch' mode:
//   1. Watch BLE presence service — the on-Pi watch-presence service writes a JSON
//      status file (present/away via the Apple Watch IRK + RSSI). This is the primary,
//      desk-level signal. Used when the file is present and FRESH.
//   2. Home Assistant proximity — fallback when the watch service isn't reporting
//      (file missing/stale), preserving the original HA-proximity behaviour.
//
// In 'home' mode the watch file is not read at all — a fresh watch report saying "away"
// (you left the desk) must not lock a display you asked to stay unlocked while you are
// in the house. Home is decided by the HA LOCATION slot (a person/device_tracker whose
// state is a zone), with the proximity slot as a fallback. A custom zone ("Office",
// "Gym") is NOT home: only the literal `home` zone is.
//
// `away` is the single boolean the client acts on:
//   true  -> SARA may auto-lock (you appear to have left)
//   false -> you're present (and the client may auto-unlock)
//   null  -> unknown (no source available). The client MUST NOT auto-lock on null —
//            only the idle-timeout safety net should fire — so a blind signal can never
//            lock you out.
const fs = require('fs');
const express = require('express');
const ha = require('../telemetry/homeAssistant');

const router = express.Router();

// Read per-request, not at module load, so the mode can be flipped by editing .env and
// restarting SARA alone — no code change, and nothing else in the process caches it.
//
// ⚠ The DEFAULT is 'home' (Nick's call, 30 Aug 2026) — house-level geolocation, not the
// Apple Watch. Set SARA_PRESENCE_SOURCE=watch to go back to desk-level proximity. The
// watch path is kept whole, not deleted: this is a change of mind about which question
// to ask, and the BLE service on the Pi is still running and still writing its file.
function presenceSource() {
  return (process.env.SARA_PRESENCE_SOURCE || 'home').toLowerCase() === 'watch' ? 'watch' : 'home';
}

const WATCH_FILE = process.env.WATCH_STATUS_FILE || '/home/nickw/watch-irk/presence.json';
// A watch report older than this is stale -> fall back to HA rather than trust it.
const WATCH_STALE_MS = Number(process.env.WATCH_STALE_MS) || 30000;

function readWatch() {
  try {
    const raw = fs.readFileSync(WATCH_FILE, 'utf8');
    const d = JSON.parse(raw);
    const ageMs = d.updated ? Date.now() - Date.parse(d.updated) : Infinity;
    if (ageMs > WATCH_STALE_MS) return null; // stale -> not trustworthy
    if (d.status !== 'present' && d.status !== 'away') return null;
    return {
      away: d.status === 'away',
      present: d.status === 'present',
      rssi: typeof d.rssi === 'number' ? d.rssi : null,
      source: 'watch-ble',
      ageMs,
    };
  } catch {
    return null; // file missing/unreadable -> fall back
  }
}

// Decide "in the house?" from an HA telemetry snapshot. PURE (takes the snapshot, no
// I/O, no clock) so the rule is testable without a live Home Assistant.
//
// Only the literal `home` zone is home. Everything else that HA can actually say —
// `not_home`, a custom zone, a categorical away word — is away. Anything we cannot
// read (HA down, slot not configured, `unknown`/`unavailable`) is `null`, never a
// guess: the client never locks on null, so a blind signal cannot lock Nick out of a
// display in his own house.
function homePresence(telemetry) {
  if (!telemetry || !telemetry.available) {
    return { away: null, reason: telemetry?.reason || 'telemetry-unavailable', basis: null, zone: null };
  }
  const loc = telemetry.signals?.location || null;
  if (loc && typeof loc.zone === 'string') {
    const zone = loc.zone.toLowerCase();
    if (zone === 'unknown' || zone === 'unavailable' || zone === '') {
      return { away: null, reason: 'zone-unknown', basis: 'ha-location', zone: loc.zone };
    }
    return { away: zone !== 'home', reason: null, basis: 'ha-location', zone: loc.zone };
  }
  // No location slot configured — fall back to proximity, which already resolves
  // home/away words and distance the same way.
  const prox = telemetry.signals?.proximity || null;
  if (prox && prox.away !== null && typeof prox.away !== 'undefined') {
    return { away: prox.away, reason: null, basis: 'ha-proximity', zone: prox.state ?? null };
  }
  return { away: null, reason: 'no-location-signal', basis: null, zone: null };
}

router.get('/', (_req, res) => {
  const mode = presenceSource();

  // 'home' mode: house-level only. The watch file is deliberately not consulted —
  // leaving the desk must not lock a display that should stay unlocked while home.
  if (mode === 'home') {
    const t = ha.getTelemetry();
    const home = homePresence(t);
    return res.json({
      mode,
      source: t.source,
      available: home.away !== null,
      reason: home.reason,
      basis: home.basis,
      zone: home.zone,
      away: home.away,
      present: home.away === null ? null : !home.away,
      polledAt: t.polledAt || null,
      checkedAt: new Date().toISOString(),
    });
  }

  const watch = readWatch();
  if (watch) {
    return res.json({
      mode,
      source: 'watch-ble',
      available: true,
      reason: null,
      away: watch.away,
      present: watch.present,
      rssi: watch.rssi,
      ageMs: watch.ageMs,
      checkedAt: new Date().toISOString(),
    });
  }

  // Fallback: Home Assistant proximity (original behaviour).
  const t = ha.getTelemetry();
  const prox = t.available ? t.signals.proximity : null;
  res.json({
    mode,
    source: t.source,
    available: t.available,
    reason: t.reason || 'watch-unavailable',
    away: prox ? prox.away : null,
    present: prox ? prox.present : null,
    proximity: prox || null,
    polledAt: t.polledAt || null,
    checkedAt: new Date().toISOString(),
  });
});

module.exports = router;
// Pure rule, exported for tests.
module.exports.homePresence = homePresence;
module.exports.presenceSource = presenceSource;
