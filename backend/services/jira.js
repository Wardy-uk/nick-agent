'use strict';

const https = require('https');
const db = require('../db/database');

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || '';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'NT';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
let pollTimer = null;

function isConfigured() {
  return !!(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN);
}

function jiraRequest(urlPath, options = {}) {
  const { method = 'GET', body = null, timeoutMs = 15000 } = options;

  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, JIRA_BASE_URL);
    const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

    const reqOptions = {
      method,
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      timeout: timeoutMs
    };

    if (body) reqOptions.headers['Content-Type'] = 'application/json';

    const req = https.request(url, reqOptions, (res) => {
      if (res.statusCode >= 400) {
        let responseBody = '';
        res.on('data', c => responseBody += c);
        res.on('end', () => reject(new Error(`Jira API ${res.statusCode}: ${responseBody.substring(0, 200)}`)));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON from Jira: ${e.message}`)); }
      });
    });

    req.on('error', (err) => reject(new Error(`Jira request failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Jira request timed out')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Escalation queue ─────────────────────────────────────────────────────────

/**
 * The request-type arm ALONE — customer-raised portal escalations, 6 of the 17
 * live ones. Nothing calls this any more and nothing should: it was what
 * `syncEscalations` and the briefing alerts used, and it is why both understated
 * escalations by two thirds (#94). Use `fetchActiveEscalations`, which ORs in
 * the tier population. Kept only because it is exported.
 */
async function fetchEscalationTickets() {
  const jql = `resolution = Unresolved AND "Request Type" in ("Escalation (NT)") AND status not in (CLOSED, Done, Resolved) ORDER BY created DESC`;

  const result = await jiraRequest('/rest/api/3/search/jql', {
    method: 'POST',
    body: {
      jql,
      fields: ['summary', 'status', 'priority', 'assignee', 'created', 'updated', 'comment'],
      maxResults: 50
    }
  });
  return result.issues || [];
}

/**
 * Every ticket that is escalated RIGHT NOW, which is two populations, not one:
 *
 *  - Request Type = "Escalation (NT)" — the customer raised it as an escalation
 *    through the portal. This is what `fetchEscalationTickets` already watches.
 *  - Current Tier = "Escalations" — the ticket was moved into the escalations
 *    tier internally. Nothing in NEURO looked at these, so a ticket escalated by
 *    the team was invisible here.
 *
 * They overlap but neither contains the other, so it is one OR'd query rather
 * than two calls — a ticket matching both should appear once, with both badges.
 *
 * `statusCategory != Done` rather than a list of status names: the queue has
 * more done-ish statuses than anyone remembers, and NOVA uses the category form
 * everywhere for exactly that reason.
 */
const TIER_FIELD = 'customfield_12981';        // Current Tier
const REQUEST_TYPE_FIELDS = ['customfield_10020', 'customfield_12800'];

const ESCALATION_FIELDS = ['summary', 'status', 'priority', 'assignee', 'created', 'updated',
  'duedate', TIER_FIELD, ...REQUEST_TYPE_FIELDS];

/**
 * Has Nick replied on this ticket?
 *
 * Jira caps the inline `comment` field at 20 per issue, and it returns the
 * NEWEST 20 (`startAt` is offset from the end — NT-14855 came back
 * `startAt: 32, total: 52`). That was worth checking rather than assuming,
 * because the oldest 20 would have made this answer "no" on exactly the long,
 * churning threads an escalation becomes, and over-nagged on all of them.
 * The newest window is also the right question: "has Nick engaged with this
 * lately" is what the nudge is for, not "did he ever type in it".
 */
function nickInComments(comments) {
  const nickEmail = (JIRA_EMAIL || '').toLowerCase();
  return (comments || []).some(c => {
    const authorEmail = (c.author?.emailAddress || '').toLowerCase();
    const authorName = (c.author?.displayName || '').toLowerCase();
    return (nickEmail && authorEmail.includes(nickEmail)) || authorName.includes('nick ward');
  });
}

function mapEscalationIssue(issue) {
  const f = issue.fields || {};
  // Two fields carry the request type on this instance and only one is
  // populated per ticket — take whichever answers rather than guessing.
  const requestType = REQUEST_TYPE_FIELDS
    .map(id => f[id]?.requestType?.name)
    .find(Boolean) || null;
  const tier = f[TIER_FIELD]?.value || null;
  const base = JIRA_BASE_URL ? JIRA_BASE_URL.replace(/\/$/, '') : null;
  return {
    key: issue.key,
    summary: f.summary || '',
    status: f.status?.name || null,
    priority: f.priority?.name || null,
    assignee: f.assignee?.displayName || null,
    created: f.created || null,
    updated: f.updated || null,
    duedate: f.duedate || null,
    tier,
    requestType,
    // Why this ticket is in the list. Without it a row is unexplained, and the
    // routes in mean different things: the customer shouting, us having moved
    // it, or someone having escalated it for urgency.
    viaRequestType: /escalation/i.test(requestType || ''),
    viaTier: tier === 'Escalations',
    viaUrgency: false,
    // null, not false, when `comment` was not requested — "we did not look" and
    // "he has not replied" are different answers, and only one of them should
    // ever put a ticket on the Focus card.
    nickCommented: f.comment ? nickInComments(f.comment.comments) : null,
    url: base ? `${base}/browse/${issue.key}` : null,
  };
}

const ESCALATION_PAGE_SIZE = 100;

async function searchEscalations(jql, { withComments = false } = {}) {
  // Comments roughly triple the payload, so only the caller that actually reads
  // them pays for it — the /active route and the by-key lookup do not.
  const fields = withComments ? [...ESCALATION_FIELDS, 'comment'] : ESCALATION_FIELDS;
  const result = await jiraRequest('/rest/api/3/search/jql', {
    method: 'POST',
    body: { jql, fields, maxResults: ESCALATION_PAGE_SIZE },
  });
  // `/search/jql` dropped `total`, so `isLast` is the only cap signal there is.
  // Say so out loud: a silently truncated escalation list is the same species of
  // bug as the 1,958-key JQL and the calendar $top=50, and this list drives a
  // count Nick reads as complete.
  if (result.isLast === false) {
    console.warn(`[Jira] Escalation search hit the ${ESCALATION_PAGE_SIZE}-issue page and there are MORE — `
      + `the list is truncated. JQL: ${jql}`);
  }
  return (result.issues || []).map(mapEscalationIssue);
}

async function fetchActiveEscalations(opts = {}) {
  return searchEscalations(
    `project = ${JIRA_PROJECT_KEY} AND statusCategory != Done AND `
    + `("Request Type" in ("Escalation (NT)") OR cf[12981] = "Escalations") `
    + `ORDER BY created ASC`,
    opts
  );
}

/**
 * The still-open subset of a list of keys, in the same shape.
 *
 * Urgency escalations are known only to NOVA's log, which records that an
 * escalation happened and has no idea whether the ticket has since been closed.
 * So NOVA supplies the keys and Jira answers which are still live — neither
 * source can answer it alone.
 */
async function fetchOpenIssuesByKey(keys) {
  const list = [...new Set((keys || []).filter(k => /^[A-Z][A-Z0-9]+-\d+$/.test(k)))];
  if (list.length === 0) return [];

  // Chunked, because `maxResults` is a cliff and not an error: one query for
  // 1,900 keys returns the first 100 by sort order and says nothing about the
  // rest, which is how today's escalations got cut while three-month-old ones
  // came back. A key query is exactly bounded, so ask in batches that fit.
  const CHUNK = 100;
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const batch = list.slice(i, i + CHUNK);
    out.push(...await searchEscalations(
      `key in (${batch.join(',')}) AND statusCategory != Done ORDER BY created ASC`
    ));
  }
  return out;
}

/**
 * #94 — this used to call `fetchEscalationTickets()`, the request-type arm
 * alone: only the escalations a customer raised through the portal. Every
 * ticket the team moved into the Escalations TIER was invisible to the count,
 * the Focus card, the briefing and the nudge — i.e. to every surface Nick
 * actually checks. Measured live on 16 Aug: narrow 6, both arms 17.
 *
 * The naive swap is wrong in two ways that both fail silently:
 *  - `fetchActiveEscalations` returns objects already flattened by
 *    `mapEscalationIssue`, so reading `issue.fields.summary` off them blanks
 *    every summary and created date;
 *  - `comment` is not in `ESCALATION_FIELDS`, so "has Nick replied" would come
 *    back false for all 17 and the whole queue would land unseen.
 * Hence `withComments: true` and the flattened reads below.
 */
async function syncEscalations() {
  if (!isConfigured()) return { ok: false, reason: 'not configured' };

  try {
    const issues = await fetchActiveEscalations({ withComments: true });

    let known = {};
    try {
      const raw = db.getState('escalation_seen');
      known = raw ? JSON.parse(raw) : {};
    } catch { known = {}; }

    // The first sync after the widening backfills eleven tickets NEURO has
    // never seen, the oldest 136 days old. They did not ARRIVE — NEURO simply
    // started looking — so this run does not stamp them as interruptions
    // against a running focus session (#89), whose one number is "what pulled
    // you away, and when".
    //
    // Note what is deliberately NOT seeded: their unseen state. Of the 17, Nick
    // has already replied to 12, and those never reach the card anyway — the
    // filter is `!hasComment && !seen`. The five left are ones he has never
    // answered, aged 6 to 65 days, and they are the entire finding. Marking
    // them `seen` to keep the first day quiet would make this fix a no-op on
    // the one surface it exists to correct. They surface as ONE banner, not
    // five, because `buildEscalationMessage` counts and names the oldest.
    const backfilling = !db.getState('escalation_wide_seeded');

    let newUnseen = 0;
    const updated = { ...known };

    for (const issue of issues) {
      const key = issue.key;
      // `nickCommented` is null when Jira wasn't asked for comments. Treat that
      // as "commented" — an unknown must never be the thing that raises a nudge.
      if (issue.nickCommented === null) {
        console.warn(`[Jira] ${key}: comments not returned, assuming replied rather than nagging`);
      }
      const hasComment = issue.nickCommented !== false;

      // Detail fields are refreshed every sync — Focus/Briefing render these,
      // so a stale summary or priority would show Nick the wrong thing.
      const details = {
        summary: issue.summary || '',
        created: issue.created,
        status: issue.status,
        priority: issue.priority,
        assignee: issue.assignee,
      };

      if (!updated[key]) {
        updated[key] = { seen: false, hasComment, ...details };
        if (!hasComment) {
          newUnseen++;
          console.log(`[Jira] ${backfilling ? 'Backfilled' : 'New'} escalation without Nick comment: ${key}`);
          // Stamp the arrival against whatever Nick is mid-way through (#89).
          // It does NOT pause — an escalation landing is not proof he switched
          // to it, and guessing would corrupt the one number the return prompt
          // rests on. It only means the prompt can later say what interrupted.
          if (!backfilling) {
            try {
              require('./focus-session').noteInterruption({
                source: 'escalation',
                detail: `${key} arrived`,
              });
            } catch { /* no session running, which is the usual case */ }
          }
        }
      } else {
        Object.assign(updated[key], details, { hasComment });
      }
    }

    const activeKeys = new Set(issues.map(i => i.key));
    for (const key of Object.keys(updated)) {
      if (!activeKeys.has(key)) delete updated[key];
    }

    db.setState('escalation_seen', JSON.stringify(updated));
    db.setState('escalation_last_sync', new Date().toISOString());
    db.setState('escalation_count', String(issues.length));
    if (backfilling) {
      console.log(`[Jira] Escalation query widened to both arms — ${issues.length} active, `
        + `${newUnseen} with no reply from Nick. Backfill run, no interruptions stamped.`);
      db.setState('escalation_wide_seeded', new Date().toISOString());
    }

    // Always sync — this raises, refreshes AND clears the banner, so an escalation
    // Nick has since replied to stops nagging without waiting for the nag cycle.
    try {
      require('./nudges').triggerEscalationNudge();
    } catch (e) {
      console.warn('[Jira] Failed to sync escalation nudge:', e.message);
    }

    return { ok: true, total: issues.length, newUnseen };
  } catch (err) {
    console.error('[Jira] Escalation sync failed:', err.message);
    return { ok: false, error: err.message };
  }
}

function markEscalationsSeen() {
  try {
    const raw = db.getState('escalation_seen');
    const known = raw ? JSON.parse(raw) : {};
    for (const key of Object.keys(known)) {
      known[key].seen = true;
    }
    db.setState('escalation_seen', JSON.stringify(known));
  } catch {}
  // Nothing unseen left — drop the banner rather than waiting for the nag cycle
  try { require('./nudges').triggerEscalationNudge(); } catch {}
}

function getUnseenEscalationCount() {
  try {
    const raw = db.getState('escalation_seen');
    const known = raw ? JSON.parse(raw) : {};
    return Object.values(known).filter(v => !v.hasComment && !v.seen).length;
  } catch { return 0; }
}

// Nick's own name and an unset priority are the DEFAULTS on this queue, not
// facts about a ticket. Measured over all 41 escalations Jira has ever held:
// priority is "Unset" on 33 of them (the other 8 include a Critical, so the
// field is worth keeping when it is actually set), and 23 are assigned to Nick
// on Nick's own board. "Open" is likewise the baseline for an unresolved
// escalation. Rendering any of those is a badge on every row, which sorts and
// tells nothing — so they are nulled HERE rather than filtered in each panel,
// or Focus and Briefing get to disagree about what is worth showing.
//
// What survives is the discriminating half: Reopened / Waiting on Development,
// a real priority, and an assignee who is someone other than Nick — including
// nobody, which on an escalation is the loudest of the three.
const ESCALATION_OWNER = 'Nick Ward';

function _informativeStatus(status) {
  if (!status || status === 'Open') return null;
  return status;
}

function _informativePriority(priority) {
  if (!priority || priority === 'Unset' || priority === 'None') return null;
  return priority;
}

function _informativeAssignee(assignee) {
  if (!assignee) return 'Unassigned';
  return assignee === ESCALATION_OWNER ? null : assignee;
}

/**
 * The unseen escalations themselves, oldest first — a count on its own doesn't
 * tell Nick what to act on, so Focus/Briefing render these.
 */
function getUnseenEscalations() {
  try {
    const raw = db.getState('escalation_seen');
    const known = raw ? JSON.parse(raw) : {};
    return Object.entries(known)
      .filter(([, v]) => !v.hasComment && !v.seen)
      .map(([key, v]) => ({
        key,
        summary: v.summary || '',
        created: v.created || null,
        status: _informativeStatus(v.status),
        priority: _informativePriority(v.priority),
        assignee: _informativeAssignee(v.assignee),
        url: JIRA_BASE_URL ? `${JIRA_BASE_URL.replace(/\/$/, '')}/browse/${key}` : null,
      }))
      .sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));
  } catch { return []; }
}

/**
 * #105 — stamp a list of escalations with whether Nick has actually replied.
 *
 * `escalation_seen` already tracks this per ticket; it is what drives the Focus
 * card's unseen count. The Escalations tab ignored it, so a ticket answered an
 * hour ago looked identical to one nobody had touched in a week — which is the
 * single piece of state that turns a list into a work queue.
 *
 * Only possible across the whole list since #94: before that `escalation_seen`
 * held the six request-type escalations, so eleven of the seventeen rows had no
 * state to read at all.
 *
 * Three values, not two. `unknown` is real and must not read as "needs you":
 * a ticket the sync has not covered yet (NOVA's urgency arm can contribute keys
 * Jira's two arms do not) has never had its comments looked at, and guessing
 * would put a ticket on a work queue on no evidence. Same rule as
 * `nickCommented` being null rather than false.
 */
function decorateWithReplyState(escalations) {
  let known = {};
  try {
    const raw = db.getState('escalation_seen');
    known = raw ? JSON.parse(raw) : {};
  } catch { known = {}; }

  return (escalations || []).map(e => {
    const row = known[e.key];
    if (!row) return { ...e, replyState: 'unknown', needsReply: false };
    return {
      ...e,
      replyState: row.hasComment ? 'replied' : 'awaiting-you',
      needsReply: !row.hasComment,
      acknowledged: !!row.seen,
    };
  });
}

// ── Queue sync (OFF by default) ──────────────────────────────────────────────

/**
 * Refill `jira_tickets_cache`, the table eight callers read and nothing has
 * written since 3 July 2026.
 *
 * ⚠ DEFAULT OFF, deliberately. Commit 48e6481 deleted the whole queue feature
 * with the reason "too much noise", and that was a product decision, not a bug.
 * What WAS a bug is that three later commits reintroduced readers of the cache
 * it left behind, so NEURO spent seven weeks quoting a frozen snapshot of twelve
 * tickets in standups, EOD notes, chat and the briefing. That half is fixed
 * regardless of this flag — every consumer now gates on `getQueueSummary().fresh`
 * and says nothing rather than something false.
 *
 * This exists so the choice is one env var rather than a rebuild: turn it on and
 * the queue context comes back, leave it off and the readers stay silent.
 *
 * Note the endpoint. The legacy `/rest/api/3/search` this feature originally used
 * now answers 410 Gone — Atlassian removed it — so a straight revert of 48e6481
 * would not have worked. `/rest/api/3/search/jql` is what the escalation path
 * already uses and is verified working.
 */
const QUEUE_SYNC_ENABLED = process.env.JIRA_QUEUE_SYNC_ENABLED === 'true';
const QUEUE_PAGE_SIZE = 100;
const QUEUE_FIELDS = ['summary', 'status', 'priority', 'assignee'];

async function syncQueue() {
  if (!isConfigured()) return { ok: false, reason: 'not configured' };
  if (!QUEUE_SYNC_ENABLED) return { ok: false, reason: 'disabled' };

  const jql = `project = ${JIRA_PROJECT_KEY} AND resolution = Unresolved `
    + `AND status not in (CLOSED, Done, Resolved) ORDER BY created DESC`;

  try {
    const result = await jiraRequest('/rest/api/3/search/jql', {
      method: 'POST',
      body: { jql, fields: QUEUE_FIELDS, maxResults: QUEUE_PAGE_SIZE },
    });

    const issues = result?.issues || [];

    // A structurally valid response carrying no issues is treated as a FAILURE
    // and does not wipe a good cache — the bank-holidays rule. An empty queue
    // and a query that quietly stopped matching look identical otherwise, and
    // this cache's whole failure mode has been looking plausible while wrong.
    if (!issues.length) {
      console.warn('[Jira] Queue sync returned 0 issues — keeping the previous cache rather than emptying it');
      return { ok: false, reason: 'empty result', kept: true };
    }

    // `/search/jql` dropped `total`, so `isLast` is the only cap signal. Same
    // species as the calendar $top=50 and the 1,958-key JQL: a silent cap here
    // would understate the queue for ever, so it is said out loud.
    if (result?.isLast === false) {
      console.warn(`[Jira] Queue sync capped at ${QUEUE_PAGE_SIZE} — the queue is larger than the cache`);
    }

    db.clearStaleTickets();
    for (const issue of issues) {
      const f = issue.fields || {};
      db.upsertTicket({
        ticket_key: issue.key,
        summary: f.summary || null,
        status: f.status?.name || null,
        priority: f.priority?.name || null,
        assignee: f.assignee?.displayName || null,
        // SLA data lived in the deleted flagged-ticket path and is not fetched
        // here. NULL, never 0 — an unknown SLA must not read as "no time left",
        // and `at_risk` stays false rather than being guessed from a priority.
        sla_remaining_minutes: null,
        sla_name: null,
        at_risk: false,
        raw_json: null,
      });
    }

    console.log(`[Jira] Queue synced — ${issues.length} tickets`);
    return { ok: true, count: issues.length, capped: result?.isLast === false };
  } catch (e) {
    // Loud, and the cache is left alone. A failed refresh must not look like an
    // empty queue.
    console.error('[Jira] Queue sync failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ── Polling ──────────────────────────────────────────────────────────────────

function startPolling() {
  if (!isConfigured()) {
    console.log('[Jira] Not configured — polling disabled');
    return;
  }

  const tick = () => {
    syncEscalations().catch(err => console.error('[Jira] Poll error:', err.message));
    if (QUEUE_SYNC_ENABLED) {
      syncQueue().catch(err => console.error('[Jira] Queue poll error:', err.message));
    }
  };

  setTimeout(tick, 5000);
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);

  console.log(`[Jira] Polling started — every ${POLL_INTERVAL_MS / 1000}s`
    + ` (escalations${QUEUE_SYNC_ENABLED ? ' + queue' : '; queue sync off'})`);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[Jira] Polling stopped');
  }
}

module.exports = {
  isConfigured,
  fetchEscalationTickets,
  fetchActiveEscalations,
  fetchOpenIssuesByKey,
  syncEscalations,
  syncQueue,
  markEscalationsSeen,
  getUnseenEscalationCount,
  getUnseenEscalations,
  decorateWithReplyState,
  // pure, exported for the tests — what counts as informative is the decision
  _mapEscalationIssue: mapEscalationIssue,
  _nickInComments: nickInComments,
  _informativeStatus,
  _informativePriority,
  _informativeAssignee,
  startPolling,
  stopPolling,
};
