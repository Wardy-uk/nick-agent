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

/**
 * Interactive default. Escalating a ticket happens while Nick is talking to
 * someone, and a call that takes longer than this has already failed him.
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

/**
 * `timeoutMs` overrides the interactive default for batch reads.
 *
 * The flow-signals endpoint runs its queries sequentially and under READ
 * UNCOMMITTED — deliberately, because firing them concurrently starved the
 * DTU-limited Azure SQL instance and half of them timed out server-side. That
 * makes it slower than 15s, so the weekly report's pull failed with "operation
 * aborted due to timeout" and the whole ticket-flow section rendered as absent.
 *
 * Honest, but useless. A report built once a week can afford to wait; the
 * default stays short for the interactive paths that cannot.
 */
async function call(path, { method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
  const c = config();
  if (!isConfigured()) throw new Error('NOVA bridge is not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)');

  const res = await fetch(`${c.url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-neuro-bridge-secret': c.secret,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    const err = new Error(payload?.error || `NOVA ${method} ${path} failed (${res.status})`);
    // The status is the difference between "retry this" and "stop asking". A 404 from
    // the 1-2-1 bridge means NOVA has no roster entry for that person — replaying it
    // every morning would never succeed and would bury the real failures in noise.
    err.status = res.status;
    throw err;
  }
  return payload.data;
}

/** The urgency vocabulary, so the model picks a real code rather than inventing one. */
async function listUrgencyReasons() {
  return call('/api/neuro-bridge/escalation-reasons?kind=urgency');
}

/**
 * Tickets NOVA's escalation log has an escalation for, newest per ticket.
 *
 * The log is NOVA's alone and there is no Jira field that mirrors it, so
 * without this an urgency escalation is invisible to every list NEURO can build.
 */
async function listEscalations({ days = 90, type } = {}) {
  const q = new URLSearchParams({ days: String(days) });
  if (type) q.set('type', type);
  return call(`/api/neuro-bridge/escalations?${q}`);
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

// ── 1-2-1 loop ──────────────────────────────────────────────────────────────
//
// NEURO books the 1-2-1; NOVA preps and runs it. NOVA's day-before prep job only fires
// for a session it holds as 'scheduled', and until this existed nothing created one —
// the prep email had never been sent, not once, in the two months the job had been live.

/** Tell NOVA a 1-2-1 is booked (or has moved). Idempotent at the far end. */
async function push121Booking({ agentName, date, outlookEventId }) {
  return call('/api/neuro-bridge/121/booking', {
    method: 'POST',
    body: { agentName, date, outlookEventId: outlookEventId || undefined },
  });
}

/** Tell NOVA the 1-2-1 has come out of the diary. */
async function cancel121({ agentName }) {
  return call('/api/neuro-bridge/121/cancel', { method: 'POST', body: { agentName } });
}

/** Push a person's cadence, in days. `null` = off the rota (`cadence: n/a`). */
async function push121Cadence({ agentName, cadenceDays }) {
  return call('/api/neuro-bridge/121/cadence', { method: 'POST', body: { agentName, cadenceDays } });
}

/** What NOVA believes is booked, plus its roster — the reconciliation and drift feed. */
async function get121State({ days = 60 } = {}) {
  return call(`/api/neuro-bridge/121/state?days=${encodeURIComponent(days)}`);
}

/**
 * 1-2-1s NOVA has finished running, with the actions agreed in them.
 *
 * A nightly batch rather than an interactive path, and it reads two tables on a
 * DTU-limited instance, so it gets a longer leash than the escalation default.
 */
async function get121Completed({ since }) {
  return call(`/api/neuro-bridge/121/completed?since=${encodeURIComponent(since)}`, { timeoutMs: 60000 });
}

/**
 * Offer NOVA a 1-2-1 transcript found in the vault. PROPOSES — NOVA holds it as a
 * candidate until a human approves it, because attribution is a guess.
 *
 * Long timeout: the transcript itself is the payload and a 45-minute 1-2-1 is a lot of
 * text to push over Tailscale.
 */
async function push121TranscriptCandidate({ plaudId, agentName, meetingDate, title, notePath, transcript, attribution }) {
  return call('/api/neuro-bridge/121/transcript-candidate', {
    method: 'POST',
    timeoutMs: 60000,
    body: { plaudId, agentName, meetingDate, title, notePath, transcript, attribution },
  });
}

/** Recordings NOVA has already resolved, so a rejected one is never re-offered. */
async function get121KnownRecordings() {
  return call('/api/neuro-bridge/121/known-recordings');
}

module.exports = {
  isConfigured, listUrgencyReasons, listEscalations, getTicket, escalate, call,
  push121Booking, cancel121, push121Cadence, get121State, get121Completed,
  push121TranscriptCandidate, get121KnownRecordings,
};
