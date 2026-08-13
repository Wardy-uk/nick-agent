const express = require('express');
const router = express.Router();
const db = require('../db/database');
const nudges = require('../services/nudges');

// GET /api/nudges — active nudges + snooze state
router.get('/', (req, res) => {
  const active = db.getActiveNudges();
  const snoozeState = nudges.getSnoozeState();
  res.json({ nudges: active, snoozeState });
});

// SSE stream for real-time nudges
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  nudges.addClient(res);
});

// POST /api/nudges/:id/complete
router.post('/:id/complete', (req, res) => {
  const id = Number(req.params.id);
  // Look up nudge type before completing so we can log it
  const active = db.getActiveNudges();
  const nudge = active.find(n => n.id === id);
  db.completeNudge(id);
  if (nudge) {
    const activity = require('../services/activity');
    activity.trackNudgeDismiss(nudge.type);
  }
  res.json({ success: true });
});

// POST /api/nudges/:type/snooze — snooze a nudge. Body/query `minutes` (default 30).
router.post('/:type/snooze', (req, res) => {
  const { type } = req.params;
  if (!nudges.NUDGE_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid nudge type' });
  }
  const minutes = req.body?.minutes ?? req.query.minutes;
  const result = nudges.snoozeNudge(type, minutes);
  res.json({ success: true, ...result, snoozed_for: `${result.minutes} minutes` });
});

// GET /api/nudges/diagnostic — check nudge system state
router.get('/diagnostic', (req, res) => {
  const obsidian = require('../services/obsidian');
  const nudgesService = require('../services/nudges');

  const today = new Date().toISOString().split('T')[0];
  const dailyNote = obsidian.readTodayDailyNote();

  res.json({
    now: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    today,
    standupDone: nudgesService.isStandupDone ? nudgesService.isStandupDone() : 'method not exported',
    dailyNoteExists: !!dailyNote,
    dailyNoteHasFocusToday: dailyNote ? dailyNote.includes('## Focus Today') : false,
    dailyNoteHasStandup: dailyNote ? dailyNote.includes('## Standup') : false,
    activeNudges: db.getActiveNudges(),
    snoozeState: nudgesService.getSnoozeState(),
    pushConfigured: require('../services/webpush').isConfigured(),
    sseClients: 'see server logs'
  });
});

// POST /api/nudges/trigger-standup — manual trigger for testing
router.post('/trigger-standup', (req, res) => {
  nudges.triggerStandupNudge();
  res.json({ success: true });
});

// POST /api/nudges/trigger-todo — manual trigger for testing
router.post('/trigger-todo', (req, res) => {
  nudges.triggerTodoNudge();
  res.json({ success: true });
});

// POST /api/nudges/nag-check — manual trigger for nag cycle
router.post('/nag-check', (req, res) => {
  nudges.nagCheck();
  res.json({ success: true });
});

module.exports = router;
