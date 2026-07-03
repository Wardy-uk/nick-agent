const express = require('express');
const router = express.Router();
const jira = require('../services/jira');
const db = require('../db/database');


// GET /api/jira/escalations/unseen — count for sidebar badge
router.get('/escalations/unseen', (req, res) => {
  try {
    const count = jira.getUnseenEscalationCount();
    res.json({ count });
  } catch (e) {
    res.json({ count: 0 });
  }
});

// POST /api/jira/escalations/seen — mark all as seen when queue tab opened
router.post('/escalations/seen', async (req, res) => {
  try {
    jira.markEscalationsSeen();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/jira/escalations — full escalation list for queue panel
router.get('/escalations', async (req, res) => {
  try {
    const raw = db.getState('escalation_seen');
    const known = raw ? JSON.parse(raw) : {};
    const tickets = Object.entries(known).map(([key, v]) => ({
      key,
      summary: v.summary,
      created: v.created,
      hasComment: v.hasComment,
      seen: v.seen
    }));
    res.json({ tickets, total: tickets.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
