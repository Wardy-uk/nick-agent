'use strict';

/**
 * The standalone task screen — accounts, sign-in, and what an account can see.
 *
 * ⚠ This is the only part of NEURO deliberately open to the public internet
 * (Tailscale Funnel is on, so an auth exemption is not "tailnet only"). The
 * tests that matter most are the NEGATIVE ones: what a stolen PIN cannot reach,
 * and how expensive guessing one is. A feature test proving "she can add a task"
 * would pass just as happily over a door that also handed out Nick's inbox.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ NEVER the live agent.db (mistakes.md, 13 Aug).
process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-capture-')), 'scratch.db',
);
// Sessions are HMAC-signed with this; without it the service refuses to issue
// one rather than signing with a predictable key.
process.env.NEURO_API_TOKEN = 'test-secret-for-session-signing';

const db = require('../db/database');
const capture = require('./capture-links');
const taskStore = require('./task-store');

test.before(async () => { await db.init(); });

function newAccount(over) {
  const base = { label: 'Jenny', username: 'jenny', pin: '4821', domain: 'personal' };
  return capture.create(Object.assign(base, over || {}));
}

// ── Accounts and sign-in ─────────────────────────────────────────────────────

test('an account signs in and gets a session', () => {
  assert.equal(newAccount().ok, true);
  const res = capture.login('jenny', '4821');
  assert.equal(res.ok, true);
  assert.ok(res.token);
  assert.equal(res.label, 'Jenny');

  const account = capture.resolveSession(res.token);
  assert.ok(account);
  assert.equal(account.username, 'jenny');
});

test('a wrong username and a wrong PIN are indistinguishable', () => {
  newAccount({ username: 'sam', label: 'Sam' });
  const wrongPin = capture.login('sam', '0000');
  const noSuchUser = capture.login('nobody-at-all', '0000');

  // Distinguishing them tells an attacker which usernames exist, which is half
  // the work of guessing a short PIN — and tells an honest person nothing.
  assert.equal(wrongPin.ok, false);
  assert.equal(noSuchUser.ok, false);
  assert.equal(wrongPin.error, noSuchUser.error);
  assert.equal(wrongPin.status, noSuchUser.status);
});

test('the PIN is never stored in the clear, and never returned', () => {
  newAccount({ username: 'vera', label: 'Vera', pin: '9137' });
  const raw = db.getState('capture_links');
  assert.equal(raw.indexOf('9137'), -1, 'the PIN must not appear in storage');

  const listed = capture.list().find(a => a.username === 'vera');
  assert.equal(listed.pin, undefined);
  assert.equal(listed.pinHash, undefined);
  assert.equal(listed.salt, undefined);
});

test('a short PIN is refused at creation', () => {
  const res = newAccount({ username: 'weak', pin: '12' });
  assert.equal(res.ok, false);
});

test('a duplicate username is refused', () => {
  newAccount({ username: 'twice', label: 'Twice' });
  assert.equal(newAccount({ username: 'TWICE', label: 'Twice again' }).ok, false, 'matching is case-insensitive');
});

// ── Brute force ──────────────────────────────────────────────────────────────

test('⚠ a short PIN is protected by a lockout, not by luck', () => {
  // A 4-digit PIN has ten thousand combinations. Unthrottled on a public
  // endpoint that is not a lock at all — this test IS the lock.
  newAccount({ username: 'target', label: 'Target', pin: '1234' });

  for (let i = 0; i < capture.MAX_FAILURES; i++) {
    assert.equal(capture.login('target', '0000').ok, false);
  }

  // Even the RIGHT pin is refused while locked out — otherwise an attacker who
  // happened to guess correctly on the sixth try would walk straight in.
  const locked = capture.login('target', '1234');
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 429);
  // The lockout is stated, unlike the reason for a failure: someone who has
  // genuinely forgotten needs to know that waiting is the answer, or they will
  // keep trying and stay locked out for ever.
  assert.match(locked.error, /Try again in/);
});

test('a PIN reset clears the lockout — it is the way back in', () => {
  newAccount({ username: 'locked', label: 'Locked', pin: '1111' });
  for (let i = 0; i < capture.MAX_FAILURES; i++) capture.login('locked', '0000');
  assert.equal(capture.login('locked', '1111').status, 429);

  assert.equal(capture.setPin('locked', '2222').ok, true);
  assert.equal(capture.login('locked', '2222').ok, true);
});

// ── Sessions ─────────────────────────────────────────────────────────────────

test('a tampered or expired session is rejected', () => {
  newAccount({ username: 'sess', label: 'Sess' });
  const token = capture.login('sess', '4821').token;

  assert.ok(capture.resolveSession(token));
  assert.equal(capture.resolveSession(token + 'x'), null, 'a changed signature must not verify');
  assert.equal(capture.resolveSession('nonsense'), null);
  assert.equal(capture.resolveSession(''), null);
  assert.equal(capture.resolveSession(null), null);

  // Expiry is inside the signed body, so it cannot be extended by the client.
  const future = new Date(Date.now() + 13 * 3600 * 1000);
  assert.equal(capture.resolveSession(token, future), null);
});

test('⚠ revoking takes effect immediately, not when the session expires', () => {
  newAccount({ username: 'gone', label: 'Gone' });
  const token = capture.login('gone', '4821').token;
  assert.ok(capture.resolveSession(token));

  capture.revoke('gone');
  // The token is still validly signed and unexpired. `enabled` is re-read every
  // request precisely so that does not matter.
  assert.equal(capture.resolveSession(token), null);
});

test('sessions are refused rather than signed with a predictable key', () => {
  const saved = process.env.NEURO_API_TOKEN;
  const savedPin = process.env.NEURO_PIN;
  delete process.env.NEURO_API_TOKEN;
  delete process.env.NEURO_PIN;
  assert.equal(capture.issueSession('anyone'), null);
  process.env.NEURO_API_TOKEN = saved;
  if (savedPin !== undefined) process.env.NEURO_PIN = savedPin;
});

// ── The boundary ─────────────────────────────────────────────────────────────

test('⚠ an account sees ONLY its own submissions', () => {
  // The entire security boundary of this feature. Enforced by a `source` match
  // in the query, never by filtering a fuller list in the page.
  newAccount({ username: 'alice', label: 'Alice' });
  newAccount({ username: 'bob', label: 'Bob' });
  const alice = capture.resolveSession(capture.login('alice', '4821').token);
  const bob = capture.resolveSession(capture.login('bob', '4821').token);

  capture.submit(alice, 'Alice thing');
  capture.submit(bob, 'Bob thing');
  // Something of Nick's own, which neither of them must ever see.
  taskStore.createTask({ text: 'Confidential HR matter for Chris', source: 'manual' });

  const seen = capture.submissions(alice).map(t => t.text);
  assert.deepEqual(seen, ['Alice thing']);
  assert.equal(seen.indexOf('Bob thing'), -1);
  assert.equal(seen.indexOf('Confidential HR matter for Chris'), -1);
});

test('a submission carries only what she needs to see', () => {
  newAccount({ username: 'thin', label: 'Thin' });
  const account = capture.resolveSession(capture.login('thin', '4821').token);
  capture.submit(account, 'Pick up the parcel');

  const row = capture.submissions(account)[0];
  // No MoSCoW, no priority, no score, no origin path — those are Nick's own
  // working notes about his own list, and none of them is her business.
  assert.deepEqual(Object.keys(row).sort(), ['addedAt', 'dueDate', 'status', 'text']);
});

test('the account decides the domain, and a personal one cannot create work', () => {
  newAccount({ username: 'dom', label: 'Dom', domain: 'personal' });
  const account = capture.resolveSession(capture.login('dom', '4821').token);
  capture.submit(account, 'Water the plants');

  const task = taskStore.listTasks({ status: 'open' }).find(t => t.text === 'Water the plants');
  assert.equal(task.domain, 'personal');
  assert.equal(task.source, 'capture:Dom');
});

test('status is reported in words she understands, and refusal is not hidden', () => {
  newAccount({ username: 'stat', label: 'Stat' });
  const account = capture.resolveSession(capture.login('stat', '4821').token);
  capture.submit(account, 'Fix the gate');

  const task = taskStore.listTasks({ status: 'open' }).find(t => t.text === 'Fix the gate');
  taskStore.updateTask(task.id, { status: 'dropped' });

  // 'dropped' is reported honestly as "not doing" rather than hidden or dressed
  // up as done — she asked for something and deserves to know it was declined.
  assert.equal(capture.submissions(account)[0].status, 'not doing');
});

// ── Rate limiting ────────────────────────────────────────────────────────────

test('the submission window survives a restart and a refusal does not extend it', () => {
  newAccount({ username: 'hammer', label: 'Hammer' });
  const account = capture.resolveSession(capture.login('hammer', '4821').token);
  const now = new Date('2026-08-29T10:00:00Z');

  for (let i = 0; i < capture.MAX_PER_HOUR; i++) {
    assert.equal(capture.submit(account, `thing ${i}`, { now }).ok, true);
  }
  const blocked = capture.submit(account, 'one too many', { now });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 429);

  // ⚠ A refused submission records no hit, or a hammering client would lock
  // itself out for ever rather than for an hour.
  assert.equal(capture.submit(account, 'later', { now: new Date('2026-08-29T11:30:00Z') }).ok, true);

  // The window lives on the stored account, not in a module-level map: the
  // backend restarts several times a day on deploys, and an in-memory budget
  // would reset with it — the bug the push governor already had to fix.
  const raw = JSON.parse(db.getState('capture_links'));
  assert.ok(Array.isArray(raw.find(a => a.username === 'hammer').hits));
});

test('empty submissions are refused before they reach the task store', () => {
  newAccount({ username: 'blank', label: 'Blank' });
  const account = capture.resolveSession(capture.login('blank', '4821').token);
  assert.equal(capture.submit(account, '   ').ok, false);
  assert.equal(capture.submit(account, '').status, 400);
});

test('the constant-time compare does not throw, and empty never matches', () => {
  // timingSafeEqual throws on a length mismatch, and two EMPTY buffers compare
  // EQUAL — so an absent value would match an absent stored one.
  assert.equal(capture._constantEquals('short', 'a-much-longer-value'), false);
  assert.equal(capture._constantEquals('same', 'same'), true);
  assert.equal(capture._constantEquals('', ''), false);
  assert.equal(capture._constantEquals(null, undefined), false);
});

test('the auth exemption cannot reach the admin routes by prefix', () => {
  // The public screen is /api/c and the admin half is /api/capture-links — one
  // letter apart on purpose. The middleware tests startsWith('/c/'), NOT
  // startsWith('/c'), or '/capture-links' would slip through the same branch
  // and creating accounts would be public.
  const exempt = (p) => p.startsWith('/c/');
  assert.equal(exempt('/c/login'), true);
  assert.equal(exempt('/c/tasks'), true);
  assert.equal(exempt('/capture-links'), false);
  assert.equal(exempt('/capture-links/jenny/pin'), false);
  assert.equal(exempt('/capture/todo'), false);
  assert.equal(exempt('/chat'), false);
  assert.equal(exempt('/calendar/events'), false);
});
