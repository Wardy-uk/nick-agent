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
 * Whether a sample is him actively using that machine. PURE.
 *
 * Shared by `runAcross` and the daily rollup so "active" cannot come to mean two
 * things — the rollup's hours and the live run must be answering the same
 * question about the same sample.
 */
function isActive(sample) {
  if (!sample || sample.locked) return false;
  if (Number(sample.idleSeconds) >= IDLE_AWAY_MINUTES * 60) return false;
  return sanitiseApp(sample.app) != null;
}

/**
 * The current run across EVERY reporting machine. PURE.
 *
 * `buckets` is `{ [host]: samples[] }`, each newest-first. Returns `currentRun`'s
 * shape plus `host` (which machine answered), `hosts` (what each one said) and
 * `otherHostsActive`.
 *
 * ⚠ Which host answered is ALWAYS reported. A run attributed to the wrong
 * machine is worse than no run, and with one host installed the field is simply
 * always the same — that is the point at which it is cheap to get right.
 *
 * ⚠ A run on one machine is only unbroken if he was not on ANOTHER machine
 * during it. Two hosts will each report a tidy three-hour stretch for an
 * afternoon spent switching between them: true of each list in isolation, false
 * about the man. So the run starts after the last moment another machine saw
 * real use, and says which one interrupted it.
 */
function runAcross(buckets = {}, now = new Date()) {
  const entries = Object.entries(buckets || {}).filter(([, s]) => Array.isArray(s) && s.length);
  if (!entries.length) {
    return {
      known: false, app: null, label: null, minutes: 0,
      why: 'the laptop has never reported', host: null, hosts: [], otherHostsActive: [],
    };
  }

  const runs = entries.map(([host, list]) => ({ host, list, run: currentRun(list, now), newest: list[0] }));

  // An ACTIVE host beats a merely-reporting one, and inside each group the
  // freshest sample wins. A machine that is on but idle must never outrank the
  // one he is actually typing at.
  const rank = r => (r.run.known && r.run.app ? 2 : r.run.known ? 1 : 0);
  runs.sort((a, b) => (rank(b) - rank(a)) || String(b.newest.at).localeCompare(String(a.newest.at)));
  const primary = runs[0];

  const hosts = runs.map(r => ({ host: r.host, at: r.newest.at, known: r.run.known, active: !!r.run.app }));
  const base = { ...primary.run, host: primary.host, hosts, otherHostsActive: [] };
  if (!primary.run.known || !primary.run.app) return base;

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  let startMs = Date.parse(primary.run.since);
  let since = primary.run.since;
  const interrupted = [];
  for (const other of runs) {
    if (other.host === primary.host) continue;
    // Newest-first, so the first hit is the LATEST time another machine was in
    // use — which is where this run really began.
    const hit = other.list.find(s => {
      const t = Date.parse(s.at);
      return isActive(s) && Number.isFinite(t) && t > startMs && t <= nowMs;
    });
    if (hit) { startMs = Date.parse(hit.at); since = hit.at; interrupted.push(other.host); }
  }
  if (!interrupted.length) return base;

  return {
    ...base,
    since,
    minutes: Math.max(0, Math.round(_minutesBetween(since, now) || 0)),
    otherHostsActive: interrupted,
  };
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

// ── Storage, bucketed by host ────────────────────────────────────────────────

/**
 * ⚠ Samples are bucketed BY HOST, and that is not tidiness.
 *
 * Until 2 Sep 2026 every sample went into ONE 400-slot ring. With one machine
 * that is correct and cheap; the moment a second box runs the agent it is wrong
 * in two ways at once, and both are silent:
 *
 *  1. Both hosts compete for the same 400 slots, so the window each machine can
 *     see halves — and MAX_SAMPLES is the whole basis of "twelve hours of
 *     history".
 *  2. Worse, `currentRun` walks one list looking for CONTIGUITY. Interleave two
 *     hosts and the other machine's sample lands mid-run in a different app and
 *     ends it. Every run length would read short, with nothing logged and no
 *     error anywhere — which is precisely the failure this feature caught in
 *     RescueTime, where 0.16h was reported against a measured 8.21h day.
 *
 * So each host gets its own ring and its own `mentioned` map. Fixed BEFORE the
 * second install rather than after, because after is when the numbers are wrong
 * and plausible.
 */

// A reporter that sends no hostname still has to go somewhere. Written and read
// in this one module so the two halves cannot drift — an unrecognised marker
// arriving on a card as a machine name is the `(plan unknown)` lesson.
const UNKNOWN_HOST = 'unknown';

// The whole thing is one `agent_state` blob, parsed on every read, and several
// surfaces poll it. Four machines is already more than Nick owns; the cap is
// here so a reporter with a rolling hostname cannot grow the blob without limit.
const MAX_HOSTS = 4;

function _hostKey(host) {
  const s = host == null ? '' : String(host).trim().slice(0, 40);
  return s || UNKNOWN_HOST;
}

function _blankBucket() {
  return { samples: [], mentioned: {} };
}

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return { hosts: {} };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (parsed && parsed.hosts && typeof parsed.hosts === 'object') {
      const hosts = {};
      for (const [h, b] of Object.entries(parsed.hosts)) {
        hosts[h] = {
          samples: Array.isArray(b && b.samples) ? b.samples : [],
          mentioned: b && b.mentioned && typeof b.mentioned === 'object' ? b.mentioned : {},
        };
      }
      return { hosts };
    }

    // ── Migration from the single-ring shape ──
    // Lossless: every sample already carries the host that sent it, so the rows
    // go where they always belonged. `mentioned` is COPIED into each bucket
    // rather than dropped — the conservative direction is a long-run line that
    // stays quiet slightly too long, not one that repeats the moment we deploy.
    const legacy = Array.isArray(parsed && parsed.samples) ? parsed.samples : [];
    const mentioned = parsed && parsed.mentioned && typeof parsed.mentioned === 'object' ? parsed.mentioned : {};
    const hosts = {};
    for (const s of legacy) {
      const k = _hostKey(s && s.host);
      if (!hosts[k]) hosts[k] = { samples: [], mentioned: { ...mentioned } };
      hosts[k].samples.push(s);
    }
    if (!Object.keys(hosts).length && Object.keys(mentioned).length) {
      hosts[UNKNOWN_HOST] = { samples: [], mentioned: { ...mentioned } };
    }
    return { hosts };
  } catch (e) {
    console.error('[Desktop] Could not read activity:', e.message);
    return { hosts: {} };
  }
}

/** Drop the least-recently-reporting hosts past MAX_HOSTS. */
function _prune(state) {
  const keys = Object.keys(state.hosts);
  if (keys.length <= MAX_HOSTS) return;
  keys
    .map(h => ({ h, at: (state.hosts[h].samples[0] || {}).at || '' }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(MAX_HOSTS)
    .forEach(({ h }) => { delete state.hosts[h]; });
}

function _save(state) {
  const hosts = {};
  for (const [h, b] of Object.entries(state.hosts || {})) {
    hosts[h] = { samples: (b.samples || []).slice(0, MAX_SAMPLES), mentioned: b.mentioned || {} };
  }
  db.setState(STATE_KEY, JSON.stringify({ hosts }));
}

/** `{ [host]: samples[] }` — what the pure functions take. */
function _buckets(state) {
  const out = {};
  for (const [h, b] of Object.entries(state.hosts || {})) out[h] = b.samples || [];
  return out;
}

/**
 * Record one sample. Returns what was stored, so the reporter can see that the
 * sanitiser agreed with it — a reporter that thinks it sent an app name and had
 * it stripped should be able to tell.
 */
function record({ app = null, idleSeconds = 0, locked = false, host = null, at = null } = {}) {
  const state = _load();
  const key = _hostKey(host);

  const stamp = at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  const sample = {
    at: stamp,
    // ⚠ A locked session stores NO app. What he had open before walking away is
    // not something to keep.
    app: locked ? null : sanitiseApp(app),
    idleSeconds: Math.max(0, Math.round(Number(idleSeconds) || 0)),
    locked: !!locked,
    // The normalised key, never the raw value: a sample whose host disagreed
    // with the bucket holding it is a trap for everything downstream.
    host: key,
  };

  if (!state.hosts[key]) state.hosts[key] = _blankBucket();
  const bucket = state.hosts[key];
  // Newest first, and out-of-order arrivals are placed rather than assumed — a
  // reporter catching up after a sleep can post a batch.
  bucket.samples.unshift(sample);
  bucket.samples.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  bucket.samples = bucket.samples.slice(0, MAX_SAMPLES);

  _prune(state);
  _save(state);

  return sample;
}

/**
 * Samples, newest first. Merged across machines by default — "has anything
 * reported lately" is a question about the estate, not about one box. Pass a
 * host for the questions that are about one machine, such as whether a run was
 * broken.
 */
function samples({ host = null } = {}) {
  const state = _load();
  if (host != null) return ((state.hosts[_hostKey(host)] || {}).samples || []).slice();
  return Object.values(state.hosts)
    .flatMap(b => b.samples || [])
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** What each machine last said. Read-only, and the basis of the senses row. */
function hosts() {
  const state = _load();
  return Object.entries(state.hosts).map(([host, b]) => ({
    host,
    sampleCount: (b.samples || []).length,
    lastAt: (b.samples || [])[0] ? b.samples[0].at : null,
  })).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

/** The current run, read from stored samples, across every machine. */
function run(now = new Date()) {
  return runAcross(_buckets(_load()), now);
}

/** Whether he is at a machine at all, and which one. */
function present(now = new Date()) {
  const r = run(now);
  if (!r.known) return { known: false, at: false, why: r.why, host: null };
  return { known: true, at: r.app != null, why: r.why || null, host: r.host };
}

/**
 * The long-run observation, if there is one — and it REMEMBERS having said it,
 * so a surface polled every thirty seconds does not repeat the same line. The
 * memory is PER HOST, because the same app running long on two machines is two
 * separate facts. Recording the mention is a write, so this is not pure; the
 * judgement it wraps is.
 */
function longRunObservation(now = new Date()) {
  const state = _load();
  const r = runAcross(_buckets(state), now);
  const bucket = r.host ? state.hosts[r.host] : null;
  const obs = assessDesk({ run: r, lastMentioned: (bucket && bucket.mentioned[r.app]) || null, now });
  if (obs && bucket) {
    bucket.mentioned[obs.app] = now.toISOString();
    _save(state);
  }
  return obs;
}

module.exports = {
  // pure
  sanitiseApp,
  labelFor,
  isActive,
  currentRun,
  runAcross,
  atLaptop,
  assessDesk,
  // stateful
  record,
  samples,
  hosts,
  run,
  present,
  longRunObservation,
  // constants
  STATE_KEY,
  MAX_SAMPLES,
  MAX_HOSTS,
  UNKNOWN_HOST,
  FRESH_MINUTES,
  IDLE_AWAY_MINUTES,
  LONG_RUN_MINUTES,
  LONG_RUN_REMIND_MINUTES,
};
