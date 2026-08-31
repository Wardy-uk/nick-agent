'use strict';

/**
 * /api/profile — what SARA knows about Nick as a person.
 *
 * Nick's design (31 Aug 2026): seed it from the memory Claude and ChatGPT have
 * already accumulated, enrich it with a one-time interview run from NEURO, then
 * let SARA add to it as she learns. So the only typing is a paste and one
 * conversation.
 *
 * ⚠ PRIVATE. This never reaches VESTA, a catalogue, or anything outside NEURO.
 * It is the most personal thing in the vault by construction.
 */

const express = require('express');
const router = express.Router();
const profile = require('../services/profile');

router.get('/', (req, res) => {
  const found = profile.read();
  if (!found.ok) return res.status(500).json({ ok: false, error: found.why });
  res.json({
    ok: true,
    ...found.profile,
    count: profile.count(found.profile),
    gaps: profile.gaps(found.profile),
    empty: !!found.empty,
  });
});

/** What she would actually be told, for checking it reads right. */
router.get('/block', (req, res) => {
  res.json({ ok: true, block: profile.block() });
});

/**
 * POST /api/profile/seed — paste a memory dump from Claude or ChatGPT.
 *
 * The dump is prose; turning it into attributed facts is exactly a model task.
 *
 * ⚠ The model RESTRUCTURES and may not ADD. A profile that quietly acquires an
 * interest he does not have is worse than an empty one, because he would have no
 * reason to distrust it — so the prompt says so twice and everything lands
 * stamped `seed`, which SARA renders as "(mentioned)" rather than "(told me)".
 *
 * ⚠ It PROPOSES by default. `apply: true` writes; without it he gets the list
 * back to look at first. This is a file about him, assembled by a model, from a
 * dump written by another model — two removes from anything he actually said,
 * and that deserves a look before it becomes what she believes.
 */
router.post('/seed', async (req, res) => {
  const { text, source = 'seed', apply = false } = req.body || {};
  const raw = String(text || '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'text is required' });
  if (raw.length > 60000) return res.status(400).json({ ok: false, error: 'that dump is too large — split it' });

  try {
    const facts = await profile.extractFacts(raw);
    if (!facts.ok) return res.status(502).json({ ok: false, error: facts.why });
    if (!apply) {
      return res.json({ ok: true, proposed: facts.facts, applied: false, note: 'Nothing written. POST again with apply:true.' });
    }
    const result = profile.addFacts(facts.facts, { source });
    if (!result.ok) return res.status(500).json({ ok: false, error: result.why });
    res.json({ ok: true, applied: true, added: result.added, duplicates: result.duplicates });
  } catch (e) {
    console.error('[Profile] Seed failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/profile/facts — add facts directly. What the interview calls, and
 *  what SARA calls when he tells her something in passing. */
router.post('/facts', (req, res) => {
  const { facts, source = 'conversation' } = req.body || {};
  if (!Array.isArray(facts) || !facts.length) {
    return res.status(400).json({ ok: false, error: 'facts must be a non-empty array of { text, section }' });
  }
  const result = profile.addFacts(facts, { source });
  if (!result.ok) return res.status(500).json({ ok: false, error: result.why });
  res.json({ ok: true, added: result.added, duplicates: result.duplicates });
});

// ── The get-to-know-you conversation ─────────────────────────────────────────

const interview = require('../services/profile-interview');

router.get('/interview', (req, res) => {
  const session = interview.load();
  res.json({ ok: true, ...interview.status(), messages: session ? session.messages : [] });
});

router.post('/interview/start', async (req, res) => {
  try {
    // ⚠ Restarting is EXPLICIT. An accidental restart throws away a conversation
    // he has already given an hour to.
    const session = await interview.start({ restart: (req.body || {}).restart === true });
    res.json({ ok: true, ...interview.status(), messages: session.messages });
  } catch (e) {
    // 503 + retryable, with the session intact, so the client can try again
    // without him retyping — standup-session's rule.
    res.status(503).json({ ok: false, retryable: true, error: e.message });
  }
});

router.post('/interview/reply', async (req, res) => {
  try {
    const session = await interview.reply((req.body || {}).message);
    res.json({ ok: true, ...interview.status(), messages: session.messages });
  } catch (e) {
    const retryable = /provider/i.test(e.message);
    res.status(retryable ? 503 : 400).json({ ok: false, retryable, error: e.message, messages: (interview.load() || {}).messages || [] });
  }
});

module.exports = router;
