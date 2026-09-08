'use strict';

const express = require('express');
const router = express.Router();
const attention = require('../services/attention');

/**
 * GET /api/attention — the one thing SARA should surface right now.
 *
 * This is the feed both SARA surfaces render. It is READ-ONLY and must stay so:
 * an ambient screen polled every minute must never be the reason something
 * changed (`state-of-play`'s rule).
 *
 * `primary: null` is a valid, correct answer — most of a calm day should be
 * quiet. Consumers must render silence, not treat it as a failure.
 */
router.get('/', async (req, res) => {
  try {
    // ?view=work|personal pins the AGENDA for a widget locked to one side of
    // the split. Anything else is ignored rather than rejected: an unknown
    // value must fall back to the brain's own read, never to an empty diary.
    // work | personal pin a side; flip asks for the opposite of the brain's own
    // read, for the second card in a stack. Anything else is ignored rather
    // than rejected: an unknown value must fall back to the brain, never to an
    // empty diary.
    const asked = String(req.query.view || '').toLowerCase();
    const view = ['work', 'personal', 'flip'].indexOf(asked) !== -1 ? asked : null;
    // ⚠ `ask` moves the DASHBOARD, never the pool. It is matched
    // deterministically against a small route table (`sara-surface`), bounded
    // here so a caller cannot push an unbounded string into the payload, and it
    // adds no candidates and re-ranks nothing — the answer to the question is
    // still streamed by chat. It also cannot move the surface off `blind`.
    const ask = typeof req.query.ask === 'string' ? req.query.ask.slice(0, 200) : null;
    res.json(await attention.build({ view, ask }));
  } catch (e) {
    console.error('[Attention] build failed:', e.message);
    // An error is NOT an empty feed. Returning `{primary:null}` here would be
    // indistinguishable from a genuinely quiet moment, which is exactly the
    // false all-clear this whole layer is built to avoid.
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/attention/context — the situational read alone, without the pool.
 * Cheap, and useful for a surface that wants to know where Nick is without
 * paying for a full decision-engine evaluation.
 */
router.get('/context', async (req, res) => {
  try {
    const { inputs, gaps } = await attention.gather();
    const { resolveContext } = require('../services/context-state');
    res.json({ context: resolveContext(inputs), gaps });
  } catch (e) {
    console.error('[Attention] context failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Lifecycle (Phase 3, Gate 1) ──────────────────────────────────────────────
//
// ⚠ Every literal path below is registered BEFORE `/records/:id/act`. Express
// matches in registration order, and a literal declared after a sibling
// parameterised route is read as its parameter — which is how
// `/api/email/triage/feedback` once answered "Email not found".

const lifecycle = require('../services/attention-lifecycle');
const settings = require('../services/attention-settings');

/** GET /api/attention/records — every open record, whatever its state. */
router.get('/records', (req, res) => {
  try {
    const db = require('../db/database');
    lifecycle.releaseDeferrals(new Date());
    res.json({
      version: 'v1',
      records: db.getOpenAttentionRecords().map(lifecycle.present),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/attention/history — what was surfaced, when, and why.
 *
 * The required "recent notifications/attention history with the reason each was
 * surfaced". A state column alone cannot answer it: it holds only the latest
 * value, so a card deferred three times looks identical to one deferred once.
 */
router.get('/history', (req, res) => {
  try {
    const db = require('../db/database');
    res.json({ events: db.getAttentionHistory(req.query.limit) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/settings', (req, res) => {
  try {
    res.json({ settings: settings.read(), deferReasons: [...lifecycle.DEFER_REASONS], levels: settings.LEVELS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * PATCH /api/attention/settings — the controls.
 *
 * Unknown keys are ignored rather than stored: this blob is read on every push,
 * and letting a client write arbitrary fields into it is how a typo becomes a
 * permanent silent setting nobody can find.
 */
router.patch('/settings', (req, res) => {
  try {
    res.json({ ok: true, settings: settings.update(req.body || {}) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/attention/records/:id/act
 *   start | acknowledge | defer | dismiss | complete | resolve
 *
 * Clients submit ACTIONS, never states. A refusal answers 4xx with the reason in
 * words, rather than a success the surface would render as a change that did not
 * happen (`action-presenter`'s blockers rule).
 *
 * ⚠ The action semantics are the product here, and each one exists because the
 * legacy `/api/focus` surface conflated it with another:
 *   `start`      — a focus session began. Changes NO state. The old Briefing
 *                  "Do it" button POSTed an outcome at this moment, recording
 *                  work as finished when it had only just been picked up.
 *   `complete`   — Nick's explicit confirmation. The ONLY path that resolves,
 *                  and the only one that may close a task.
 *   `defer`      — "not now" / "waiting on someone", with the reason recorded,
 *                  because a thing deferred three times for `too-big` is a
 *                  different problem from one deferred for `not-now`.
 *   `dismiss`    — "not relevant". Teaches suppression, touches no work.
 * Navigating to an item is deliberately NOT here: opening something is not an
 * action on it, and giving it a route is how it acquires a side effect later.
 */
router.post('/records/:id/act', async (req, res) => {
  try {
    const { action, minutes, reason, note } = req.body || {};
    const result = lifecycle.act(req.params.id, action, { minutes, reason, note });
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

    let taskCompleted = result.taskCompleted ?? null;
    let taskWhy = result.taskWhy ?? null;
    let msPush = null;

    // ⚠ A Microsoft-owned card is closed HERE, because `lifecycle.act` is
    // synchronous and Graph is not. It goes through `services/ms-complete` — the
    // same one implementation `/api/todos/complete-ms` uses — so the mirror flip,
    // the wins record, the recurrence repaint, the webhook fallback and the retry
    // queue cannot drift between the two surfaces that tick the same task.
    if (result.pendingMicrosoft) {
      try {
        const msComplete = require('../services/ms-complete');
        const push = await msComplete.completeMicrosoftTask({
          msId: result.pendingMicrosoft.msId,
          source: result.pendingMicrosoft.msSource || null,
        });
        msPush = { pushed: push.pushed, held: push.held, rolled: push.rolled || null, warning: push.warning || null };
        // ⚠ What "completed" MEANS here: the work is closed somewhere that
        // stops the card being regenerated. Either the mirror line flipped —
        // which is what NEURO itself reads, and why `complete-ms` returns ok
        // with `pushed:'none'` — or Microsoft took it. Neither, and nothing was
        // closed anywhere, which is precisely the case that must not report a
        // completion; that lie is the whole reason this change exists.
        taskCompleted = Boolean(push.mirrored) || push.pushed !== 'none';
        // A recurrence is NOT a failed completion: Microsoft closed the
        // occurrence and rolled the same task forward on purpose, and reported
        // as a failure it reads exactly like a lost tick.
        taskWhy = push.rolled
          ? 'Microsoft closed this occurrence and rolled the task forward'
          : (push.pushed === 'none'
            ? `${push.mirrored ? 'ticked in NEURO, but ' : 'nothing was ticked — '}Microsoft would not take it${push.held ? ' — held, NEURO will retry' : ''}`
            : 'Microsoft task completed');
      } catch (e) {
        // The record is already resolved; say what failed rather than pretending
        // either way. A silent swallow here is how a tick comes to look like it
        // worked while the task stays open on somebody's board.
        taskCompleted = false;
        taskWhy = `could not reach Microsoft — ${e.message}`;
      }
    }

    // The pool is rebuilt from working memory, which caches for TEN MINUTES —
    // so without this the client's immediate refresh re-renders the card that
    // was just completed and it reads as a button that did nothing. Same call
    // `/api/focus` already makes after an action completes.
    if (taskCompleted) {
      try { require('../services/working-memory').invalidate('attention: card completed'); } catch { /* best effort */ }
    }

    res.json({
      ok: true,
      record: lifecycle.present(result.record),
      // Only meaningful for `complete`, and always stated rather than implied:
      // resolving the card and closing the task are two outcomes, and a tick
      // held by the outcome-note rule must not read as a completion.
      taskCompleted,
      taskWhy,
      // Present only when the completion had to leave the building.
      msPush,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
