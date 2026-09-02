/**
 * "Open it" — turning what a card knows about a task into the row itself.
 *
 * Nick, 1 Sep 2026: *every card must be actionable — either edit/complete, or
 * navigate to the actual tasks.* The second half needs a shared answer to one
 * question: given what a card happens to hold about a piece of work, WHICH row
 * in the task list is it?
 *
 * It lives here rather than inside `TodoPanel` for two reasons. Every surface
 * that names work has to be able to produce one of these, so a copy per panel
 * is a copy per panel free to drift about what counts as a match. And it is
 * pure, so it can be pinned without React — which the panel itself cannot be.
 */

/**
 * The identity a card hands over when it says "open it".
 *
 * The three handles are the SAME three `completeTask.js` uses, in the same
 * order of trust, because a card that can close a thing must be able to point
 * at it. `taskText` is last and is the only one that can be wrong.
 *
 * Returns null when the context carries nothing to go on — and null means "no
 * pin", which renders as the ordinary task list rather than as an empty one.
 */
export function pinFromContext(ctx) {
  if (!ctx) return null;
  const taskId = ctx.taskId ?? ctx.task_id ?? null;
  const msId = ctx.msId ?? ctx.ms_id ?? null;
  const filePath = ctx.filePath ?? null;
  const lineNumber = ctx.lineNumber ?? null;
  const text = ctx.taskText ?? null;
  if (taskId == null && msId == null && filePath == null && !text) return null;
  return { taskId, msId, filePath, lineNumber, text };
}

/**
 * Loose text key — used only when nothing better is on offer.
 *
 * Deliberately cruder than `task-store.dedupeKey`: this decides what to SHOW,
 * never what to write, and a client-side re-implementation of the canonical
 * normaliser would be a second opinion about task identity. Where the two
 * disagree the pin misses, and a miss is stated.
 */
function looseKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/<!--.*?-->/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Find the row a pin names. PURE.
 *
 * ⚠ Returns null rather than a near-miss. A pin that resolved to the WRONG task
 * would expand somebody else's work under a heading saying it was the thing the
 * card was about — and every control on that expanded row writes for real, to
 * Planner and the vault as well as to NEURO. A miss costs a sentence; a wrong
 * match costs a task.
 */
export function findPinned(todos, pin) {
  if (!pin || !Array.isArray(todos)) return null;
  if (pin.taskId != null) {
    const hit = todos.find((t) => t.task_id != null && String(t.task_id) === String(pin.taskId));
    if (hit) return hit;
  }
  if (pin.msId != null) {
    const hit = todos.find((t) => t.ms_id != null && String(t.ms_id) === String(pin.msId));
    if (hit) return hit;
  }
  if (pin.filePath && pin.lineNumber != null) {
    const hit = todos.find((t) => t.filePath === pin.filePath && Number(t.lineNumber) === Number(pin.lineNumber));
    if (hit) return hit;
  }
  if (pin.text) {
    const key = looseKey(pin.text);
    if (key) {
      const hit = todos.find((t) => looseKey(t.text) === key);
      if (hit) return hit;
    }
  }
  return null;
}

export { looseKey as _looseKey };
