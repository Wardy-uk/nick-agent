'use strict';

/**
 * Team Health routes.
 *   GET /api/team-health            -- all teams, prioritised issues
 *   GET /api/team-health?team=...   -- filter to one team
 */

const express = require('express');
const router = express.Router();
const teamHealth = require('../services/team-health');

router.get('/', (req, res) => {
  try {
    const team = req.query.team ? String(req.query.team) : undefined;
    const severity = req.query.severity ? String(req.query.severity) : 'high';
    const result = teamHealth.teamHealthSnapshot({ team, severity });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[team-health]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/teams', (_req, res) => {
  res.json({ ok: true, teams: Object.keys(teamHealth.TEAMS) });
});

/**
 * GET /api/team-health/roster — the live roster, for clients that were carrying
 * their own copy of it (#13).
 *
 * The frontend cannot require a backend service, which is exactly why
 * `ChatPanel` ended up with a hardcoded list of fifteen first names. Returns
 * both the full names and the first names that are unambiguous, so a caller
 * never has to re-derive that rule and get it wrong.
 */
router.get('/roster', (_req, res) => {
  try {
    const roster = require('../services/team-roster');
    res.json({
      ok: true,
      teams: roster.teams(),
      people: roster.directReports().map(p => ({
        name: p.name, role: p.role, team: p.group, email: p.email,
      })),
      firstNames: Object.fromEntries(roster.reportFirstNames()),
    });
  } catch (e) {
    console.error('[team-health/roster]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
