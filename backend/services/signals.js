'use strict';

/**
 * Every sense SARA has, and whether it is actually working.
 *
 * Nick, 31 Aug 2026: *"we should add something in NEURO … that shows all these
 * signals, and whether they are red or green."*
 *
 * The argument for it is this session's own history. Three separate blindnesses
 * were found in a single morning, and **every one of them was invisible**:
 *
 *   · the HA phone feed had returned null for five weeks after the phone
 *     re-registered, and the code blamed the phone for going quiet.
 *   · `health-signals` had been computing trends nothing ever read.
 *   · dietary logging stopped in March 2026 and nothing noticed, because a
 *     metric with no recent rows returns an empty result rather than an error.
 *
 * A dead sensor and a quiet one look identical from every screen in the system.
 * That is the failure this page exists to make impossible, and it is why the
 * states below are FIVE and not two.
 *
 * ── The states ──────────────────────────────────────────────────────────────
 *   live            reporting inside its own expected cadence
 *   stale           it used to report and has stopped — the loud one
 *   never           configured but has never said anything
 *   off             not configured, which is a CHOICE and not a fault
 *   error           the check itself failed; we do not know
 *
 * ⚠ `off` and `stale` must never render the same. Not having a desktop agent
 * installed is a decision; having one that stopped talking is a problem. Two
 * states that look alike is how a real fault hides behind a deliberate gap.
 *
 * ⚠ Each signal carries its OWN cadence. Heart rate arrives every few minutes,
 * body weight every few days, and a shared threshold would either scream about
 * the scales or stay silent about the watch — the `health-signals.sensorsQuiet`
 * lesson, applied to sources rather than metrics.
 *
 * PURE where it judges: `rate()` takes a timestamp, a cadence and a clock, so
 * the thresholds pin without a database — the `pi-health.assess()` split. Only
 * `snapshot()` reads.
 *
 * READ-ONLY throughout. This page must never be the reason something changed.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * Turn "when did this last say anything" into a state. PURE.
 *
 * `expectMinutes` is how long the source may reasonably be quiet before silence
 * means something. `staleAfter` defaults to three times that — one missed report
 * is a hiccup, three in a row is a fault.
 */
function rate(lastAt, expectMinutes, now = new Date(), { staleAfter = null } = {}) {
  if (!lastAt) return { state: 'never', ageMinutes: null };
  const t = Date.parse(lastAt);
  if (!Number.isFinite(t)) return { state: 'error', ageMinutes: null, why: 'unreadable timestamp' };

  const ageMinutes = Math.max(0, Math.round((now.getTime() - t) / 60000));
  const limit = staleAfter == null ? expectMinutes * 3 : staleAfter;
  return { state: ageMinutes <= limit ? 'live' : 'stale', ageMinutes };
}

/** "14h 35m" / "3 days". Plain words beat a raw minute count on a status row. */
function age(minutes) {
  if (minutes == null) return null;
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Worst state present, for the headline. `off` is NOT a fault and cannot win. */
function overallOf(signals = []) {
  const order = ['error', 'stale', 'never', 'live', 'off'];
  for (const s of order) {
    if (s === 'live' || s === 'off') break;
    if (signals.some(x => x.state === s)) return s;
  }
  return signals.some(x => x.state === 'live') ? 'live' : 'off';
}

// ── Reading ──────────────────────────────────────────────────────────────────

function _latestSample(metric) {
  try {
    const rows = db.getHealthSamples(metric, new Date(Date.now() - 30 * 86400000).toISOString(), 1);
    return rows && rows.length ? rows[0].recorded_at : null;
  } catch {
    return null;
  }
}

/**
 * One row per sense. Every source is independently guarded: a check that throws
 * becomes `error` for that ROW and never takes the page down, because a status
 * page that cannot render is worse than any single red light on it.
 */
function snapshot(now = new Date()) {
  const signals = [];
  const add = (s) => signals.push(s);
  const guard = (id, label, what, fn) => {
    try {
      add({ id, label, what, ...fn() });
    } catch (e) {
      add({ id, label, what, state: 'error', ageMinutes: null, why: e.message });
    }
  };

  // ── Phone ─────────────────────────────────────────────────────────────────
  guard('phone', 'Phone', 'where you are, and whether you have the phone with you', () => {
    const ha = require('./ha');
    if (!ha.isConfigured()) return { state: 'off', why: 'Home Assistant is not configured' };
    // Cached states — this is a status page and must not add a network round
    // trip per render. `getStates` holds a 60s cache of its own.
    const cached = ha.cachedStates();
    // Not yet fetched is not a fault — the first read of the process has simply
    // not happened. Distinct from "fetched and found nothing".
    if (!cached) return { state: 'never', why: 'not read yet since the backend restarted' };
    const resolved = ha.resolvePhoneEntities(cached);
    if (resolved.source === 'none') {
      return { state: 'never', why: `no reporting entities for "${resolved.base}"`, detail: 'the phone may have re-registered' };
    }
    // The Companion app reports on significant change, not on a timer, so a
    // motionless hour is quiet by design — but battery keeps ticking.
    const r = rate(resolved.reportingAt, 30, now, { staleAfter: 120 });
    return { ...r, detail: `${resolved.base}${resolved.suffix}` };
  });

  // ── Watch ─────────────────────────────────────────────────────────────────
  guard('watch', 'Apple Watch', 'whether you have been sitting, and your recovery', () => {
    // heartRate is the liveness proxy: 13-19 samples an hour whenever it is on
    // the wrist, day and night.
    const r = rate(_latestSample('heartRate'), 30, now, { staleAfter: 180 });
    const stand = _latestSample('apple_stand_time');
    return { ...r, detail: stand ? `stand data to ${String(stand).slice(0, 16)}` : 'no stand data' };
  });

  // ── Laptop ────────────────────────────────────────────────────────────────
  guard('laptop', 'Laptop', 'whether you are working, and what on', () => {
    const desk = require('./desktop-activity');
    const samples = desk.samples();
    if (!samples.length) {
      return { state: 'off', why: 'the desktop agent has never reported', detail: 'run desktop-agent/install.ps1' };
    }
    const r = rate(samples[0].at, desk.FRESH_MINUTES, now, { staleAfter: desk.FRESH_MINUTES * 3 });
    const run = desk.run(now);
    return {
      ...r,
      detail: run.known && run.app ? `in ${run.label}` : (run.known ? run.why : null),
    };
  });

  // ── RescueTime ────────────────────────────────────────────────────────────
  //
  // ⚠ This row does NOT ask whether the API answered. That is what every
  // RescueTime dashboard already tells you, and it was green throughout the nine
  // weekdays it recorded nothing. It asks whether RescueTime AGREES with what
  // the desktop agent independently measured — the only question that would have
  // caught the failure.
  guard('rescuetime', 'RescueTime', 'a second opinion on where the day went, audited against the agent', () => {
    const svc = require('./rescuetime');
    if (!svc.isConfigured()) {
      // A CHOICE, not a fault: no key means Nick has not connected it.
      return { state: 'off', why: 'no API key', detail: 'Settings → Integrations' };
    }
    const c = svc.coverageReport(30);
    if (c.state === 'calibrating') {
      // Not yet enough overlapping days to accuse it of anything. Distinct from
      // agreeing, and it says so rather than showing a green light it has not
      // earned.
      return { state: 'never', why: c.why, detail: `${c.judged}/${c.needed} comparable days` };
    }
    if (c.state === 'under') {
      return { state: 'stale', why: c.why, detail: `missed ${c.days.slice(0, 3).join(', ')}` };
    }
    return { state: 'live', detail: `agrees on ${c.judged} measured days` };
  });

  // ── Apple Health ingest ───────────────────────────────────────────────────
  guard('health', 'Health data', 'sleep, HRV, resting heart rate, exercise', () => {
    const r = rate(_latestSample('hrv') || _latestSample('steps'), 60, now, { staleAfter: 12 * 60 });
    let days = null;
    try { days = require('./health-daily').recentDays(1).length; } catch { /* rolled up separately */ }
    return { ...r, detail: days ? 'rolled up daily' : 'no daily rollup yet' };
  });

  // ── Diet logging ──────────────────────────────────────────────────────────
  //
  // Not a sensor fault when it is quiet — it is Nick not logging, which is a
  // fact about him rather than about the system. `off` rather than `stale` for
  // exactly that reason, and it is the row that makes the food and water
  // observations explicable when they never appear.
  guard('diet', 'Food & water logging', 'whether you have eaten and drunk today', () => {
    const last = _latestSample('dietary_energy_consumed') || _latestSample('dietary_water');
    if (!last) return { state: 'off', why: 'nothing logged in the last 30 days', detail: 'MyFitnessPal writes into Apple Health' };
    const r = rate(last, 24 * 60, now, { staleAfter: 3 * 24 * 60 });
    return r.state === 'stale'
      ? { state: 'off', ageMinutes: r.ageMinutes, why: 'you have stopped logging', detail: 'not a fault — SARA stays quiet about food until it resumes' }
      : r;
  });

  // ── Apple Reminders / Calendar push ───────────────────────────────────────
  //
  // A PUSH source with no server-side schedule: nothing here runs on a timer,
  // so if the Shortcut on the phone stops firing there is no failed job, no
  // error and no empty result anywhere — a phone that has stopped pushing looks
  // exactly like a man with no reminders. Measured 3 Sep 2026: it last pushed on
  // 29 August, 111 hours earlier, and one task has ever been created from it.
  // Nothing in NEURO said so, which is precisely the blindness this page exists
  // for.
  //
  // ⚠ `stale` is the ingest's OWN verdict, not a second threshold computed here.
  // `apple-ingest.status()` already names it, and two places deciding what
  // "stale" means for one source is how a panel comes to disagree with the
  // endpoint it renders.
  guard('apple', 'Apple Reminders', 'reminders and calendar pushed from your phone', () => {
    const st = require('./apple-ingest').status(now);
    if (!st.known) return { state: 'error', why: st.why || 'the ingest could not be read' };
    if (!st.lastPushAt) {
      // Configured or not, we cannot tell from here — the Shortcut lives on the
      // phone. "It has never pushed" is the honest statement, and it is not the
      // same as "it is broken".
      return { state: 'never', why: 'the phone has never pushed', detail: 'the Shortcut may not be installed' };
    }
    const ageMinutes = st.ageHours == null ? null : Math.round(st.ageHours * 60);
    return {
      state: st.stale ? 'stale' : 'live',
      ageMinutes,
      why: st.stale ? 'the Shortcut on your phone has stopped pushing' : undefined,
      detail: `${st.events} event(s) cached`,
    };
  });

  // ── Calendar ──────────────────────────────────────────────────────────────
  guard('calendar', 'Calendar', 'meetings, and whether now is a good moment', () => {
    // ⚠ There is no `calendar_last_sync` state key — the freshness lives on the
    // rows themselves, in `calendar_cache.fetched_at`. Checked rather than
    // assumed; guessing a key here would have produced a permanently-red light
    // for a feature that works.
    const row = db.get('SELECT COUNT(*) AS n, MAX(fetched_at) AS fetched FROM calendar_cache');
    if (!row || !row.n) return { state: 'never', why: 'nothing cached yet' };
    const r = rate(row.fetched, 30, now, { staleAfter: 180 });
    return { ...r, detail: `${row.n} cached events` };
  });

  // ── Vault ─────────────────────────────────────────────────────────────────
  guard('vault', 'Obsidian vault', 'notes, people, meetings — everything she knows', () => {
    const obsidian = require('./obsidian');
    if (!obsidian.isConfigured()) return { state: 'off', why: 'no vault path configured' };
    const fs = require('fs');
    const path = require('path');
    const root = process.env.OBSIDIAN_VAULT_PATH;
    if (!fs.existsSync(root)) return { state: 'error', why: 'the vault path is not readable — Syncthing may be down' };
    // Newest mtime in Daily/ is the cheapest honest liveness check: it is the
    // one folder that changes every day it is used.
    const daily = path.join(root, 'Daily');
    let newest = null;
    if (fs.existsSync(daily)) {
      for (const f of fs.readdirSync(daily).slice(-40)) {
        try {
          const m = fs.statSync(path.join(daily, f)).mtime.toISOString();
          if (!newest || m > newest) newest = m;
        } catch { /* a file that vanished mid-scan is not a fault */ }
      }
    }
    return { ...rate(newest, 24 * 60, now, { staleAfter: 5 * 24 * 60 }), detail: 'via Syncthing' };
  });

  // ── Deliberately NOT a row: Location ─────────────────────────────────────
  //
  // `location.lastSource()` is IN-MEMORY and resets on every backend restart,
  // which happens several times a day on deploys. A row built on it would sit
  // amber most of the time for a feature that is working, and a status page with
  // a light nobody believes is a status page nobody reads. The Phone row already
  // answers "can she see where you are"; when location gains a durable
  // last-fix timestamp, it earns a row of its own.

  return {
    generatedAt: now.toISOString(),
    signals,
    overall: overallOf(signals),
    counts: signals.reduce((acc, s) => { acc[s.state] = (acc[s.state] || 0) + 1; return acc; }, {}),
  };
}

module.exports = { rate, age, overallOf, snapshot };
