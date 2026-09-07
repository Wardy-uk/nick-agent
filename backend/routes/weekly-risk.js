'use strict';

/**
 * Weekly Risk & Anomaly Summary + Management Actions Log — PIP competencies 2/3/4,
 * plus the deliverable tracker over both (`/deliverables`).
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
const pipDeliverables = require('../services/pip-deliverables');
const logSuggest = require('../services/management-log-suggest');
const db = require('../db/database');

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
 * GET /api/weekly-risk/baseline — the competency-4 baseline and where it came
 * from. Its own route because it is the one figure in this report that is a
 * DECISION rather than a measurement (the PIP leaves it literally blank), and
 * because until it is recorded the report must say so rather than count.
 */
router.get('/baseline', (req, res) => {
  try {
    res.json({
      baseline: managementLog.status().baseline,
      agreed: managementLog.getAgreedBaseline(),
    });
  } catch (err) { fail(res, err); }
});

/**
 * POST /api/weekly-risk/baseline — record the figure agreed with Chris.
 *
 * `{ count: null }` clears it back to unrecorded. ⚠ Omitting `count` is a 400
 * and is deliberately NOT the same as sending 0: nil overdue on 27 July is a
 * claim somebody made, and no figure is the PIP deliverable still outstanding.
 */
router.post('/baseline', (req, res) => {
  try {
    const body = req.body || {};
    if (!('count' in body)) {
      return res.status(400).json({ error: 'A baseline needs a count. Send `count: null` to clear it — omitting it is not the same as zero.' });
    }
    const agreed = body.count === null
      ? managementLog.setAgreedBaseline(null)
      : managementLog.setAgreedBaseline({ count: body.count, agreedOn: body.agreedOn, note: body.note });
    res.json({ ok: true, agreed, baseline: managementLog.status().baseline });
  } catch (err) { fail(res, err, 400); }
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
      alreadyQueued: Boolean(result.alreadyQueued),
      note: result.alreadyQueued
        ? 'Already queued for this week — refreshed the existing card rather than adding a second. Approve it in Actions.'
        : 'Queued for approval — nothing has been sent. Approve it in Actions.',
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

/**
 * GET /api/weekly-risk/send-status -- everything the panel needs to approve in
 * place: the queued card, what it would send, and whether the week is finished.
 *
 * The approval itself still goes through POST /api/actions/:id/approve, the
 * same executor and the same gate the Actions queue uses. This route exists so
 * the second gate can be SHOWN where the report is, not so a second way to send
 * can exist -- and it returns the presentation the Actions card is built from,
 * verbatim, so the two screens cannot describe the same send differently.
 */
router.get('/send-status', (req, res) => {
  try {
    const week = req.query.week || weeklyRisk.weekCommencing();
    const sent = weeklyRisk.sentSummary(weeklyRisk.sentRecord(week));
    const actionPresenter = require('../services/action-presenter');
    const pending = (db.getPendingSaraActionsByType
      ? db.getPendingSaraActionsByType('send_weekly_risk_report', 50)
      : []) || [];

    let queued = null;
    for (const action of pending) {
      const payload = typeof action.payload === 'string' ? JSON.parse(action.payload) : action.payload;
      if (!payload || payload.week !== week) continue;
      queued = {
        actionId: action.id,
        createdAt: action.created_at || null,
        // Built by the presenter, never re-derived here: the recipient, the
        // blockers and the full body have to read identically wherever the
        // approval happens.
        presentation: actionPresenter.describe({ ...action, payload }),
      };
      break;
    }

    res.json({
      week,
      queued,
      sent,
      locked: weeklyRisk.isLocked(week),
      published: weeklyRisk.publishedAt(week),
    });
  } catch (err) { fail(res, err); }
});

/**
 * POST /api/weekly-risk/reopen -- a sent week goes back to rebuilding live.
 *
 * Keeps the sent record: having sent it is a fact that does not become untrue.
 * What comes back is the ability to rebuild and to queue another send, and the
 * panel is expected to say the figures may no longer match what Chris received.
 */
router.post('/reopen', (req, res) => {
  try {
    const week = req.body?.week || weeklyRisk.weekCommencing();
    const result = weeklyRisk.reopen(week);
    if (!result.ok) return res.status(409).json({ error: 'That week has not been sent, so there is nothing to reopen' });
    res.json({ ok: true, week, sent: weeklyRisk.sentSummary(result.record), already: Boolean(result.already) });
  } catch (err) { fail(res, err); }
});

// ── Deliverables ─────────────────────────────────────────────────────────────

/**
 * GET /api/weekly-risk/deliverables — what Nick owes Chris and what exists.
 *
 * A tracker, deliberately not a burn-down: counts of what was produced, names
 * of what was not, and dates. No percentage and no grade — Chris assesses the
 * PIP, and a tool that scores it produces a number to argue with instead of a
 * list to act on. See the service header.
 *
 * Read-only, and every figure is LIFTED from weekly-risk's own stores and
 * `management-log.assess()` rather than recomputed, so this cannot disagree
 * with the two screens it summarises.
 */
router.get('/deliverables', (req, res) => {
  try {
    res.json(pipDeliverables.build());
  } catch (err) { fail(res, err); }
});

/**
 * POST /api/weekly-risk/mark-sent — record a send Nick made himself.
 *
 * ⚠ `markSent` had NO ROUTE. It was reachable only from the approve-in-Actions
 * executor, so a report emailed from Outlook — which is how the real ones have
 * gone — left no record anywhere, and the tracker could only ever say "no send
 * recorded" for ever. Same species as `capture-links.setScopes`, which shipped
 * reachable from the test suite and nothing else.
 *
 * It RECORDS, it does not send: nothing leaves NEURO here. That is what makes
 * it safe without the approval gate — the gate exists to stop mail reaching
 * Chris by accident, and this route cannot send mail at all.
 *
 * `sentAt` is accepted so a send from a previous day can be recorded honestly
 * rather than being stamped with the moment Nick got round to telling NEURO.
 */
router.post('/mark-sent', (req, res) => {
  try {
    const week = req.body?.week || weeklyRisk.weekCommencing();
    const existing = weeklyRisk.sentRecord(week);
    if (existing && !existing.reopenedAt) {
      return res.status(409).json({
        error: 'That week is already recorded as sent.',
        sent: weeklyRisk.sentSummary(existing),
      });
    }
    // ⚠ `recordExternalSend`, NOT `markSent`. The approval path's recording
    // belongs to the executor — a hook in a route is one the Actions queue
    // walks straight past — and `weekly-risk-send-routing.test.js` pins that.
    // This is the other case: no action, no approval, the mail has already gone.
    // The record is stamped `reportedByNick`, because NEURO observing its own
    // send and Nick reporting one are not the same evidence.
    const rec = weeklyRisk.recordExternalSend(week, {
      recipients: Array.isArray(req.body?.recipients) ? req.body.recipients : [],
      subject: req.body?.subject || null,
      sentAt: req.body?.sentAt || null,
    });
    // markSent swallows its own errors and returns null. Reporting that as a
    // success would leave the tracker still saying "no send recorded" one
    // refresh later, with nothing to explain why.
    if (!rec) return res.status(500).json({ error: 'Could not record the send.' });
    res.json({ ok: true, week, sent: weeklyRisk.sentSummary(rec) });
  } catch (err) { fail(res, err, 400); }
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

/**
 * Management conversations PLAUD recorded and the log has never been told about.
 *
 * ⚠ Its own path (`/log-suggestions`), deliberately NOT `/log/suggestions`.
 * There is no `GET /log/:id` today, so both would work — but this router
 * already carries `/log/:id` for PATCH and DELETE, and this repo has shipped a
 * literal path swallowed by a sibling parameterised one more than once. A
 * sibling path cannot be swallowed by a parameter that is not there.
 */
router.get('/log-suggestions', (req, res) => {
  try {
    const sinceDays = req.query.sinceDays ? Number(req.query.sinceDays) : undefined;
    res.json(logSuggest.suggest({ sinceDays: Number.isFinite(sinceDays) ? sinceDays : undefined }));
  } catch (err) { fail(res, err); }
});

/**
 * POST /api/weekly-risk/log-suggestions/accept — turn one into a real entry.
 *
 * ⚠ The route CREATES; the suggestion service never does. Everything written
 * comes from the body, so what Nick edited on the card is what lands, and a
 * suggestion he never looked at cannot become a compliance record by itself.
 *
 * ⚠ `loggedAt` is taken from the PLAUD note's own `created_at`, not from the
 * client and not from the clock. A note written by a device in the room at the
 * time IS the contemporaneous record — the same argument
 * `scripts/seed-management-log.js` makes — and `source` carries the recording
 * id so the claim is auditable rather than asserted. With no usable stamp it is
 * omitted, `create()` falls back to now, and the entry is correctly reported as
 * logged late; guessing would manufacture competency-3 compliance out of
 * nothing.
 */
router.post('/log-suggestions/accept', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.id) return res.status(400).json({ error: 'a suggestion id is required' });
    if (!String(body.summary || '').trim()) return res.status(400).json({ error: 'a summary is required' });

    // Re-read rather than trusting the client for the provenance fields. The
    // card may have been open a while, and the stamp is the one thing here that
    // must not be settable from outside.
    const found = logSuggest.suggest().suggestions.find(s => s.id === body.id);
    if (!found) {
      return res.status(409).json({ error: 'That suggestion is no longer offered — it may already be logged, or dismissed.' });
    }

    const row = managementLog.create({
      type: body.type || found.type,
      summary: String(body.summary).trim(),
      person: body.person ?? found.person,
      owner: body.owner || 'Nick',
      entryDate: body.entryDate || found.entryDate,
      dueDate: body.dueDate || null,
      action: body.action || null,
      notes: body.notes || null,
      source: found.id,
      loggedAt: found.recordedAt || undefined,
    });
    // It is accepted, so it must never be offered again even if the dedupe
    // against the log ever misses it.
    logSuggest.dismiss(found.id);
    res.status(201).json({ ok: true, row, contemporaneous: found.contemporaneous });
  } catch (err) { fail(res, err, 400); }
});

/** POST /log-suggestions/dismiss — not a management conversation. Sticks. */
router.post('/log-suggestions/dismiss', (req, res) => {
  try {
    if (!req.body?.id) return res.status(400).json({ error: 'a suggestion id is required' });
    res.json({ ok: true, dismissed: logSuggest.dismiss(req.body.id) });
  } catch (err) { fail(res, err, 400); }
});

/** POST /log-suggestions/restore — every other decision here has a way back. */
router.post('/log-suggestions/restore', (req, res) => {
  try {
    if (!req.body?.id) return res.status(400).json({ error: 'a suggestion id is required' });
    res.json({ ok: true, dismissed: logSuggest.undismiss(req.body.id) });
  } catch (err) { fail(res, err, 400); }
});

module.exports = router;
