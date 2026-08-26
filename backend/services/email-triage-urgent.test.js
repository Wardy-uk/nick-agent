'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Scratch DB, never the live one (mistakes.md, 13 Aug).
const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-triage-')), 'scratch.db');
process.env.NEURO_DB_PATH = DB_PATH;

const db = require('../db/database');
const emailTriage = require('./email-triage');
const nudges = require('./nudges');

test.before(async () => { await db.init(); });

function email(over = {}) {
  return {
    id: 'AAMk-1',
    subject: 'RE: Urgent: Tracy Welham — source of contact data',
    from: 'Phillipa Legg',
    fromEmail: 'phillipa@example.com',
    preview: 'Just to add to this —',
    lane: 'urgent',
    category: 'ACTION',
    urgency: 'high',
    reason: 'urgent language · unread',
    dismissed: false,
    ...over,
  };
}

function seed(items) {
  db.setState('email_triage', JSON.stringify(items));
}

test('urgent means the urgent lane, and only what is still outstanding', () => {
  seed([
    email(),
    email({ id: 'AAMk-2' }),
    email({ id: 'AAMk-3', lane: 'reply', urgency: 'medium' }),
    email({ id: 'AAMk-4', lane: 'fyi', urgency: 'low', category: 'FYI' }),
    email({ id: 'AAMk-5', dismissed: true }),
  ]);

  assert.equal(emailTriage.getUrgentEmails().length, 2);
});

// The regression this file exists for. The count that interrupted Nick was
// computed over a SECOND store (`inbox_items`) that his dismissals never
// reached, so actioning the whole panel left the notification saying 37. If
// these two ever read different places again, this fails.
test('the banner and the panel are the same mail — a dismissal moves both', () => {
  seed([email(), email({ id: 'AAMk-2' })]);

  assert.equal(nudges.getUrgentEmails().length, 2);
  emailTriage.dismissEmail('AAMk-1', 'done');

  assert.equal(emailTriage.getUrgentEmails().length, 1, 'panel must drop it');
  assert.equal(nudges.getUrgentEmails().length, 1, 'and so must the nudge');
});

test('nothing outstanding says nothing at all', () => {
  seed([email({ dismissed: true })]);
  assert.equal(nudges.getUrgentEmails().length, 0);
  // A null message is what clears the banner rather than raising an empty one.
  assert.equal(nudges.buildEmailMessage(nudges.getUrgentEmails()), null);
});

test('the message names the sender off the triage record, not a DB column', () => {
  seed([email(), email({ id: 'AAMk-2' })]);
  const msg = nudges.buildEmailMessage(nudges.getUrgentEmails());
  // `from_name`/`from_email` were the retired table's columns; reading those
  // off a triage record yields "undefined" in a push notification.
  assert.match(msg, /^2 urgent emails need a reply — including one from Phillipa Legg\.$/);
});

// The mailbox being unreadable must never be published as an empty inbox —
// especially now the urgent banner is driven off this pass. `null` (could not
// look) and `[]` (looked, nothing there) were one branch, and both wiped the
// stored triage.
test('an unreachable mailbox keeps the last known triage instead of clearing it', async () => {
  seed([email()]);
  const microsoft = require('./microsoft');
  const realFetch = microsoft.fetchRecentEmails;
  const realAuth = microsoft.isAuthenticated;
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmails = async () => null;
  try {
    const result = await emailTriage.runTriage();
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.match(result.reason, /unreachable/);
    assert.equal(emailTriage.getUrgentEmails().length, 1, 'the banner must not be silenced by a failed look');
  } finally {
    microsoft.fetchRecentEmails = realFetch;
    microsoft.isAuthenticated = realAuth;
  }
});

// A fully actioned inbox is the normal end of a good day. Gating the skip on
// "something undismissed is stored" would pay for a full classification every
// 30 minutes exactly when there is nothing to do.
test('unchanged mail skips the model call, even with everything dismissed', async () => {
  const microsoft = require('./microsoft');
  const realFetch = microsoft.fetchRecentEmails;
  const realAuth = microsoft.isAuthenticated;
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmails = async () => [{ id: 'AAMk-1' }, { id: 'AAMk-2' }];
  // Stubbed, or the forced run below makes a real cloud call and spends the
  // daily AI budget to prove a control-flow branch.
  const aiProvider = require('./ai-provider');
  const realTriage = aiProvider.triageEmails;
  aiProvider.triageEmails = async () => ({ text: '[]', provider: 'stub' });
  try {
    seed([email({ dismissed: true }), email({ id: 'AAMk-2', dismissed: true })]);
    // Fingerprint the same input the next run will see.
    db.setState('email_triage_input', emailTriage._internals.inputFingerprint([{ id: 'AAMk-2' }, { id: 'AAMk-1' }]));

    const result = await emailTriage.runTriage();
    assert.equal(result.skipped, true, 'same mail must not be reclassified');
    assert.equal(result.classified, 0, 'a skip classified nothing and must say so');
    // Every branch counts what is OUTSTANDING, never what the pass looked at:
    // both of these are dismissed, so there is nothing to report.
    assert.equal(result.urgent, 0);
    assert.equal(result.count, 0);

    const forced = await emailTriage.runTriage({ force: true });
    assert.notEqual(forced.skipped, true, 'force must actually re-run');
  } finally {
    microsoft.fetchRecentEmails = realFetch;
    microsoft.isAuthenticated = realAuth;
    aiProvider.triageEmails = realTriage;
  }
});

test('the fingerprint is order-independent — mail is a set, not a sequence', () => {
  const fp = emailTriage._internals.inputFingerprint;
  assert.equal(fp([{ id: 'b' }, { id: 'a' }]), fp([{ id: 'a' }, { id: 'b' }]));
  assert.notEqual(fp([{ id: 'a' }]), fp([{ id: 'a' }, { id: 'c' }]));
});

// ── Every fetched email reaches the model ──────────────────────────────────

function inbox(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `mail-${i}`,
    subject: `Subject ${i}`,
    from: `Sender ${i}`,
    fromEmail: `s${i}@example.com`,
    preview: 'Some ordinary body text with nothing special in it.',
    received: new Date().toISOString(),
    isRead: true,
  }));
}

// We fetch 40 and the model only ever saw the first 20; the other 20 fell
// through to aiCategory 'FYI', indistinguishable from a real verdict.
test('all 40 fetched emails reach the model, in batches', async () => {
  const microsoft = require('./microsoft');
  const aiProvider = require('./ai-provider');
  const realFetch = microsoft.fetchRecentEmails;
  const realAuth = microsoft.isAuthenticated;
  const realTriage = aiProvider.triageEmails;

  const batchSizes = [];
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmails = async () => inbox(40);
  aiProvider.triageEmails = async (prompt) => {
    const n = (prompt.match(/^\[\d+\] From:/gm) || []).length;
    batchSizes.push(n);
    return {
      provider: 'stub',
      text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ index: i, category: 'ACTION', reason: 'stub' }))),
    };
  };

  try {
    seed([]);
    db.setState('email_triage_input', '');
    db.setState('email_triage_feedback_rollup', '');
    await emailTriage.runTriage({ force: true });

    assert.deepEqual(batchSizes, [20, 20], 'two batches of 20, not one truncated call');
    const stored = JSON.parse(db.getState('email_triage'));
    assert.equal(stored.length, 40);
    assert.equal(stored.filter(e => e.aiClassified).length, 40, 'every email got a model verdict');
    // Batch-local indices must be mapped back, or batch 2's answers land on
    // batch 1's emails — the silent way this could go wrong.
    assert.equal(stored[39].aiCategory, 'ACTION');
  } finally {
    microsoft.fetchRecentEmails = realFetch;
    microsoft.isAuthenticated = realAuth;
    aiProvider.triageEmails = realTriage;
  }
});

test('a failed batch costs only itself, and unanswered mail says so', async () => {
  const microsoft = require('./microsoft');
  const aiProvider = require('./ai-provider');
  const realFetch = microsoft.fetchRecentEmails;
  const realAuth = microsoft.isAuthenticated;
  const realTriage = aiProvider.triageEmails;

  let call = 0;
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmails = async () => inbox(40);
  aiProvider.triageEmails = async (prompt) => {
    if (++call === 1) throw new Error('rate limited');
    const n = (prompt.match(/^\[\d+\] From:/gm) || []).length;
    return {
      provider: 'stub',
      text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ index: i, category: 'ACTION', reason: 'stub' }))),
    };
  };

  try {
    seed([]);
    db.setState('email_triage_input', '');
    await emailTriage.runTriage({ force: true });
    const stored = JSON.parse(db.getState('email_triage'));
    assert.equal(stored.filter(e => e.aiClassified).length, 20, 'the surviving batch still lands');
    // The failed half must NOT claim a verdict it never got.
    const unanswered = stored.filter(e => !e.aiClassified);
    assert.equal(unanswered.length, 20);
    assert.ok(unanswered.every(e => e.aiCategory === null), 'no answer is null, never "FYI"');
  } finally {
    microsoft.fetchRecentEmails = realFetch;
    microsoft.isAuthenticated = realAuth;
    aiProvider.triageEmails = realTriage;
  }
});

// ── The store must not become the next pile ────────────────────────────────

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

test('a dismissed entry is compacted — the body is dead weight once it is gone', () => {
  db.setState('email_triage_feedback_rollup', '');
  emailTriage._internals.storeTriage([
    email({ dismissed: true, dismissedAt: daysAgo(1), dismissReason: 'done' }),
    email({ id: 'AAMk-2' }),
  ]);

  const [dismissed, live] = JSON.parse(db.getState('email_triage'));
  assert.equal(dismissed.preview, undefined, 'a dismissed entry keeps no body');
  assert.equal(dismissed.subject, undefined);
  // What it MUST keep: the id (so the merge cannot resurrect it) and the
  // fields the #70 feedback score reads.
  assert.equal(dismissed.id, 'AAMk-1');
  assert.equal(dismissed.dismissed, true);
  assert.equal(dismissed.dismissReason, 'done');
  assert.equal(dismissed.urgency, 'high');
  assert.equal(dismissed.category, 'ACTION');
  assert.equal(live.preview, 'Just to add to this —', 'an outstanding entry is untouched');
});

test('old dismissed entries are pruned, and their verdict survives them', () => {
  db.setState('email_triage_feedback_rollup', '');
  const retain = emailTriage._internals.DISMISSED_RETAIN_DAYS;
  emailTriage._internals.storeTriage([
    email({ id: 'old-1', dismissed: true, dismissedAt: daysAgo(retain + 1), dismissReason: 'not-relevant' }),
    email({ id: 'old-2', dismissed: true, dismissedAt: daysAgo(retain + 1), dismissReason: 'done' }),
    email({ id: 'recent', dismissed: true, dismissedAt: daysAgo(1), dismissReason: 'done' }),
    email({ id: 'live' }),
  ]);

  const kept = JSON.parse(db.getState('email_triage')).map(e => e.id);
  assert.deepEqual(kept, ['recent', 'live'], 'only the aged-out dismissals go');

  // Pruning must cost history, not throw it away: all three judgements still
  // count, or the classifier's score silently resets every week.
  const fb = emailTriage.getDismissFeedback();
  assert.equal(fb.judged, 3);
  assert.equal(fb.notRelevant, 1);
  assert.equal(fb.misrankRate, 33);
});

test('a dismissal with no timestamp is kept rather than aged by guesswork', () => {
  db.setState('email_triage_feedback_rollup', '');
  emailTriage._internals.storeTriage([
    email({ id: 'undated', dismissed: true, dismissedAt: null, dismissReason: 'done' }),
  ]);
  assert.equal(JSON.parse(db.getState('email_triage')).length, 1);
});

test('clearing does not make the classifier forget it was ever corrected', () => {
  db.setState('email_triage_feedback_rollup', '');
  seed([
    email({ dismissed: true, dismissedAt: daysAgo(1), dismissReason: 'not-relevant' }),
    email({ id: 'AAMk-2' }),
  ]);
  emailTriage.clearDismissed();

  assert.equal(JSON.parse(db.getState('email_triage')).length, 1, 'dismissed entries are gone');
  assert.equal(emailTriage.getDismissFeedback().notRelevant, 1, 'the correction is not');
});

test('the chat context feed can tell "not looked yet" from "inbox clear"', () => {
  seed([]);
  db.setState('email_triage_time', '');
  assert.equal(emailTriage.getFlaggedItems().lastScan, null);

  seed([email({ lane: 'ignore', category: 'IGNORE' }), email({ id: 'AAMk-2' })]);
  db.setState('email_triage_time', String(Date.UTC(2026, 7, 26, 12, 0, 0)));
  const flagged = emailTriage.getFlaggedItems();
  assert.equal(flagged.items.length, 1, 'ignored mail is not context');
  assert.equal(flagged.items[0].emailId, 'AAMk-2');
  assert.ok(flagged.lastScan, 'a run that happened must be datable');
});
