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

function nickHasCommented(issue) {
  const comments = issue.fields?.comment?.comments || [];
  const nickEmail = (JIRA_EMAIL || '').toLowerCase();
  return comments.some(c => {
    const authorEmail = (c.author?.emailAddress || '').toLowerCase();
    const authorName = (c.author?.displayName || '').toLowerCase();
    return authorEmail.includes(nickEmail) || authorName.includes('nick ward');
  });
}

async function syncEscalations() {
  if (!isConfigured()) return { ok: false, reason: 'not configured' };

  try {
    const issues = await fetchEscalationTickets();

    let known = {};
    try {
      const raw = db.getState('escalation_seen');
      known = raw ? JSON.parse(raw) : {};
    } catch { known = {}; }

    let newUnseen = 0;
    const updated = { ...known };

    for (const issue of issues) {
      const key = issue.key;
      const hasComment = nickHasCommented(issue);

      // Detail fields are refreshed every sync — Focus/Briefing render these,
      // so a stale summary or priority would show Nick the wrong thing.
      const details = {
        summary: issue.fields?.summary || '',
        created: issue.fields?.created,
        status: issue.fields?.status?.name || null,
        priority: issue.fields?.priority?.name || null,
        assignee: issue.fields?.assignee?.displayName || null,
      };

      if (!updated[key]) {
        updated[key] = { seen: false, hasComment, ...details };
        if (!hasComment) {
          newUnseen++;
          console.log(`[Jira] New escalation without Nick comment: ${key}`);
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
        status: v.status || null,
        priority: v.priority || null,
        assignee: v.assignee || null,
        url: JIRA_BASE_URL ? `${JIRA_BASE_URL.replace(/\/$/, '')}/browse/${key}` : null,
      }))
      .sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));
  } catch { return []; }
}

// ── Polling (escalations only) ───────────────────────────────────────────────

function startPolling() {
  if (!isConfigured()) {
    console.log('[Jira] Not configured — polling disabled');
    return;
  }

  setTimeout(() => {
    syncEscalations().catch(err => console.error('[Jira] Initial sync error:', err.message));
  }, 5000);

  pollTimer = setInterval(() => {
    syncEscalations().catch(err => console.error('[Jira] Poll error:', err.message));
  }, POLL_INTERVAL_MS);

  console.log(`[Jira] Escalation polling started — every ${POLL_INTERVAL_MS / 1000}s`);
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
  syncEscalations,
  markEscalationsSeen,
  getUnseenEscalationCount,
  getUnseenEscalations,
  startPolling,
  stopPolling,
};
