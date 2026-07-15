const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/queue/summary — real queue snapshot from NEURO's cached Jira data
router.get('/summary', (req, res) => {
  try {
    const summary = db.getQueueSummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
