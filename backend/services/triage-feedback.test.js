'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-triage-'));
process.env.NEURO_DB_PATH = path.join(root, 'triage.db');

const db = require('../db/database');
const triage = require('./email-triage');

// #70 — "Done" and "Not relevant" called the identical endpoint, so the
// distinction was painted on. Every "not relevant" is Nick telling triage its
// ranking was wrong, and it was discarded on the spot — the only feedback this
// classifier will ever get for free. Two buttons that do the same thing quietly
// teach him they mean nothing.

test.before(async () => { await db.init(); });

function seed(rows) {
  db.setState('email_triage', JSON.stringify(rows));
}

test('the reason is recorded, so the two buttons stop being the same button', () => {
  seed([
    { id: 'a', subject: 'Contract query', urgency: 'high', category: 'action-required' },
    { id: 'b', subject: 'Newsletter', urgency: 'high', category: 'action-required' },
  ]);

  triage.dismissEmail('a', 'done');
  triage.dismissEmail('b', 'not-relevant');

  const stored = JSON.parse(db.getState('email_triage'));
  assert.equal(stored.find(e => e.id === 'a').dismissReason, 'done');
  assert.equal(stored.find(e => e.id === 'b').dismissReason, 'not-relevant');
  assert.ok(stored.every(e => e.dismissed));
});

test('an unknown reason degrades to unspecified rather than being stored as data', () => {
  seed([{ id: 'a', subject: 'x' }]);
  triage.dismissEmail('a', 'whatever-the-client-sent');
  assert.equal(JSON.parse(db.getState('email_triage'))[0].dismissReason, 'unspecified');
});

test('replying is its own reason — the strongest signal triage was RIGHT', () => {
  // Lumping a sent reply in with a manual "done" throws away the clearest
  // positive evidence the classifier ever produces.
  seed([{ id: 'a', subject: 'Needs an answer' }]);
  triage.dismissEmail('a', 'replied');
  assert.equal(JSON.parse(db.getState('email_triage'))[0].dismissReason, 'replied');
});

test('the score counts only what Nick has judged', () => {
  // An email still sitting in triage is not evidence either way. Counting it
  // would make the classifier look better purely because he has not got to it.
  seed([
    { id: 'a', urgency: 'high', category: 'action-required' },
    { id: 'b', urgency: 'high', category: 'action-required' },
    { id: 'c', urgency: 'high', category: 'action-required' },
    { id: 'untouched', urgency: 'high', category: 'action-required' },
    { id: 'legacy', urgency: 'high', category: 'action-required', dismissed: true },
  ]);
  triage.dismissEmail('a', 'done');
  triage.dismissEmail('b', 'not-relevant');
  triage.dismissEmail('c', 'not-relevant');

  const fb = triage.getDismissFeedback();
  assert.equal(fb.judged, 3, 'the untouched one and the pre-#70 dismiss are not verdicts');
  assert.equal(fb.notRelevant, 2);
  assert.equal(fb.misrankRate, 67);
  // `underRanked` joined the shape on 26 Aug with the "Needs action" button —
  // triage can be wrong in two directions and both are counted now.
  assert.deepEqual(fb.byCategory['high/action-required'], { judged: 3, notRelevant: 2, underRanked: 0 });
});

test('nothing judged reads as null, not as a perfect score', () => {
  seed([{ id: 'a', urgency: 'low', category: 'fyi' }]);
  const fb = triage.getDismissFeedback();
  assert.equal(fb.judged, 0);
  assert.equal(fb.misrankRate, null, 'an untested classifier is not a 0% misrank classifier');
});
