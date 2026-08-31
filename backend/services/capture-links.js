'use strict';

/**
 * Capture accounts — a small, standalone task screen for the people in Nick's
 * house. Served at its own address (tasks.nickward.co.uk), behind a username
 * and PIN, showing each person what THEY have sent and what became of it.
 *
 * ── Why it is not a NEURO login ──────────────────────────────────────────────
 *
 * Nick's wife needs to give him a task and see whether he has done it. She has
 * no iOS device, so a shared Reminders list is out, and she must never have the
 * NEURO PIN — that unlocks the whole brain: his queue, his inbox, his 1-2-1
 * notes, his health. This is a separate credential with a separate blast radius.
 *
 * ⚠ THIS IS THE ONLY PART OF NEURO DELIBERATELY OPEN TO THE PUBLIC INTERNET.
 * pi5 runs Tailscale Funnel, so exempting a path from the PIN middleware
 * publishes it to anyone, not merely to the tailnet. Everything below follows
 * from that sentence.
 *
 * ── What an account can see, and what it cannot ──────────────────────────────
 *
 * ONLY ITS OWN SUBMISSIONS. Nick asked for status back, which is a real change
 * from the first write-only cut — but "what I sent, and is it done" is a much
 * smaller claim than "Nick's task list", and the difference is enforced by
 * matching on `source = capture:<label>` rather than by filtering a fuller list
 * in the UI. Nothing else about his day is reachable from here: not his other
 * tasks, not counts, not the calendar.
 *
 * ── Why a PIN and not a secret link ──────────────────────────────────────────
 *
 * The first design put an unguessable token in the URL. That is fine for a
 * write-only door and wrong for one that shows anything back, because a URL
 * leaks in ways a password does not — browser history, a shared phone, a
 * screenshot, a message forwarded to the wrong person. A PIN is entered, not
 * stored in a link.
 *
 * ⚠ A PIN is also SHORT, and therefore brute-forceable, which is why the
 * throttle below is not optional and is the single most important thing in this
 * file. It is per account, persisted, and it counts failures rather than
 * requests so a person typing their own PIN wrong twice is unaffected.
 */

const crypto = require('crypto');
const db = require('../db/database');
const { domainOrDefault } = require('../../shared/task-domain.cjs');

const STATE_KEY = 'capture_links';

// ── What an account may SEE (VESTA, 31 Aug 2026) ─────────────────────────────
//
// The original rule here was absolute: an account sees ONLY its own
// submissions, and "nothing else about Nick's day is reachable — not his other
// tasks, not counts, not the calendar." VESTA deliberately widens that for one
// person: his partner gets a shared home surface with his diary (redacted), the
// kitchen and shared tasks on it.
//
// ⚠ So it is a per-account CAPABILITY and it DEFAULTS CLOSED. Widening the rule
// globally would silently hand every existing account sight of his calendar,
// which is the exact shape of accident this whole file exists to prevent. An
// account created before this has no `scopes` key at all and therefore gets
// `['tasks']` — precisely what it could do yesterday.
//
// `tasks` is implicit and always granted: it is what an account IS.
// ⚠ `presence` is Nick's real-time location INSIDE the house, published to an
// endpoint that is on the PUBLIC INTERNET behind a Tailscale funnel. It is the
// most personal thing this mount can carry — finer than a calendar, and live —
// so it is its own scope, granted deliberately, and it is NOT in DEFAULT_SCOPES.
// Nothing bundles it with `calendar` or `kitchen`: a scope that arrives as a
// side effect of wanting the shopping list is not consent.
const SCOPES = ['tasks', 'calendar', 'kitchen', 'shared-tasks', 'presence'];
const DEFAULT_SCOPES = ['tasks'];

/** Normalise a requested scope list. Unknown scopes are DROPPED, never passed
 *  through — a typo must not become a permission, and a future scope name must
 *  not be grantable by an old client that has not been updated. */
function normaliseScopes(requested) {
  const asked = Array.isArray(requested) ? requested : DEFAULT_SCOPES;
  const kept = asked
    .map((x) => String(x || '').trim().toLowerCase())
    .filter((x) => SCOPES.includes(x));
  // `tasks` is not optional — an account with no scopes at all would be a login
  // that can do nothing, which is a confusing way to spell "disabled".
  if (!kept.includes('tasks')) kept.unshift('tasks');
  return [...new Set(kept)];
}

/** What this account may see. An account predating scopes gets the old
 *  behaviour, never the new one. */
function scopesOf(account) {
  if (!account) return [];
  return Array.isArray(account.scopes) ? normaliseScopes(account.scopes) : [...DEFAULT_SCOPES];
}

function hasScope(account, scope) {
  return scopesOf(account).includes(scope);
}


const MAX_TEXT = 500;

// Submissions per account per hour. Generous for a person, useless for anything
// automated.
const MAX_PER_HOUR = 40;

// ── Brute force ──────────────────────────────────────────────────────────────
// A 4-6 digit PIN has at most a million combinations, so an unthrottled public
// login is not a lock at all. Five wrong tries buys a fifteen-minute lockout,
// which makes an exhaustive search take years while costing an honest person
// nothing — they get five goes at a number they already know.
const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

const MIN_PIN_LENGTH = 4;

// Sessions are signed rather than stored: a stateless token survives the
// backend restarting several times a day on deploys, which a memory-held
// session would not. Revocation still works, because `enabled` is re-checked on
// every single request rather than being baked into the token.
const SESSION_HOURS = 12;

function _secret() {
  // Derived from a secret that already exists rather than introducing another
  // one to lose. If neither is set the whole feature refuses to issue sessions
  // rather than signing with a predictable key.
  return process.env.NEURO_API_TOKEN || process.env.NEURO_PIN || null;
}

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // A corrupt blob must not read as "no accounts exist" and be silently
    // written over — that would revoke everyone without saying so.
    console.error('[Capture] Stored accounts unreadable:', e.message);
    throw new Error('capture accounts could not be read');
  }
}

function _save(accounts) {
  db.setState(STATE_KEY, JSON.stringify(accounts));
}

function _hashPin(pin, salt) {
  // scrypt rather than a plain hash: the input is a handful of digits, so the
  // only thing standing between a stolen blob and the PIN is how expensive each
  // guess is.
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

function _constantEquals(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  // ⚠ Two EMPTY buffers compare equal under timingSafeEqual, so an absent value
  // would match an absent stored one. Length is checked first for the same
  // reason timingSafeEqual cannot be called on mismatched buffers — it throws.
  if (ab.length === 0 || bb.length === 0) return false;
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function _findByUsername(accounts, username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  return accounts.find((a) => String(a.username || '').toLowerCase() === u) || null;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

function list() {
  return _load().map((a) => ({
    label: a.label,
    username: a.username,
    domain: a.domain,
    scopes: scopesOf(a),
    enabled: a.enabled !== false,
    createdAt: a.createdAt || null,
    lastSeenAt: a.lastSeenAt || null,
    submitted: Number(a.used) || 0,
    lockedUntil: a.lockedUntil || null,
    // The PIN is never returned in any form, hashed or otherwise. There is no
    // legitimate reason for a management screen to show it, and a list is
    // exactly the kind of thing that ends up in a screenshot.
  }));
}

function create({ label, username, pin, domain = 'personal', scopes = null } = {}) {
  const cleanLabel = String(label || '').trim().slice(0, 40);
  const cleanUser = String(username || '').trim().toLowerCase().slice(0, 40);
  const cleanPin = String(pin || '').trim();

  if (!cleanLabel) return { ok: false, error: 'a name is required' };
  if (!cleanUser) return { ok: false, error: 'a username is required' };
  if (cleanPin.length < MIN_PIN_LENGTH) {
    return { ok: false, error: `the PIN must be at least ${MIN_PIN_LENGTH} characters` };
  }

  const accounts = _load();
  if (_findByUsername(accounts, cleanUser)) {
    return { ok: false, error: `"${cleanUser}" is already taken` };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  accounts.push({
    label: cleanLabel,
    username: cleanUser,
    salt,
    pinHash: _hashPin(cleanPin, salt),
    // Defaults to personal, because that is what this door is FOR. The ACCOUNT
    // decides the domain, so a task from Nick's wife is personal by
    // construction rather than by a classifier guessing at the wording — and a
    // compromised account can only ever create personal tasks.
    domain: domainOrDefault(domain),
    // Defaults closed. See the SCOPES note above.
    scopes: normaliseScopes(scopes),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    used: 0,
    failures: [],
    lockedUntil: null,
    hits: [],
  });
  _save(accounts);
  return { ok: true, account: { label: cleanLabel, username: cleanUser, domain: domainOrDefault(domain) } };
}

function setPin(username, pin) {
  const accounts = _load();
  const account = _findByUsername(accounts, username);
  if (!account) return { ok: false, error: 'no such account' };
  const cleanPin = String(pin || '').trim();
  if (cleanPin.length < MIN_PIN_LENGTH) {
    return { ok: false, error: `the PIN must be at least ${MIN_PIN_LENGTH} characters` };
  }
  account.salt = crypto.randomBytes(16).toString('hex');
  account.pinHash = _hashPin(cleanPin, account.salt);
  // A PIN change clears a lockout: it is the legitimate way back in for someone
  // who has locked themselves out, and Nick has to do it for them.
  account.failures = [];
  account.lockedUntil = null;
  _save(accounts);
  return { ok: true };
}

/**
 * Change what an account may see. Admin-side only (behind the PIN), never
 * reachable from the public mount — an account that could widen its own scope
 * would make the whole model decorative.
 */
function setScopes(username, scopes) {
  const accounts = _load();
  const account = _findByUsername(accounts, String(username || '').toLowerCase());
  if (!account) return { ok: false, error: 'no such account' };
  account.scopes = normaliseScopes(scopes);
  _save(accounts);
  return { ok: true, username: account.username, scopes: account.scopes };
}

function revoke(username) {
  const accounts = _load();
  const next = accounts.filter((a) => String(a.username).toLowerCase() !== String(username).trim().toLowerCase());
  if (next.length === accounts.length) return { ok: false, error: 'no such account' };
  _save(next);
  return { ok: true, revoked: username };
}

// ── Login ────────────────────────────────────────────────────────────────────

/**
 * Check a username and PIN.
 *
 * ⚠ Wrong username and wrong PIN return the SAME message. Distinguishing them
 * tells an attacker which usernames exist, which is half the work of guessing a
 * short PIN — and it tells an honest person nothing they need.
 */
function login(username, pin, now = new Date()) {
  const accounts = _load();
  const account = _findByUsername(accounts, username);
  const generic = { ok: false, status: 401, error: 'That username or PIN is not right.' };

  if (!account || account.enabled === false) return generic;

  if (account.lockedUntil && new Date(account.lockedUntil) > now) {
    const mins = Math.ceil((new Date(account.lockedUntil) - now) / 60000);
    // The lockout IS told to the user, unlike the reason for a failure. Someone
    // who has genuinely forgotten their PIN needs to know that waiting is the
    // answer, or they will simply keep trying and stay locked out for ever.
    return { ok: false, status: 429, error: `Too many tries. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }

  const attempt = _hashPin(String(pin || ''), account.salt);
  if (!_constantEquals(attempt, account.pinHash)) {
    const cutoff = now.getTime() - LOCKOUT_MINUTES * 60000;
    const failures = (Array.isArray(account.failures) ? account.failures : []).filter((t) => t > cutoff);
    failures.push(now.getTime());
    account.failures = failures;
    if (failures.length >= MAX_FAILURES) {
      account.lockedUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60000).toISOString();
      account.failures = [];
    }
    _save(accounts);
    return generic;
  }

  account.failures = [];
  account.lockedUntil = null;
  account.lastSeenAt = now.toISOString();
  _save(accounts);

  const token = issueSession(account.username, now);
  if (!token) return { ok: false, status: 503, error: 'Sign-in is not available right now.' };
  return { ok: true, token, label: account.label, expiresInHours: SESSION_HOURS };
}

function issueSession(username, now = new Date()) {
  const secret = _secret();
  if (!secret) {
    // Refusing beats signing with a predictable key — an unsigned session on a
    // public endpoint is no session at all.
    console.error('[Capture] No NEURO_API_TOKEN/NEURO_PIN set — cannot sign sessions');
    return null;
  }
  const expires = now.getTime() + SESSION_HOURS * 3600 * 1000;
  const body = `${String(username).toLowerCase()}.${expires}`;
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${sig}`;
}

/**
 * Resolve a session token to a live account, or null.
 *
 * ⚠ `enabled` is re-checked HERE rather than trusted from the token. A signed
 * token is a claim about who someone was when they signed in; revoking an
 * account has to take effect immediately, not in twelve hours.
 */
function resolveSession(token, now = new Date()) {
  const secret = _secret();
  if (!secret || !token) return null;

  const parts = String(token).split('.');
  if (parts.length !== 2) return null;

  let body;
  try {
    body = Buffer.from(parts[0], 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }

  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!_constantEquals(parts[1], expected)) return null;

  const split = body.lastIndexOf('.');
  if (split < 1) return null;
  const username = body.slice(0, split);
  const expires = Number(body.slice(split + 1));
  if (!Number.isFinite(expires) || expires <= now.getTime()) return null;

  const account = _findByUsername(_load(), username);
  if (!account || account.enabled === false) return null;
  return account;
}

// ── Submitting ───────────────────────────────────────────────────────────────

function _noteUse(username, now) {
  const accounts = _load();
  const account = _findByUsername(accounts, username);
  if (!account) return { ok: false, error: 'no such account' };

  const cutoff = now.getTime() - 3600 * 1000;
  const hits = (Array.isArray(account.hits) ? account.hits : []).filter((t) => t > cutoff);
  if (hits.length >= MAX_PER_HOUR) {
    // Not saved: a refused submission must not extend its own window, or a
    // hammering client would keep itself locked out for ever.
    return { ok: false, error: 'too many submissions in the last hour', rateLimited: true };
  }
  hits.push(now.getTime());
  account.hits = hits;
  account.used = (Number(account.used) || 0) + 1;
  account.lastSeenAt = now.toISOString();
  _save(accounts);
  return { ok: true };
}

/**
 * Who a household task can be FOR.
 *
 * The owner plus every household account. Derived from the accounts rather than
 * typed out, the same rule the roster follows everywhere else in NEURO — a list
 * kept here would drift the first time somebody is added or revoked.
 *
 * ⚠ `null` (unassigned) is deliberately NOT in this list. It is the absence of a
 * choice, not a person, and offering it as one invites code that treats
 * "unassigned" as an identity it can compare against.
 */
const OWNER_ID = 'nick';

function people() {
  return [
    { id: OWNER_ID, label: 'Nick' },
    ..._load()
      .filter((a) => a.enabled !== false)
      .map((a) => ({ id: a.username, label: a.label })),
  ];
}

/**
 * Resolve who a task is for. PURE-ish (reads accounts). Always an ARRAY.
 *
 * Takes a single id, an array of them, or nothing. A job can genuinely belong to
 * two people — "strip the spare room" is not one person's — and forcing a single
 * owner made somebody choose a lie.
 *
 * ⚠ An unrecognised name is DROPPED, never stored as given. A typo must not
 * create a person, and a stored assignee matching nobody renders as a task
 * belonging to a ghost, which is worse than one plainly belonging to nobody.
 *
 * ⚠ Order follows `people()`, not the order they were ticked, so the same pair
 * always stores and renders identically — otherwise ["helen","nick"] and
 * ["nick","helen"] are two different strings meaning one thing.
 */
function resolveAssignees(requested) {
  const asked = Array.isArray(requested) ? requested : (requested == null ? [] : [requested]);
  const wanted = new Set(asked.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
  return people().filter((p) => wanted.has(p.id.toLowerCase())).map((p) => p.id);
}

/**
 * The column, read. PURE.
 *
 * ⚠ Tolerates BOTH shapes. `tasks.assignee` held a bare id for the few hours it
 * was single-valued, and rows written then are still in the database — parsing
 * only JSON would silently turn those into unassigned, quietly losing who a task
 * was for.
 */
function parseAssignees(raw) {
  if (raw == null || raw === '') return [];
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      // Unreadable is empty, not a guess. Better plainly unassigned than
      // attributed to whoever a broken parse happens to yield.
      return [];
    }
  }
  return [s];
}

/** The column, written. PURE. `null` for nobody — never the string "[]", which
 *  would read as assigned-to-nothing rather than unassigned. */
function serialiseAssignees(list) {
  const clean = Array.isArray(list) ? list.filter(Boolean) : [];
  return clean.length ? JSON.stringify(clean) : null;
}

/** Back-compat for callers that still think in one person. */
function resolveAssignee(requested) {
  return resolveAssignees(requested)[0] || null;
}

/**
 * A due date, or null. PURE.
 *
 * ⚠ Matched against a strict pattern rather than fed to `new Date()`, which
 * accepts almost anything and silently answers for some other day. An
 * unparseable date becomes NULL — no due date — rather than a wrong one: a task
 * with no deadline is honest, a task due on a date nobody chose is not.
 */
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
function normDueDate(value) {
  const clean = String(value == null ? '' : value).trim();
  if (!clean) return null;
  if (!DUE_RE.test(clean)) return null;
  // Reject the impossible as well as the malformed — 2026-13-45 passes the
  // pattern and is not a day.
  const [y, m, d] = clean.split('-').map(Number);
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
  return clean;
}

/**
 * Change a household task she can already see.
 *
 * ⚠ THE OWNERSHIP CHECK IS THE WHOLE THING, and it is done against the DATABASE
 * on every call, never against an id the client claims to own. The rule is
 * exactly the one `submissions` reads by: with `shared-tasks`, any task on the
 * household list; without it, only this account's own submissions. A task that
 * is neither is reported as MISSING rather than forbidden, so this cannot be
 * used to discover which ids belong to Nick.
 *
 * Only three fields are reachable — due date, assignee, and done/not-done.
 * MoSCoW, priority, notes, estimates and provenance are Nick's own working
 * notes and are not editable here, nor even addressable.
 */
function updateTask(account, taskId, patch = {}) {
  const db = require('../db/database');
  const taskStore = require('./task-store');

  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'no such task' };

  const row = db.getTaskRow(id);
  const missing = { ok: false, status: 404, error: 'no such task' };
  if (!row) return missing;

  const shared = hasScope(account, 'shared-tasks');
  const mine = String(row.source || '') === sourceFor(account);
  const visible = shared ? row.household === 1 : mine;
  if (!visible) return missing;

  const fields = {};
  // `null` is a real instruction here — "clear the due date" — and must stay
  // distinct from the key being absent, which means "leave it alone".
  if ('dueDate' in patch) fields.due_date = normDueDate(patch.dueDate);
  if ('assignees' in patch) fields.assignee = serialiseAssignees(resolveAssignees(patch.assignees));
  else if ('assignee' in patch) fields.assignee = serialiseAssignees(resolveAssignees(patch.assignee));
  if ('done' in patch) fields.status = patch.done ? 'done' : 'open';

  if (!Object.keys(fields).length) return { ok: false, status: 400, error: 'nothing to change' };

  // Through task-store, so completion does whatever completion does elsewhere
  // (the outcome-note hold, the export) rather than a raw column write.
  const updated = taskStore.updateTask(id, fields);
  return { ok: true, id, held: (updated && updated.held) || false };
}

/** The task source that marks a row as belonging to one account. */
function sourceFor(account) {
  return `capture:${account.label}`;
}

function submit(account, text, { now = new Date(), assignee = null, assignees = null, dueDate = null } = {}) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT);
  if (!clean) return { ok: false, status: 400, error: 'nothing to add' };

  const gate = _noteUse(account.username, now);
  if (!gate.ok) return { ok: false, status: 429, error: gate.error };

  const taskStore = require('./task-store');
  const { id, created } = taskStore.createTask({
    text: clean,
    domain: account.domain,
    source: sourceFor(account),
    // Whoever it is FOR, which is a different question from who typed it.
    // Unrecognised resolves to null rather than being stored as given.
    // `assignees` preferred; `assignee` still accepted so an older client keeps
    // working rather than silently losing who a task was for.
    assignee: serialiseAssignees(resolveAssignees(assignees != null ? assignees : assignee)),
    due_date: normDueDate(dueDate),
    // Anything captured through VESTA is a household task by definition — this
    // IS the shared list. Nick's own tasks default to 0 and reach it only when
    // he says so.
    household: 1,
  });

  return { ok: true, id, text: clean, created, assignees: resolveAssignees(assignees != null ? assignees : assignee) };
}

/**
 * What this account has sent, and what became of it.
 *
 * ⚠ Scoped by `source` in the QUERY, never by filtering a fuller list in the
 * caller or the page. The difference between "what I sent" and "Nick's task
 * list" is the entire security boundary of this feature, and a boundary
 * enforced in a UI is one that a future refactor walks straight through.
 *
 * The shape is deliberately thin: text, status, due date. No MoSCoW, no
 * priority, no score, no origin — those are Nick's own working notes about his
 * own list, and none of them is any of her business.
 */
function submissions(account, { limit = 50 } = {}) {
  const taskStore = require('./task-store');
  const db = require('../db/database');

  // ⚠ THE `shared-tasks` SCOPE, which until now was a name in a list and
  // nothing else — it could be ticked and changed absolutely nothing.
  //
  // Without it: only what THIS account sent, exactly as before.
  //
  // With it: the whole VESTA household pool — every task captured through any
  // household account. Scoped by a `source` PREFIX in the QUERY, never by
  // filtering a fuller list in the caller or the page.
  //
  // ⚠ The pool is deliberately NOT "every personal task". Nick's own personal
  // list is personal-domain too, and sweeping it in is exactly the boundary this
  // feature must not cross — a household surface shows what the household put
  // into it, not everything of his that happens not to be work.
  const shared = hasScope(account, 'shared-tasks');
  const rows = shared
    // ⚠ The household FLAG, not a source pattern. Source answers where a task
    // was typed; the flag answers whether it is meant to be shared — which is
    // what lets Nick put a home task on this list from NEURO, and take one off.
    ? taskStore.listTasks({ status: 'all', includeDone: true, household: true })
    : taskStore.listTasks({ status: 'all', includeDone: true, source: sourceFor(account) });
  // Newest first. listTaskRows orders by MoSCoW and priority, which is the right
  // order for Nick's own triage screen and meaningless here — she wants the
  // thing she sent this morning at the top, not the one NEURO ranks highest.
  const newest = [...rows].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const who = people();
  return newest.slice(0, limit).map((r) => ({
    // Needed to edit it. An opaque row id, not a path or anything guessable —
    // and every write re-checks the row is in this account's pool anyway.
    id: r.id,
    text: r.text,
    // Who it is FOR. `null` is unassigned and is a real answer — the UI says
    // "anyone" rather than quietly attributing it to whoever typed it.
    // Always an array — one shape whether a job belongs to nobody, one person
    // or both, so no consumer has to branch on which.
    assignees: parseAssignees(r.assignee),
    assigneeLabels: parseAssignees(r.assignee)
      .map((id) => (who.find((p) => p.id === id) || {}).label || id),
    // Who SENT it, which only means anything once more than one person can.
    // Derived from the source rather than stored twice.
    from: shared ? String(r.source || '').replace(/^capture:/, '') || null : null,
    // Collapsed to three words a non-user of NEURO understands. 'dropped' is
    // reported honestly as "not doing" rather than hidden or dressed up as
    // done — she asked for something and deserves to know it was declined.
    status: r.status === 'done' ? 'done'
      : r.status === 'dropped' ? 'not doing'
      : r.status === 'in-progress' ? 'in progress'
      : 'to do',
    dueDate: r.due_date || null,
    addedAt: (r.created_at || '').split(' ')[0] || null,
  }));
}

module.exports = {
  list,
  create,
  setScopes,
  people,
  resolveAssignee,
  resolveAssignees,
  parseAssignees,
  serialiseAssignees,
  normDueDate,
  updateTask,
  OWNER_ID,
  scopesOf,
  hasScope,
  normaliseScopes,
  SCOPES,
  DEFAULT_SCOPES,
  setPin,
  revoke,
  login,
  issueSession,
  resolveSession,
  submit,
  submissions,
  sourceFor,
  MAX_PER_HOUR,
  MAX_TEXT,
  MAX_FAILURES,
  LOCKOUT_MINUTES,
  // exported for tests
  _constantEquals,
};
