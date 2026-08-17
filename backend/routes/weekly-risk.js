'use strict';

/**
 * Weekly Risk & Anomaly Summary + Management Actions Log — PIP competencies 2/3/4.
 *
 * Read paths are free; the only thing that leaves NEURO is `publish`, which
 * writes a note into the vault. Nothing here emails, sends or notifies anybody —
 * the report goes to Chris because Nick sends it, which keeps the judgement
 * where the PIP puts it.
 */

const express = require('express');
const router = express.Router();

const weeklyRisk = require('../services/weekly-risk');
const managementLog = require('../services/management-log');

function fail(res, err, code = 500) {
  res.status(code).json({ error: err?.message || String(err) });
}

// ── Weekly risk report ───────────────────────────────────────────────────────

/** GET /api/weekly-risk?week=YYYY-MM-DD — the assessed report, no markdown. */
router.get('/', async (req, res) => {
  try {
    const week = req.query.week || weeklyRisk.weekCommencing();
    const report = await weeklyRisk.build({ week, date: req.query.date });
    const { markdown, ...rest } = report;
    res.json({ ...rest, published: weeklyRisk.publishedAt(week) });
  } catch (err) { fail(res, err); }
});

/** GET /api/weekly-risk/markdown — the note as it would be published. */
router.get('/markdown', async (req, res) => {
  try {
    const week = req.query.week || weeklyRisk.weekCommencing();
    const report = await weeklyRisk.build({ week, date: req.query.date });
    res.type('text/markdown').send(report.markdown);
  } catch (err) { fail(res, err); }
});

/**
 * GET /api/weekly-risk/manual — what Nick has entered, and what is still
 * missing. Returned separately from the report so the entry screen can be
 * opened without paying for a NOVA round trip.
 */
router.get('/manual', (req, res) => {
  try {
    const week = req.query.week || weeklyRisk.weekCommencing();
    const manual = weeklyRisk.getManual(week);
    res.json({ week, manual, blockers: weeklyRisk.manualBlockers(manual) });
  } catch (err) { fail(res, err); }
});

/** POST /api/weekly-risk/manual — save the sections NOVA cannot answer. */
router.post('/manual', (req, res) => {
  try {
    const week = req.body.week || weeklyRisk.weekCommencing();
    const { week: _ignored, ...patch } = req.body || {};
    const manual = weeklyRisk.setManual(week, patch);
    res.json({ week, manual, blockers: weeklyRisk.manualBlockers(manual) });
  } catch (err) { fail(res, err); }
});

/**
 * POST /api/weekly-risk/publish — write the note.
 *
 * Refuses while a manual section is unanswered and returns the blockers.
 * `force: true` publishes anyway, which is a deliberate choice Nick can make;
 * it is not the default, because the silence of an unanswered section renders
 * as a claim.
 */
router.post('/publish', async (req, res) => {
  try {
    const week = req.body?.week || weeklyRisk.weekCommencing();
    const result = await weeklyRisk.publish({ week, force: Boolean(req.body?.force) });
    if (!result.ok) return res.status(409).json({ error: 'Report is not ready to publish', blockers: result.blockers });
    res.json({ ok: true, path: result.path, week });
  } catch (err) { fail(res, err); }
});

/**
 * POST /api/weekly-risk/queue-send — queue the send to Chris for approval.
 *
 * Never sends. It creates a `send_weekly_risk_report` action that Nick approves
 * in the Actions panel, where the full report and the exact address are shown.
 * 409 with blockers if the report is unfinished or the recipient cannot be
 * resolved — the second is the likely one, since "Chris" is ambiguous in the
 * vault and Chris Middleton's People note carries no address.
 */
router.post('/queue-send', async (req, res) => {
  try {
    const result = await weeklyRisk.queueSend({
      week: req.body?.week || weeklyRisk.weekCommencing(),
      to: req.body?.to || null,
      force: Boolean(req.body?.force),
    });
    if (!result.ok) return res.status(409).json({ error: 'Not ready to send', blockers: result.blockers });
    res.json({
      ok: true,
      actionId: result.actionId,
      recipient: result.recipient,
      subject: result.subject,
      note: 'Queued for approval — nothing has been sent. Approve it in Actions.',
    });
  } catch (err) { fail(res, err); }
});

/**
 * POST /api/weekly-risk/test-send — email Nick a copy, to see how it lands.
 *
 * Takes NO recipient, deliberately: the address is a constant in email-sender,
 * so this route cannot be aimed at anybody. That is what makes it safe without
 * the approval gate — the gate protects against reaching Chris, and this
 * cannot. It also ignores the blockers, because looking at an unfinished report
 * is the entire point; the mail says so in a banner and in the subject.
 */
router.post('/test-send', async (req, res) => {
  try {
    const result = await weeklyRisk.testSend({ week: req.body?.week || weeklyRisk.weekCommencing() });
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({
      ok: true,
      to: result.to,
      note: result.unfinished
        ? `Sent to you. ${result.unfinished} section(s) still unanswered — the mail says so.`
        : 'Sent to you. This is exactly what Chris would receive.',
    });
  } catch (err) { fail(res, err); }
});

// ── Management log ───────────────────────────────────────────────────────────

/** GET /api/weekly-risk/log — rows plus the competency 3/4 assessment. */
router.get('/log', (req, res) => {
  try {
    res.json(managementLog.status({
      baselineDate: req.query.baselineDate || undefined,
    }));
  } catch (err) { fail(res, err); }
});

router.post('/log', (req, res) => {
  try {
    res.status(201).json(managementLog.create(req.body || {}));
  } catch (err) { fail(res, err, 400); }
});

router.patch('/log/:id', (req, res) => {
  try {
    const row = managementLog.update(Number(req.params.id), req.body || {});
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) { fail(res, err, 400); }
});

router.delete('/log/:id', (req, res) => {
  try {
    if (!managementLog.remove(Number(req.params.id))) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

module.exports = router;
