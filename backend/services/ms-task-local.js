/**
 * What NEURO thinks about a task Microsoft owns.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A Planner card carries a title, a due date, a description and a percentage,
 * and that is all Microsoft will hold. Everything NEURO ranks on — MoSCoW,
 * priority 1-3, whether Nick is actually mid-way through it or stuck waiting on
 * somebody — has nowhere to live on those rows, so a Microsoft task was
 * unrankable by construction: it appeared in the list, it could be completed,
 * and it could not be triaged. 18 of the open tasks are Microsoft's.
 *
 * ⚠ NOTHING HERE REACHES MICROSOFT. That is the whole point and it is Nick's
 * ask, not an implementation convenience. `wip-ms` already exists and pushes
 * progress to Planner, which his team reads — "working on" here is the private
 * version of that thought, and "blocked" has no Planner equivalent at all. A
 * board shared with a team is not the place to record that you are stuck, and a
 * MoSCoW letter NEURO invented has no business appearing on somebody else's
 * card. If a state should be visible to the team, it goes through `wip-ms`.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 * KV in `agent_state.ms_task_local`, following `ms_todo_list_by_task` and
 * `ms_push_queue` — this is an annotation on somebody else's row, not an
 * entity, so it earns no table and no migration.
 *
 * ⚠ It MUST be persisted rather than held in memory: the backend restarts
 * several times a day on deploys, and a triage decision that evaporates on the
 * next deploy is worse than no triage at all, because it looks like it worked.
 *
 * ⚠ An entry with nothing set is DELETED rather than stored as a row of nulls —
 * otherwise the blob grows one key per task ever looked at and never shrinks,
 * which is the email-triage store's mistake one service along.
 *
 * There is deliberately NO prune of entries for tasks Microsoft has since
 * closed, and the reason is that there is nowhere honest to call one from. The
 * only callers holding a list of live ms_ids are the two read paths, and one of
 * them (`/focus`) is FILTERED — pruning against an overdue-only view would
 * delete every annotation on a task that is merely not late. An uncalled prune
 * sitting here waiting to be wired up is worse than none. The bound is real
 * without it: one small entry per Microsoft task Nick has actually triaged, of
 * which there are 18 open today.
 */

const db = require('../db/database');
const taskStore = require('./task-store');

const KEY = 'ms_task_local';

// Three states, all private, and they are mutually exclusive: "I am doing
// this", "I cannot do this" and "my half is finished" cannot be true at once,
// and a control that allowed two of them would be a state nothing knows how to
// render.
//
// ⚠ `mine-done` is NOT a completion and must never be treated as one. A shared
// Planner card with sub-tasks is late because somebody's part is outstanding,
// and Nick's being finished changes who owes it, not whether it is owed. So the
// row stays OPEN, stays visible, keeps its due date and is never ticked, in
// NEURO or on the board — the only thing it loses is the right to demand
// action from Nick today. Ticking it here would close a card his team is still
// working on; leaving it screaming overdue makes the list say he is late for
// work he has already done.
const VALID_STATE = ['working', 'blocked', 'mine-done'];

function normState(value) {
  if (value == null || value === '') return null;
  const v = String(value).toLowerCase().trim();
  return VALID_STATE.includes(v) ? v : null;
}

function readAll() {
  try {
    const raw = db.getState(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    // Unreadable is not empty, but there is nothing useful to do with a corrupt
    // blob on a read path several surfaces poll — say so once and carry on
    // rendering the tasks themselves, which are Microsoft's and still correct.
    console.warn('[MsTaskLocal] Could not read local annotations:', e.message);
    return {};
  }
}

function writeAll(map) {
  db.setState(KEY, JSON.stringify(map));
}

/** What NEURO holds about one Microsoft task. Null when it holds nothing. */
function get(msId) {
  if (!msId) return null;
  const entry = readAll()[String(msId)];
  return entry || null;
}

/**
 * Record, clear or change what NEURO thinks about one Microsoft task.
 *
 * Only the fields PRESENT in `fields` are touched — an absent key leaves the
 * stored value alone, and an explicit null clears it. Conflating the two is how
 * a control that only sets MoSCoW would silently wipe the state beside it.
 */
function set(msId, fields = {}) {
  if (!msId) throw new Error('ms_id required');
  const id = String(msId);
  const map = readAll();
  const entry = { ...(map[id] || {}) };

  if ('state' in fields) entry.state = normState(fields.state);
  if ('moscow' in fields) entry.moscow = taskStore.normMoscow(fields.moscow);
  if ('priority' in fields) entry.priority = taskStore.normPriority(fields.priority);

  const empty = !entry.state && !entry.moscow && !entry.priority;
  if (empty) {
    delete map[id];
  } else {
    entry.updatedAt = new Date().toISOString();
    map[id] = entry;
  }
  writeAll(map);
  return empty ? null : map[id];
}

/**
 * Fold what NEURO knows onto the rows it does not own.
 *
 * ⚠ Applied ONLY where NEURO has no row of its own. A linked task (task-dedupe,
 * NEURO leading) already carries a real `moscow` and `taskPriority` off the
 * `tasks` table, and letting an annotation win over those would give one task
 * two disagreeing triages with no way to tell which was read.
 *
 * `msLocal: true` rides along so the panel can say the letter is NEURO's own
 * and is not on the board — a MUST that looks like it came from Planner is a
 * claim about somebody else's system.
 */
function annotate(rows) {
  const map = readAll();
  if (!Object.keys(map).length) return rows;
  return rows.map((row) => {
    if (!row || row.task_id || !row.ms_id) return row;
    const entry = map[String(row.ms_id)];
    if (!entry) return row;
    // ⚠ The letter has to travel in `meta` as well as on the row. `decorateTask`
    // reads `metadata.moscow` and falls through to classifying the text when it
    // is absent — so an annotation written only to the top level was silently
    // overwritten by the classifier on both read paths, and a MUST looked like
    // it had stuck purely because the classifier agreed. Verified against a
    // real row before changing it: a stored `could` came back `must`.
    const meta = entry.moscow ? { ...(row.meta || {}), moscow: entry.moscow } : row.meta;
    return {
      ...row,
      meta,
      moscow: entry.moscow || row.moscow || null,
      taskPriority: entry.priority || row.taskPriority || null,
      msLocalState: entry.state || null,
      // A neutral flag rather than the state word, because `todo-intelligence`
      // ranks every task in the system and has no business knowing Microsoft's
      // vocabulary — it needs to know that this due date is no longer Nick's,
      // not where the thought came from.
      myPartDone: entry.state === 'mine-done',
      msLocal: true,
    };
  });
}

module.exports = { get, set, annotate, normState, VALID_STATE, _KEY: KEY };
