'use strict';

/**
 * How long things take, and what fits in the time there is.
 *
 * The gap this closes: nothing in NEURO knew the duration of anything. No
 * estimate on a task, no record of how long work actually took, and no answer
 * to "you have forty minutes before your next meeting — what can I finish?".
 * Every other accommodation in the system is about WHAT to do — the one thing,
 * wins, quick wins, avoidance — and none about whether it fits in the time
 * available. Time blindness is one of the most consistent ADHD traits and the
 * system did not attempt it at all.
 *
 * Two deliberate limits, both about not pretending:
 *
 * 1. An un-estimated task is NOT silently treated as thirty minutes. It is
 *    treated as thirty minutes and SAID SO — every item carries `assumed`, and
 *    the caller is expected to show it. A "this fits" that turns out to be a
 *    guess is worse than no answer, because it is the answer you stop trusting
 *    after the second time it is wrong.
 *
 * 2. Nothing here learns from completion timestamps yet. That was floated and
 *    is deliberately not built: it needs a body of finished, estimated tasks to
 *    calibrate against and there are currently none. Guessing durations from a
 *    model instead is the same mistake as the MoSCoW classifier — a confident
 *    number nobody can check.
 */

const db = require('../db/database');

// The assumption used for un-estimated work. Coarse, and stated everywhere it
// is applied. 30 rather than 15 because under-estimating is what makes a plan
// collapse: being handed something that overruns the gap is the failure mode
// that trains you to ignore the feature.
const ASSUMED_MINUTES = 30;

// Leave the last few minutes of any gap alone. Walking into a meeting straight
// off the back of a task is how you arrive with the previous thing still in
// your head — and an estimate that exactly fills the gap has no room to be
// slightly wrong, which it always is.
const BUFFER_MINUTES = 5;

function pad(n) { return String(n).padStart(2, '0'); }

/** Local date string — never toISOString(), which shifts the day on BST evenings. */
function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Graph hands back naive local wall-clock strings ("2026-08-18T14:00:00"). */
function minutesIntoDay(dateTime) {
  const m = String(dateTime || '').match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * How long until the next thing in the diary, and what that thing is.
 *
 * `events` is passed in rather than fetched, so this stays synchronous and
 * testable and the caller controls whether a Graph read happens at all — the
 * ADHD panel is deterministic-first for a reason and must not start waiting on
 * a network call.
 */
function nextGap(events, now = new Date()) {
  const today = dateStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const upcoming = (events || [])
    .filter(e => e.date === today)
    .filter(e => e.showAs !== 'cancelled' && e.showAs !== 'free')
    .filter(e => !e.isAllDay)   // an all-day marker is not a wall you hit at a time
    .map(e => ({ ...e, startMin: minutesIntoDay(e.start) }))
    .filter(e => e.startMin != null && e.startMin > nowMin)
    .sort((a, b) => a.startMin - b.startMin);

  if (!upcoming.length) {
    // No wall ahead is a real answer, and a different one from "no time".
    return { minutes: null, until: null, nextEvent: null, openEnded: true };
  }

  const next = upcoming[0];
  return {
    minutes: Math.max(0, next.startMin - nowMin - BUFFER_MINUTES),
    until: `${pad(Math.floor(next.startMin / 60))}:${pad(next.startMin % 60)}`,
    nextEvent: { subject: next.subject, start: next.start },
    openEnded: false,
  };
}

/**
 * Which open tasks fit in `minutes`.
 *
 * Ranked by the caller's order (the task list arrives already scored), then cut
 * to what fits. Deliberately NOT re-ranked by duration: offering the shortest
 * thing first is how "what fits" degrades into the quick-wins list that already
 * exists, and the ADHD panel is explicit that a smaller task is not always the
 * right answer.
 */
function whatFits(tasks, minutes, { limit = 5 } = {}) {
  if (minutes == null) {
    // Open-ended. Everything fits, so saying "here is what fits" is noise —
    // that is the ordinary task list's job, not this one's.
    return { openEnded: true, minutes: null, items: [], assumedCount: 0 };
  }

  const items = [];
  let assumedCount = 0;
  for (const task of tasks || []) {
    if (task.status && task.status !== 'open' && task.status !== 'in-progress') continue;
    const estimate = task.estimateMinutes ?? task.estimate_minutes ?? null;
    const effective = estimate == null ? ASSUMED_MINUTES : estimate;
    if (effective > minutes) continue;
    if (estimate == null) assumedCount++;
    items.push({
      task_id: task.task_id ?? task.id ?? null,
      text: task.text,
      moscow: task.moscow || null,
      due_date: task.due_date || null,
      minutes: effective,
      // The whole point of the flag: the caller must be able to say "assuming
      // half an hour" rather than presenting a guess as a measurement.
      assumed: estimate == null,
    });
    if (items.length >= limit) break;
  }

  return { openEnded: false, minutes, items, assumedCount, assumedMinutes: ASSUMED_MINUTES };
}

/** How much of the task list has an estimate at all — the honest denominator. */
function estimateCoverage() {
  const rows = db.listTaskRows({ status: 'all', includeDone: false })
    .filter(r => r.status === 'open' || r.status === 'in-progress');
  const withEstimate = rows.filter(r => r.estimate_minutes != null).length;
  return {
    total: rows.length,
    estimated: withEstimate,
    // Stated as a fraction rather than a percentage of a small number, because
    // "18% populated" is exactly how the priority field ended up meaningless.
    unestimated: rows.length - withEstimate,
  };
}

module.exports = {
  ASSUMED_MINUTES,
  BUFFER_MINUTES,
  nextGap,
  whatFits,
  estimateCoverage,
  dateStr,
  minutesIntoDay,
};
