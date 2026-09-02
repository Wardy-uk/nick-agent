'use strict';

/**
 * RescueTime, as a SECOND OPINION that is continuously audited.
 *
 * ── Why this exists, and why it is shaped like this ─────────────────────────
 * Nick already pays for RescueTime and asked (2 Sep 2026) whether pulling its
 * API would beat the desktop agent NEURO owns. Measured over three months
 * against that agent and the wins ledger, it did not:
 *
 *   - 9 blind weekdays where NEURO held hard evidence of a full working day,
 *   - 19% of all recorded work sitting on days RescueTime saw nothing,
 *   - and 1 Sep, where it reported 0.16h against 8.21h of measured active time
 *     ON THE MACHINE IT WAS INSTALLED ON.
 *
 * The finding was never "RescueTime is inaccurate". It is that a stopped
 * RescueTime looks EXACTLY like a quiet Tuesday, from inside RescueTime. Its own
 * dashboard was green throughout.
 *
 * So this integration takes the two things RescueTime genuinely has and refuses
 * the one it does not:
 *
 *  ✓ CATEGORIES — how a day split across kinds of work.
 *  ✓ BROWSER DOMAINS — the one real gap in NEURO's own sensor, which collapses
 *    every browser to "chrome" by design.
 *  ✗ THE PRODUCTIVITY PULSE. Measured r = -0.96 against meeting count: it is a
 *    coding-vs-meetings ratio, and NEURO already derives both halves from git
 *    and the calendar. Storing it would add a number that looks like insight and
 *    carries none. It is not fetched, not stored, not exposed.
 *
 * ⚠ AND THE AGREEMENT CHECK IS THE FEATURE, not a nicety. `desktop_daily` is an
 * independent, local measurement of the same machine on the same day, which
 * RescueTime cannot influence. Every RescueTime figure is therefore checkable,
 * and the senses row answers "does RescueTime agree with what was measured?"
 * rather than "did the API respond?" — the second is what was green all August.
 *
 * ── The privacy line ────────────────────────────────────────────────────────
 * ⚠ Activity rows are NOT clean. A real row pulled on 2 Sep 2026 read:
 *
 *   web.plaud.ai&response_type=code id_token&scope=name email&response_mode=...
 *
 * — an OAuth flow with its parameters attached. RescueTime holds full window
 * titles and document names (which on this machine means Outlook subject lines,
 * customer names and a disciplinary folder); this integration must never carry
 * any of it into NEURO, where it would reach vault embeddings and cloud model
 * prompts. `sanitiseActivity()` cuts to the bare hostname and nothing else, and
 * `restrict_kind=document` is never requested.
 *
 * PURE where it judges: parsing, sanitising and the agreement rules take plain
 * values, so all of it pins without a key or a network.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');

const API = 'https://www.rescuetime.com/anapi/data';
const KEY_STATE = 'rescuetime_key';

// RescueTime's free tier keeps a rolling three months; asking for more is not an
// error, it just returns nothing. 14 days is the sync window — comfortably wider
// than any backfill it does, and cheap at two calls.
const SYNC_WINDOW_DAYS = 14;

// ⚠ Below this share of what the agent MEASURED, RescueTime is not watching.
// Provisional and deliberately generous: the failure being caught is 0.016, not
// 0.8. It is only ACTED on once there are enough overlapping days to mean
// something — see `coverage()`.
const AGREEMENT_FLOOR = 0.4;

// Until this many comparable days exist, the check reports `calibrating` rather
// than a verdict. Same idiom as stress-score, and for the same reason: a
// threshold applied to three days of data is a coin toss wearing a number.
const MIN_CALIBRATION_DAYS = 7;

// A day the agent barely saw cannot referee anything.
const MIN_DESK_SAMPLES = 60;

// Tails that mean "this is a file, not a website". See sanitiseActivity.
const FILE_EXTENSIONS = new Set([
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf', 'csv', 'txt', 'md', 'rtf',
  'js', 'ts', 'tsx', 'jsx', 'json', 'sql', 'py', 'ps1', 'sh', 'yml', 'yaml',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'zip', 'log', 'eml', 'msg', 'one',
]);

// ── Credential ───────────────────────────────────────────────────────────────
//
// Read at CALL time so a pasted key works with no restart; `.env` still wins
// where set. The Notion/OpenRouter pattern, not a second worse one.

function key() {
  if (process.env.RESCUETIME_API_KEY) return process.env.RESCUETIME_API_KEY;
  try { return db.getState(KEY_STATE) || ''; } catch { return ''; }
}

function isConfigured() {
  return Boolean(key());
}

/** WHERE the credential came from — never what it is. */
function credentialSource() {
  if (process.env.RESCUETIME_API_KEY) return 'env';
  try { return db.getState(KEY_STATE) ? 'stored' : null; } catch { return null; }
}

/**
 * Store a key typed into the panel.
 *
 * Shape-checked only. RescueTime keys are a long opaque alphanumeric run with no
 * prefix to key on, so a wrong-but-well-formed key is caught by the first real
 * call, which reports its own failure honestly.
 */
function setStoredKey(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return { ok: false, error: 'No key given.' };
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(trimmed)) {
    return { ok: false, error: 'That does not look like a RescueTime API key (a long run of letters and digits, from rescuetime.com/anapi/manage).' };
  }
  db.setState(KEY_STATE, trimmed);
  return { ok: true };
}

function clearStoredKey() {
  db.setState(KEY_STATE, '');
  return { ok: true, stillInEnv: Boolean(process.env.RESCUETIME_API_KEY) };
}

// ── Pure: parsing ────────────────────────────────────────────────────────────

/**
 * Turn RescueTime's `{row_headers, rows}` into objects. PURE.
 *
 * ⚠ Indexed BY HEADER NAME, never by position. The shapes differ per
 * `restrict_kind` and per `perspective` (a ranked pull leads with "Rank", an
 * interval pull with "Date"), and this repo has twice shipped a feature built on
 * an identifier that was guessed rather than copied from live data.
 *
 * A missing expected header REFUSES rather than returning empty rows: a silently
 * empty result here reads as "he did nothing that day", which is the single
 * failure this integration exists to detect.
 */
function parseRows(payload, required = []) {
  if (!payload || !Array.isArray(payload.row_headers) || !Array.isArray(payload.rows)) {
    return { ok: false, error: 'RescueTime did not return a row table', rows: [] };
  }
  const index = {};
  payload.row_headers.forEach((h, i) => { index[h] = i; });
  const missing = required.filter(h => index[h] === undefined);
  if (missing.length) {
    return {
      ok: false,
      rows: [],
      error: `RescueTime returned columns [${payload.row_headers.join(', ')}] — expected ${missing.join(', ')}`,
    };
  }
  return {
    ok: true,
    rows: payload.rows.map(r => {
      const o = {};
      for (const [h, i] of Object.entries(index)) o[h] = r[i];
      return o;
    }),
  };
}

/**
 * An activity name reduced to something safe to keep, and classified. PURE.
 *
 * ⚠ This is the privacy boundary of the whole integration. RescueTime activity
 * rows carry query strings and OAuth parameters verbatim — a real one pulled on
 * 2 Sep began `web.plaud.ai&response_type=code id_token&scope=name email&...`.
 * Everything after the first separator is discarded, unconditionally.
 *
 * Returns `{ kind: 'domain'|'app', value }`, or null for anything unusable. A
 * hostname has a dot and no spaces; everything else is an application name,
 * which is the same class of fact NEURO's own agent already stores.
 */
function sanitiseActivity(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Cut at the first thing that could carry a path, a query or a title.
  s = s.split(/[&?#/\\|]/)[0].trim();
  if (!s) return null;
  s = s.slice(0, 80).trim();

  const looksLikeHost = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/i.test(s);
  // ⚠ A FILENAME matches that pattern too: `risk-assessment-naomi.docx` is a
  // perfectly good hostname as far as the regex is concerned, and it carries a
  // colleague's name. `restrict_kind=document` is never requested, so this
  // should not arrive — which is exactly the reasoning that makes a cheap guard
  // worth having rather than not.
  const tail = s.toLowerCase().split('.').pop();
  const isFileExtension = FILE_EXTENSIONS.has(tail);

  if (looksLikeHost && !isFileExtension) {
    return { kind: 'domain', value: s.toLowerCase().replace(/^www\./, '') };
  }

  // ⚠ Anything else is an app name, and it goes through the SAME sanitiser the
  // desktop agent uses — cut at the first separator, so a window title collapses
  // to its first token. Deliberately the same function and not a second, gentler
  // copy: two sanitisers over one class of data means the weaker one is the leak.
  // Cost is a hyphenated name losing its tail (`tailscale-ipn` becomes
  // `tailscale`), which still identifies it.
  const app = require('./desktop-activity').sanitiseApp(s);
  return app ? { kind: 'app', value: app } : null;
}

/** Seconds to minutes, one decimal. PURE. */
function toMinutes(seconds) {
  return Math.round(((Number(seconds) || 0) / 60) * 10) / 10;
}

/**
 * Fold parsed rows into `{ [day]: { totalMinutes, categories, domains, apps } }`.
 * PURE.
 *
 * ⚠ The day key is taken from RescueTime's OWN Date field and used verbatim. It
 * reports in the account's configured timezone, so re-deriving it from a
 * timestamp here would silently shift a day for every evening's work.
 */
function foldDays(overviewRows = [], activityRows = []) {
  const days = {};
  const dayOf = key => {
    if (!days[key]) days[key] = { day: key, totalMinutes: 0, categories: {}, domains: {}, apps: {} };
    return days[key];
  };

  for (const r of overviewRows) {
    const day = String(r.Date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const mins = toMinutes(r['Time Spent (seconds)']);
    const d = dayOf(day);
    d.totalMinutes = Math.round((d.totalMinutes + mins) * 10) / 10;
    const cat = String(r.Category || '').slice(0, 60) || 'Uncategorized';
    d.categories[cat] = Math.round(((d.categories[cat] || 0) + mins) * 10) / 10;
  }

  for (const r of activityRows) {
    const day = String(r.Date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const item = sanitiseActivity(r.Activity);
    if (!item) continue;
    const mins = toMinutes(r['Time Spent (seconds)']);
    const d = dayOf(day);
    const bucket = item.kind === 'domain' ? d.domains : d.apps;
    bucket[item.value] = Math.round(((bucket[item.value] || 0) + mins) * 10) / 10;
  }

  for (const d of Object.values(days)) {
    const top = Object.entries(d.categories).sort((a, b) => b[1] - a[1])[0];
    d.topCategory = top ? top[0] : null;
  }
  return days;
}

// ── Pure: the agreement check ────────────────────────────────────────────────

/**
 * Does RescueTime's day agree with what the agent MEASURED? PURE.
 *
 * `deskDay` is a `desktop_daily` row for the same date.
 *
 * ⚠ Three refusals, and they are the point:
 *
 *  1. A day the agent did not properly cover CANNOT referee. An incomplete or
 *     thin agent day yields `unknown` with a reason — never a verdict against
 *     RescueTime, which would blame it for our own blind spot.
 *  2. Only UNDER-reporting is ever flagged. RescueTime legitimately records more
 *     than the agent: another machine, or time before the agent was installed.
 *     Flagging "over" would produce a permanent false alarm on a working feed.
 *  3. RescueTime exposes NO per-device breakdown, so its total cannot be
 *     attributed to one machine. The comparison is made against the agent's
 *     busiest host that day and SAYS which — an approximation, named as one.
 */
function assessDay(rtDay, deskDays = []) {
  const busiest = [...deskDays].sort(
    (a, b) => (Number(b.present_minutes) || 0) - (Number(a.present_minutes) || 0)
  )[0];

  if (!busiest) {
    return { state: 'unknown', why: 'the desktop agent recorded nothing that day', ratio: null, host: null };
  }
  if (!busiest.complete) {
    return { state: 'unknown', why: 'the day is not finished', ratio: null, host: busiest.host };
  }
  if ((Number(busiest.sample_count) || 0) < MIN_DESK_SAMPLES) {
    return {
      state: 'unknown',
      host: busiest.host,
      ratio: null,
      why: `the agent only recorded ${busiest.sample_count} samples that day — too thin to referee`,
    };
  }

  const measured = Number(busiest.present_minutes) || 0;
  if (measured <= 0) {
    return { state: 'unknown', why: 'the agent measured no time at the machine', ratio: null, host: busiest.host };
  }

  const reported = rtDay ? Number(rtDay.total_minutes) || 0 : 0;
  const ratio = Math.round((reported / measured) * 100) / 100;

  if (!rtDay || reported <= 0) {
    return {
      state: 'under',
      ratio: 0,
      host: busiest.host,
      why: `RescueTime logged nothing while the agent measured ${(measured / 60).toFixed(1)}h at ${busiest.host}`,
    };
  }
  if (ratio < AGREEMENT_FLOOR) {
    return {
      state: 'under',
      ratio,
      host: busiest.host,
      why: `RescueTime logged ${(reported / 60).toFixed(1)}h against ${(measured / 60).toFixed(1)}h measured at ${busiest.host}`,
    };
  }
  return { state: 'agree', ratio, host: busiest.host, why: null };
}

/**
 * Should this day's fetch replace what is stored? PURE.
 *
 * ⚠ `desktop-daily.shouldReplace` in its other form. RescueTime returning
 * nothing for a day it previously reported eight hours of is indistinguishable
 * from a real quiet day — and of the two readings, only one destroys evidence.
 * So an empty answer never overwrites a day that had hours.
 */
function shouldStore(existing, totalMinutes) {
  const had = Number(existing && existing.total_minutes) || 0;
  const has = Number(totalMinutes) || 0;
  if (had > 0 && has <= 0) {
    return {
      write: false,
      why: `RescueTime returned nothing for a day it had already reported ${(had / 60).toFixed(1)}h for`,
    };
  }
  return { write: true };
}

/**
 * The rollup the senses row reads. PURE.
 *
 * ⚠ `calibrating` until MIN_CALIBRATION_DAYS comparable days exist. Reporting
 * "RescueTime has stopped watching" off two days would make the check the thing
 * that cries wolf, and a check nobody believes is worse than no check.
 */
function coverage(pairs = []) {
  const judged = pairs.filter(p => p.state === 'agree' || p.state === 'under');
  const under = judged.filter(p => p.state === 'under');
  const unknown = pairs.filter(p => p.state === 'unknown').length;

  if (judged.length < MIN_CALIBRATION_DAYS) {
    return {
      state: 'calibrating',
      judged: judged.length,
      needed: MIN_CALIBRATION_DAYS,
      under: under.length,
      unknown,
      why: `${judged.length} of ${MIN_CALIBRATION_DAYS} comparable days so far`,
    };
  }
  if (under.length) {
    return {
      state: 'under',
      judged: judged.length,
      under: under.length,
      unknown,
      days: under.map(u => u.day).filter(Boolean),
      why: `RescueTime under-reported on ${under.length} of the last ${judged.length} measured days`,
    };
  }
  return { state: 'agree', judged: judged.length, under: 0, unknown, why: null };
}

// ── Network ──────────────────────────────────────────────────────────────────

function _dayKey(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function _fetch(params, { timeoutMs = 20000 } = {}) {
  const k = key();
  if (!k) return { ok: false, error: 'not-configured' };

  const qs = new URLSearchParams({ key: k, format: 'json', ...params });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}?${qs}`, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      // ⚠ The body may echo the key back in an error message. Never pass it on.
      return { ok: false, error: res.status === 401 ? 'unauthorized' : `http-${res.status}` };
    }
    try {
      return { ok: true, payload: JSON.parse(text) };
    } catch {
      return { ok: false, error: 'unparseable' };
    }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and fold a date range. Returns `{ ok, days, gaps }`.
 *
 * Two calls: categories, then activities for the domains. `restrict_kind` is
 * never `document` and never `productivity` — see the header.
 */
async function fetchRange(from, to) {
  const gaps = [];
  const base = { perspective: 'interval', interval: 'day', restrict_begin: from, restrict_end: to };

  const overview = await _fetch({ ...base, restrict_kind: 'overview' });
  if (!overview.ok) return { ok: false, days: {}, gaps: [{ input: 'categories', why: overview.error }] };
  const parsedOverview = parseRows(overview.payload, ['Date', 'Time Spent (seconds)', 'Category']);
  if (!parsedOverview.ok) return { ok: false, days: {}, gaps: [{ input: 'categories', why: parsedOverview.error }] };

  // ⚠ The domains are the reason to do this at all, but a failure here must not
  // discard the categories that already arrived — a partial answer, clearly
  // labelled, beats nothing.
  const activity = await _fetch({ ...base, restrict_kind: 'activity' });
  let activityRows = [];
  if (!activity.ok) {
    gaps.push({ input: 'domains', why: activity.error });
  } else {
    const parsedActivity = parseRows(activity.payload, ['Date', 'Time Spent (seconds)', 'Activity']);
    if (!parsedActivity.ok) gaps.push({ input: 'domains', why: parsedActivity.error });
    else activityRows = parsedActivity.rows;
  }

  return { ok: true, days: foldDays(parsedOverview.rows, activityRows), gaps };
}

// ── Stateful ─────────────────────────────────────────────────────────────────

/**
 * Pull the trailing window into `rescuetime_daily`.
 *
 * ⚠ A day that comes back EMPTY never overwrites a day that had hours. That is
 * the `desktop-daily` guard in its other form: RescueTime returning nothing for
 * a day it previously reported eight hours of is indistinguishable from a real
 * quiet day, and the destructive reading is the one that loses evidence.
 */
async function sync({ now = new Date(), days = SYNC_WINDOW_DAYS } = {}) {
  if (!isConfigured()) {
    return { ok: false, written: 0, skipped: [], gaps: [{ input: 'rescuetime', why: 'not-configured' }] };
  }

  const to = _dayKey(now);
  const from = _dayKey(new Date(now.getTime() - days * 86400000));
  const result = await fetchRange(from, to);
  if (!result.ok) return { ok: false, written: 0, skipped: [], gaps: result.gaps };

  const written = [];
  const skipped = [];
  const todayKey = _dayKey(now);

  for (const [day, d] of Object.entries(result.days)) {
    try {
      const verdict = shouldStore(db.getRescueTimeDay(day), d.totalMinutes);
      if (!verdict.write) {
        skipped.push({ day, why: verdict.why });
        continue;
      }
      db.upsertRescueTimeDay({
        day,
        totalMinutes: d.totalMinutes,
        categories: JSON.stringify(d.categories || {}),
        domains: JSON.stringify(d.domains || {}),
        topCategory: d.topCategory,
        complete: day < todayKey,
      });
      written.push(day);
    } catch (e) {
      result.gaps.push({ input: day, why: e.message });
    }
  }

  return { ok: true, written: written.length, writtenDays: written, skipped, gaps: result.gaps };
}

function hydrate(row) {
  if (!row) return row;
  const parse = v => { try { return v ? JSON.parse(v) : {}; } catch { return {}; } };
  return { ...row, categories: parse(row.categories), domains: parse(row.domains), complete: !!row.complete };
}

/** Days with their agreement verdict attached. Newest first. */
function recentDays(days = 30) {
  const rt = db.getRescueTimeDays(days).map(hydrate);
  const deskByDay = {};
  for (const r of require('./desktop-daily').recentDays(days)) {
    (deskByDay[r.day] = deskByDay[r.day] || []).push(r);
  }
  return rt.map(r => ({ ...r, agreement: assessDay(r, deskByDay[r.day] || []) }));
}

/**
 * The senses answer. Every day the AGENT measured is considered, not only the
 * days RescueTime returned — otherwise a day it missed entirely is absent from
 * its own coverage report, which is the failure marking itself as healthy.
 */
function coverageReport(days = 30) {
  const deskDays = require('./desktop-daily').recentDays(days, { completeOnly: true });
  const byDay = {};
  for (const r of deskDays) (byDay[r.day] = byDay[r.day] || []).push(r);

  const rtByDay = {};
  for (const r of db.getRescueTimeDays(days).map(hydrate)) rtByDay[r.day] = r;

  const pairs = Object.keys(byDay).map(day => ({ day, ...assessDay(rtByDay[day] || null, byDay[day]) }));
  return { ...coverage(pairs), configured: isConfigured(), credentialSource: credentialSource(), pairs };
}

module.exports = {
  // credential
  key,
  isConfigured,
  credentialSource,
  setStoredKey,
  clearStoredKey,
  // pure
  parseRows,
  sanitiseActivity,
  toMinutes,
  foldDays,
  assessDay,
  coverage,
  shouldStore,
  // network + state
  fetchRange,
  sync,
  recentDays,
  coverageReport,
  // constants
  KEY_STATE,
  AGREEMENT_FLOOR,
  MIN_CALIBRATION_DAYS,
  MIN_DESK_SAMPLES,
  SYNC_WINDOW_DAYS,
};
