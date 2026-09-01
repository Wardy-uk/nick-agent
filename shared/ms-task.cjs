/**
 * Which Microsoft board a task belongs to — phrased once, for every surface.
 *
 * A Planner task's card used to read "MS Planner" and nothing else, which is
 * true of all of them and so answers nothing: Nick's tasks are spread over
 * several Planner boards and several To Do lists, and the board is most of what
 * says whose work it is. `syncMicrosoftTasks` now writes the plan as a `### `
 * heading and `parseVaultTodos` reads it back onto the task as `msPlan`.
 *
 * Pure, and in `shared/` rather than in either frontend, because three surfaces
 * render task cards (NEURO's TodoPanel, SARA's Tasks and Focus) and three copies
 * of "how do we word this" is how they come to disagree about the same task.
 *
 * UNKNOWN IS SILENCE, NEVER A GUESS. A plan that could not be read is null all
 * the way from Graph to here, and a card says nothing rather than naming a board
 * the task might not be on.
 */

const SYSTEM_LABELS = { 'MS Planner': 'Planner', 'MS ToDo': 'To Do' };

/** 'MS Planner' / 'MS ToDo' / null — the same test task-dedupe uses. */
function msSystem(task) {
  const raw = (task && (task.msSource || task.source)) || '';
  if (/planner/i.test(raw)) return 'MS Planner';
  if (/to-?do/i.test(raw)) return 'MS ToDo';
  return null;
}

/** The board/list name, or null. */
function msPlan(task) {
  const plan = task && task.msPlan;
  return typeof plan === 'string' && plan.trim() ? plan.trim() : null;
}

/**
 * The badge for a task card, or null for "nothing to say".
 *
 * `withSystem: false` drops the "Planner"/"To Do" half, and is for the one case
 * where the card ALREADY carries a source badge reading "MS Planner" — two
 * badges carrying one fact. Everywhere else it stays on, because a bare board
 * name on a card with no other Microsoft marker says nothing about where the
 * work lives. That includes a task NEURO owns that is LINKED to a Microsoft one:
 * its source badge reads "NEURO", and the Microsoft mirror line is suppressed
 * once a pair is linked, so this is all the provenance the card has left.
 */
function msPlanBadge(task, options) {
  if (!task) return null;
  const withSystem = !options || options.withSystem !== false;
  const plan = msPlan(task);
  const system = withSystem ? SYSTEM_LABELS[msSystem(task)] || null : null;
  if (!plan) return system;                       // linked, but the board is unknown
  return system ? `${system} · ${plan}` : plan;
}

// ── Recurrence ───────────────────────────────────────────────────────────────
//
// A recurring Microsoft To Do task does NOT disappear when you complete it.
// Graph accepts the PATCH, closes that occurrence, rolls the SAME task id
// forward to the next one and sets `status` back to `notStarted` — so the next
// mirror sync reads it from Graph as open and writes it straight back into
// `Tasks/Microsoft Tasks.md`.
//
// From Nick's side that is indistinguishable from a completion NEURO lost:
// tick it, and an hour later it is back. Three of his To Do tasks are monthly
// and months in arrears, so each tick advances them by exactly one occurrence
// and they reappear until the due date catches up with today. Ticked three
// times, back three times, with nothing anywhere saying why.
//
// So recurrence is READ from Graph, carried onto the mirror line and rendered.
// The point is not to change what happens — the roll is correct behaviour — but
// to make it legible, which is the difference between a system that lost your
// work and one that told you what it did with it.
//
// UNKNOWN IS "REPEATS", NEVER A GUESSED FREQUENCY. A pattern type this does not
// recognise still means the task comes back, and saying so is true; naming it
// "Monthly" because most of his are would be inventing a fact about his diary.

/** The units we can name. Anything else is `repeats`. */
const RECURRENCE_UNITS = {
  daily: 'daily',
  weekly: 'weekly',
  absoluteMonthly: 'monthly',
  relativeMonthly: 'monthly',
  absoluteYearly: 'yearly',
  relativeYearly: 'yearly',
};

const UNIT_NOUNS = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  yearly: ['year', 'years'],
};

const SIMPLE_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

/**
 * Graph's `recurrence` object → the token written onto the mirror line.
 *
 * `monthly`, or `weekly:2` where the interval is not 1. Null when the task does
 * not recur at all — which must stay distinct from `repeats` ("it comes back and
 * I could not read how often").
 */
function recurrenceToken(recurrence) {
  if (!recurrence || typeof recurrence !== 'object') return null;
  const pattern = recurrence.pattern || {};
  const unit = RECURRENCE_UNITS[pattern.type] || null;
  if (!unit) return 'repeats';
  const interval = Number(pattern.interval);
  if (!Number.isFinite(interval) || interval <= 1) return unit;
  return `${unit}:${Math.round(interval)}`;
}

/** The token read back off the line. `{unit, interval}`, or null. */
function parseRecurrence(token) {
  if (typeof token !== 'string' || !token.trim()) return null;
  const [rawUnit, rawInterval] = token.trim().split(':');
  const unit = rawUnit === 'repeats' || UNIT_NOUNS[rawUnit] ? rawUnit : null;
  if (!unit) return null;
  const interval = Number(rawInterval);
  return { unit, interval: Number.isFinite(interval) && interval > 1 ? Math.round(interval) : 1 };
}

/**
 * How a recurring task is described on a card. Null for a task that does not
 * recur — a badge reading "one-off" on 150 tasks is a badge nobody reads.
 */
function recurrenceLabel(taskOrToken) {
  const token = typeof taskOrToken === 'string'
    ? taskOrToken
    : (taskOrToken && taskOrToken.recurrence) || null;
  const rec = parseRecurrence(token);
  if (!rec) return null;
  if (rec.unit === 'repeats') return 'Repeats';
  if (rec.interval === 1) return SIMPLE_LABELS[rec.unit];
  return `Every ${rec.interval} ${UNIT_NOUNS[rec.unit][1]}`;
}

/**
 * How many whole occurrences the task is still behind, given the due date it
 * has just rolled to.
 *
 * This is what turns "it came back again" into "you are six occurrences behind
 * and each tick moves it one" — Nick ticked one of these three times in three
 * days without that ever being said.
 *
 * PURE, and null wherever it cannot be counted honestly: no unit we understand,
 * no readable date, or a due date that is not in the past. Zero and null are
 * different answers — 0 means caught up, null means we could not tell.
 */
function occurrencesBehind(token, dueDate, now = new Date()) {
  const rec = parseRecurrence(token);
  if (!rec || rec.unit === 'repeats') return null;
  if (!dueDate) return null;
  const due = new Date(typeof dueDate === 'string' && dueDate.length === 10 ? `${dueDate}T00:00:00Z` : dueDate);
  if (Number.isNaN(due.getTime())) return null;
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) return null;
  if (due >= at) return 0;

  let steps;
  if (rec.unit === 'daily') {
    steps = Math.floor((at - due) / 86400000);
  } else if (rec.unit === 'weekly') {
    steps = Math.floor((at - due) / (7 * 86400000));
  } else {
    // Months and years are not a fixed number of milliseconds, so they are
    // counted on the calendar rather than divided out.
    const months = (at.getUTCFullYear() - due.getUTCFullYear()) * 12 + (at.getUTCMonth() - due.getUTCMonth())
      - (at.getUTCDate() < due.getUTCDate() ? 1 : 0);
    steps = rec.unit === 'yearly' ? Math.floor(months / 12) : months;
  }
  return Math.max(0, Math.floor(steps / rec.interval));
}

/**
 * What to SAY when a completion rolled the task forward instead of closing it.
 *
 * Composed once, on the server, and rendered verbatim by every surface — the
 * same rule the attention feed's `say`/`speech` follow. Three surfaces phrasing
 * "your completion worked but the task is back" three ways is how they come to
 * disagree about whether it worked at all.
 *
 * Returns null when there is nothing true to add.
 */
function rolledNotice(rolled, now = new Date()) {
  if (!rolled) return null;
  const label = recurrenceLabel(rolled.recurrence);
  const lead = label ? `${label} task` : 'Recurring task';
  const behind = occurrencesBehind(rolled.recurrence, rolled.nextDue, now);

  if (!rolled.nextDue) {
    // Microsoft took the completion and rolled it, and would not tell us to
    // when. "It will be back" is the whole of what is known, so it is the whole
    // of what is said.
    return `${lead} — that occurrence is closed in Microsoft, and it will come back for the next one.`;
  }
  if (behind && behind > 0) {
    return `${lead} — that occurrence is closed. Still ${behind} behind: the next one was due ${rolled.nextDue}, `
      + `so it will keep coming back until the dates catch up. Each tick moves it one.`;
  }
  return `${lead} — that occurrence is closed. Back again on ${rolled.nextDue}.`;
}

module.exports = {
  msSystem, msPlan, msPlanBadge, SYSTEM_LABELS,
  recurrenceToken, parseRecurrence, recurrenceLabel, occurrencesBehind, rolledNotice,
};
