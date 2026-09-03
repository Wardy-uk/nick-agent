'use strict';

/**
 * /api/tasks — NEURO's task store, the source of truth since 13 Aug 2026.
 *
 * The migration endpoints (import / export / verify / drain) are deliberately here
 * rather than in a script, so each step is re-runnable from the app and every step is
 * reversible: import is idempotent, export regenerates, verify is read-only.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const taskStore = require('../services/task-store');
const taskExport = require('../services/task-export');
const taskImport = require('../services/task-import');
const captureDrain = require('../services/task-capture-drain');

// GET /api/tasks — ?status=open|done|all &moscow= &source= &q=
router.get('/', (req, res) => {
  try {
    const rows = taskStore.listTasks({
      status: req.query.status || 'open',
      moscow: req.query.moscow || null,
      source: req.query.source || null,
      // Absent means BOTH domains — never a default of 'work', which would hide
      // personal tasks from every existing caller of this route without saying so.
      domain: req.query.domain || null,
      // Absent means EVERY origin, including the unclassified pile. ?origin=none
      // asks for the unclassified rows alone — which is the review queue for the
      // weekly report's third bucket, and the one thing a plain `origin=` value
      // cannot express.
      origin: req.query.origin && req.query.origin !== 'none' ? req.query.origin : null,
      originUnset: req.query.origin === 'none',
      includeDone: req.query.status === 'all',
    });
    const q = (req.query.q || '').toLowerCase().trim();
    const filtered = q ? rows.filter(r => r.text.toLowerCase().includes(q)) : rows;
    res.json({ tasks: filtered, counts: taskStore.counts() });
  } catch (e) {
    console.error('[Tasks] List error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tasks/untriaged — tasks with no MoSCoW bucket yet (drives the review UI)
router.get('/untriaged', (req, res) => {
  try {
    // Untriaged means "no decision yet" — a proposed bucket still needs confirming.
    const rows = taskStore.listTasks({ status: 'open' }).filter(r => !r.moscow || r.moscow_proposed);
    res.json({ tasks: rows, counts: taskStore.counts() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tasks — create (route 2: NEURO direct)
router.post('/', (req, res) => {
  try {
    const { text, moscow, priority, due_date, source, notes, origin_path, origin_line, estimateMinutes, estimateExact, domain, origin, criticality } = req.body;
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
    const result = taskStore.createTask({
      text, moscow, priority, due_date, notes, origin_path, origin_line,
      // ⚠ Whitelisted deliberately, and the reason is two lines below: a field
      // createTask accepts but the route omits is dropped IN SILENCE. That cost
      // every new task its estimate once already; a dropped domain would file
      // every personal task as work and look like it had worked.
      domain,
      // Commitment or continual improvement. Omitted means "let the classifier
      // look at the provenance", which usually means unclassified — never a
      // silent default, because the weekly report counts these separately.
      origin,
      // createTask has always accepted this; the route's whitelist did not pass
      // it, so an estimate given at creation was dropped in silence and only a
      // later PATCH could set one. It decides how long a calendar block is, so
      // the silent drop meant every freshly created task blocked at the assumed
      // thirty minutes.
      estimateMinutes,
      // A typed number is honoured exactly; a preset still snaps to a bucket.
      estimateExact,
      // How urgent the SENDER said this was — stored verbatim as provenance and
      // never re-derived here. NEURO records who claimed what; deciding whether
      // the claim is right is the sending system's job, and second-guessing it
      // would give one question two answers. Absent is the normal case and does
      // not mean "low".
      criticality,
      // ⚠ NOT `|| 'manual'`. This is the human-facing create endpoint, but it is
      // reachable by any machine client holding the API token, so defaulting
      // here asserted "a person typed this" on behalf of callers that never said
      // so — the same untrue claim the store's old default made, one layer up.
      // The only caller today (TodoPanel's Add task) sends `source: 'manual'`
      // explicitly, because it is the one place that actually knows. Anything
      // arriving unnamed is stored `unattributed` by task-store, which is the
      // single place that decides what an unnamed writer is called.
      source,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[Tasks] Create error:', e);
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/tasks/:id — edit text / moscow / priority / due / status / notes.
// This is the thing that had nowhere to live before the migration: with the DB
// owning the data it is a plain write, and the export handles the file.
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = db.getTaskRow(id);
    const task = taskStore.updateTask(id, req.body || {});
    if (!task) return res.status(404).json({ error: 'Task not found' });
    // Same push as /complete — a task can be finished by editing its status as
    // well as by the button, and a link that only worked down one of those two
    // paths is a link Nick cannot trust.
    const msPush = (task.status === 'done' && before && before.status !== 'done')
      ? await pushCompletionToMicrosoft(task)
      : null;
    res.json({ ok: true, task, msPush });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Push a completion out to Microsoft for a task linked to a Planner / To Do one.
 *
 * Never allowed to fail the request. The NEURO task is already done by the time
 * this runs, and reporting that as a failure would tell Nick his tick did not
 * land when it did — the same rule sent-replies follows for its bookkeeping.
 * What the push actually did is returned so the client can say so rather than
 * quietly implying Microsoft agrees.
 */
async function pushCompletionToMicrosoft(task) {
  if (!task || !task.ms_id) return null;
  // A tick that was HELD for a write-up has not completed anything, so pushing
  // it out would close the linked Planner / To Do task while the NEURO one is
  // still open — the two lists disagreeing in the one direction the link exists
  // to prevent, and in Microsoft, where NEURO cannot put it back.
  if (task.status !== 'done') return null;
  try {
    const microsoft = require('../services/microsoft');
    const result = await microsoft.completeMicrosoftTask(task.ms_id, task.ms_source || null);
    if (!result.completed) {
      console.warn(`[Tasks] #${task.id} done in NEURO but Microsoft push failed: ${result.reason}`);
    }
    return result;
  } catch (e) {
    console.error(`[Tasks] #${task.id} Microsoft push threw:`, e.message);
    return { completed: false, reason: 'error' };
  }
}

// POST /api/tasks/:id/complete
router.post('/:id/complete', async (req, res) => {
  try {
    const task = taskStore.setStatus(Number(req.params.id), 'done');
    if (!task) return res.status(404).json({ error: 'Task not found' });
    // Linked to a Microsoft task, so completing it here completes it there too —
    // that is the whole point of confirming the pair (17 Aug 2026).
    const msPush = await pushCompletionToMicrosoft(task);
    res.json({ ok: true, task, msPush });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/tasks/:id/reopen
router.post('/:id/reopen', (req, res) => {
  try {
    const task = taskStore.setStatus(Number(req.params.id), 'open');
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true, task });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', (req, res) => {
  try {
    const ok = taskStore.deleteTask(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Migration / plumbing ─────────────────────────────────────────────────────

// POST /api/tasks/import — seed from Master Todo + the triage worksheets.
// DRY RUN unless { dryRun: false } is sent explicitly.
router.post('/import', (req, res) => {
  try {
    const result = taskImport.importFromVault({
      dryRun: req.body?.dryRun !== false,
      includeDone: req.body?.includeDone === true,
    });
    res.json(result);
  } catch (e) {
    console.error('[Tasks] Import error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tasks/export — regenerate the vault export note
router.post('/export', (req, res) => {
  try {
    res.json(taskExport.writeExport());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tasks/export/verify — does the note match the DB exactly?
router.get('/export/verify', (req, res) => {
  try {
    res.json(taskExport.verifyExport());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tasks/drain — route 3: pull Tasks/Capture.md into the store and clear it
router.post('/drain', (req, res) => {
  try {
    res.json(captureDrain.drainCaptureFile({
      dryRun: req.body?.dryRun === true,
      force: req.body?.force === true,
    }));
  } catch (e) {
    console.error('[Tasks] Drain error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tasks/status — one call that answers "is the migration healthy?"
router.get('/status', (req, res) => {
  try {
    const verify = taskExport.verifyExport();
    res.json({
      counts: taskStore.counts(),
      masterTodoRetired: db.getState('tasks.master_todo_retired') === 'true',
      export: { ok: verify.ok, exportedAt: verify.exportedAt, path: verify.path, dbCount: verify.dbCount, fileCount: verify.fileCount },
      capturePath: captureDrain.CAPTURE_RELATIVE,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tasks/retire-master — step 6. Stops Master Todo.md being parsed and moves
// it to Tasks/Archive/. Reversible: { retired: false } flips the flag back (the file
// stays in Archive; move it yourself if you want the original path back).
router.post('/retire-master', (req, res) => {
  try {
    const retire = req.body?.retired !== false;
    if (retire) {
      const verify = taskExport.verifyExport();
      if (!verify.ok && req.body?.force !== true) {
        return res.status(409).json({
          error: 'Export does not match the DB — fix that before retiring Master Todo',
          verify,
        });
      }
      const fs = require('fs');
      const path = require('path');
      const vault = process.env.OBSIDIAN_VAULT_PATH || '';
      const from = path.join(vault, 'Tasks', 'Master Todo.md');
      const to = path.join(vault, 'Tasks', 'Archive', `Master Todo (retired ${new Date().toISOString().split('T')[0]}).md`);
      let moved = null;
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        moved = path.relative(vault, to).replace(/\\/g, '/');
      }
      db.setState('tasks.master_todo_retired', 'true');
      return res.json({ ok: true, retired: true, moved });
    }
    db.setState('tasks.master_todo_retired', 'false');
    res.json({ ok: true, retired: false });
  } catch (e) {
    console.error('[Tasks] Retire error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
