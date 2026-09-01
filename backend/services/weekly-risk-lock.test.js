'use strict';

/**
 * A sent week is a RECORD, not a draft.
 *
 * Every route in this service rebuilds from live data, which is right while the
 * report is being worked on — it is how a figure corrected on Monday morning
 * reaches the version Chris gets. The moment it is sent, that becomes the wrong
 * behaviour: the only honest answer to "what did I send Chris?" is the words
 * that left, and a rebuild would quietly show different numbers a week later
 * under a banner saying the report had been sent.
 *
 * Four things are pinned, and the second is the one that would be tempting to
 * simplify away:
 *
 *  1. build() hands back the sent body verbatim while the week is locked, and
 *     never touches the live snapshot to do it.
 *  2. SENT and LOCKED are separate. Reopening restores rebuilding; it must not
 *     erase the fact that Chris has had it. One boolean cannot say both.
 *  3. A locked week refuses a second send, in words, naming the way out — that
 *     is what stops the same report reaching a manager twice.
 *  4. A reopened week rebuilds live but STILL reports what was sent, so the
 *     screen can say the figures may no longer match.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'wr-lock-')), 'scratch.db',
);

const db = require('../db/database');
const wr = require('./weekly-risk');

test.before(async () => { await db.init(); });

const WEEK = '2026-08-24';

function sendIt(week = WEEK, body = '# The report as it was sent\n\nOpen commitments: 31.') {
  return wr.markSent(week, {
    actionId: 42,
    recipients: [{ name: 'Chris Middleton', email: 'chris@nurtur.tech' }],
    subject: `Weekly Risk & Anomaly Summary — w/c ${week}`,
    body,
  });
}

test('an unsent week is not locked and has no record', () => {
  assert.strictEqual(wr.sentRecord('2026-09-07'), null);
  assert.strictEqual(wr.isLocked('2026-09-07'), false);
});

test('build() returns the SENT body verbatim while locked, without rebuilding', async () => {
  const body = '# Frozen\n\nThis is exactly what left.';
  sendIt(WEEK, body);
  assert.strictEqual(wr.isLocked(WEEK), true);

  const report = await wr.build({ week: WEEK });
  assert.strictEqual(report.markdown, body, 'a rebuild here would show figures Chris never saw');
  assert.strictEqual(report.locked, true);
  assert.strictEqual(report.sent.recipients[0].email, 'chris@nurtur.tech');
  assert.strictEqual(report.sent.sendCount, 1);
});

test('live:true is the one way past the freeze, for a caller that means it', async () => {
  // The escape hatch exists so "what would it say today?" stays answerable on a
  // finished week. It must be asked for explicitly — never the default, or the
  // freeze is decorative.
  const report = await wr.build({ week: WEEK, live: true });
  assert.notStrictEqual(report.locked, true);
});

test('a locked week REFUSES a second send and names the way out', async () => {
  const result = await wr.queueSend({ week: WEEK });
  assert.strictEqual(result.ok, false);
  assert.match(result.blockers[0], /already sent/i);
  assert.match(result.blockers[0], /chris@nurtur\.tech/);
  // Naming the fix is the difference between a refusal and a dead end.
  assert.match(result.blockers[0], /reopen/i);
});

test('reopening restores rebuilding but KEEPS the record of having sent it', async () => {
  const result = wr.reopen(WEEK);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(wr.isLocked(WEEK), false, 'reopened means the screen may rebuild again');

  // ⚠ The fact does not become untrue. A single boolean for both questions
  // would have erased this.
  const rec = wr.sentRecord(WEEK);
  assert.ok(rec, 'the send record must survive a reopen');
  assert.ok(rec.reopenedAt, 'and must say when it was reopened');
  assert.strictEqual(rec.recipients[0].email, 'chris@nurtur.tech');
});

test('a reopened week rebuilds live and STILL reports what was sent', async () => {
  // Without this the screen cannot warn that the figures below may no longer
  // match what Chris received — a reopened week would look untouched.
  const report = await wr.build({ week: WEEK });
  assert.notStrictEqual(report.locked, true);
  assert.ok(report.sent, 'the sent summary must ride along on a reopened week');
  assert.ok(report.sent.reopenedAt);
});

test('reopening twice is not an error, and reopening an unsent week is', () => {
  const again = wr.reopen(WEEK);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.already, true);

  const never = wr.reopen('2026-09-14');
  assert.strictEqual(never.ok, false);
  assert.strictEqual(never.reason, 'not-sent');
});

test('sending again after a reopen counts the send and clears the reopen', () => {
  sendIt(WEEK, '# Second version\n\nDifferent numbers.');
  const rec = wr.sentRecord(WEEK);
  assert.strictEqual(rec.sendCount, 2, 'two sends is a fact the screen has to be able to state');
  assert.strictEqual(rec.reopenedAt, null);
  assert.strictEqual(wr.isLocked(WEEK), true);
});

test('the summary carries what a screen needs and NOT the body', () => {
  // The body is large and is already on the card; a summary that dragged it
  // along would put the whole report into every status poll.
  const summary = wr.sentSummary(wr.sentRecord(WEEK));
  assert.ok(summary.sentAt && summary.subject && summary.recipients.length);
  assert.strictEqual(summary.body, undefined);
  assert.strictEqual(summary.report, undefined);
});

test('a record with a body but no stashed build still freezes, and says it is report-only', async () => {
  // The shape a send queued before the stash existed leaves behind. It must not
  // silently fall through to a rebuild under a "sent" banner.
  const week = '2026-07-06';
  db.setState(`weekly_risk_sent_${week}`, JSON.stringify({
    week, sentAt: '2026-07-06T11:00:00.000Z', recipients: [{ email: 'chris@nurtur.tech' }],
    subject: 's', body: '# Old send', report: null, sendCount: 1, reopenedAt: null,
  }));
  const report = await wr.build({ week });
  assert.strictEqual(report.locked, true);
  assert.strictEqual(report.markdown, '# Old send');
  assert.strictEqual(report.reportOnly, true, 'the panel needs to know the stat tiles are unavailable');
});
