'use strict';

/**
 * NOVA client — NEURO's hands inside the support platform.
 *
 * NOVA owns the Jira queue, the escalation log and the account context; NEURO
 * owns the conversation Nick is actually having. So "escalate NT-28061, the AM
 * says they're at renewal" has to cross the gap. It goes DIRECT (decided in the
 * BA, 15 Aug 2026) rather than via n8n — one less moving part between a spoken
 * sentence and a Jira write.
 *
 * Auth: NOVA has no machine-token path. It is JWT-only, and its middleware
 * re-reads the role from the users table on every request, so NEURO needs a real
 * NOVA account rather than a shared secret. We log in, cache the JWT, and
 * re-authenticate once on a 401 — tokens expire and the alternative is an
 * escalation failing at the moment Nick asks for it.
 *
 * IMPORTANT: the username on that NOVA account is what lands in the Jira comment
 * as "Escalated by ...", and the assignee reads it. Name the account for how it
 * should read to them, not for what it technically is.
 */

const db = require('../db/database');

const TIMEOUT_MS = 15000;

function config() {
  return {
    url: (process.env.NOVA_URL || db.getState('nova.url') || '').replace(/\/$/, ''),
    username: process.env.NOVA_USERNAME || db.getState('nova.username') || '',
    password: process.env.NOVA_PASSWORD || db.getState('nova.password') || '',
  };
}

/** Configured at all? Callers use this to degrade rather than throw. */
function isConfigured() {
  const c = config();
  return Boolean(c.url && c.username && c.password);
}

let cachedToken = null;

async function login() {
  const c = config();
  if (!isConfigured()) throw new Error('NOVA is not configured (NOVA_URL / NOVA_USERNAME / NOVA_PASSWORD)');

  const res = await fetch(`${c.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: c.username, password: c.password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.data?.token) {
    throw new Error(`NOVA login failed (${res.status}): ${body?.error || 'no token returned'}`);
  }
  cachedToken = body.data.token;
  return cachedToken;
}

/** Call NOVA, re-authenticating once if the cached token has expired. */
async function call(path, { method = 'GET', body } = {}) {
  const c = config();
  if (!cachedToken) await login();

  const send = async () => fetch(`${c.url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cachedToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  let res = await send();
  if (res.status === 401) {
    cachedToken = null;
    await login();
    res = await send();
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `NOVA ${method} ${path} failed (${res.status})`);
  }
  return payload.data;
}

/** The urgency vocabulary, so the model picks a real code rather than inventing one. */
async function listUrgencyReasons() {
  return call('/api/escalations/reasons?kind=urgency');
}

/**
 * Raise a manual escalation. NOVA does the actual work — internal-only comment,
 * tighten-only due date, raise-only priority — and returns what it changed.
 */
async function escalate({ ticketKey, reasonCode, neededBy, notes }) {
  return call('/api/escalations/manual', {
    method: 'POST',
    body: {
      ticket_key: ticketKey,
      reason_code: reasonCode,
      needed_by: neededBy || undefined,
      notes: notes || undefined,
    },
  });
}

module.exports = { isConfigured, listUrgencyReasons, escalate, call };
