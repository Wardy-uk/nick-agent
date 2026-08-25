'use strict';

/**
 * Context state — what NEURO believes Nick is doing RIGHT NOW.
 *
 * NEURO is the brain; SARA is the voice, ears and eyes. That division makes the
 * inference NEURO's job, not SARA's. `sara/backend/src/state/inference.js` had
 * started to grow a second one — an activity enum, a confidence model and a
 * recommended-view map — but its inputs were SEEDED (`state/seed.js`), so it was
 * a second opinion assembled from data that did not exist. The rules and the
 * honesty are ported here; the four-domain contract they sat on is not, because
 * that shape was invented for the seed and NEURO has real inputs instead.
 *
 * PURE. No DB, no network, no clock — `now` is passed in. Same split as
 * `pi-health.assess()`, `one-to-one-detect.cadenceState()` and
 * `state-of-play.assess()`: the judgement is the product, so it has to pin
 * without a Pi, a vault or a date rollover.
 *
 * ⚠ The load-bearing rule is that a MISSING input is never a zero. `known:false`
 * on the queue means "we could not look", and reading that as "nothing is
 * breaching" is how a dashboard reports a false all-clear (`weekly-risk`'s
 * `greenPct` lesson, and `wins`'s "a failed source is a GAP, never a zero").
 * Anything we could not see lands in `unknowns` and costs confidence.
 *
 * `steady` and `unknown` are therefore DIFFERENT facts: steady means we looked
 * and nothing stood out; unknown means we could not look.
 *
 * CommonJS only — NEURO backend convention.
 */

// How far ahead of a meeting the prep moment starts. Ten minutes is the window
// in which prep is still useful and not yet too late to read.
const PRE_MEETING_MINUTES = 10;

// Ritual windows. Deliberately the SAME boundaries `decision-engine._getMode()`
// already uses (morning < 11, lateday >= 16) rather than two fresh numbers —
// two definitions of "it is standup time" is how the surface and the nudge come
// to disagree about the same morning.
const MORNING_ENDS_HOUR = 11;
const LATE_DAY_STARTS_HOUR = 16;

// The bounded activity set, in the order it resolves. Nothing here is
// open-ended or auto-discovered: adding a state is a deliberate act.
const ACTIVITY = {
  UNKNOWN: 'unknown',                 // nothing legible came in
  IN_MEETING: 'in-meeting',           // in a room with other people
  PRE_MEETING: 'pre-meeting',         // a meeting with others starts shortly
  FIREFIGHTING: 'firefighting',       // escalations / SLA breaches are live
  IN_FOCUS_SESSION: 'in-focus-session', // a focus session is running
  RITUAL: 'ritual',                   // standup or EOD is outstanding, in its window
  OFF: 'off',                         // not a working day
  AWAY: 'away',                       // presence or location says away
  STEADY: 'steady',                   // we looked; nothing stood out
};

// Every input block SARA can feed the brain. Used to work out what was missing,
// so "we could not see the calendar" is a fact the surface can state.
const INPUT_BLOCKS = ['calendar', 'focusSession', 'queue', 'location', 'presence', 'rituals', 'workingDay'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A block counts as known only if it is an object that has not said otherwise.
// Absent and `{known:false}` are the same fact and must not diverge.
function known(block) {
  return isObject(block) && block.known !== false;
}

function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Which calendar events are meetings WITH OTHER PEOPLE, and where `now` sits
 * relative to them.
 *
 * ⚠ `attendeesOther` must be decided by the caller and must be exactly `true`.
 * This is `plaud-admin-blocks`'s rule unchanged: half of Nick's diary is time
 * blocked out for solo work, Graph lists the organiser among the attendees on
 * some events and not others, so an attendee COUNT is true for a solo block
 * roughly at random. Anything we cannot establish fails CLOSED — a focus block
 * announced as "you're in a meeting" is worse than saying nothing.
 */
function readMeetings(calendar, now) {
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  const nowMs = now.getTime();
  const preWindowMs = PRE_MEETING_MINUTES * 60 * 1000;

  let current = null;
  let next = null;
  let undecidable = 0;

  for (const ev of events) {
    if (!isObject(ev)) continue;
    if (ev.isAllDay) continue;
    if (ev.isCancelled) continue;
    if (ev.showAs === 'free') continue;

    const start = toDate(ev.start);
    const end = toDate(ev.end);
    if (!start || !end) continue;

    if (ev.attendeesOther !== true) {
      // Only count it as undecidable if it would otherwise have mattered —
      // a solo block at 3pm is not a gap in our knowledge, it is a solo block.
      if (ev.attendeesOther == null && end.getTime() > nowMs && start.getTime() - nowMs <= preWindowMs) {
        undecidable++;
      }
      continue;
    }

    if (start.getTime() <= nowMs && end.getTime() > nowMs) {
      if (!current || start.getTime() > toDate(current.start).getTime()) current = ev;
      continue;
    }
    const untilMs = start.getTime() - nowMs;
    if (untilMs > 0 && untilMs <= preWindowMs) {
      if (!next || start.getTime() < toDate(next.start).getTime()) next = ev;
    }
  }

  return {
    current,
    next,
    minutesToNext: next ? Math.max(0, Math.round((toDate(next.start).getTime() - nowMs) / 60000)) : null,
    undecidable,
  };
}

function readAway(presence, location) {
  const byPresence = known(presence) && presence.present === false;
  const byLocation = known(location) && location.place === 'away';
  return { away: byPresence || byLocation, byPresence, byLocation };
}

/**
 * Confidence in the read. Built from how much we could actually see, not from
 * how decisive the answer sounds — a firm-sounding activity inferred from one
 * live input is exactly the thing that should score low.
 */
function deriveConfidence({ activity, knownCount, contradictions }) {
  const basis = [];

  if (activity === ACTIVITY.UNKNOWN) {
    return {
      score: 0.2,
      level: 'low',
      basis: ['no-legible-input'],
      rationale: 'Nothing legible came in, so there is no read to be confident about.',
    };
  }

  // The clock is always known, which is worth something on its own but never
  // much: it is the one input that cannot be wrong and cannot say what you are
  // doing. Everything above that floor is earned by an input that answered.
  let score = 0.35;
  basis.push('clock');
  score += 0.1 * knownCount;
  basis.push(`${knownCount}-of-${INPUT_BLOCKS.length}-inputs`);

  if (knownCount < INPUT_BLOCKS.length) basis.push('inputs-missing');

  // The calm default is a weak-signal answer by nature. Say so rather than
  // presenting "nothing stood out" with the same certainty as a live breach.
  if (activity === ACTIVITY.STEADY) {
    score -= 0.15;
    basis.push('weak-signal-default');
  }

  if (contradictions.length) {
    score -= 0.2;
    basis.push('contradiction-present');
  }

  score = Math.max(0.2, Math.min(0.95, Number(score.toFixed(2))));

  // ⚠ The LEVEL is capped by coverage, not left to the score alone. Measured on
  // the live box the first time this ran: 4 of 7 inputs answered — no calendar,
  // no location, no presence — and the arithmetic landed on exactly 0.75, so the
  // read called itself `high` while its own rationale said three inputs could
  // not be read. `level` is the half consumers act on (it is what decides
  // whether `attention.gate` may HIDE work), so a generous label there is a
  // context blind to the diary quietly earning the right to filter the screen.
  // "High" now means what it says: everything answered.
  let level = score >= 0.75 ? 'high' : score >= 0.5 ? 'moderate' : 'low';
  if (level === 'high' && knownCount < INPUT_BLOCKS.length) level = 'moderate';

  let rationale;
  if (contradictions.length) {
    rationale = 'Inputs disagree; the read is reported with the conflict rather than smoothed over.';
  } else if (knownCount === INPUT_BLOCKS.length) {
    rationale = 'Every input answered and they agree.';
  } else {
    rationale = `${INPUT_BLOCKS.length - knownCount} of ${INPUT_BLOCKS.length} inputs could not be read, so this is inferred from what was available.`;
  }
  if (activity === ACTIVITY.STEADY) rationale += ' Nothing stood out, so this is a calm default rather than a positive signal.';

  return { score, level, basis, rationale };
}

/**
 * Resolve the context.
 *
 * @param {object} inputs  see INPUT_BLOCKS — every block optional, each may
 *                         carry `known:false` to say "we could not look"
 * @param {Date}   now
 * @returns {object} the context block
 */
function resolveContext(inputs = {}, now = new Date()) {
  const at = toDate(now) || new Date();
  const src = isObject(inputs) ? inputs : {};

  const unknowns = INPUT_BLOCKS.filter((name) => !known(src[name]));
  const knownCount = INPUT_BLOCKS.length - unknowns.length;

  const reasons = [];
  const contradictions = [];
  const derivedFrom = [];

  // Place is reported independently of activity — "where" and "what" are
  // different questions and a surface may want one without the other.
  const place = known(src.location)
    ? { known: true, name: src.location.place || 'unknown', source: src.location.source || null }
    : { known: false, name: null, source: null };

  if (unknowns.length === INPUT_BLOCKS.length) {
    return {
      activity: ACTIVITY.UNKNOWN,
      label: 'Unknown',
      summary: "I can't see enough to say what you're doing.",
      place,
      quiet: false,
      confidence: deriveConfidence({ activity: ACTIVITY.UNKNOWN, knownCount: 0, contradictions: [] }),
      reasons: ['No input answered, so there is nothing to infer from.'],
      contradictions: [],
      unknowns,
      derivedFrom: [],
      at: at.toISOString(),
    };
  }

  const meetings = known(src.calendar) ? readMeetings(src.calendar, at) : { current: null, next: null, minutesToNext: null, undecidable: 0 };
  const breaching = known(src.queue) ? Number(src.queue.breaching) || 0 : 0;
  const escalations = known(src.queue) ? Number(src.queue.unseenEscalations) || 0 : 0;
  const session = known(src.focusSession) && isObject(src.focusSession.active) ? src.focusSession.active : null;
  const { away, byPresence, byLocation } = readAway(src.presence, src.location);
  const isWorkingDay = known(src.workingDay) ? src.workingDay.isWorkingDay !== false : true;
  const hour = at.getHours();

  if (meetings.undecidable > 0) {
    reasons.push(`${meetings.undecidable} event${meetings.undecidable === 1 ? '' : 's'} nearby could not be judged as a meeting or a solo block, so ${meetings.undecidable === 1 ? 'it was' : 'they were'} left out.`);
  }

  // Conflicts are noted BEFORE the priority resolution, so confidence and the
  // stated reasons reflect them whichever branch ends up winning.
  if (away && (breaching > 0 || escalations > 0)) {
    contradictions.push('Presence says you are away, but the queue has live escalations — the work signal takes priority.');
  }
  if (away && meetings.current) {
    contradictions.push('Presence says you are away, but a meeting with other people is in the diary right now.');
  }
  if (!isWorkingDay && (meetings.current || session)) {
    contradictions.push(`Today is not a working day (${(known(src.workingDay) && src.workingDay.reason) || 'non-working'}), but there is live activity.`);
  }

  let activity;
  let label;
  let summary;
  let quiet = false;

  // ── Priority resolution ────────────────────────────────────────────────────
  // Most-committed signal wins. "Committed" rather than "urgent": being in a
  // room with people outranks a breaching queue not because it matters more but
  // because it is the one state where SARA interrupting is actively wrong.
  if (meetings.current) {
    activity = ACTIVITY.IN_MEETING;
    label = 'In a meeting';
    summary = meetings.current.subject ? `You're in "${meetings.current.subject}".` : "You're in a meeting.";
    quiet = true;
    reasons.push('A calendar event with other people in it is running now.');
    reasons.push('SARA stays quiet in a meeting — this is the one state where speaking up is wrong by default.');
    derivedFrom.push('calendar');
  } else if (meetings.next) {
    activity = ACTIVITY.PRE_MEETING;
    label = 'Meeting shortly';
    const mins = meetings.minutesToNext;
    summary = `${meetings.next.subject || 'A meeting'} in ${mins} minute${mins === 1 ? '' : 's'}.`;
    reasons.push(`A meeting with other people starts in ${mins} minute${mins === 1 ? '' : 's'} — inside the ${PRE_MEETING_MINUTES}-minute prep window.`);
    derivedFrom.push('calendar');
  } else if (breaching > 0 || escalations > 0) {
    activity = ACTIVITY.FIREFIGHTING;
    label = 'Firefighting';
    const parts = [];
    if (breaching > 0) parts.push(`${breaching} breaching`);
    if (escalations > 0) parts.push(`${escalations} unseen escalation${escalations === 1 ? '' : 's'}`);
    summary = `The queue needs you — ${parts.join(', ')}.`;
    reasons.push(`Queue is live: ${parts.join(', ')}.`);
    derivedFrom.push('queue');
  } else if (session) {
    activity = ACTIVITY.IN_FOCUS_SESSION;
    label = 'In a focus session';
    summary = session.taskTitle ? `You're working on "${session.taskTitle}".` : "You're in a focus session.";
    reasons.push(`A focus session is running${session.taskTitle ? `: "${session.taskTitle}"` : ''}.`);
    derivedFrom.push('focusSession');
  } else if (isWorkingDay && known(src.rituals) && src.rituals.standupOutstanding && hour < MORNING_ENDS_HOUR) {
    activity = ACTIVITY.RITUAL;
    label = 'Standup outstanding';
    summary = "The standup hasn't been done yet.";
    reasons.push(`It is before ${MORNING_ENDS_HOUR}:00 and the standup is still outstanding.`);
    derivedFrom.push('rituals');
  } else if (isWorkingDay && known(src.rituals) && src.rituals.eodOutstanding && hour >= LATE_DAY_STARTS_HOUR) {
    activity = ACTIVITY.RITUAL;
    label = 'EOD outstanding';
    summary = "The end-of-day wrap hasn't been done yet.";
    reasons.push(`It is after ${LATE_DAY_STARTS_HOUR}:00 and the EOD is still outstanding.`);
    derivedFrom.push('rituals');
  } else if (!isWorkingDay) {
    activity = ACTIVITY.OFF;
    label = 'Not a working day';
    const reason = (known(src.workingDay) && src.workingDay.reason) || null;
    summary = reason === 'holiday' ? "It's a bank holiday." : reason === 'weekend' ? "It's the weekend." : "It's not a working day.";
    quiet = true;
    reasons.push(`Today is not a working day${reason ? ` (${reason})` : ''}, and nothing urgent is live.`);
    derivedFrom.push('workingDay');
  } else if (away) {
    activity = ACTIVITY.AWAY;
    label = 'Away';
    summary = "You're away — nothing here needs you this second.";
    if (byPresence) reasons.push('Presence telemetry reports you are not here.');
    if (byLocation) reasons.push('Location context is "away".');
    derivedFrom.push(byPresence ? 'presence' : 'location');
  } else {
    activity = ACTIVITY.STEADY;
    label = 'Steady';
    summary = 'Nothing pressing.';
    reasons.push('Nothing is breaching, no meeting is close, no session is running and no ritual is outstanding.');
    derivedFrom.push(...INPUT_BLOCKS.filter((name) => known(src[name])));
  }

  // Always be explicit about what we could not see. An ambient surface that
  // quietly infers from half its inputs is one that will eventually be
  // confidently wrong with nothing on screen to explain why.
  if (unknowns.length) {
    reasons.push(`Could not read: ${unknowns.join(', ')}.`);
  }

  return {
    activity,
    label,
    summary,
    place,
    quiet,
    confidence: deriveConfidence({ activity, knownCount, contradictions }),
    reasons,
    contradictions,
    unknowns,
    derivedFrom: [...new Set(derivedFrom)],
    at: at.toISOString(),
  };
}

module.exports = {
  resolveContext,
  ACTIVITY,
  INPUT_BLOCKS,
  PRE_MEETING_MINUTES,
  MORNING_ENDS_HOUR,
  LATE_DAY_STARTS_HOUR,
};
