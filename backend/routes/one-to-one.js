'use strict';

/**
 * 1:1 routes — detection, booking, and meeting note CRUD.
 *   GET  /api/1to1/recent        ?refresh=1   — detected 1-2-1 history per person
 *   POST /api/1to1/sync          { apply? }   — stamp People notes from the notes
 *   POST /api/1to1/propose       { person, durationMinutes? }  — read-only draft
 *   POST /api/1to1/book          { person, start, end, email?, subject? }
 *   POST /api/1to1/notes         { action, title, date?, type?, people?, body?, section?, content? }
 *
 * Prep generation was removed on 14 Aug 2026 — NOVA owns 1-2-1 prep now. Keeping
 * a second generator here would have produced competing prep docs for the same
 * meeting. `services/one-to-one-prep.js` is retained but no longer routed — and
 * as of 16 Aug it has ZERO code consumers anywhere in the repo, not just no
 * route. `scripts/smoke-tier1.js` was the last one and was still EXECUTING it
 * against the real vault on every `npm test` (#119); that is gone. Deleting the
 * service is now a no-op change, waiting only on NOVA being confirmed to cover
 * prep end to end (#21) — which is blocked behind #116.
 */

const express = require('express');
const router = express.Router();

const meetingNote = require('../services/meeting-note');
const detect = require('../services/one-to-one-detect');
const booking = require('../services/one-to-one-booking');

// Detected 1-2-1 history, newest first, keyed by person.
router.get('/recent', (req, res) => {
  try {
    const index = detect.getIndex({ force: req.query.refresh === '1' });
    res.json({
      ok: true,
      byPerson: index.byPerson || {},
      scannedAt: index.scannedAt || null,
      scanned: index.scanned || 0,
    });
  } catch (e) {
    console.error('[1to1/recent]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Write detected dates back into People frontmatter. Dry-run unless apply=true.
router.post('/sync', (req, res) => {
  try {
    const result = detect.syncPeopleNotes({ apply: req.body?.apply === true });
    res.json(result);
  } catch (e) {
    console.error('[1to1/sync]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/1to1/tracker { apply? } — regenerate `Areas/1-2-1 Tracker.md` (#31).
 *
 * Dry-run by default, returning the table it WOULD write. The nightly sync
 * calls this itself via `syncPeopleNotes`; this exists so it can be inspected
 * and forced without waiting for 10pm.
 */
router.post('/tracker', (req, res) => {
  try {
    const tracker = require('../services/one-to-one-tracker');
    const result = tracker.render({ apply: req.body?.apply === true });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    console.error('[1to1/tracker]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/1to1/nova-sync { apply? } — reconcile bookings + cadence into NOVA.
 *
 * Dry-run by default, returning exactly what it would push. The 06:20 cron calls this
 * with apply, ahead of NOVA's 07:00 prep job; this exists so it can be inspected and
 * forced without waiting for the morning. Also reports roster drift between the vault's
 * direct reports and NOVA's plans, which nothing else compares.
 */
router.post('/nova-sync', async (req, res) => {
  try {
    const result = await require('../services/nova-121-sync').reconcile({ apply: req.body?.apply === true });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    console.error('[1to1/nova-sync]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/1to1/nova-writeback { apply?, since? } — pull completed 1-2-1s from NOVA
 * into the People cards, then regenerate the tracker.
 *
 * Dry-run by default. The 22:20 cron calls this with apply; `since` overrides the
 * watermark for a backfill.
 */
router.post('/nova-writeback', async (req, res) => {
  try {
    const result = await require('../services/nova-121-writeback').writeBack({
      apply: req.body?.apply === true,
      since: typeof req.body?.since === 'string' ? req.body.since : null,
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    console.error('[1to1/nova-writeback]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/1to1/nova-transcripts { apply?, days? } — offer vault 1-2-1 transcripts to
 * NOVA as candidates. Dry-run by default. NOVA attaches nothing until Nick approves.
 */
router.post('/nova-transcripts', async (req, res) => {
  try {
    const result = await require('../services/nova-121-transcripts').offerTranscripts({
      apply: req.body?.apply === true,
      days: Number(req.body?.days) || undefined,
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    console.error('[1to1/nova-transcripts]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/1to1/pending-transcripts — who has a Plaud recording waiting for approval in
 * NOVA. Drives the badge on the People board. Answers `ok:false` rather than an empty
 * list when NOVA cannot be reached, so "none pending" is never confused with "unknown".
 */
router.get('/pending-transcripts', async (req, res) => {
  try {
    const nova = require('../services/nova-client');
    if (!nova.isConfigured()) return res.json({ ok: false, error: 'NOVA bridge not configured', agents: [] });
    const data = await nova.get121PendingCandidates();
    res.json({ ok: true, agents: data.agents || [] });
  } catch (e) {
    res.json({ ok: false, error: e.message, agents: [] });
  }
});

/**
 * GET /api/1to1/open-actions — 1-2-1 commitments still owed, per person, from NOVA.
 *
 * NOVA owns `agent_121_actions` and is the only place a commitment made IN a 1-2-1 is
 * recorded with a status. The People card used to render a count of NEURO tasks whose
 * text happened to mention the person's name, under the words "N actions owed" — a fuzzy
 * match over Nick's own todo list, presented on a 1-2-1 card as a fact about a colleague.
 *
 * ⚠ `ok:false` rather than an empty map when NOVA cannot be reached, and a person NOVA
 * does not track is ABSENT from `agents` rather than present as 0. "Nothing owed",
 * "not tracked" and "couldn't ask" are three different facts and the card renders each
 * differently.
 */
router.get('/open-actions', async (req, res) => {
  try {
    const nova = require('../services/nova-client');
    if (!nova.isConfigured()) return res.json({ ok: false, error: 'NOVA bridge not configured', agents: {} });
    const data = await nova.get121State({ days: 60 });
    const rows = data?.agents;
    // The bridge answers `agents: null` on a DB error behind a 503; nova-client may also
    // hand back a shape we did not expect. Neither is "nobody owes anything".
    if (!Array.isArray(rows)) return res.json({ ok: false, error: 'NOVA returned no roster', agents: {} });
    const agents = {};
    for (const a of rows) {
      if (a && a.agentName && Number.isFinite(a.openActions)) agents[a.agentName] = a.openActions;
    }
    // ⚠ A NOVA older than 2026-09-04 answers this route perfectly and carries no
    // `openActions` at all — which would map to an empty object and render as a team
    // that owes nothing, the reader-before-writer shape this repo keeps getting bitten
    // by. A roster with names but not one countable field is an OLD BRIDGE, not a clean
    // slate. (A roster that is genuinely empty is a different thing and stays ok:true.)
    if (rows.length > 0 && Object.keys(agents).length === 0) {
      return res.json({ ok: false, error: 'NOVA did not report action counts (bridge predates them)', agents: {} });
    }
    res.json({ ok: true, agents });
  } catch (e) {
    res.json({ ok: false, error: e.message, agents: {} });
  }
});

// Propose a slot. Reads the calendar; creates nothing.
router.post('/propose', async (req, res) => {
  try {
    const { person, durationMinutes } = req.body || {};
    if (!person) return res.status(400).json({ ok: false, error: 'person is required' });
    const result = await booking.propose(person, { durationMinutes });
    res.json(result);
  } catch (e) {
    console.error('[1to1/propose]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Plan slots for several people at once. Reads only; creates nothing.
router.post('/plan-all', async (req, res) => {
  try {
    const { people, durationMinutes } = req.body || {};
    if (!Array.isArray(people) || !people.length) {
      return res.status(400).json({ ok: false, error: 'people (array) is required' });
    }
    const result = await booking.planAll(people, { durationMinutes });
    res.json(result);
  } catch (e) {
    console.error('[1to1/plan-all]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create every event in a confirmed plan. Each is independent — one failure
// does not abandon the rest, and nothing is retried.
router.post('/book-all', async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: 'items (array) is required' });
    }
    const result = await booking.bookAll(items);
    res.json(result);
  } catch (e) {
    console.error('[1to1/book-all]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create the event. Only reached after Nick has confirmed a proposal.
router.post('/book', async (req, res) => {
  try {
    const { person, start, end, email, subject, durationMinutes } = req.body || {};
    if (!person || !start || !end) {
      return res.status(400).json({ ok: false, error: 'person, start and end are required' });
    }
    const result = await booking.book({ person, start, end, email, subject, durationMinutes });
    res.json(result);
  } catch (e) {
    console.error('[1to1/book]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Find the existing 1-2-1 in the diary. Reads only.
router.get('/find/:person', async (req, res) => {
  try {
    const result = await booking.findOneToOne(req.params.person);
    res.json(result);
  } catch (e) {
    console.error('[1to1/find]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Propose where a 1-2-1 should move to. Reads only — moves nothing.
router.post('/propose-reschedule', async (req, res) => {
  try {
    const { person, after, durationMinutes } = req.body || {};
    if (!person) return res.status(400).json({ ok: false, error: 'person is required' });
    const result = await booking.proposeReschedule(person, { after, durationMinutes });
    res.json(result);
  } catch (e) {
    console.error('[1to1/propose-reschedule]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Move the event. Only reached after Nick has confirmed a proposal — Graph
// emails the attendee an update, so nothing moves by looking.
router.post('/reschedule', async (req, res) => {
  try {
    const { person, eventId, start, end, reason } = req.body || {};
    if (!person || !eventId || !start || !end) {
      return res.status(400).json({ ok: false, error: 'person, eventId, start and end are required' });
    }
    const result = await booking.reschedule({ person, eventId, start, end, reason });
    res.json(result);
  } catch (e) {
    console.error('[1to1/reschedule]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// How often this person's 1-2-1 has been moved. Read-only; feeds the Team card.
router.get('/moves/:person', (req, res) => {
  try {
    const moves = booking.movesFor(req.params.person);
    res.json({ ok: true, person: req.params.person, moveCount: moves.length, moves });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/notes', (req, res) => {
  try {
    const { action, title, date, type, people, body, section, content } = req.body || {};
    if (!action) return res.status(400).json({ ok: false, error: 'action is required' });
    const result = meetingNote.manageMeetingNote({ action, title, date, type, people, body, section, content });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[1to1/notes]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
