'use strict';

/**
 * Attention controls — the settings behind every interruption.
 *
 * Its own module rather than part of `attention-lifecycle`, because `webpush`
 * needs to ask these questions on every send and has no business pulling in the
 * reconciler to do it.
 *
 * ⚠ Quiet hours DEFAULT to `PUSH_QUIET_HOURS`, deliberately. NEURO already had
 * exactly one considered statement about when to leave Nick alone, and inventing
 * a second one is how two parts of a system come to disagree about the same
 * evening — which is precisely what happened when `resolveDuty` guessed
 * 08:00–18:00 and flipped the widget to a day-off view at 18:14 on a Friday.
 * The stored setting wins ONLY once Nick has actually set one.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');

const STATE_KEY = 'attention_settings';

const LEVELS = ['all', 'normal', 'critical-only'];

const DEFAULTS = {
  enabled: true,
  quietHours: null,          // null = fall back to PUSH_QUIET_HOURS
  interruptionLevel: 'normal',
  pausedUntil: null,
  domains: { work: true, personal: true },
};

function _envQuietHours() {
  const raw = process.env.PUSH_QUIET_HOURS || '22:00-07:00';
  return raw === 'off' ? null : raw;
}

/** A quiet-hours string is only usable if it parses. Anything else is ignored. */
function isQuietWindow(value) {
  if (value === 'off') return true;
  return /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(String(value || ''));
}

function read() {
  let stored = {};
  try {
    stored = JSON.parse(db.getState(STATE_KEY) || '{}') || {};
  } catch {
    stored = {};
  }
  const domains = stored.domains && typeof stored.domains === 'object' ? stored.domains : {};
  return {
    enabled: stored.enabled !== false,
    // The effective window, with `source` named so the control surface can say
    // "inherited from the server" rather than showing Nick a value he never set
    // as though he had.
    quietHours: isQuietWindow(stored.quietHours) ? stored.quietHours : _envQuietHours(),
    quietHoursSource: isQuietWindow(stored.quietHours) ? 'setting' : 'server',
    interruptionLevel: LEVELS.includes(stored.interruptionLevel) ? stored.interruptionLevel : DEFAULTS.interruptionLevel,
    pausedUntil: typeof stored.pausedUntil === 'string' ? stored.pausedUntil : null,
    domains: {
      work: domains.work !== false,
      personal: domains.personal !== false,
    },
  };
}

/**
 * Patch the settings. Unknown keys are IGNORED rather than stored — this blob is
 * read on every push, and letting a client write arbitrary fields into it is how
 * a typo becomes a permanent silent setting nobody can find.
 */
function update(patch = {}) {
  const current = read();
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    quietHours: current.quietHoursSource === 'setting' ? current.quietHours : null,
    interruptionLevel: current.interruptionLevel,
    pausedUntil: current.pausedUntil,
    domains: { ...current.domains },
  };

  if (patch.quietHours === null) next.quietHours = null;          // back to the server's
  else if (isQuietWindow(patch.quietHours)) next.quietHours = patch.quietHours;

  if (LEVELS.includes(patch.interruptionLevel)) next.interruptionLevel = patch.interruptionLevel;

  // Pausing is expressed in MINUTES by the caller and stored as an instant. A
  // stored duration would be wrong the moment it was read back — the same reason
  // the navigation shortcut stores a start rather than "minutesAway".
  if (patch.pausedUntil === null || patch.pauseMinutes === 0) next.pausedUntil = null;
  else if (Number.isFinite(Number(patch.pauseMinutes)) && Number(patch.pauseMinutes) > 0) {
    const mins = Math.min(Number(patch.pauseMinutes), 24 * 60);
    next.pausedUntil = new Date(Date.now() + mins * 60000).toISOString();
  }

  if (patch.domains && typeof patch.domains === 'object') {
    if (typeof patch.domains.work === 'boolean') next.domains.work = patch.domains.work;
    if (typeof patch.domains.personal === 'boolean') next.domains.personal = patch.domains.personal;
  }

  db.setState(STATE_KEY, JSON.stringify(next));
  return read();
}

/**
 * Is SARA paused right now? PURE — takes the settings and the clock.
 *
 * An unparseable `pausedUntil` reads as NOT paused: a corrupt value must not be
 * able to silence NEURO indefinitely with no way for Nick to see why.
 */
function isPaused(settings, now = new Date()) {
  if (!settings || !settings.pausedUntil) return false;
  const until = new Date(settings.pausedUntil).getTime();
  if (!Number.isFinite(until)) return false;
  return now.getTime() < until;
}

/** Quiet-hours test against a settings object rather than the env. PURE. */
function isQuietAt(settings, now = new Date()) {
  const raw = settings && settings.quietHours;
  if (!raw || raw === 'off') return false;
  const m = String(raw).match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const startMins = Number(m[1]) * 60 + Number(m[2]);
  const endMins = Number(m[3]) * 60 + Number(m[4]);
  const mins = now.getHours() * 60 + now.getMinutes();
  // Wraps midnight, so "after start OR before end" rather than a simple range.
  return startMins > endMins ? (mins >= startMins || mins < endMins) : (mins >= startMins && mins < endMins);
}

module.exports = { read, update, isPaused, isQuietAt, isQuietWindow, LEVELS, DEFAULTS, STATE_KEY };
