'use strict';

/**
 * Escalations — the desk surface for "this ticket needs to jump the queue".
 *
 * Nick gets asked for escalations verbally and in Teams, usually with a ticket
 * number and a reason that never makes it anywhere durable. This is the form:
 * type the key, see what the ticket actually is, say why, done.
 *
 * NOVA owns every rule (internal-only comment, tighten-only due date,
 * raise-only priority) and every write. This route is a thin, honest pipe —
 * it deliberately re-implements none of that logic, because two copies of a
 * safety rule is one copy too many.
 *
 * Unlike the chat tool, submitting here is NOT queued for approval. The chat
 * tool queues because SARA is acting on an inferred intention; here Nick has
 * typed the ticket key, read the detail back and pressed the button. A second
 * approval step for a form he just filled in is friction, not safety — so the
 * UI confirms what will change before it posts, and that confirmation IS the gate.
 */

const express = require('express');
const router = express.Router();
const nova = require('../services/nova-client');
const jira = require('../services/jira');

/**
 * How far back the urgency arm asks NOVA's log — #104.
 *
 * This was 90 days, and a 90-day window is a SILENT cap: an urgency escalation
 * older than that on a still-open ticket simply stopped being badged, and
 * "still open 91 days after being escalated" is precisely the ticket Nick would
 * most want to see. That is the fifth instance of this species here (calendar
 * `$top=50`, the 1,958-key JQL, Planner `$top=200`, the escalation `isLast`).
 *
 * Measured before changing it: over the log's ENTIRE life it holds exactly TWO
 * manual escalations, both raised on 15 Aug 2026, so the incidence of the bug
 * today is zero — widening 90 → 3650 days moves 1,935 rows to 2,352 and finds
 * the same 2. So this is not a fix for a live symptom; it retires the cap
 * before the population is old enough to hit it, which costs ~400 extra rows on
 * a route that is not hot.
 *
 * Ten years is "the whole log" rather than a tuned number — a window nobody can
 * age out of is the only kind that never needs revisiting. And the response
 * NAMES it either way, because a number that cannot state its own edge is the
 * actual defect: honest beats wide.
 */
const URGENCY_WINDOW_DAYS = 3650;

function requireNova(req, res, next) {
  if (!nova.isConfigured()) {
    return res.status(503).json({
      error: 'NOVA is not configured — set NOVA_BRIDGE_URL and NOVA_BRIDGE_SECRET',
    });
  }
  next();
}

/** ADF or plain string → readable text. Jira descriptions arrive as a doc tree. */
function adfText(node, depth = 0) {
  if (!node || depth > 12) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(n => adfText(n, depth + 1)).join('');
  if (node.type === 'text') return node.text || '';
  const inner = adfText(node.content, depth + 1);
  // Block-level nodes need a break after them or the whole thing runs together.
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}

/**
 * GET /api/escalation/active — what is escalated right now.
 *
 * Three populations, two systems. Jira answers the first two (Request Type =
 * Escalation, and Current Tier = Escalations) directly, because those are
 * facts on the ticket. The third — an urgency escalation raised here or in
 * NOVA — changes priority and the due date but deliberately leaves the tier
 * alone, so it writes NOTHING to Jira identifying the ticket as escalated:
 * NOVA's escalation_log is the only record it happened. That is why NT-28062
 * and NT-28075 were escalated and still invisible to a Jira-only query.
 *
 * NOVA supplies the keys, Jira says which are still open — neither source can
 * answer it alone.
 *
 * Deliberately NOT behind `requireNova`: the two Jira arms are the bulk of the
 * list and must still render on a day the bridge is down. When it is down the
 * response carries a `warning` rather than quietly returning a short list,
 * because a list that silently omits a population is worse than no list.
 */
router.get('/active', async (req, res) => {
  if (!jira.isConfigured()) {
    return res.status(503).json({ error: 'Jira is not configured' });
  }

  let escalations;
  try {
    escalations = await jira.fetchActiveEscalations();
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Jira: ${e.message}` });
  }

  let warning = null;
  // What the urgency arm actually did, so the caller never has to assume. All
  // three states are distinct: `off` (not configured), `error` (NOVA refused) and
  // `ok` — and only `ok` means the count below is the whole population.
  const urgency = {
    state: 'off',
    windowDays: URGENCY_WINDOW_DAYS,
    logRows: null,
    manual: null,
  };
  if (nova.isConfigured()) {
    try {
      // Manual only, and that is a semantic choice rather than a filter for
      // speed. The other types already show up in the Jira arms or are not
      // escalations in this sense: `jira_transition` IS a tier move, so the
      // tier arm has it; `ai_agent` is the AI raising one. Only a manual
      // urgency escalation leaves no trace in Jira, which is the entire reason
      // this arm exists — and badging 1,300 old tier moves "urgency" would be
      // untrue as well as unreadable.
      // Filtered again here rather than trusting the query param: an older NOVA
      // ignores `type` and answers with all ~1,950 rows, and this route should
      // be correct against whichever version is deployed rather than only the
      // one it shipped alongside.
      const raw = await nova.listEscalations({ days: URGENCY_WINDOW_DAYS, type: 'manual' }) || [];
      const logged = raw.filter(e => e.escalation_type === 'manual');
      urgency.state = 'ok';
      urgency.logRows = raw.length;
      urgency.manual = logged.length;
      const byKey = new Map(escalations.map(t => [t.key, t]));

      // Anything the log knows about that the tier/request-type arms missed
      // still has to be checked against Jira — the log has no idea whether the
      // ticket has since been closed.
      const unknown = logged.map(e => e.ticket_key).filter(k => !byKey.has(k));
      for (const t of await jira.fetchOpenIssuesByKey(unknown)) {
        byKey.set(t.key, t);
        escalations.push(t);
      }

      for (const e of logged) {
        const t = byKey.get(e.ticket_key);
        if (!t) continue;   // closed since, or not in this project
        t.viaUrgency = true;
        t.urgencyReason = e.reason_label || e.reason_code || null;
        t.escalatedBy = e.escalated_by || null;
        t.escalatedAt = e.created_at || null;
      }
    } catch (e) {
      urgency.state = 'error';
      warning = `Urgency escalations are missing from this list — NOVA said: ${e.message}`;
    }
  } else {
    warning = 'Urgency escalations are missing from this list — NOVA is not configured.';
  }

  escalations.sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));

  // #105 — which of these are actually waiting on Nick. Decided in the service so
  // this tab and the Focus card cannot disagree about what "needs a reply" means.
  const decorated = jira.decorateWithReplyState(escalations);
  const awaitingReply = decorated.filter(e => e.needsReply).length;

  res.json({
    escalations: decorated,
    awaitingReply,
    total: decorated.length,
    // #104 — the list states the window it used. A count that cannot describe
    // its own edge is indistinguishable from a complete one, which is how a cap
    // stays invisible until the day it starts cutting.
    urgency,
    warning,
  });
});

// GET /api/escalation/reasons — the urgency vocabulary, for the picker.
router.get('/reasons', requireNova, async (req, res) => {
  try {
    res.json({ reasons: await nova.listUrgencyReasons() });
  } catch (e) {
    res.status(502).json({ error: `Could not reach NOVA: ${e.message}` });
  }
});

// GET /api/escalation/ticket/:key — enough detail to know it is the right ticket.
router.get('/ticket/:key', requireNova, async (req, res) => {
  const key = String(req.params.key || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
    return res.status(400).json({ error: `"${key}" is not a ticket key (expected e.g. NT-28061)` });
  }
  try {
    const t = await nova.getTicket(key);
    // NOVA returns every navigable field; the form needs a handful.
    res.json({
      ticket: {
        key: t.key,
        summary: t.summary || null,
        status: t.status?.name || null,
        statusCategory: t.status?.statusCategory?.key || null,
        priority: t.priority?.name || null,
        duedate: t.duedate || null,
        tier: t.customfield_12981?.value || null,
        assignee: t.assignee?.displayName || null,
        reporter: t.reporter?.displayName || null,
        created: t.created || null,
        updated: t.updated || null,
        description: adfText(t.description).trim().slice(0, 2000) || null,
        // Newest first, and flagged so an internal note isn't mistaken for
        // something the customer has already been told.
        comments: (t.comments || []).slice(-5).reverse().map(c => ({
          // The bridge flattens author to a string; Jira's own shape is an object.
          // Handle both, or every comment reads "Unknown".
          author: (typeof c.author === 'string' ? c.author : c.author?.displayName) || 'Unknown',
          created: c.created,
          internal: c.jsdPublic === false,
          text: adfText(c.body).trim().slice(0, 600),
        })),
      },
    });
  } catch (e) {
    const notFound = /not found|404/i.test(e.message);
    res.status(notFound ? 404 : 502).json({ error: notFound ? `${key} not found` : `Could not reach NOVA: ${e.message}` });
  }
});

// POST /api/escalation — do it. NOVA applies the rules and reports what changed.
router.post('/', requireNova, async (req, res) => {
  const { ticket_key, reason_code, needed_by, notes } = req.body || {};
  if (!ticket_key) return res.status(400).json({ error: 'ticket_key is required' });
  if (!reason_code) return res.status(400).json({ error: 'reason_code is required' });
  if (needed_by && !/^\d{4}-\d{2}-\d{2}$/.test(needed_by)) {
    return res.status(400).json({ error: 'needed_by must be YYYY-MM-DD' });
  }
  try {
    const result = await nova.escalate({
      ticketKey: String(ticket_key).trim().toUpperCase(),
      reasonCode: reason_code,
      neededBy: needed_by || null,
      notes: notes || null,
    });
    res.json({ result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
