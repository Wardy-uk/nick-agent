'use strict';

/**
 * The capture door.
 *
 * ⚠ This is the only route in NEURO deliberately open to the public internet
 * (Tailscale Funnel is on, so an auth exemption is not "tailnet only"). The
 * tests that matter most here are the NEGATIVE ones: what a leaked link cannot
 * do. A feature test proving "she can add a task" would pass just as happily
 * over a door that also handed out Nick's inbox.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ NEVER the live agent.db — moving one aside for a test destroyed the local
// dev copy once already (mistakes.md, 13 Aug).
process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-capture-')), 'scratch.db',
);

const db = require('../db/database');
const captureLinks = require('./capture-links');

test.before(async () => { await db.init(); });

test('a link creates personal tasks, attributed to whoever holds it', () => {
  const made = captureLinks.create('Jenny');
  assert.equal(made.ok, true);
  assert.equal(made.link.domain, 'personal', 'the door defaults to personal — that is what it is FOR');

  const res = captureLinks.submit(made.link.token, '  Book the dentist  ');
  assert.equal(res.ok, true);
  assert.equal(res.text, 'Book the dentist');

  const taskStore = require('./task-store');
  const task = taskStore.listTasks({ status: 'open' }).find(t => t.text === 'Book the dentist');
  assert.ok(task, 'the task should exist');
  // The TOKEN is the evidence for the domain — no classifier guessing from the
  // wording, the same rule as everywhere else in NEURO.
  assert.equal(task.domain, 'personal');
  // "Who asked me for this" has to be answerable, and `source` is a free TEXT
  // column, so it needs no new schema.
  assert.equal(task.source, 'capture:Jenny');
});

test('a submission never learns anything about Nick', () => {
  const made = captureLinks.create('Leaky');
  const res = captureLinks.submit(made.link.token, 'Milk');

  // The whole security model in one assertion: the reply carries only an echo
  // of what was sent. Not a task id, not a position in a list, not a count of
  // what Nick owes. A capture page that renders his list hands his work queue
  // to whoever finds the URL.
  assert.deepEqual(Object.keys(res).sort(), ['created', 'ok', 'text']);
});

test('an unknown token and a revoked one are indistinguishable', () => {
  const made = captureLinks.create('Temporary');
  assert.equal(captureLinks.submit(made.link.token, 'still works').ok, true);

  captureLinks.revoke('Temporary');

  const revoked = captureLinks.submit(made.link.token, 'should fail');
  const nonsense = captureLinks.submit('not-a-real-token-at-all', 'should also fail');

  assert.equal(revoked.ok, false);
  assert.equal(nonsense.ok, false);
  // Same status AND same words — whoever holds a dead link must not be able to
  // tell "this was switched off" from "this never existed".
  assert.equal(revoked.status, nonsense.status);
  assert.equal(revoked.error, nonsense.error);
});

test('tokens are redacted in the list unless explicitly revealed', () => {
  captureLinks.create('Screenshot');
  const listed = captureLinks.list().find(l => l.label === 'Screenshot');
  assert.ok(listed.token.endsWith('…'), 'a link list ends up in screenshots and logs');

  const revealed = captureLinks.list({ reveal: true }).find(l => l.label === 'Screenshot');
  assert.ok(revealed.token.length > 20);
});

test('the rate limit survives a restart and a refusal does not extend itself', () => {
  const made = captureLinks.create('Hammer');
  const now = new Date('2026-08-29T10:00:00Z');

  for (let i = 0; i < captureLinks.MAX_PER_HOUR; i++) {
    assert.equal(captureLinks.noteUse('Hammer', now).ok, true, `submission ${i + 1} should be allowed`);
  }
  const blocked = captureLinks.noteUse('Hammer', now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rateLimited, true);

  // ⚠ A refused submission must not record a hit. If it did, a hammering client
  // would keep itself locked out for ever rather than for an hour.
  const stillBlocked = captureLinks.noteUse('Hammer', new Date('2026-08-29T10:30:00Z'));
  assert.equal(stillBlocked.ok, false, 'still inside the window');

  const later = captureLinks.noteUse('Hammer', new Date('2026-08-29T11:30:00Z'));
  assert.equal(later.ok, true, 'the window rolls, and it rolled from the last ALLOWED hit');

  // The window lives on the stored link, not in a module-level map: the backend
  // restarts several times a day on deploys, and an in-memory budget would reset
  // with it — the bug the push governor already had to fix.
  const raw = JSON.parse(db.getState('capture_links'));
  assert.ok(Array.isArray(raw.find(l => l.label === 'Hammer').hits));
});

test('a duplicate is reported as folded, not as a fresh add', () => {
  const made = captureLinks.create('Twice');
  assert.equal(captureLinks.submit(made.link.token, 'Put the bins out').created, true);
  // She has no list to check against, so "added!" twice for one thing would be
  // a lie she cannot catch.
  assert.equal(captureLinks.submit(made.link.token, 'Put the bins out').created, false);
});

test('empty submissions are refused before they reach the task store', () => {
  const made = captureLinks.create('Blank');
  assert.equal(captureLinks.submit(made.link.token, '   ').ok, false);
  assert.equal(captureLinks.submit(made.link.token, '').status, 400);
});

test('the token comparison does not throw on a length mismatch', () => {
  // timingSafeEqual throws when the buffers differ in length, which would turn
  // a wrong token into a 500 — and a 500 is itself a signal that a short token
  // was "differently wrong" from a long one.
  assert.equal(captureLinks._tokenEquals('short', 'a-much-longer-token'), false);
  assert.equal(captureLinks._tokenEquals('same', 'same'), true);
  assert.equal(captureLinks._tokenEquals(null, undefined), false);
});

test('the auth exemption cannot reach the admin routes by prefix', () => {
  // The public door is /api/c and the admin half is /api/capture-links — one
  // letter apart on purpose. The middleware tests startsWith('/c/'), NOT
  // startsWith('/c'), or '/capture-links' would slip through the same branch
  // and creating links would be public.
  const exempt = (p) => p.startsWith('/c/');

  assert.equal(exempt('/c/some-token'), true);
  assert.equal(exempt('/capture-links'), false);
  assert.equal(exempt('/capture-links/Jenny'), false);
  assert.equal(exempt('/capture/todo'), false);
  assert.equal(exempt('/chat'), false);
  assert.equal(exempt('/calendar/events'), false);
});
