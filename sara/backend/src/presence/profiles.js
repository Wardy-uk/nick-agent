// Room fingerprints, and the calibration run that produces them.
//
// ⚠ THESE PERSIST, unlike the live readings. A reading is worthless three
// seconds later; a profile costs Nick standing in a room for two minutes and
// must survive a deploy, or every restart silently un-teaches the house. Plain
// JSON on disk: a handful of rooms, written rarely, read at startup, and
// legible enough to inspect or hand-edit when something looks wrong.
//
// A calibration run collects the raw samples as they arrive and builds the
// profile at the end. The RAW SAMPLES ARE KEPT alongside the summary, because
// the first thing anyone will want when a room is misidentified is to see what
// it was actually taught, and a mean and a standard deviation cannot be
// un-averaged.

'use strict';

const fs = require('fs');
const path = require('path');
const { buildProfile } = require('./fingerprint');

const FILE = process.env.SARA_PROFILES_FILE
  || path.join(__dirname, '..', '..', 'data', 'room-profiles.json');

// A calibration run is capped so a forgotten one cannot grow without bound or
// sit open for ever holding the room in a half-taught state.
const MAX_RUN_MS = 10 * 60 * 1000;
const MAX_SAMPLES = 400;

let profiles = {};      // room -> profile
let run = null;         // the calibration in progress, if any

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const d = JSON.parse(raw);
    profiles = d && d.profiles ? d.profiles : {};
    return { ok: true, rooms: Object.keys(profiles) };
  } catch (e) {
    // Missing is normal on a fresh install: no rooms taught yet. Anything else
    // is worth saying out loud rather than silently starting from nothing —
    // a corrupt file that reads as "uncalibrated" would quietly disable the
    // whole feature and look like it had never been set up.
    if (e.code !== 'ENOENT') console.warn('[profiles] could not read ' + FILE + ': ' + e.message);
    profiles = {};
    return { ok: false, reason: e.code === 'ENOENT' ? 'no profiles yet' : e.message };
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ profiles, savedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, FILE);   // atomic, so a crash mid-write cannot truncate the lot
    return { ok: true };
  } catch (e) {
    console.error('[profiles] could not save: ' + e.message);
    return { ok: false, reason: e.message };
  }
}

function all() {
  return profiles;
}

function summary() {
  return Object.entries(profiles).map(([room, p]) => ({
    room,
    samples: p.samples || 0,
    sensors: Object.keys(p.sensors || {}),
    calibratedAt: p.calibratedAt || null,
  }));
}

/** Start teaching a room. Replaces any run in progress, and says which it dropped. */
function startRun(room, now = new Date()) {
  const previous = run ? run.room : null;
  run = { room, startedAt: now.toISOString(), samples: [], at: now.getTime() };
  return { ok: true, room, replaced: previous };
}

/**
 * Offer the current reading to an in-progress run.
 *
 * `reading` is a map of sensorRoom -> {rssi, rate}. Called on every push, so it
 * must be cheap and must never throw into the sensor's request path.
 */
function offer(reading, now = new Date()) {
  if (!run) return { collecting: false };
  if (now.getTime() - run.at > MAX_RUN_MS) {
    const room = run.room;
    finishRun(now);
    return { collecting: false, expired: true, room };
  }
  if (run.samples.length >= MAX_SAMPLES) return { collecting: true, full: true };
  // A sample with nothing in it teaches nothing and would drag the stats.
  const usable = Object.values(reading || {}).some(v => v && (typeof v.rssi === 'number' || typeof v.rate === 'number'));
  if (usable) run.samples.push(reading);
  return { collecting: true, samples: run.samples.length };
}

/** Build and store the profile. Refuses on too little evidence rather than saving a bad one. */
function finishRun(now = new Date(), { minSamples = 10 } = {}) {
  if (!run) return { ok: false, reason: 'no calibration in progress' };
  const { room, samples } = run;
  run = null;

  if (samples.length < minSamples) {
    // ⚠ Refuse rather than store. A profile built from three samples has a
    // standard deviation near zero, which makes that sensor overwhelmingly
    // important and produces confident nonsense — worse than no profile, which
    // at least reports itself as uncalibrated.
    return {
      ok: false,
      room,
      samples: samples.length,
      reason: `only ${samples.length} samples — needs at least ${minSamples}. Nothing saved.`,
    };
  }

  const profile = buildProfile(room, samples);
  profile.calibratedAt = now.toISOString();
  profile.rawSamples = samples;
  profiles[room] = profile;
  const saved = save();
  return { ok: true, room, samples: samples.length, sensors: Object.keys(profile.sensors), saved };
}

function status() {
  if (!run) return { calibrating: false };
  return { calibrating: true, room: run.room, samples: run.samples.length, startedAt: run.startedAt };
}

function forget(room) {
  if (!profiles[room]) return { ok: false, reason: 'no such profile' };
  delete profiles[room];
  save();
  return { ok: true, room };
}

module.exports = { load, save, all, summary, startRun, offer, finishRun, status, forget, FILE, MAX_RUN_MS };
