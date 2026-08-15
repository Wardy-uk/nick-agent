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

const TIMEOUT_MS = 15000;

/**
 * Auth is the NEURO bridge's shared secret, NOT a NOVA login.
 *
 * The service-account route needed a password that turned out not to exist
 * anywhere, and it signed the internal Jira comment "Escalated by sara" — a
 * robot reaching into an assignee's ticket. The bridge NOVA already exposes for
 * the Microsoft integration is hardcoded to Nick and nobody else, which makes
 * it both simpler AND more honest: attribution is a property of the route
 * rather than a lookup table, and manual escalation is Nick-only in v1 anyway.
 *
 * Reuses NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET, already configured on the Pi.
 */
function config() {
  return {
    url: (process.env.NOVA_BRIDGE_URL || '').replace(/\/api\/neuro-bridge\/?$/, '').replace(/\/$/, ''),
    secret: process.env.NOVA_BRIDGE_SECRET || '',
  };
}

/** Configured at all? Callers use this to degrade rather than throw. */
function isConfigured() {
  const c = config();
  return Boolean(c.url && c.secret);
}

async function call(path, { method = 'GET', body } = {}) {
  const c = config();
  if (!isConfigured()) throw new Error('NOVA bridge is not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)');

  const res = await fetch(`${c.url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-neuro-bridge-secret': c.secret,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `NOVA ${method} ${path} failed (${res.status})`);
  }
  return payload.data;
}

/** The urgency vocabulary, so the model picks a real code rather than inventing one. */
async function listUrgencyReasons() {
  return call('/api/neuro-bridge/escalation-reasons?kind=urgency');
}

/** Enough ticket detail to confirm it is the right ticket before escalating. */
async function getTicket(key) {
  return call(`/api/neuro-bridge/ticket/${encodeURIComponent(key)}`);
}

/**
 * Raise a manual escalation. NOVA does the actual work — internal-only comment,
 * tighten-only due date, raise-only priority — and returns what it changed.
 */
async function escalate({ ticketKey, reasonCode, neededBy, notes }) {
  return call('/api/neuro-bridge/escalate', {
    method: 'POST',
    body: {
      ticket_key: ticketKey,
      reason_code: reasonCode,
      needed_by: neededBy || undefined,
      notes: notes || undefined,
    },
  });
}

module.exports = { isConfigured, listUrgencyReasons, getTicket, escalate, call };
