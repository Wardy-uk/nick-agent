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

// GET /api/task-blocks/plan/:taskId — what would be created. Creates nothing.
router.get('/plan/:taskId', (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    if (!Number.isInteger(taskId)) return res.status(400).json({ ok: false, error: 'taskId must be a number' });
    const draft = taskBlocks.plan(taskId, {
      date: req.query.date || null,
      startTime: req.query.startTime || null,
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
    const taskId = parseInt(req.body?.taskId, 10);
    if (!Number.isInteger(taskId)) return res.status(400).json({ ok: false, error: 'taskId required' });

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

    const result = await taskBlocks.schedule(taskId, { date, startTime });
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
