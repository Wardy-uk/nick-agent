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
  const realFetch = microsoft.fetchRecentEmailsDetailed;
  const realAuth = microsoft.isAuthenticated;
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ emails: null, complete: false });
  try {
    const result = await emailTriage.runTriage();
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.match(result.reason, /unreachable/);
    assert.equal(emailTriage.getUrgentEmails().length, 1, 'the banner must not be silenced by a failed look');
  } finally {
    microsoft.fetchRecentEmailsDetailed = realFetch;
    microsoft.isAuthenticated = realAuth;
  }
});

// A fully actioned inbox is the normal end of a good day. Gating the skip on
// "something undismissed is stored" would pay for a full classification every
// 30 minutes exactly when there is nothing to do.
test('unchanged mail skips the model call, even with everything dismissed', async () => {
  const microsoft = require('./microsoft');
  const realFetch = microsoft.fetchRecentEmailsDetailed;
  const realAuth = microsoft.isAuthenticated;
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ emails: [{ id: 'AAMk-1' }, { id: 'AAMk-2' }], complete: true });
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
    microsoft.fetchRecentEmailsDetailed = realFetch;
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
  const realFetch = microsoft.fetchRecentEmailsDetailed;
  const realAuth = microsoft.isAuthenticated;
  const realTriage = aiProvider.triageEmails;

  const batchSizes = [];
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ emails: inbox(40), complete: true });
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
    microsoft.fetchRecentEmailsDetailed = realFetch;
    microsoft.isAuthenticated = realAuth;
    aiProvider.triageEmails = realTriage;
  }
});

test('a failed batch costs only itself, and unanswered mail says so', async () => {
  const microsoft = require('./microsoft');
  const aiProvider = require('./ai-provider');
  const realFetch = microsoft.fetchRecentEmailsDetailed;
  const realAuth = microsoft.isAuthenticated;
  const realTriage = aiProvider.triageEmails;

  let call = 0;
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ emails: inbox(40), complete: true });
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
    microsoft.fetchRecentEmailsDetailed = realFetch;
    microsoft.isAuthenticated = realAuth;
    aiProvider.triageEmails = realTriage;
  }
});

// ── "This should have been an action" ──────────────────────────────────────

test('promoting moves an email into ACTION without dismissing it', () => {
  db.setState('email_triage_feedback_rollup', '');
  seed([email({ id: 'fyi-1', lane: 'fyi', category: 'FYI', urgency: 'low' })]);

  assert.equal(emailTriage.promoteEmail('fyi-1').ok, true);

  const cat = emailTriage.getTriageByCategory();
  assert.equal(cat.action.length, 1, 'it lands in the ACTION group');
  assert.equal(cat.fyi.length, 0, 'and leaves FYI');
  assert.ok(!cat.action[0].dismissed, 'it is NOT dismissed — it stays on screen');
  // Never the urgent lane: that is what pushes a notification, and a correction
  // made while reading the panel must not interrupt the person reading it.
  assert.equal(cat.action[0].lane, 'reply');
  assert.equal(emailTriage.getUrgentEmails().length, 0);
});

// The one that matters: at a 30-minute cadence a promotion that did not survive
// the merge would silently drop back to FYI within the half hour, so the button
// would appear to work and then quietly undo itself.
test('a promotion survives the next re-classification', async () => {
  const microsoft = require('./microsoft');
  const aiProvider = require('./ai-provider');
  const realFetch = microsoft.fetchRecentEmailsDetailed;
  const realAuth = microsoft.isAuthenticated;
  const realTriage = aiProvider.triageEmails;

  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ complete: true, emails: [{
    // Neutral on purpose: "digest", "weekly report" and friends are NOISE
    // keywords that force IGNORE deterministically, which would land this in
    // the wrong section before the promotion is even reached.
    id: 'fyi-1', subject: 'Team notes from Tuesday', from: 'Someone', fromEmail: 's@example.com',
    preview: 'Sharing where we got to.', received: new Date().toISOString(), isRead: true,
  }] });
  // The model keeps calling it FYI — exactly the disagreement being overridden.
  aiProvider.triageEmails = async () => ({
    provider: 'stub',
    text: JSON.stringify([{ index: 0, category: 'FYI', reason: 'digest' }]),
  });

  try {
    db.setState('email_triage_feedback_rollup', '');
    db.setState('email_triage_input', '');
    seed([]);
    await emailTriage.runTriage({ force: true });
    assert.equal(emailTriage.getTriageByCategory().fyi.length, 1);

    emailTriage.promoteEmail('fyi-1');
    db.setState('email_triage_input', '');
    await emailTriage.runTriage({ force: true });

    const cat = emailTriage.getTriageByCategory();
    assert.equal(cat.action.length, 1, 'still ACTION after a full re-classify');
    assert.equal(cat.fyi.length, 0);
    assert.equal(cat.action[0].promoted, true);
  } finally {
    microsoft.fetchRecentEmailsDetailed = realFetch;
    microsoft.isAuthenticated = realAuth;
    aiProvider.triageEmails = realTriage;
  }
});

test('promoting records the miss against what triage SAID', () => {
  db.setState('email_triage_feedback_rollup', '');
  seed([email({ id: 'fyi-1', lane: 'fyi', category: 'FYI', urgency: 'low' })]);
  emailTriage.promoteEmail('fyi-1');

  const fb = emailTriage.getDismissFeedback();
  assert.equal(fb.underRanked, 1);
  assert.equal(fb.judged, 1);
  assert.equal(fb.underRankRate, 100);
  assert.equal(fb.overRankRate, 0);
  // Both directions count as a misrank — a score that only counted over-ranking
  // flattered the classifier for the failure that costs most.
  assert.equal(fb.misrankRate, 100);
  assert.equal(fb.byCategory['low/FYI'].underRanked, 1, 'attributed to the verdict that was wrong');
});

// `readRollup` normalises the stored blob and is ALSO what the fold reads
// before incrementing, so a counter it forgets to carry resets to 0 on every
// write and can never reach 2. It shipped that way for exactly one test run.
test('the under-ranked counter accumulates rather than resetting each time', () => {
  db.setState('email_triage_feedback_rollup', '');
  seed([
    email({ id: 'a', lane: 'fyi', category: 'FYI', urgency: 'low' }),
    email({ id: 'b', lane: 'fyi', category: 'FYI', urgency: 'low' }),
    email({ id: 'c', lane: 'delegate', category: 'DELEGATE', urgency: 'low' }),
  ]);
  emailTriage.promoteEmail('a');
  emailTriage.promoteEmail('b');
  emailTriage.promoteEmail('c');

  const fb = emailTriage.getDismissFeedback();
  assert.equal(fb.underRanked, 3);
  assert.equal(fb.judged, 3);
  assert.equal(fb.byCategory['low/FYI'].underRanked, 2);
  assert.equal(fb.byCategory['low/DELEGATE'].underRanked, 1);
});

test('promoting something that is gone reports it rather than claiming success', () => {
  seed([email({ id: 'gone', dismissed: true, dismissedAt: new Date().toISOString() })]);
  assert.deepEqual(emailTriage.promoteEmail('gone'), { ok: false, reason: 'already dismissed' });
  assert.deepEqual(emailTriage.promoteEmail('never-seen'), { ok: false, reason: 'not in triage' });
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
  const retain = emailTriage._internals.DISMISSED_RETAIN_DAYS();
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

// ── Nothing drops out by age (1 Sep 2026) ──────────────────────────────────
//
// The merge kept `existing.filter(dismissed)` plus whatever the fetch returned,
// and the fetch was 24 hours of the newest 40 messages. So the store's memory
// was exactly backwards: mail Nick had FINISHED with survived a week, and mail
// he had not dealt with vanished a day after it arrived. The ACTION lane
// emptied itself overnight and a promotion expired in 24 hours.

function stubFetch(emails, complete = true) {
  const microsoft = require('./microsoft');
  const aiProvider = require('./ai-provider');
  const real = {
    fetch: microsoft.fetchRecentEmailsDetailed,
    auth: microsoft.isAuthenticated,
    triage: aiProvider.triageEmails,
  };
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ emails, complete });
  aiProvider.triageEmails = async (prompt) => {
    const n = (prompt.match(/^\[\d+\] From:/gm) || []).length;
    return {
      provider: 'stub',
      text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ index: i, category: 'FYI', reason: 'stub' }))),
    };
  };
  return () => {
    microsoft.fetchRecentEmailsDetailed = real.fetch;
    microsoft.isAuthenticated = real.auth;
    aiProvider.triageEmails = real.triage;
  };
}

test('an unanswered email older than the window is carried forward, not dropped', async () => {
  const restore = stubFetch([]);
  try {
    db.setState('email_triage_input', '');
    // 30 days old: outside anything the fetch looked at, and never actioned.
    seed([email({ id: 'old-1', received: daysAgo(30) })]);
    await emailTriage.runTriage({ force: true });

    const cat = emailTriage.getTriageByCategory();
    assert.equal(cat.action.length, 1, 'age is never a reason to drop unanswered mail');
    assert.equal(emailTriage.getUrgentEmails().length, 1);
  } finally { restore(); }
});

test('a promotion outlives the fetch window', async () => {
  const restore = stubFetch([]);
  try {
    db.setState('email_triage_feedback_rollup', '');
    db.setState('email_triage_input', '');
    seed([email({ id: 'fyi-old', lane: 'fyi', category: 'FYI', urgency: 'low', received: daysAgo(30) })]);
    assert.equal(emailTriage.promoteEmail('fyi-old').ok, true);

    await emailTriage.runTriage({ force: true });
    const cat = emailTriage.getTriageByCategory();
    assert.equal(cat.action.length, 1, '"keep this in front of me" must not expire');
    assert.equal(cat.action[0].promoted, true);
  } finally { restore(); }
});

// Absence is only evidence when we actually saw the whole window.
test('an incomplete read never concludes an email has gone', async () => {
  const restore = stubFetch([], false);
  try {
    db.setState('email_triage_input', '');
    seed([email({ id: 'recent-1', received: daysAgo(1) })]);
    await emailTriage.runTriage({ force: true });
    assert.equal(emailTriage.getTriageByCategory().action.length, 1,
      'a capped or part-failed page walk must not sweep the panel');
  } finally { restore(); }
});

test('an email that has left the Inbox is closed, and is not counted as feedback', async () => {
  const restore = stubFetch([], true);
  try {
    db.setState('email_triage_feedback_rollup', '');
    db.setState('email_triage_input', '');
    seed([email({ id: 'filed-1', received: daysAgo(1) })]);
    await emailTriage.runTriage({ force: true });

    assert.equal(emailTriage.getTriageByCategory().action.length, 0,
      'deleted or filed in Outlook — it is off his plate');
    const stored = JSON.parse(db.getState('email_triage'));
    const gone = stored.find(e => e.id === 'filed-1');
    assert.equal(gone.dismissed, true);
    assert.equal(gone.dismissReason, 'left-inbox');
    // It is NEURO noticing, not Nick judging the classifier.
    assert.equal(emailTriage.getDismissFeedback().judged, 0);
  } finally { restore(); }
});

// The 30-minute cadence over a 14-day window is only affordable because an
// email's text never changes, so neither does its model answer.
test('an already-classified email is not sent to the model again', async () => {
  const microsoft = require('./microsoft');
  const aiProvider = require('./ai-provider');
  const realFetch = microsoft.fetchRecentEmailsDetailed;
  const realAuth = microsoft.isAuthenticated;
  const realTriage = aiProvider.triageEmails;
  const seen = [];
  const mail = inbox(3);
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ emails: mail, complete: true });
  aiProvider.triageEmails = async (prompt) => {
    const n = (prompt.match(/^\[\d+\] From:/gm) || []).length;
    seen.push(n);
    return {
      provider: 'stub',
      text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ index: i, category: 'FYI', reason: 'stub' }))),
    };
  };
  try {
    seed([]);
    db.setState('email_triage_input', '');
    await emailTriage.runTriage({ force: true });
    assert.deepEqual(seen, [3]);

    // A new arrival changes the fingerprint, so the pass runs — but only the
    // one new email may cost anything.
    mail.push({ ...inbox(1)[0], id: 'mail-new' });
    await emailTriage.runTriage();
    assert.deepEqual(seen, [3, 1], 'only the new mail is sent to the model');
  } finally {
    microsoft.fetchRecentEmailsDetailed = realFetch;
    microsoft.isAuthenticated = realAuth;
    aiProvider.triageEmails = realTriage;
  }
});

// Pressing "Run Triage" must not re-buy verdicts. The first live press did:
// 663 emails re-classified, and the categories moved on no new information.
test('force skips the fingerprint check, not the classification cache', async () => {
  const microsoft = require('./microsoft');
  const aiProvider = require('./ai-provider');
  const realFetch = microsoft.fetchRecentEmailsDetailed;
  const realAuth = microsoft.isAuthenticated;
  const realTriage = aiProvider.triageEmails;
  const mail = inbox(3);
  let calls = 0;
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ emails: mail, complete: true });
  aiProvider.triageEmails = async (prompt) => {
    calls++;
    const n = (prompt.match(/^\[\d+\] From:/gm) || []).length;
    return {
      provider: 'stub',
      text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ index: i, category: 'FYI', reason: 'stub' }))),
    };
  };
  try {
    seed([]);
    db.setState('email_triage_input', '');
    await emailTriage.runTriage({ force: true });
    assert.equal(calls, 1);

    const forced = await emailTriage.runTriage({ force: true });
    assert.notEqual(forced.skipped, true, 'force must still re-run the pass');
    assert.equal(calls, 1, 'but it must not pay for verdicts it already has');
  } finally {
    microsoft.fetchRecentEmailsDetailed = realFetch;
    microsoft.isAuthenticated = realAuth;
    aiProvider.triageEmails = realTriage;
  }
});

// A provider that is down, refusing, or out of credit returns no text. That
// used to become an empty array — indistinguishable from the model reading the
// batch and classifying nothing — so whole runs came back unanswered with no
// error anywhere (found live 1 Sep 2026: the Anthropic key had no credit).
test('a provider that answers nothing is a failed batch, not an empty verdict', async () => {
  const microsoft = require('./microsoft');
  const aiProvider = require('./ai-provider');
  const realFetch = microsoft.fetchRecentEmailsDetailed;
  const realAuth = microsoft.isAuthenticated;
  const realTriage = aiProvider.triageEmails;
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ emails: inbox(2), complete: true });
  try {
    seed([]);
    db.setState('email_triage_input', '');
    aiProvider.triageEmails = async () => ({ text: '', provider: 'none' });
    await emailTriage.runTriage({ force: true });
    let stored = JSON.parse(db.getState('email_triage'));
    assert.equal(stored.filter(e => e.aiClassified).length, 0);
    assert.ok(stored.every(e => e.aiCategory === null), 'no answer is null, never a category');

    // Truncated by the token budget: no closing bracket, so it is a cut-off
    // answer rather than an empty one.
    seed([]);
    db.setState('email_triage_input', '');
    aiProvider.triageEmails = async () => ({ text: '[{"index": 0, "category": "ACT', provider: 'stub' });
    await emailTriage.runTriage({ force: true });
    stored = JSON.parse(db.getState('email_triage'));
    assert.equal(stored.filter(e => e.aiClassified).length, 0, 'half an answer is no answer');
  } finally {
    microsoft.fetchRecentEmailsDetailed = realFetch;
    microsoft.isAuthenticated = realAuth;
    aiProvider.triageEmails = realTriage;
  }
});

// -- Muting a sender (4 Sep 2026) -------------------------------------------
//
// The bug: "Not relevant" was a statement about one MESSAGE, and the mail it
// gets pressed on is a newsletter with a fresh id every day. Thirteen National
// Club Golfer emails sat undismissed in the live store, ten dismissals deep.

const { applySenderMute, readSenderRules, SENDER_MUTED, LOOKBACK_DAYS,
  DISMISSED_RETAIN_DAYS } = emailTriage._internals;

function clearRules() {
  db.setState('email_triage_muted_senders', '{}');
  db.setState('email_triage_feedback_rollup', '');
}

test('a dismissal outlives every fetch that can still return its id', () => {
  // The other half of the same complaint: retention was a literal 7 while the
  // lookback window had widened to 14, so a dismissal on mail still sitting in
  // the Inbox was pruned on day 7 and re-fetched on day 8 as brand new mail.
  assert.ok(DISMISSED_RETAIN_DAYS() > LOOKBACK_DAYS,
    'a dismissed entry must survive longer than the window that can re-fetch it');
});

test('"not relevant" mutes the sender, and sweeps what is already in the panel', () => {
  clearRules();
  seed([
    email({ id: 'golf-1', from: 'National Club Golfer', fromEmail: 'news@nationalclubgolfer.com' }),
    email({ id: 'golf-2', from: 'National Club Golfer', fromEmail: 'NEWS@NationalClubGolfer.com' }),
    email({ id: 'golf-3', from: 'National Club Golfer', fromEmail: 'news@nationalclubgolfer.com' }),
    email({ id: 'colleague', fromEmail: 'phillipa@example.com' }),
  ]);

  const result = emailTriage.dismissEmail('golf-1', 'not-relevant');
  assert.equal(result.muted.ok, true);
  assert.equal(result.muted.muted, 'news@nationalclubgolfer.com', 'the address, lowercased');

  const byId = new Map(emailTriage.getStoredTriage().map(e => [e.id, e]));
  // The whole complaint: the twelve editions that arrived before he got round
  // to pressing it are exactly the mail he is telling us he does not want.
  assert.equal(byId.get('golf-2').dismissed, true, 'case differs, same sender');
  assert.equal(byId.get('golf-2').dismissReason, SENDER_MUTED);
  assert.equal(byId.get('golf-3').dismissed, true);
  assert.equal(byId.get('colleague').dismissed, false, 'nobody else is touched');
});

test('the rule outlives the entries it produced - new mail is filed with no second press', () => {
  clearRules();
  seed([email({ id: 'golf-1', fromEmail: 'news@nationalclubgolfer.com' })]);
  emailTriage.dismissEmail('golf-1', 'not-relevant');

  // Tomorrow's edition: a different id, a different subject, and nothing left
  // in the store that remembers it - only the rule.
  const tomorrow = applySenderMute(
    email({ id: 'golf-99', subject: 'Tiger Woods banned from driving', fromEmail: 'news@nationalclubgolfer.com' }),
    readSenderRules(),
  );
  assert.equal(tomorrow.dismissed, true);
  assert.equal(tomorrow.category, 'IGNORE');
  assert.equal(tomorrow.lane, 'ignore');
  assert.equal(tomorrow.urgent, false);
});

test('a muted sender is NOT a verdict Nick made about each message', () => {
  clearRules();
  seed([
    email({ id: 'golf-1', fromEmail: 'news@nationalclubgolfer.com' }),
    ...Array.from({ length: 12 }, (_, i) =>
      email({ id: 'golf-x' + i, fromEmail: 'news@nationalclubgolfer.com' })),
  ]);
  emailTriage.dismissEmail('golf-1', 'not-relevant');

  // One press, one verdict. Counting the twelve auto-filed ones would let a
  // single mute swamp the whole #70 feedback score.
  const fb = emailTriage.getDismissFeedback();
  assert.equal(fb.judged, 1, 'he judged the sender once, not thirteen times');
  assert.equal(fb.notRelevant, 1);
});

test('a mute never overwrites what Nick already recorded about a message', () => {
  clearRules();
  seed([
    email({ id: 'golf-1', fromEmail: 'news@nationalclubgolfer.com' }),
    email({ id: 'golf-done', fromEmail: 'news@nationalclubgolfer.com',
      dismissed: true, dismissedAt: daysAgo(1), dismissReason: 'done' }),
  ]);
  emailTriage.dismissEmail('golf-1', 'not-relevant');

  const done = emailTriage.getStoredTriage().find(e => e.id === 'golf-done');
  assert.equal(done.dismissReason, 'done', 'his record of what he did with it stands');
});

test('an unusable sender is REFUSED, not muted as an empty rule', () => {
  clearRules();
  // A rule keyed on "" would match every email whose sender could not be read.
  seed([email({ id: 'nofrom', fromEmail: null }), email({ id: 'other', fromEmail: 'a@b.com' })]);
  const result = emailTriage.dismissEmail('nofrom', 'not-relevant');

  assert.equal(result.muted.ok, false, 'and it says so rather than silently no-opping');
  assert.ok(result.muted.reason);
  assert.deepEqual(readSenderRules(), {});
  assert.equal(emailTriage.getStoredTriage().find(e => e.id === 'other').dismissed, false);
});

test('Nicks own address is refused - the one rule with unbounded blast radius', () => {
  clearRules();
  seed([email({ id: 'self', fromEmail: 'NickW@Nurtur.tech' })]);
  const result = emailTriage.dismissEmail('self', 'not-relevant',
    { selfAddress: 'nickw@nurtur.tech' });

  assert.equal(result.muted.ok, false);
  assert.deepEqual(readSenderRules(), {},
    'muting yourself would hide your own mail with no visible cause');
});

test('an unknown signed-in address does not break the button', () => {
  // Refusing here would kill the feature on exactly the days Microsoft auth has
  // expired. The recoverable half is the panel's list, not this check.
  clearRules();
  seed([email({ id: 'golf-1', fromEmail: 'news@nationalclubgolfer.com' })]);
  const result = emailTriage.dismissEmail('golf-1', 'not-relevant', { selfAddress: null });

  assert.equal(result.muted.ok, true);
  assert.equal(emailTriage.listMutedSenders().length, 1, 'and it is listed, so it can be undone');
});

test('un-muting is possible, and does not resurrect what was filed', () => {
  clearRules();
  seed([
    email({ id: 'golf-1', fromEmail: 'news@nationalclubgolfer.com' }),
    email({ id: 'golf-2', fromEmail: 'news@nationalclubgolfer.com' }),
  ]);
  emailTriage.dismissEmail('golf-1', 'not-relevant');
  assert.equal(emailTriage.listMutedSenders().length, 1);

  assert.equal(emailTriage.unmuteSender('NEWS@nationalclubgolfer.com').ok, true, 'case-insensitive');
  assert.deepEqual(emailTriage.listMutedSenders(), []);
  // "Show me this sender from now on", not "put a fortnight of newsletters back".
  assert.equal(emailTriage.getStoredTriage().find(e => e.id === 'golf-2').dismissed, true);
  assert.equal(emailTriage.unmuteSender('news@nationalclubgolfer.com').ok, false, 'and says so');
});

test('"done" and "replied" mute nobody', () => {
  clearRules();
  seed([email({ id: 'a', fromEmail: 'colleague@nurtur.tech' })]);
  emailTriage.dismissEmail('a', 'done');
  assert.deepEqual(readSenderRules(), {},
    'only "not relevant" is a statement about the sender');
});

// ── The FYI section ages out (7 Sep 2026) ───────────────────────────────────
//
// 715 informational emails standing in one collapsed section. The rule closes
// them; what these pin is everything it must NOT close.

const AGE_DAY = 86400000;
const NOW = Date.parse('2026-09-07T12:00:00Z');
const aged = (items, opts = {}) =>
  emailTriage._internals.ageOutInformational(items, { now: NOW, ...opts });
const before = d => new Date(NOW - d * AGE_DAY).toISOString();

function info(over = {}) {
  return email({
    id: 'info-1', category: 'FYI', lane: 'fyi', urgency: 'low',
    received: before(10), ...over,
  });
}

test('FYI older than the window is closed, and stamped as NEURO acting', () => {
  const out = aged([info()]);
  assert.equal(out.aged, 1);
  assert.equal(out.entries[0].dismissed, true);
  assert.equal(out.entries[0].dismissReason, 'aged-out');
});

test('the sweep covers IGNORE too — the section is 715, the category is 224', () => {
  // The panel renders FYI and IGNORE under one "FYI (N)" heading. Sweeping the
  // category alone clears a third of what Nick is looking at, which reads as a
  // fix that did not work.
  const out = aged([info({ id: 'a' }), info({ id: 'b', category: 'IGNORE', lane: 'ignore' })]);
  assert.equal(out.aged, 2);
});

test('inside the window is left alone, and the array is returned unchanged', () => {
  const items = [info({ received: before(6) })];
  const out = aged(items);
  assert.equal(out.aged, 0);
  // Identity, so a caller can skip the write.
  assert.equal(out.entries, items);
});

test('ACTION and DELEGATE never age out, at any age', () => {
  const out = aged([
    info({ id: 'a', category: 'ACTION', lane: 'reply', received: before(90) }),
    info({ id: 'b', category: 'DELEGATE', received: before(90) }),
  ]);
  assert.equal(out.aged, 0);
});

test('a promoted entry is never aged out', () => {
  // "Keep this in front of me" is Nick overruling the classifier; a NEURO rule
  // does not get to overrule that back.
  const out = aged([info({ promoted: true, category: 'FYI' })]);
  assert.equal(out.aged, 0);
});

test('no readable received date means KEPT, never guessed old', () => {
  assert.equal(aged([info({ received: null })]).aged, 0);
  assert.equal(aged([info({ received: 'not a date' })]).aged, 0);
});

test('an already-dismissed entry keeps Nick\'s own verdict', () => {
  const out = aged([info({
    dismissed: true, dismissReason: 'not-relevant', dismissedAt: before(9),
  })]);
  assert.equal(out.aged, 0);
  assert.equal(out.entries[0].dismissReason, 'not-relevant');
});

test('days <= 0 switches the rule OFF rather than ageing everything out', () => {
  assert.equal(aged([info({ received: before(400) })], { days: 0 }).aged, 0);
  assert.equal(aged([info({ received: before(400) })], { days: NaN }).aged, 0);
});

test('an aged-out email is NOT a verdict — it stays out of the feedback score', () => {
  seed([
    info({ id: 'x', dismissed: true, dismissReason: 'aged-out', dismissedAt: before(1) }),
    email({ id: 'y', dismissed: true, dismissReason: 'not-relevant', dismissedAt: before(1) }),
  ]);
  const fb = emailTriage.getDismissFeedback();
  // One judged verdict, Nick's. Hundreds of timed-out FYIs must not swamp it.
  assert.equal(fb.judged, 1);
});

test('purge applies the rule, and dryRun changes nothing', () => {
  seed([info({ id: 'p1' }), info({ id: 'p2', received: before(2) })]);
  const preview = emailTriage.purgeAgedInformational({ dryRun: true });
  assert.equal(preview.aged, 1);
  assert.equal(emailTriage.getStoredTriage().filter(e => e.dismissed).length, 0);

  const done = emailTriage.purgeAgedInformational();
  assert.equal(done.aged, 1);
  const stored = emailTriage.getStoredTriage();
  assert.equal(stored.filter(e => e.dismissed).length, 1);
  assert.equal(stored.filter(e => !e.dismissed)[0].id, 'p2');
});
