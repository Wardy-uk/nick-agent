'use strict';

/**
 * Transitions — the seams of the day, where starting is hardest.
 *
 * Phase 3, Work Package C. The moments this exists for are the ones where an
 * intention reliably evaporates: the ten minutes before a meeting (too short to
 * start anything, long enough to lose), the minute after one ends (when the
 * follow-ups are still in your head and about to stop being), and the return to
 * something put down hours ago.
 *
 * ── What it must never do ───────────────────────────────────────────────────
 * It proposes. It does not act. No timer is started, no calendar is written, no
 * task is completed — the brief is explicit and so is this codebase's own
 * history: `plaud-admin-blocks` created 52 real events where 27 were wanted, and
 * a prompt that acts on its own is that failure with a friendlier face.
 *
 * ── It refuses to guess ─────────────────────────────────────────────────────
 * `known: false` on the calendar means NO transition, ever. "I could not read
 * the diary" and "there is nothing coming up" license opposite behaviour, and
 * telling Nick to leave for a meeting that is not there — or failing to, because
 * the read was empty — are both worse than silence.
 *
 * A "meeting" is `context-state.isRealMeeting`, IMPORTED rather than
 * re-derived: half his diary is solo work blocks, and "you just finished a
 * meeting, capture the follow-ups" said after an hour of writing alone is the
 * kind of wrong that gets a feature switched off.
 *
 * PURE — no DB, no clock, no I/O. Every input is passed in, so the judgement
 * pins without a Pi (the `pi-health.assess()` split).
 */

const { isRealMeeting, PRE_MEETING_MINUTES } = require('./context-state');

// How long after a meeting ends the follow-up prompt is still worth showing.
// Long enough to survive walking back to the desk, short enough that it is
// still THIS meeting he is thinking about rather than a vague prompt about
// meetings in general.
const POST_MEETING_MINUTES = 10;

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function minutesBetween(fromMs, toMs) {
  return Math.round((toMs - fromMs) / 60000);
}

/**
 * The one transition worth naming right now, or null.
 *
 * @param {object}   opts
 * @param {object}   opts.calendar  {known, events:[{start,end,subject,...}]}
 * @param {object}   opts.recovery  focus-session.recovery() output, or null
 * @param {Date}     opts.now
 * @returns {object|null} {kind, prompt, question, options, tab, meta}
 */
function nextTransition({ calendar = null, recovery = null, now = new Date() } = {}) {
  const nowMs = now.getTime();

  // ⚠ An unreadable diary produces NO calendar transition. It does not fall
  // through to "nothing coming up" — that is a claim, and we have not earned it.
  const canSeeDiary = Boolean(calendar && calendar.known === true);
  const events = canSeeDiary && Array.isArray(calendar.events) ? calendar.events : [];

  let current = null;
  let next = null;
  let justEnded = null;

  for (const ev of events) {
    if (!isRealMeeting(ev)) continue;
    const start = toDate(ev.start);
    const end = toDate(ev.end);
    if (!start || !end) continue;

    if (start.getTime() <= nowMs && end.getTime() > nowMs) {
      if (!current || start.getTime() > toDate(current.start).getTime()) current = ev;
      continue;
    }

    const untilStart = minutesBetween(nowMs, start.getTime());
    if (untilStart > 0 && untilStart <= PRE_MEETING_MINUTES) {
      if (!next || start.getTime() < toDate(next.start).getTime()) next = ev;
    }

    const sinceEnd = minutesBetween(end.getTime(), nowMs);
    if (sinceEnd >= 0 && sinceEnd <= POST_MEETING_MINUTES) {
      if (!justEnded || end.getTime() > toDate(justEnded.end).getTime()) justEnded = ev;
    }
  }

  // ── In a meeting: say nothing ──────────────────────────────────────────────
  // The one state where interrupting is actively wrong, and the gate already
  // treats it that way. A transition prompt is still an interruption.
  if (current) return null;

  // ── Leaving for the next one ───────────────────────────────────────────────
  // Time-critical, so it outranks everything else. It offers prep, and it offers
  // nothing that would change the diary.
  if (next) {
    const start = toDate(next.start);
    const mins = Math.max(0, minutesBetween(nowMs, start.getTime()));
    const where = next.location ? ` (${next.location})` : '';
    return {
      kind: 'leave-now',
      prompt: mins <= 1
        ? `"${next.subject || 'Your next meeting'}" starts in a minute${where}.`
        : `"${next.subject || 'Your next meeting'}" starts in ${mins} minutes${where}.`,
      question: 'Leave now, or open the prep?',
      options: ['prep', 'dismiss'],
      tab: 'prep',
      meta: { start: next.start, subject: next.subject || null, minutesAway: mins },
    };
  }

  // ── Just came out of one ───────────────────────────────────────────────────
  // The follow-ups are in his head for about a minute. This is the whole reason
  // capture exists, and the moment nothing has ever pointed him at it.
  if (justEnded) {
    const end = toDate(justEnded.end);
    return {
      kind: 'post-meeting',
      prompt: `"${justEnded.subject || 'That meeting'}" just finished.`,
      question: 'Anything to capture before it goes?',
      options: ['capture', 'dismiss'],
      tab: 'capture',
      meta: { subject: justEnded.subject || null, endedAt: justEnded.end, minutesSince: minutesBetween(end.getTime(), nowMs) },
    };
  }

  // ── Something put down earlier ─────────────────────────────────────────────
  // ⚠ Taken VERBATIM from focus-session.recovery(). It is not re-phrased and not
  // re-decided here: that module owns what a returning prompt says, and a second
  // wording of the same fact is how two surfaces drift. This layer only decides
  // that now is a moment to show it.
  if (recovery && (recovery.kind === 'resume' || recovery.kind === 'shrink')) {
    return {
      kind: `session-${recovery.kind}`,
      prompt: recovery.prompt,
      question: recovery.question,
      options: recovery.options,
      tab: 'now',
      meta: { sessionId: recovery.session?.id || null, nextStep: recovery.nextStep || null },
    };
  }

  return null;
}

module.exports = { nextTransition, POST_MEETING_MINUTES };
