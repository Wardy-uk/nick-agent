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

module.exports = { msSystem, msPlan, msPlanBadge, SYSTEM_LABELS };
