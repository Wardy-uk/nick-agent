'use strict';

/**
 * Task blocks — push a task into the O365 calendar, and the write-up that
 * decides when it is done. See services/task-blocks.js for the reasoning.
 *
 * Mounted at /api/task-blocks, its own top-level mount rather than under
 * /api/tasks: a sibling registered after the parameterised /api/tasks/:id would
 * have "blocks" parsed as an id, which is the trap /api/task-dedupe already
 * exists to avoid.
 */

const express = require('express');
const router = express.Router();
const taskBlocks = require('../services/task-blocks');

// GET /api/task-blocks — blocks that owe a write-up. The panel's whole payload.
router.get('/', (req, res) => {
  try {
    const { rows, error } = taskBlocks.listOutstanding({ now: new Date() });
    res.json({
      ok: !error,
      // "nothing outstanding" and "the list could not be read" are different
      // answers, and an empty array presenting as the first is how a broken
      // feed reads as a clear one.
      error: error || null,
      blocks: rows,
      minOutcomeChars: taskBlocks.MIN_OUTCOME_CHARS,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** `?taskIds=58,61` or a single `/plan/58`. Both shapes, one parser. */
function readTaskIds(raw) {
  return String(raw ?? '').split(',').map(s => parseInt(s, 10)).filter(Number.isInteger);
}

const MAX_TASKS_PER_BLOCK = 12;

/**
 * A window has to be a real length. The upper bound is a whole working day: a
 * longer one is a typo, and a block that swallows the diary is not a thing to
 * create quietly.
 */
function readMinutes(raw) {
  if (raw == null || raw === '') return { minutes: null };
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return { error: 'minutes must be a positive whole number' };
  if (n > 480) return { error: 'minutes must be 480 (a working day) or less' };
  return { minutes: n };
}

// GET /api/task-blocks/plan/:taskIds — what would be created. Creates nothing.
// `:taskIds` is one id or a comma-separated list, so a batch can be previewed
// (total, window, whether it is overpacked) before anything reaches the diary.
router.get('/plan/:taskIds', (req, res) => {
  try {
    const taskIds = readTaskIds(req.params.taskIds);
    if (!taskIds.length) return res.status(400).json({ ok: false, error: 'taskIds must be numbers' });
    if (taskIds.length > MAX_TASKS_PER_BLOCK) {
      return res.status(400).json({ ok: false, error: `at most ${MAX_TASKS_PER_BLOCK} tasks in one block` });
    }
    const mins = readMinutes(req.query.minutes);
    if (mins.error) return res.status(400).json({ ok: false, error: mins.error });

    const draft = taskBlocks.plan(taskIds, {
      date: req.query.date || null,
      startTime: req.query.startTime || null,
      minutes: mins.minutes,
    });
    res.status(draft.ok ? 200 : 400).json(draft);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/task-blocks/sweep — run the release pass now. Registered above the
// parameterised routes so "sweep" is never read as a block id.
router.post('/sweep', (req, res) => {
  try {
    res.json({ ok: true, ...taskBlocks.sweep({ dryRun: req.body?.dryRun === true }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/task-blocks — create the event, the stub and the row.
//
// No approval gate: the event has no attendees, so nothing leaves the building.
// That is the same test action-presenter applies to everything else, not an
// exception to it.
router.post('/', async (req, res) => {
  try {
    // `taskIds` for a batch, `taskId` for one — the single form stays because it
    // is what the task row sends and there is no reason to make it build a list.
    const taskIds = req.body?.taskIds != null
      ? readTaskIds(Array.isArray(req.body.taskIds) ? req.body.taskIds.join(',') : req.body.taskIds)
      : readTaskIds(req.body?.taskId);
    if (!taskIds.length) return res.status(400).json({ ok: false, error: 'taskId or taskIds required' });
    if (taskIds.length > MAX_TASKS_PER_BLOCK) {
      return res.status(400).json({ ok: false, error: `at most ${MAX_TASKS_PER_BLOCK} tasks in one block` });
    }

    const mins = readMinutes(req.body?.minutes);
    if (mins.error) return res.status(400).json({ ok: false, error: mins.error });

    const date = req.body?.date || null;
    const startTime = req.body?.startTime || null;
    if ((date && !startTime) || (startTime && !date)) {
      return res.status(400).json({ ok: false, error: 'give both date and startTime, or neither' });
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
    }
    if (startTime && !/^\d{2}:\d{2}$/.test(startTime)) {
      return res.status(400).json({ ok: false, error: 'startTime must be HH:MM' });
    }

    const result = await taskBlocks.schedule(taskIds, {
      date,
      startTime,
      minutes: mins.minutes,
      // The estimate write-back is on by default — it is the whole reason the
      // duration is asked for here — but a caller can decline it.
      saveEstimates: req.body?.saveEstimates !== false,
    });
    res.status(result.ok ? 200 : (result.duplicate ? 409 : 502)).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/task-blocks/:id/release — close it with no write-up, on the record.
router.post('/:id/release', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id must be a number' });
    const result = taskBlocks.release(id, req.body?.reason, {
      completeTask: req.body?.completeTask !== false,
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/task-blocks/:id/note — write the outcome note now.
//
// A repair action, not the usual path: the stub is written when the block is
// created, so this covers the case where that failed (vault unreachable) or the
// note was deleted. It NEVER overwrites — an existing note is reported, not
// replaced, because clobbering a written-up note would destroy the one thing
// this whole feature protects.
router.post('/:id/note', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id must be a number' });
    const result = taskBlocks.createNote(id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/task-blocks/:id/tasks/:taskId — take one task back out of a block.
//
// The task itself is untouched and goes back to being an ordinary open task;
// only the membership and its hold go. Removing the LAST task is refused —
// an empty block is a window in the diary for nothing, and `drop` is the honest
// way to say it is not happening.
router.delete('/:id/tasks/:taskId', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const taskId = parseInt(req.params.taskId, 10);
    if (!Number.isInteger(id) || !Number.isInteger(taskId)) {
      return res.status(400).json({ ok: false, error: 'id and taskId must be numbers' });
    }
    const result = await taskBlocks.removeTask(id, taskId);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/task-blocks/:id/drop — the work is not happening in that slot. The
// task is untouched and stays open; only the block is abandoned.
router.post('/:id/drop', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id must be a number' });
    const result = taskBlocks.drop(id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
