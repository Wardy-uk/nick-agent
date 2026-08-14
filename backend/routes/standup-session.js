'use strict';

/**
 * Collaborative standup / EOD session API.
 *
 * GET  /api/standup-session/:kind          — resume today's session (null if none)
 * POST /api/standup-session/:kind/start    — begin (or re-open) today's session
 * POST /api/standup-session/:kind/reply    — send a message, get the next turn
 * POST /api/standup-session/:kind/finish   — write the note and close
 * POST /api/standup-session/:kind/abandon  — bin today's session and start over
 *
 * Every response carries the whole session, so the client never has to hold
 * state the server does not already have. That is the point: the previous flow
 * kept the entire conversation in browser memory until one final POST, and lost
 * everything when that POST failed.
 */

const express = require('express');
const router = express.Router();
const session = require('../services/standup-session');

const KINDS = new Set([session.KIND_STANDUP, session.KIND_EOD]);

function kindOf(req, res) {
  const kind = String(req.params.kind || '').toLowerCase();
  if (!KINDS.has(kind)) {
    res.status(400).json({ error: `kind must be "standup" or "eod"` });
    return null;
  }
  return kind;
}

// Trim what goes over the wire — the client needs the transcript and the state,
// not the whole gathered context blob.
function present(s) {
  if (!s) return null;
  return {
    kind: s.kind,
    dateKey: s.dateKey,
    state: s.state,
    degraded: Boolean(s.degraded),
    lastError: s.lastError || null,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    outcome: s.outcome,
    messages: s.messages,
  };
}

router.get('/:kind', (req, res) => {
  const kind = kindOf(req, res);
  if (!kind) return;
  try {
    res.json({ session: present(session.resume(kind)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:kind/start', async (req, res) => {
  const kind = kindOf(req, res);
  if (!kind) return;
  try {
    const s = await session.start(kind, { restart: Boolean(req.body?.restart) });
    res.json({ session: present(s) });
  } catch (e) {
    console.error('[StandupSession] Start failed:', e.message);
    // 503, not 500: the conversation could not start, but nothing is broken and
    // retrying is the right move. The client says so rather than offering a
    // dead end.
    res.status(503).json({ error: e.message, retryable: true });
  }
});

router.post('/:kind/reply', async (req, res) => {
  const kind = kindOf(req, res);
  if (!kind) return;
  try {
    const s = await session.reply(kind, req.body?.message);
    res.json({ session: present(s) });
  } catch (e) {
    console.error('[StandupSession] Reply failed:', e.message);
    // The message is already persisted server-side even though the turn failed,
    // so the client can retry without Nick retyping anything.
    const saved = session.resume(kind);
    res.status(503).json({ error: e.message, retryable: true, session: present(saved) });
  }
});

router.post('/:kind/finish', (req, res) => {
  const kind = kindOf(req, res);
  if (!kind) return;
  try {
    const result = session.finish(kind);
    res.json({ ok: true, alreadyFinished: Boolean(result.alreadyFinished), session: present(result.session) });
  } catch (e) {
    console.error('[StandupSession] Finish failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:kind/abandon', (req, res) => {
  const kind = kindOf(req, res);
  if (!kind) return;
  try {
    session.clear(kind);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
