'use strict';

/**
 * The desktop agent's day, rolled up and kept.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `desktop-activity` is a LIVE sensor: a ~13-hour ring buffer in `agent_state`,
 * deliberately disposable, answering "what is he doing right now". That is the
 * right shape for the long-run observation and the wrong shape for every
 * question with a date in it, because the samples age out within the day.
 *
 * The alternative considered was RescueTime's API (2 Sep 2026). Measured against
 * this agent and the wins ledger over three months it was WORSE, not better:
 * nine weekdays where RT logged under an hour while NEURO held hard evidence of
 * a full day, 19% of all recorded work sitting on days RT saw nothing, and one
 * clean case — 1 Sep — where RT reported 0.16h against 8.21h of measured active
 * time on the same machine. Its own numbers looked like a quiet Tuesday. Nothing
 * in RT could say it had stopped watching.
 *
 * So the sensor NEURO owns keeps the history, and it is built to say when it
 * could not see rather than to report a quiet day.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 * ⚠ A GAP IS NOT TIME AT THE DESK. Time is attributed to the interval BETWEEN
 * consecutive samples, and an interval longer than the agent's reporting cadence
 * is dropped entirely — a laptop asleep from 12:30 to 13:30 did not spend that
 * hour in VS Code, and bridging the hole is how a lunch break becomes part of a
 * four-hour run.
 *
 * ⚠ NEVER OVERWRITE A FULLER ROW WITH A THINNER ONE. The ring holds half a day,
 * so a rollup run after a restart can only see part of yesterday. Writing that
 * over a complete row would silently replace eight hours with two — the exact
 * shape of the health backfill bug that wrote 744 days and left 328 with any
 * data. `sync()` refuses and says which day it refused.
 *
 * PURE where it counts: `rollup()` takes plain samples and returns plain totals,
 * so every rule above pins without a database or a Windows box.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');
const desk = require('./desktop-activity');

// How long a gap between samples may be and still count as continuous time.
// Borrowed from the sensor rather than picked again: the reporter's cadence is
// what defines a gap, and two numbers for one fact is how two parts of a system
// come to disagree about the same afternoon.
const MAX_GAP_MINUTES = desk.FRESH_MINUTES;

// How many trailing days sync() will consider. The ring cannot hold more than
// about half a day, so this is a bound on ambition, not on the read.
const SYNC_WINDOW_DAYS = 3;

// ── Pure ─────────────────────────────────────────────────────────────────────

/** Local day key. Never toISOString() — the Pi may run in UTC. */
function dayKey(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(date.getTime())) return null;
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * Roll one machine's samples into per-day totals. PURE.
 *
 * `samples` is that host's list in any order; returns `{ [day]: totals }`.
 *
 * ⚠ An interval is attributed to the day it STARTED in. At a two-minute cadence
 * that misplaces at most one interval per midnight, which is a smaller error
 * than splitting introduces complexity — but it is a choice, not an accident.
 */
function rollup(samples = [], { gapMinutes = MAX_GAP_MINUTES } = {}) {
  const list = (Array.isArray(samples) ? samples : [])
    .filter(s => s && Number.isFinite(Date.parse(s.at)))
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const days = {};
  const dayOf = key => {
    if (!days[key]) {
      days[key] = {
        day: key,
        presentMinutes: 0,
        activeMinutes: 0,
        idleMinutes: 0,
        lockedMinutes: 0,
        apps: {},
        longestRunMinutes: 0,
        firstAt: null,
        lastAt: null,
        sampleCount: 0,
      };
    }
    return days[key];
  };

  // Every sample counts towards its own day's census, even the last one of the
  // day which contributes no interval — otherwise a day with a single sample
  // reports sample_count 0 and reads as "the agent never ran".
  for (const s of list) {
    const key = dayKey(s.at);
    if (!key) continue;
    const d = dayOf(key);
    d.sampleCount += 1;
    if (!d.firstAt || s.at < d.firstAt) d.firstAt = s.at;
    if (!d.lastAt || s.at > d.lastAt) d.lastAt = s.at;
  }

  // Run tracking, carried across the loop so a stretch is measured end to end.
  let runApp = null;
  let runStartMs = null;

  const closeRun = endMs => {
    if (runApp && runStartMs != null) {
      const mins = (endMs - runStartMs) / 60000;
      const key = dayKey(new Date(runStartMs));
      if (key && mins > 0) {
        const d = dayOf(key);
        if (mins > d.longestRunMinutes) d.longestRunMinutes = mins;
      }
    }
    runApp = null;
    runStartMs = null;
  };

  for (let i = 0; i < list.length - 1; i += 1) {
    const a = list[i];
    const b = list[i + 1];
    const aMs = Date.parse(a.at);
    const bMs = Date.parse(b.at);
    const mins = (bMs - aMs) / 60000;

    // ⚠ The interval belongs to the state of the EARLIER sample: that is what he
    // was doing during it. And a gap is dropped, never bridged.
    if (mins <= 0 || mins > gapMinutes) {
      closeRun(aMs);
      continue;
    }

    const key = dayKey(a.at);
    if (!key) continue;
    const d = dayOf(key);
    d.presentMinutes += mins;

    const app = desk.sanitiseApp(a.app);
    if (a.locked) {
      d.lockedMinutes += mins;
      closeRun(aMs);
    } else if (!desk.isActive(a)) {
      d.idleMinutes += mins;
      closeRun(aMs);
    } else {
      d.activeMinutes += mins;
      d.apps[app] = (d.apps[app] || 0) + mins;
      if (runApp !== app) {
        closeRun(aMs);
        runApp = app;
        runStartMs = aMs;
      }
    }
  }
  if (list.length) closeRun(Date.parse(list[list.length - 1].at));

  for (const d of Object.values(days)) {
    const top = Object.entries(d.apps).sort((a, b) => b[1] - a[1])[0];
    d.topApp = top ? top[0] : null;
    d.topAppMinutes = top ? round1(top[1]) : null;
    d.presentMinutes = round1(d.presentMinutes);
    d.activeMinutes = round1(d.activeMinutes);
    d.idleMinutes = round1(d.idleMinutes);
    d.lockedMinutes = round1(d.lockedMinutes);
    d.longestRunMinutes = round1(d.longestRunMinutes);
    for (const k of Object.keys(d.apps)) d.apps[k] = round1(d.apps[k]);
  }
  return days;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * Should this computed row replace the stored one? PURE.
 *
 * ⚠ The whole guard. The ring buffer holds about half a day, so a run after a
 * restart sees only part of yesterday — and writing that over a full row would
 * quietly turn an eight-hour day into a two-hour one, with no error anywhere.
 * More evidence may overwrite less; less may never overwrite more.
 */
function shouldReplace(existing, computed) {
  if (!existing) return { write: true };
  const had = Number(existing.sample_count) || 0;
  const has = Number(computed.sampleCount) || 0;
  if (has >= had) return { write: true };
  return {
    write: false,
    why: `stored row has ${had} samples, this pass could only see ${has} — the ring buffer no longer covers that day`,
  };
}

// ── Stateful ─────────────────────────────────────────────────────────────────

/**
 * Roll the live buffer into `desktop_daily`. Idempotent, and safe to run as
 * often as you like — it recomputes a trailing window and writes only where the
 * evidence is at least as good as what is already stored.
 *
 * Returns `{ written, skipped, gaps }`. ⚠ `gaps` is reported and logged rather
 * than swallowed: a rollup that quietly writes nothing because the buffer was
 * unreadable looks exactly like a quiet day, which is the failure this whole
 * feature exists to avoid reproducing.
 */
function sync({ now = new Date(), days = SYNC_WINDOW_DAYS } = {}) {
  const written = [];
  const skipped = [];
  const gaps = [];

  const todayKey = dayKey(now);
  const oldest = dayKey(new Date(now.getTime() - days * 86400000));

  let hosts = [];
  try {
    hosts = desk.hosts();
  } catch (e) {
    gaps.push({ input: 'desktop buffer', why: e.message });
    return { written: 0, writtenDays: [], skipped, gaps };
  }
  if (!hosts.length) {
    gaps.push({ input: 'desktop buffer', why: 'no machine has ever reported' });
    return { written: 0, writtenDays: [], skipped, gaps };
  }

  for (const { host } of hosts) {
    let byDay;
    try {
      byDay = rollup(desk.samples({ host }));
    } catch (e) {
      gaps.push({ input: `host ${host}`, why: e.message });
      continue;
    }

    for (const [day, totals] of Object.entries(byDay)) {
      if (day < oldest) continue;
      try {
        const existing = db.getDesktopDay(day, host);
        const verdict = shouldReplace(existing, totals);
        if (!verdict.write) {
          skipped.push({ day, host, why: verdict.why });
          continue;
        }
        db.upsertDesktopDay({
          ...totals,
          host,
          apps: JSON.stringify(totals.apps || {}),
          // The day is over. Deliberately NOT a claim that the agent ran for all
          // of it — sample_count and first/last_at are what answer that.
          complete: day < todayKey,
        });
        written.push({ day, host });
      } catch (e) {
        gaps.push({ input: `${host} ${day}`, why: e.message });
      }
    }
  }

  return { written: written.length, writtenDays: written, skipped, gaps };
}

/** Newest first. `completeOnly` keeps a half-finished today out of an average. */
function recentDays(days = 30, { completeOnly = false, host = null } = {}) {
  return db.getDesktopDays(days, { completeOnly, host }).map(hydrate);
}

function getDay(day, host = null) {
  const rows = db.getDesktopDaysFor(day, host).map(hydrate);
  return host ? rows[0] || null : rows;
}

function hydrate(row) {
  if (!row) return row;
  let apps = {};
  try {
    apps = row.apps ? JSON.parse(row.apps) : {};
  } catch { apps = {}; }
  return { ...row, apps, complete: !!row.complete };
}

module.exports = {
  // pure
  dayKey,
  rollup,
  shouldReplace,
  // stateful
  sync,
  recentDays,
  getDay,
  // constants
  MAX_GAP_MINUTES,
  SYNC_WINDOW_DAYS,
};
