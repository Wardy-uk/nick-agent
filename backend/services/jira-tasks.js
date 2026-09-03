'use strict';

/**
 * Tickets assigned to Nick, as tasks Jira closes.
 *
 * ── Why this exists, and why it is shaped like this ──────────────────────────
 *
 * Nothing in NEURO had ever asked Jira what was assigned to Nick. The only JQL
 * in the repo was the escalation pair, so the working escalation code was not a
 * broken version of this — it is a different feature that got built instead. A
 * ticket sitting in Nick's name was known to Jira and to nothing else.
 *
 * Nick's decision (3 Sep 2026) settles the hard part. These become REAL tasks,
 * linked to the ticket, with NEURO's own fields (due date, MoSCoW, estimate)
 * editable as normal — **but there is no manual tick**. Completion is driven by
 * the ticket's own status, so there is never two places to close one thing.
 * That is the whole design, and everything below follows from it:
 *
 *  - **The refusal lives in `task-store.updateTask`**, not in a route. Every
 *    completion path in the estate — the todos routes, the SARA funnel, the MCP
 *    tool, the chat tool — arrives through that one function, and a guard in any
 *    one of them is a guard the other three walk past. (The same argument the
 *    task-blocks write-up hold is built on.)
 *  - **Closing is a SEPARATE read, not an absence.** A ticket missing from
 *    "assigned to me and not done" could be done, reassigned, moved to a project
 *    the token cannot see, or deleted — and only the first is a reason to mark
 *    Nick's work finished. So the sync asks Jira about the linked keys directly
 *    and closes only on `statusCategory === 'done'`. Absence of evidence is not
 *    evidence, which is this codebase's oldest lesson and the one that costs
 *    most here: a wrongly closed task is work that silently stops existing.
 *  - **Unassignment is not completion.** A ticket taken off Nick is no longer
 *    his, but it was not finished by him and may not be finished at all. The
 *    task is UNLINKED and left open with a note, so he can decide — the
 *    conservative half of `release()`'s rule that a reason is always required.
 *
 * The link lives in `agent_state.jira_task_links` (key → task id). A KV ledger
 * rather than a column, following `ms_todo_list_by_task` and `ms_push_queue`:
 * it is an annotation on the relationship between two systems, and a schema
 * migration on a 547MB live database is a bigger risk than the query
 * convenience is worth. It is PERSISTED because the backend restarts several
 * times a day and an in-memory link would re-create every task on every deploy.
 */

const db = require('../db/database');
const jira = require('./jira');
const taskStore = require('./task-store');

const LINKS_KEY = 'jira_task_links';

/** The stamp that makes a task Jira-owned. Read by `task-store`'s refusal. */
const SOURCE = 'jira-assigned';

/**
 * Kill switch. Off by default: it writes real tasks into Nick's list.
 *
 * ⚠ Read at CALL time, through the flag registry, not captured into a const at
 * require time. It was the second form, which is exactly the shape
 * `feature-flags.js` exists to undo: the value could only change with an .env
 * edit and a pm2 restart, so the switch the scheduler's own comment claims
 * "needs no restart to be read" demonstrably did. The environment still WINS
 * where it is explicitly set — the registry only decides when it is not.
 */
function isEnabled() {
  return require('./feature-flags').isEnabled('jira_assigned_sync');
}

/**
 * How many tickets one run will turn into tasks.
 *
 * Not a performance bound — a guard against the first run finding a hundred
 * assigned tickets and filling the list Nick uses to decide what to do next in
 * a single unannounced go. Loud when it caps, never silent.
 */
const MAX_CREATE = Number(process.env.JIRA_ASSIGNED_MAX_CREATE || 25);

function readLinks() {
  try {
    const raw = db.getState(LINKS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLinks(links) {
  db.setState(LINKS_KEY, JSON.stringify(links));
}

/**
 * Is this task Jira's to close?
 *
 * ⚠ Decided by the LINK, not by the `source` column. The two come apart in the
 * case that matters: when a ticket is taken off Nick the link goes and the task
 * stays, and if ownership were read off `source` that task could never be
 * completed by anybody ever again — Jira has stopped caring about it and Nick
 * would be refused. The link is the live fact; the column is provenance.
 */
function isJiraOwned(taskId) {
  return keyForTask(taskId) != null;
}

/**
 * The ticket key a task is linked to, or null.
 *
 * Read from the LEDGER, never parsed back out of the task text — the text is
 * Nick's to edit, and a link that breaks when he rewords a task is a link that
 * silently hands completion back to nobody.
 */
function keyForTask(taskId, links = readLinks()) {
  for (const [key, id] of Object.entries(links)) if (Number(id) === Number(taskId)) return key;
  return null;
}

/** How the ticket reads as a task. The key leads, so it is findable in Jira. */
function taskTextFor(issue) {
  return `${issue.key}: ${String(issue.summary || '').replace(/\s+/g, ' ').trim()}`.slice(0, 200);
}

/**
 * Bring the assigned list and the task list into agreement.
 *
 * Read-only unless `apply` — the same two-step every writer in this repo uses,
 * so "what would this do" is answerable without doing it.
 */
async function sync({ apply = false } = {}) {
  // ⚠ Only APPLYING is gated. The dry run must work while the switch is OFF,
  // because it is the thing you consult in order to decide whether to turn the
  // switch on — gating it made the preview unavailable at exactly the moment it
  // was wanted, and the switch is now one click away in Settings. Nothing below
  // writes unless `apply`, so an ungated dry run costs two read-only JQL calls.
  const enabled = isEnabled();
  if (apply && !enabled) return { ok: false, reason: 'disabled (JIRA_ASSIGNED_SYNC_ENABLED)' };
  if (!jira.isConfigured()) return { ok: false, reason: 'Jira is not configured' };

  const links = readLinks();
  const result = {
    ok: true,
    dryRun: !apply,
    // A preview of work that will never happen on its own reads exactly like a
    // preview of work that will, so the answer says which it is.
    enabled,
    assigned: 0,
    created: [],
    closed: [],
    unlinked: [],
    capped: 0,
    gaps: [],
  };

  // ── What is mine now ──────────────────────────────────────────────────────
  let fetched;
  try {
    fetched = await jira.fetchAssignedToMe();
  } catch (e) {
    return { ok: false, reason: `Could not read assigned tickets: ${e.message}` };
  }
  if (!fetched) return { ok: false, reason: 'Jira is not configured' };
  if (!fetched.complete) {
    // ⚠ Load-bearing. An incomplete read must never be allowed to reach the
    // unlink branch below, where absence is read as "no longer yours".
    result.gaps.push('the assigned-ticket list was truncated — nothing was unlinked on this run');
  }

  const assigned = fetched.issues;
  result.assigned = assigned.length;
  const assignedKeys = new Set(assigned.map((i) => i.key));

  // ── New ones become tasks ─────────────────────────────────────────────────
  const fresh = assigned.filter((i) => !links[i.key]);
  const toCreate = fresh.slice(0, MAX_CREATE);
  result.capped = fresh.length - toCreate.length;
  if (result.capped) {
    console.warn(`[JiraTasks] ${fresh.length} unlinked assigned tickets, creating ${toCreate.length} — `
      + `${result.capped} left for the next run`);
  }

  for (const issue of toCreate) {
    const entry = { key: issue.key, text: taskTextFor(issue), url: issue.url };
    if (!apply) { result.created.push({ ...entry, dryRun: true }); continue; }
    try {
      const { id, created } = taskStore.createTask({
        text: entry.text,
        source: SOURCE,
        // Jira's own due date if it has one. NEURO's is editable afterwards —
        // and is never written back, because Jira's date is somebody else's
        // record of when it is due.
        due_date: issue.dueDate || null,
        origin_path: issue.url || null,
        notes: `Assigned to you in Jira${issue.status ? ` (${issue.status})` : ''}. `
          + `This one closes when the ticket does — resolve ${issue.key} in Jira.`,
        // Somebody assigned it to him. That is the test for a commitment.
        origin: 'commitment',
      });
      links[issue.key] = id;
      result.created.push({ ...entry, taskId: id, folded: created === false });
    } catch (e) {
      result.gaps.push(`${issue.key}: ${e.message}`);
    }
  }

  // ── What Jira now says about everything linked ────────────────────────────
  const linkedKeys = Object.keys(links);
  if (linkedKeys.length) {
    let states = null;
    try {
      states = await jira.fetchIssueStates(linkedKeys);
    } catch (e) {
      result.gaps.push(`could not read the state of linked tickets: ${e.message}`);
    }

    if (states) {
      const byKey = new Map(states.issues.map((i) => [i.key, i]));
      for (const key of linkedKeys) {
        const taskId = links[key];
        const row = db.getTaskRow(taskId);
        if (!row) {
          // The task was deleted. The link has nothing left to point at.
          if (apply) delete links[key];
          result.unlinked.push({ key, reason: 'task no longer exists' });
          continue;
        }
        if (row.status === 'done' || row.status === 'dropped') continue;

        const issue = byKey.get(key);
        if (!issue) {
          // ⚠ Jira did not answer for this key. Deleted, moved, or invisible to
          // the token — and NONE of those is "Nick finished it". Reported, never
          // acted on.
          result.gaps.push(`${key}: Jira returned nothing for it — left open`);
          continue;
        }

        if (issue.resolved) {
          if (!apply) { result.closed.push({ key, taskId, status: issue.status, dryRun: true }); continue; }
          try {
            // `via` is what distinguishes this from a person ticking the box.
            const updated = taskStore.updateTask(taskId, { status: 'done', jiraSync: true });
            result.closed.push({
              key, taskId, status: issue.status,
              // A completion held for a missing write-up is still held here: the
              // block asked for evidence and Jira closing a ticket is not it.
              held: updated?.held ? updated.held.reason : null,
            });
          } catch (e) {
            result.gaps.push(`${key}: could not close task #${taskId}: ${e.message}`);
          }
          continue;
        }

        // Still open in Jira, but no longer Nick's. Unlink and SAY so — an
        // unassigned ticket was not finished, and closing it here would put a
        // completion in the wins ledger nobody made.
        if (fetched.complete && !assignedKeys.has(key)) {
          if (!apply) { result.unlinked.push({ key, taskId, reason: 'no longer assigned to you', dryRun: true }); continue; }
          delete links[key];
          try {
            taskStore.updateTask(taskId, {
              source: null,
              notes: `${row.notes ? `${row.notes}\n\n` : ''}No longer assigned to you in Jira (${issue.status}). `
                + `Left open — it is yours to close or drop.`,
            });
          } catch (e) {
            result.gaps.push(`${key}: unlinked, but the note could not be written: ${e.message}`);
          }
          result.unlinked.push({ key, taskId, reason: 'no longer assigned to you' });
        }
      }
    }
  }

  if (apply) writeLinks(links);
  return result;
}

module.exports = {
  sync,
  isJiraOwned,
  keyForTask,
  readLinks,
  taskTextFor,
  SOURCE,
  isEnabled,
  MAX_CREATE,
};
