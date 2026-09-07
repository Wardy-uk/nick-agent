'use strict';

/**
 * A suggestion that DID something is not offered again.
 *
 * The dedupe only ever read PENDING actions, so approving a `draft_reply` took
 * it out of that set and the next `/api/focus` call regenerated it — for as
 * long as the email stayed urgent, which is for ever. Measured on the live DB
 * before the fix: ONE email held 1,168 superseded, 6 executed and 2 rejected
 * `draft_reply` rows, i.e. six paid drafts and two duplicate outbound sends
 * queued for one message.
 *
 * Real scratch DB, because the whole bug lives in which rows the dedupe reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-suggest-')), 'scratch.db');

const db = require('../db/database');
const engine = require('./suggestion-engine');
const presenter = require('./action-presenter');

test.before(async () => { await db.init(); });

const EMAIL = 'AAMkAGI1MjNlMj-simon';
const OTHER = 'AAMkAGI1MjNlMj-someone-else';

function urgentEmail(emailId = EMAIL, subject = 'Udemny') {
  return {
    id: 'email-urgent',
    type: 'email',
    title: `Urgent email — ${subject}`,
    urgency: 'high',
    meta: { emailId, subject, from: 'Simon Greenhalgh' },
  };
}

function reset() {
  db.run ? null : null;
  for (const row of db.getRecentSaraActions(500)) {
    db.updateSaraActionStatus(row.id, 'superseded');
  }
}

test('the identity is the EMAIL, not the focus item', () => {
  // Every urgent email arrives as the focus item `email-urgent`, so keying on
  // that would let one drafted reply suppress the offer for every future email.
  const a = engine.suggestionIdentity('draft_reply', { emailId: EMAIL }, 'email-urgent');
  const b = engine.suggestionIdentity('draft_reply', { emailId: OTHER }, 'email-urgent');
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test('no identifying field means DO NOT SUPPRESS', () => {
  // A duplicate card can be seen; a silently withheld one cannot.
  assert.equal(engine.suggestionIdentity('draft_reply', {}, 'email-urgent'), null);
  assert.equal(engine.suggestionIdentity('open_task', { navigate: 'todos' }, 'todo-1'), null);
});

test('draft_reply is not navigation — which is what makes it offered-once', () => {
  // The classification is action-presenter's, never a list of names here.
  assert.notEqual(presenter.describe({ type: 'draft_reply', payload: { emailId: EMAIL } }).kind,
    presenter.NAVIGATE);
  assert.equal(presenter.describe({ type: 'open_task', payload: { navigate: 'todos' } }).kind,
    presenter.NAVIGATE);
});

test('an EXECUTED draft is never offered again for the same email', () => {
  reset();
  const first = engine.generateSuggestions([urgentEmail()]);
  assert.equal(first[0].type, 'draft_reply');
  const [created] = engine.persistSuggestions(first);

  // Nick approves: the row leaves the pending set, and the email is still urgent.
  db.updateSaraActionStatus(created.id, 'executed');

  const again = engine.generateSuggestions([urgentEmail()]);
  assert.ok(!again.some(s => s.type === 'draft_reply'), 'the drafted reply came back');
});

test('a REJECTED draft is not offered again either', () => {
  reset();
  const [created] = engine.persistSuggestions(engine.generateSuggestions([urgentEmail()]));
  db.updateSaraActionStatus(created.id, 'rejected');
  assert.ok(!engine.generateSuggestions([urgentEmail()]).some(s => s.type === 'draft_reply'));
});

test('a DIFFERENT email still gets its draft offered', () => {
  reset();
  const [created] = engine.persistSuggestions(engine.generateSuggestions([urgentEmail()]));
  db.updateSaraActionStatus(created.id, 'executed');

  const other = engine.generateSuggestions([urgentEmail(OTHER, 'Something else')]);
  assert.ok(other.some(s => s.type === 'draft_reply'), 'a decision on one email silenced another');
});

test('a FAILED action is offered again — he approved it and it did not happen', () => {
  reset();
  const [created] = engine.persistSuggestions(engine.generateSuggestions([urgentEmail()]));
  db.updateSaraActionStatus(created.id, 'failed');
  assert.ok(engine.generateSuggestions([urgentEmail()]).some(s => s.type === 'draft_reply'));
});

test('superseded is not a decision — Nick chose nothing', () => {
  reset();
  const [created] = engine.persistSuggestions(engine.generateSuggestions([urgentEmail()]));
  db.updateSaraActionStatus(created.id, 'superseded');
  assert.ok(engine.generateSuggestions([urgentEmail()]).some(s => s.type === 'draft_reply'));
});

test('a decision buried behind a thousand superseded rows is still found', () => {
  reset();
  // The live shape: 1,168 superseded rows in front of the decisions. A recency
  // window cheap enough to run is small enough to miss every one of them, so
  // the status filter has to be in SQL.
  const [created] = engine.persistSuggestions(engine.generateSuggestions([urgentEmail()]));
  db.updateSaraActionStatus(created.id, 'executed');
  for (let i = 0; i < 1200; i++) {
    const id = db.createSaraAction('draft_reply', { emailId: EMAIL }, 0.8, 'noise', 'email-urgent');
    db.updateSaraActionStatus(id, 'superseded');
  }
  assert.ok(!engine.generateSuggestions([urgentEmail()]).some(s => s.type === 'draft_reply'));
});

test('navigation stays repeatable — a shortcut is always available', () => {
  reset();
  const item = { id: 'todo-overdue-top', type: 'todo', title: 'Overdue', urgency: 'high', meta: {} };
  const [created] = engine.persistSuggestions(engine.generateSuggestions([item]));
  assert.equal(created.type, 'open_task');
  db.updateSaraActionStatus(created.id, 'executed');
  assert.ok(engine.generateSuggestions([item]).some(s => s.type === 'open_task'),
    'the "Do it" shortcut stopped being offered');
});
