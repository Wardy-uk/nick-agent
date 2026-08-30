'use strict';

/**
 * Focus sessions — start the one thing, and find your way back to it.
 *
 * GET  /api/session            — current session + the return prompt, one read
 * GET  /api/session/history    — the last few sessions, planned vs actual
 * POST /api/session/start      — { taskId?, text?, minutes?, force? }
 * POST /api/session/pause      — { reason?, source? }
 * POST /api/session/resume
 * POST /api/session/interrupt  — note something landed, without stopping the clock
 * POST /api/session/finish     — { completeTask? }
 * POST /api/session/abandon
 *
 * All synchronous — the state is one KV row, and a surface read at a moment of
 * low executive function must not hesitate. Same reasoning as /api/time.
 *
 * `start` without `force` REFUSES when a session is already running and hands
 * back the one that is, rather than choosing between two "current things" on
 * Nick's behalf. The client asks; force is the answer.
 */

const express = require('express');
const router = express.Router();
const session = require('../services/focus-session');

router.get('/', (req, res) => {
  try {
    res.json(session.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    res.json({ sessions: session.history().slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/start', (req, res) => {
  try {
    const result = session.start({
      taskId: req.body?.taskId ?? null,
      text: req.body?.text || '',
      minutes: req.body?.minutes == null ? null : Number(req.body.minutes),
      force: Boolean(req.body?.force),
      source: req.body?.source || 'manual',
      // The concrete first move, if he named one. Optional: a session without a
      // named step is still a session, and demanding one would put a form in
      // front of the thing that exists to lower the barrier to starting.
      nextStep: req.body?.nextStep || null,
    });
    // 409 rather than 400: the request was fine, the world had something else
    // in it. The running session comes back so the client can name it in the
    // "you're already on X — switch?" prompt.
    res.status(result.ok ? 200 : 409).json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/pause', (req, res) => {
  try {
    res.json(session.pause({ source: req.body?.source || 'manual', detail: req.body?.detail || null }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/resume', (req, res) => {
  try {
    res.json(session.resume());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/interrupt', (req, res) => {
  try {
    res.json(session.noteInterruption({ source: req.body?.source || 'unknown', detail: req.body?.detail || null }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/session/shrink — "make this smaller".
 *
 * The one control that lowers the barrier rather than raising awareness. With a
 * `step` it names the smaller thing and carries on; WITHOUT one it parks the
 * session in `needs-smaller`, which is an honest state and not the same as
 * paused: "not now" and "I'm stuck on how big this is" are different problems
 * and get different prompts.
 *
 * ⚠ Never treated as failure anywhere downstream. A task shrunk three times is
 * a finding about the work, not a mark against Nick.
 */
router.post('/shrink', (req, res) => {
  try {
    const result = session.shrink({ step: req.body?.step || null, note: req.body?.note || null });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/session/next-step — set or clear the concrete next action. */
router.post('/next-step', (req, res) => {
  try {
    const result = session.setNextStep(req.body?.step || '');
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/session/step-away — Nick says he was pulled off it.
 *
 * ⚠ Deliberately NOT `/interrupt`, which already means "something arrived, keep
 * the clock running" and must keep meaning that: NEURO cannot know whether an
 * arriving escalation actually took him away, and guessing corrupts the one
 * number the return prompt rests on. This is him saying it did.
 */
router.post('/step-away', (req, res) => {
  try {
    res.json(session.stepAway({ source: req.body?.source || 'manual', detail: req.body?.detail || null }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/finish', (req, res) => {
  try {
    res.json(session.finish({ completeTask: Boolean(req.body?.completeTask) }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/abandon', (req, res) => {
  try {
    res.json(session.abandon());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
