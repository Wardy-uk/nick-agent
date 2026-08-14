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
 * meeting. `services/one-to-one-prep.js` is retained but no longer routed.
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
