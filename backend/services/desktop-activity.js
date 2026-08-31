'use strict';

/**
 * What the laptop is doing — the one signal NEURO could not get any other way.
 *
 * Nick, 31 Aug 2026: "not working on my laptop (can SARA detect that?) and not
 * in a meeting — suggest a task. Too long coding (can SARA detect I've been in
 * VS Code for 4 hours?) — suggest a task."
 *
 * Both answers are yes, and neither is reachable from anything NEURO already
 * has: the phone knows where he is, the watch knows whether he is sitting, the
 * calendar knows whether a meeting is running, and NONE of them can tell working
 * from not-working, or four hours of one job from four hours of twelve. A small
 * Windows-side reporter posts a sample every couple of minutes and this is where
 * it lands.
 *
 * ── The privacy line, and it is not negotiable ───────────────────────────────
 * ⚠ The reporter sends the FOREGROUND PROCESS NAME and nothing else. Never the
 * window title, never a file path, never a URL, never keystrokes. A VS Code
 * title carries the file and the workspace; a browser title carries the page;
 * an Outlook title carries the SUBJECT LINE of whatever is open, which on this
 * machine means customer names, ticket subjects and, on a bad day, the contents
 * of a disciplinary folder. "Code" is enough to answer both of Nick's questions
 * and cannot leak any of that. `sanitiseApp()` enforces it server-side too, so a
 * future reporter that gets careless is truncated here rather than trusted.
 *
 * ⚠ A LOCKED session reports `locked` and no app at all. What he had open before
 * walking away is not something to keep a record of.
 *
 * ── Storage ─────────────────────────────────────────────────────────────────
 * A bounded ring buffer in `agent_state`, following `focus_session_history` and
 * `one_to_one_moves` rather than adding a table. This is disposable state — "what
 * is he doing lately" — not a record: nothing needs to query it by anything but
 * recency, a missed hour matters to nobody, and a schema migration on the live DB
 * is a bigger risk than the query convenience is worth. At one sample every two
 * minutes, `MAX_SAMPLES` is a little over twelve hours, which is comfortably more
 * than any run worth reporting.
 *
 * PURE where it judges: `currentRun()` and `assessDesk()` take plain arrays and a
 * clock, so every threshold pins without a database or a Windows box.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');

const STATE_KEY = 'desktop_activity';
const MAX_SAMPLES = 400;

// How stale a sample may be before it stops describing now. The reporter posts
// every two minutes; three missed posts means the laptop is off, asleep, or off
// the tailnet — all of which are "we cannot see it", never "he is not working".
const FRESH_MINUTES = 8;

// Idle for this long and he is not at the machine, whatever is on screen.
// `GetLastInputInfo` is keyboard and mouse across the whole session, so reading
// counts as idle — hence a figure that tolerates a long think, not a short one.
const IDLE_AWAY_MINUTES = 10;

// A single unbroken stretch in one app that is worth mentioning. Nick said four
// hours; this fires at three, because the useful moment is before the fourth.
const LONG_RUN_MINUTES = 180;

// Once mentioned, stay quiet for this long rather than saying it every poll.
const LONG_RUN_REMIND_MINUTES = 90;

// Apps where a long unbroken run is the JOB rather than a problem worth naming.
// Deliberately empty: it is a real question whether a four-hour meeting or a
// four-hour design session deserves the same line as four hours of coding, and
// guessing at that list before Nick has seen the feature would be inventing his
// preferences for him.
const NEVER_MENTION = new Set([]);

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * A process name reduced to something safe to store. PURE.
 *
 * Belt and braces: the reporter already sends only the process name, and this
 * makes a careless future reporter harmless rather than trusted. Anything with
 * a path separator, a space or an extension is stripped to its stem, and the
 * result is capped — a window title cannot survive this.
 */
function sanitiseApp(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // A title is usually "file.ts - project - Visual Studio Code"; take nothing
  // after the first separator, so a leaked title collapses to its first token.
  s = s.split(/[\\/|—–-]/)[0].trim();
  s = s.replace(/\.(exe|app)$/i, '');
  s = s.replace(/[^\w .+#-]/g, '');
  s = s.slice(0, 40).trim();
  return s || null;
}

/** Friendlier names for the handful worth reading on a card. */
const APP_LABELS = {
  Code: 'VS Code',
  devenv: 'Visual Studio',
  WindowsTerminal: 'Terminal',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  OUTLOOK: 'Outlook',
  ms: 'Teams',
  Teams: 'Teams',
  msedge: 'Edge',
  chrome: 'Chrome',
  firefox: 'Firefox',
  EXCEL: 'Excel',
  WINWORD: 'Word',
  ssms: 'SQL Server Management Studio',
  Obsidian: 'Obsidian',
};

function labelFor(app) {
  if (!app) return null;
  return APP_LABELS[app] || APP_LABELS[app.toLowerCase()] || app;
}

/**
 * The current unbroken run in one app. PURE.
 *
 * `samples` is newest-first `[{ at, app, idleSeconds, locked }]`.
 *
 * Returns `{ known, app, label, minutes, why }`. The three answers are kept
 * apart deliberately:
 *   known:false           — the laptop has not reported recently enough to say
 *   known:true, app:null  — reporting, but he is idle or locked: not working
 *   known:true, app:'Code'— actively in one app for `minutes`
 *
 * ⚠ A gap in the samples ENDS the run rather than being bridged. If the laptop
 * slept for an hour in the middle, that hour was not four hours of coding, and
 * assuming continuity across a hole is how a lunch break becomes part of the
 * run.
 */
function currentRun(samples = [], now = new Date()) {
  const list = Array.isArray(samples) ? samples : [];
  if (!list.length) return { known: false, app: null, label: null, minutes: 0, why: 'the laptop has never reported' };

  const newest = list[0];
  const ageMin = _minutesBetween(newest.at, now);
  if (ageMin == null || ageMin > FRESH_MINUTES) {
    return {
      known: false,
      app: null,
      label: null,
      minutes: 0,
      why: ageMin == null
        ? 'the laptop has never reported'
        : `the laptop last reported ${Math.round(ageMin)} minutes ago`,
    };
  }

  if (newest.locked) return { known: true, app: null, label: null, minutes: 0, why: 'locked' };
  if (Number(newest.idleSeconds) >= IDLE_AWAY_MINUTES * 60) {
    return { known: true, app: null, label: null, minutes: 0, why: 'idle' };
  }

  const app = sanitiseApp(newest.app);
  if (!app) return { known: true, app: null, label: null, minutes: 0, why: 'no foreground app' };

  // Walk back while it is the same app, actively used, and the samples are
  // CONTIGUOUS. `FRESH_MINUTES` doubles as the biggest gap that still counts as
  // the same sitting.
  let runStart = newest.at;
  let prev = newest;
  for (let i = 1; i < list.length; i += 1) {
    const s = list[i];
    if (!s) break;
    if (sanitiseApp(s.app) !== app) break;
    if (s.locked) break;
    if (Number(s.idleSeconds) >= IDLE_AWAY_MINUTES * 60) break;
    const gap = _minutesBetween(s.at, prev.at);
    if (gap == null || gap > FRESH_MINUTES) break;
    runStart = s.at;
    prev = s;
  }

  return {
    known: true,
    app,
    label: labelFor(app),
    minutes: Math.max(0, Math.round(_minutesBetween(runStart, now) || 0)),
    since: runStart,
  };
}

/**
 * Whether he is at the laptop at all. PURE, and separate from `currentRun`
 * because "is he working" and "what is he working on" are different questions
 * with different failure modes — the first is what decides whether SARA should
 * be surfacing work, and it must never answer "no" merely because the laptop is
 * off the network.
 */
function atLaptop(samples = [], now = new Date()) {
  const run = currentRun(samples, now);
  if (!run.known) return { known: false, at: false, why: run.why };
  return { known: true, at: run.app != null, why: run.why || null };
}

/**
 * Should a long run be mentioned? PURE.
 *
 * `lastMentioned` is the ISO time this app's run was last surfaced, so a poll
 * every thirty seconds does not repeat it. Returns null when there is nothing
 * to say.
 */
function assessDesk({ run = null, lastMentioned = null, now = new Date() } = {}) {
  if (!run || !run.known || !run.app) return null;
  if (run.minutes < LONG_RUN_MINUTES) return null;
  if (NEVER_MENTION.has(run.app)) return null;

  const since = _minutesBetween(lastMentioned, now);
  if (since != null && since < LONG_RUN_REMIND_MINUTES) return null;

  const hours = Math.floor(run.minutes / 60);
  const mins = run.minutes % 60;
  const spell = mins >= 15 ? `${hours}h ${mins}m` : `${hours} hours`;

  return {
    kind: 'long-focus',
    level: 'nudge',
    // States the fact. Whether that is good or bad is his call — four hours on
    // one thing is a good day as often as it is a stuck one.
    text: `${spell} in ${run.label} without a real break.`,
    suggestion: 'Worth a break, or a different job for a bit.',
    because: `the laptop has reported ${run.label} in the foreground since ${run.since}`,
    evidence: [{ source: 'desktop', ref: run.app, observedAt: run.since, detail: `${run.minutes} min unbroken` }],
    weight: 1,
    app: run.app,
  };
}

function _minutesBetween(fromIso, toIsoOrDate) {
  if (!fromIso) return null;
  const a = Date.parse(fromIso);
  const b = toIsoOrDate instanceof Date ? toIsoOrDate.getTime() : Date.parse(toIsoOrDate);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 60000;
}

// ── Storage ──────────────────────────────────────────────────────────────────

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return { samples: [], mentioned: {} };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      mentioned: parsed.mentioned && typeof parsed.mentioned === 'object' ? parsed.mentioned : {},
    };
  } catch (e) {
    console.error('[Desktop] Could not read activity:', e.message);
    return { samples: [], mentioned: {} };
  }
}

function _save(state) {
  db.setState(STATE_KEY, JSON.stringify({
    samples: state.samples.slice(0, MAX_SAMPLES),
    mentioned: state.mentioned || {},
  }));
}

/**
 * Record one sample. Returns what was stored, so the reporter can see that the
 * sanitiser agreed with it — a reporter that thinks it sent an app name and had
 * it stripped should be able to tell.
 */
function record({ app = null, idleSeconds = 0, locked = false, host = null, at = null } = {}) {
  const state = _load();

  const stamp = at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  const sample = {
    at: stamp,
    // ⚠ A locked session stores NO app. What he had open before walking away is
    // not something to keep.
    app: locked ? null : sanitiseApp(app),
    idleSeconds: Math.max(0, Math.round(Number(idleSeconds) || 0)),
    locked: !!locked,
    host: host ? String(host).slice(0, 40) : null,
  };

  // Newest first, and out-of-order arrivals are placed rather than assumed —
  // a reporter catching up after a sleep can post a batch.
  state.samples.unshift(sample);
  state.samples.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  state.samples = state.samples.slice(0, MAX_SAMPLES);
  _save(state);

  return sample;
}

function samples() {
  return _load().samples;
}

/** The current run, read from stored samples. */
function run(now = new Date()) {
  return currentRun(_load().samples, now);
}

/** Whether he is at the laptop, read from stored samples. */
function present(now = new Date()) {
  return atLaptop(_load().samples, now);
}

/**
 * The long-run observation, if there is one — and it REMEMBERS having said it,
 * so a surface polled every thirty seconds does not repeat the same line.
 * Recording the mention is a write, so this is not pure; the judgement it wraps
 * is.
 */
function longRunObservation(now = new Date()) {
  const state = _load();
  const r = currentRun(state.samples, now);
  const obs = assessDesk({ run: r, lastMentioned: state.mentioned[r.app] || null, now });
  if (obs) {
    state.mentioned[obs.app] = now.toISOString();
    _save(state);
  }
  return obs;
}

module.exports = {
  // pure
  sanitiseApp,
  labelFor,
  currentRun,
  atLaptop,
  assessDesk,
  // stateful
  record,
  samples,
  run,
  present,
  longRunObservation,
  // constants
  STATE_KEY,
  MAX_SAMPLES,
  FRESH_MINUTES,
  IDLE_AWAY_MINUTES,
  LONG_RUN_MINUTES,
  LONG_RUN_REMIND_MINUTES,
};
