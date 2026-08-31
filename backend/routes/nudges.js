const express = require('express');
const router = express.Router();
const db = require('../db/database');
const nudges = require('../services/nudges');

// GET /api/nudges — active nudges + snooze state + why nothing is nudging
router.get('/', (req, res) => {
  const active = db.getActiveNudges();
  const snoozeState = nudges.getSnoozeState();
  // `suppression` travels with the payload so a quiet banner can SAY why it is
  // quiet. Silence that looks identical to a broken nudge is what makes Nick
  // stop trusting the thing.
  res.json({
    nudges: active,
    snoozeState,
    leave: nudges.getLeave(),
    suppression: nudges.nudgeSuppression(),
  });
});

// ── Annual leave ─────────────────────────────────────────────────────────────
//
// Distinct from snooze, and deliberately not built on it. Snooze is per-type and
// measured in minutes ("not now"); leave is every ritual at once and measured in
// DAYS ("not this week"). Expressing a week off as eight separate 24-hour
// snoozes would be a lie the moment one of them lapsed.

// POST /api/nudges/leave  { days }  — today counts as day 1.
router.post('/leave', (req, res) => {
  const days = req.body?.days ?? req.query.days ?? 1;
  const n = Number(days);
  if (!Number.isFinite(n) || n < 1) {
    return res.status(400).json({ ok: false, error: 'days must be a positive number' });
  }
  res.json(nudges.setLeave(n));
});

// DELETE /api/nudges/leave — back early. Not optional; plans change.
router.delete('/leave', (req, res) => {
  res.json(nudges.clearLeave());
});

/**
 * GET /api/nudges/availability — who is off, and whether NEURO could tell.
 *
 * Reports the cached copy AND its provenance. "We could not ask NOVA" must stay
 * distinguishable from "nobody is off"; the second is an all-clear and the
 * first is not.
 */
router.get('/availability', (req, res) => {
  try {
    const availability = require('../services/team-availability');
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const snap = availability.snapshot(now);
    res.json({
      ok: true,
      status: availability.status(now),
      today: dateStr,
      me: availability.selfAbsenceOn(dateStr, snap),
      othersOffToday: availability.othersOff(dateStr, snap),
      upcoming: (snap.absences || []).slice(0, 40),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Force a pull from NOVA rather than waiting for the half-hourly refresh. */
router.post('/availability/refresh', async (req, res) => {
  try {
    res.json(await require('../services/team-availability').refresh());
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
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

// POST /api/nudges/eod/snooze-till-nine — the one-tap on the 8pm prompt.
//
// ⚠ Registered ABOVE /:type/snooze. Express matches in registration order, and
// declared after it this path would be read as the type "eod" with a literal
// "snooze-till-nine" — the #70 trap, one route along.
router.post('/eod/snooze-till-nine', (req, res) => {
  const result = nudges.snoozeEodUntilNine();
  if (!result.ok) return res.status(409).json({ success: false, error: result.reason });
  res.json({ success: true, ...result });
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
