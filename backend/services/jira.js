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

      if (!updated[key]) {
        updated[key] = {
          seen: false,
          hasComment,
          summary: issue.fields?.summary || '',
          created: issue.fields?.created
        };
        if (!hasComment) {
          newUnseen++;
          console.log(`[Jira] New escalation without Nick comment: ${key}`);
        }
      } else {
        updated[key].hasComment = hasComment;
      }
    }

    const activeKeys = new Set(issues.map(i => i.key));
    for (const key of Object.keys(updated)) {
      if (!activeKeys.has(key)) delete updated[key];
    }

    db.setState('escalation_seen', JSON.stringify(updated));
    db.setState('escalation_last_sync', new Date().toISOString());
    db.setState('escalation_count', String(issues.length));

    if (newUnseen > 0) {
      try {
        const nudges = require('./nudges');
        const unseenList = Object.entries(updated)
          .filter(([, v]) => !v.hasComment && !v.seen)
          .slice(0, 3)
          .map(([k, v]) => `${k}: ${v.summary}`)
          .join('; ');
        const msg = `${newUnseen} new escalation${newUnseen > 1 ? 's' : ''} need${newUnseen === 1 ? 's' : ''} your attention: ${unseenList}`;
        nudges.broadcast({ type: 'nudge', nudge_type: 'escalation', message: msg, nag_count: 0 });
        const webpush = require('./webpush');
        webpush.sendToAll('NEURO — New Escalation', msg, { type: 'escalation', url: '/queue' }).catch(() => {});
        console.log(`[Jira] Escalation nudge sent: ${newUnseen} new`);
      } catch (e) {
        console.warn('[Jira] Failed to send escalation nudge:', e.message);
      }
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
}

function getUnseenEscalationCount() {
  try {
    const raw = db.getState('escalation_seen');
    const known = raw ? JSON.parse(raw) : {};
    return Object.values(known).filter(v => !v.hasComment && !v.seen).length;
  } catch { return 0; }
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
  startPolling,
  stopPolling,
};
