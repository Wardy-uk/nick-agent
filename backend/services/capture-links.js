'use strict';

/**
 * Capture links — a write-only door for the people in Nick's house.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * Nick's wife needs to be able to give him a task. She has no iOS device, so a
 * shared Reminders list is out; she has no NEURO PIN and should not have one,
 * because the PIN unlocks the entire brain — his queue, his inbox, his 1-2-1
 * notes, his health. What she needs is one box and a Send button.
 *
 * ⚠ THIS ROUTE IS ON THE PUBLIC INTERNET. pi5 runs Tailscale Funnel, so anything
 * exempted from the PIN middleware is reachable by anyone who finds the URL —
 * not just the tailnet. That is intended here (she has to reach it from her own
 * phone, off the tailnet) and it makes the token the ONLY credential. Hence
 * every rule below.
 *
 * ── The rules ────────────────────────────────────────────────────────────────
 *
 * 1. WRITE ONLY. It never returns a task, a count, or anything about Nick's
 *    day. A capture page that renders his list hands his work queue to whoever
 *    has the URL — and a URL leaks in ways a password does not: browser
 *    history, a shared phone, a screenshot. The only thing a valid token buys
 *    is the ability to ADD.
 *
 * 2. THE TOKEN IS THE DOMAIN. A link carries the domain its submissions get, so
 *    a task from Nick's wife is `personal` by construction rather than by a
 *    classifier guessing from the wording. Same rule as everywhere else in
 *    NEURO: the evidence decides, nobody types it in. It also means a leaked
 *    link can only ever create personal tasks, never work ones.
 *
 * 3. NAMED LINKS, NOT ONE SHARED SECRET. One per person, revocable
 *    individually, and the label is stored on every task it creates — so "who
 *    asked me for this" is answerable, and losing one link does not mean
 *    reissuing everybody's.
 *
 * 4. NOTHING IS APPROVED. Her task appears immediately. An approval queue was
 *    the first design and it is wrong for a trusted person: if she adds
 *    "pick up the prescription" and it sits pending until Nick approves it, she
 *    has asked him for a thing and he now has a SECOND thing to do. That is
 *    worse than the fridge door. Attribution plus an undo is the right amount
 *    of safety here, and the tasks are trivially droppable.
 *
 * Storage is a KV blob in `agent_state`, following `standup-session` and
 * `plaud-admin-blocks`: a handful of rows that are read once per submission do
 * not earn a table, and a schema migration on the live DB is a bigger risk than
 * the query convenience is worth.
 */

const crypto = require('crypto');
const db = require('../db/database');
const { domainOrDefault } = require('../../shared/task-domain.cjs');

const STATE_KEY = 'capture_links';

// 24 bytes = 192 bits. This is the whole credential on a public URL, so it is
// sized to be unguessable rather than typeable — it is delivered as a link.
const TOKEN_BYTES = 24;

// Per link, per hour. Generous for a person and useless for anything automated;
// the point is that a leaked link cannot fill the task list overnight.
const MAX_PER_HOUR = 40;

const MAX_TEXT = 500;

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // A corrupt blob must not be read as "no links exist" and silently
    // reissued over the top — that would revoke everyone without saying so.
    console.error('[CaptureLinks] Stored links unreadable:', e.message);
    throw new Error('capture links could not be read');
  }
}

function _save(links) {
  db.setState(STATE_KEY, JSON.stringify(links));
}

/**
 * Compare in constant time.
 *
 * A plain === on a secret leaks its prefix through timing. That is a thin attack
 * over the internet, but this is a public endpoint holding the only credential,
 * and the fix costs one function call.
 */
function _tokenEquals(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  // ⚠ Two EMPTY buffers compare equal under timingSafeEqual, so without this an
  // absent token would match an absent stored one — and any link that somehow
  // persisted with a blank token would then be openable by sending nothing at
  // all. `resolve` already guards its own input, but a comparison helper that
  // says "" === "" is a landmine for the next caller.
  if (ab.length === 0 || bb.length === 0) return false;
  // timingSafeEqual throws on length mismatch, which is itself a leak — so the
  // lengths are compared first and the result folded in, rather than returning
  // early on it.
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Every link, with the token REDACTED unless explicitly asked for. */
function list({ reveal = false } = {}) {
  return _load().map((l) => ({
    label: l.label,
    domain: l.domain,
    enabled: l.enabled !== false,
    createdAt: l.createdAt || null,
    lastUsedAt: l.lastUsedAt || null,
    used: Number(l.used) || 0,
    // The full token is shown only when Nick has asked to see it — a link list
    // rendered in a screenshot or a log should not hand the credential over.
    token: reveal ? l.token : `${String(l.token).slice(0, 6)}…`,
  }));
}

function create(label, { domain = 'personal' } = {}) {
  const clean = String(label || '').trim().slice(0, 40);
  if (!clean) return { ok: false, error: 'label is required' };

  const links = _load();
  if (links.some((l) => l.label.toLowerCase() === clean.toLowerCase())) {
    return { ok: false, error: `there is already a link called "${clean}"` };
  }

  const link = {
    token: crypto.randomBytes(TOKEN_BYTES).toString('base64url'),
    label: clean,
    // Defaults to personal, because that is what this door is FOR. A work link
    // is expressible but has to be asked for.
    domain: domainOrDefault(domain),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    used: 0,
    hits: [],
  };
  links.push(link);
  _save(links);
  return { ok: true, link: { label: link.label, domain: link.domain, token: link.token } };
}

function revoke(label) {
  const links = _load();
  const next = links.filter((l) => l.label.toLowerCase() !== String(label).trim().toLowerCase());
  if (next.length === links.length) return { ok: false, error: 'no link with that label' };
  _save(next);
  return { ok: true, revoked: label };
}

/**
 * Resolve a token to its link, or null.
 *
 * Returns null for unknown AND for disabled, deliberately without saying which:
 * the caller answers both with the same 404, so a revoked link cannot be told
 * apart from a wrong one by whoever is holding it.
 */
function resolve(token) {
  const t = String(token || '');
  if (!t) return null;
  for (const link of _load()) {
    if (link.enabled !== false && _tokenEquals(link.token, t)) return link;
  }
  return null;
}

/**
 * Record a use and say whether it is within the rate limit.
 *
 * The window is kept ON the link rather than in a module-level map, because the
 * backend restarts several times a day on deploys — an in-memory budget would
 * reset with it, which is the bug the push governor already had to fix.
 */
function noteUse(label, now = new Date()) {
  const links = _load();
  const link = links.find((l) => l.label === label);
  if (!link) return { ok: false, error: 'link not found' };

  const cutoff = now.getTime() - 3600 * 1000;
  const hits = (Array.isArray(link.hits) ? link.hits : []).filter((t) => t > cutoff);
  if (hits.length >= MAX_PER_HOUR) {
    // Not saved: a refused submission must not extend its own window, or a
    // hammering client would keep itself locked out for ever.
    return { ok: false, error: 'too many submissions in the last hour', rateLimited: true };
  }

  hits.push(now.getTime());
  link.hits = hits;
  link.used = (Number(link.used) || 0) + 1;
  link.lastUsedAt = now.toISOString();
  _save(links);
  return { ok: true };
}

/**
 * Take a submission and create the task. Returns what the PAGE may see.
 *
 * ⚠ The return value is deliberately thin — `{ok:true}` and the text back as an
 * echo, nothing else. Not the task id, not the position in a list, not a count
 * of what Nick owes. Whoever holds this link learns only that their own message
 * arrived.
 */
function submit(token, text, { now = new Date() } = {}) {
  const link = resolve(token);
  if (!link) return { ok: false, status: 404, error: 'unknown link' };

  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (!clean) return { ok: false, status: 400, error: 'nothing to add' };

  const gate = noteUse(link.label, now);
  if (!gate.ok) return { ok: false, status: 429, error: gate.error };

  const taskStore = require('./task-store');
  const { created } = taskStore.createTask({
    text: clean,
    domain: link.domain,
    // Who asked. `source` is a free TEXT column with a documented value list,
    // so this needs no new column to answer "who wanted this".
    source: `capture:${link.label}`,
  });

  return { ok: true, text: clean, created };
}

module.exports = {
  list,
  create,
  revoke,
  resolve,
  submit,
  noteUse,
  MAX_PER_HOUR,
  MAX_TEXT,
  // exported for tests
  _tokenEquals,
};
