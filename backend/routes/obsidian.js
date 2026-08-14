const express = require('express');
const router = express.Router();
const obsidianService = require('../services/obsidian');

// GET /api/obsidian/status
router.get('/status', (req, res) => {
  res.json({ configured: obsidianService.isConfigured() });
});

// GET /api/obsidian/daily
router.get('/daily', (req, res) => {
  const content = obsidianService.readTodayDailyNote();
  res.json({ date: obsidianService.todayDateString(), content });
});

// POST /api/obsidian/daily
router.post('/daily', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content is required' });
  const filePath = obsidianService.writeTodayDailyNote(content);
  res.json({ success: true, path: filePath });
});

// POST /api/obsidian/daily/append
router.post('/daily/append', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const filePath = obsidianService.appendToDailyNote(content);
  res.json({ success: true, path: filePath });
});

// GET /api/obsidian/people
router.get('/people', (req, res) => {
  const names = obsidianService.listPeopleNotes();
  res.json({ people: names });
});

// GET /api/obsidian/people/:name
router.get('/people/:name', (req, res) => {
  const content = obsidianService.readPersonNote(req.params.name);
  if (content === null) {
    return res.json({ name: req.params.name, exists: false, content: null, frontmatter: {}, tags: [] });
  }
  const frontmatter = obsidianService.parseFrontmatter(content);
  const tags = obsidianService.extractTags(content);
  res.json({ name: req.params.name, exists: true, content, frontmatter, tags });
});

// The 121-prep/latest endpoint was removed on 14 Aug 2026 — NOVA owns 1-2-1 prep.
// The Team board now shows the most recent 1-2-1 that actually happened
// (GET /api/1to1/recent) rather than the most recent prep doc, which had been
// generated five times for Heidi without a single meeting following it.

// PUT /api/obsidian/people/:name/raw — overwrite the full person note (markdown body + frontmatter)
router.put('/people/:name/raw', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content (string) is required' });
  }
  try {
    const result = obsidianService.writePersonNoteRaw(req.params.name, content);
    res.json({ success: true, path: result });
  } catch (err) {
    console.error('[obsidian] writePersonNoteRaw error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/obsidian/people/:name/update — update person note frontmatter and append notes
router.post('/people/:name/update', (req, res) => {
  const { last121, next121Due, notes, employmentStatus } = req.body;
  if (!last121 && !next121Due && !notes && !employmentStatus) {
    return res.status(400).json({ error: 'At least one field required (last121, next121Due, notes, employmentStatus)' });
  }
  const result = obsidianService.updatePersonNote(req.params.name, { last121, next121Due, notes, employmentStatus });
  if (result === null) {
    return res.status(404).json({ error: `Person note not found: ${req.params.name}` });
  }
  res.json({ success: true, path: result });
});

// GET /api/obsidian/calendar — calendar events from ICS feed (falls back to vault daily notes)
router.get('/calendar', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });
  try {
    const events = await obsidianService.fetchCalendarEvents(start, end);
    res.json({ events });
  } catch (e) {
    console.error('[Calendar] Error:', e);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// GET /api/obsidian/ninety-day-plan — parsed 90-day plan data from vault
router.get('/ninety-day-plan', (req, res) => {
  const plan = obsidianService.parseNinetyDayPlan();
  if (!plan) return res.status(404).json({ error: '90 Day Plan file not found in vault' });
  res.json(plan);
});

module.exports = router;
