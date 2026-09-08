'use strict';

/**
 * "Not now" for an approval card. PURE — no DB, no clock, no network.
 *
 * The Actions queue is the one screen where nothing has happened yet, so every
 * card on it is a thing Nick has to decide. Before this, the only ways to clear
 * one were to APPROVE it (which sends the email, creates the task, books the
 * meeting) or to REJECT it — and rejection is a verdict that is recorded and
 * that teaches the suggestion engine not to offer it again. There was no way to
 * say the true thing, which is usually "yes, but not this morning".
 *
 * ⚠ A SNOOZE IS NOT A DECISION, and that is the whole design. The row keeps
 * `status = 'pending'`, because three separate passes read the pending pool to
 * decide whether to CREATE another one:
 *
 *   · `suggestion-engine.generateSuggestions` dedupes against pending,
 *   · `action-candidates` folds a repeated commitment into a pending row,
 *   · `weekly-risk` asks "is one already queued" before queueing.
 *
 * Move a snoozed action out of that pool and NEURO regenerates the identical
 * card within the minute — which is the 7 Sep offered-once bug, reintroduced by
 * a button whose entire meaning is "leave me alone". So the sleep is applied at
 * the SURFACES that ask "what needs me now", and nowhere else.
 *
 * ⚠ It is also not a rejection, so it teaches the engine NOTHING. Nick saying
 * "later" must not become evidence he did not want it.
 */

// A week. Past this, "not now" has stopped being a timing decision and become a
// rejection nobody recorded — and a card asleep for a month is a commitment
// quietly dropped. Refused rather than clamped: silently giving a shorter sleep
// than asked for is the planner disagreeing with Nick about his own diary.
const MAX_SNOOZE_MINUTES = 7 * 24 * 60;

// The options the panel offers. Kept here rather than in the component so the
// screen cannot offer a duration the server refuses.
const PRESETS = [
  { label: '1 hour', minutes: 60 },
  { label: '3 hours', minutes: 180 },
  { label: 'Tomorrow', minutes: 24 * 60 },
  { label: 'Next week', minutes: 7 * 24 * 60 },
];

/**
 * Is this action asleep right now?
 *
 * ⚠ An unreadable or nonsense `snoozed_until` reads as AWAKE. The failure
 * directions are not symmetric: a card shown too early is a mild annoyance Nick
 * can snooze again, a card hidden by a value nothing can parse is an approval
 * that silently never happens.
 */
function isSnoozed(action, now = new Date()) {
  const raw = action && action.snoozed_until;
  if (!raw) return false;
  const until = Date.parse(raw);
  if (!Number.isFinite(until)) return false;
  return until > now.getTime();
}

/**
 * Split a pending list into what needs Nick now and what is asleep.
 *
 * Returns both, because a shorter queue is indistinguishable from a queue with
 * less in it — the same rule as the Must Move lane reporting what it held back.
 */
function partitionSnoozed(actions = [], now = new Date()) {
  const awake = [];
  const asleep = [];
  for (const a of actions) (isSnoozed(a, now) ? asleep : awake).push(a);
  // Waking soonest first: the next thing to come back is the useful top of a
  // list nobody is being asked to act on.
  asleep.sort((a, b) => String(a.snoozed_until).localeCompare(String(b.snoozed_until)));
  return { awake, asleep };
}

/**
 * Work out when a snooze should end, or refuse and say why.
 *
 * `expiresAt` is the moment the action dies of its own accord — a navigation
 * shortcut is retired the day after it is raised, and a meeting-prep card the
 * moment the meeting starts.
 *
 * ⚠ A SNOOZE MAY NEVER OUTLIVE ITS ACTION. Without this, "remind me tomorrow"
 * on a prep shortcut is a card that is swept to `expired` while it sleeps and
 * simply never comes back: Nick asked for it later and got it never, silently,
 * which is the one outcome a snooze must not produce. Refused by name rather
 * than shortened, so the answer is his to give.
 */
function resolveSnooze(minutes, { now = new Date(), expiresAt = null } = {}) {
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0) {
    return { ok: false, reason: 'snooze needs a positive number of minutes' };
  }
  if (mins > MAX_SNOOZE_MINUTES) {
    return { ok: false, reason: `the longest snooze is ${MAX_SNOOZE_MINUTES / (24 * 60)} days — beyond that, reject it instead` };
  }
  const until = new Date(now.getTime() + mins * 60000);
  if (expiresAt) {
    const dies = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isFinite(dies.getTime()) && until.getTime() >= dies.getTime()) {
      return {
        ok: false,
        reason: 'this one expires before then, so it would never come back',
        expiresAt: dies.toISOString(),
      };
    }
  }
  return { ok: true, until: until.toISOString(), minutes: mins };
}

module.exports = {
  isSnoozed,
  partitionSnoozed,
  resolveSnooze,
  MAX_SNOOZE_MINUTES,
  PRESETS,
};
