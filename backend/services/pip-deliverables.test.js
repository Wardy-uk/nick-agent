'use strict';

/**
 * PIP deliverables — the rules about what may and may not be claimed.
 *
 * `assess()` is pure, so what is under test is the product: which weeks count
 * as owed, what "produced" is allowed to mean, and what the tracker refuses to
 * say. Two failures here are expensive in opposite directions — telling Nick he
 * has sent something Chris never received, and telling him he missed a
 * deliverable that was never owed — so both are pinned.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const pip = require('./pip-deliverables');

// A Thursday inside the PIP window.
const TODAY = '2026-09-03';

// ── Refusal 1: produced and sent are different facts ─────────────────────────

test('a published week that was never sent is not counted as sent', () => {
  const r = pip.assess({
    weekly: [{ week: '2026-08-10', published: true, sent: false }],
    today: TODAY,
  });
  assert.equal(r.weekly.produced, 1);
  assert.equal(r.weekly.sent, 0, 'a draft on disk is not a thing Chris has received');
  assert.ok(r.weekly.producedNotSent.includes('2026-08-10'), 'and it must be named');
});

test('a sent week counts as both produced and sent', () => {
  const r = pip.assess({
    weekly: [{ week: '2026-08-10', published: true, sent: true }],
    today: TODAY,
  });
  assert.equal(r.weekly.produced, 1);
  assert.equal(r.weekly.sent, 1);
  assert.equal(r.weekly.producedNotSent.length, 0);
});

test('a sent week is never listed as missing', () => {
  const r = pip.assess({
    weekly: [{ week: '2026-08-10', published: false, sent: true }],
    today: TODAY,
  });
  assert.ok(!r.weekly.missing.includes('2026-08-10'));
});

// ── Refusal 2: a week before the cadence existed is not owed ─────────────────

test('weeks before the cadence was agreed are never counted as missed', () => {
  const r = pip.assess({ weekly: [], today: TODAY });
  // The PIP began 27 Jul; the Monday-midday cadence was agreed 12 Aug.
  for (const week of ['2026-07-27', '2026-08-03']) {
    assert.ok(!r.weekly.missing.includes(week), `${week} predates the standard`);
  }
  assert.equal(r.weekly.owedFrom, '2026-08-10');
});

test('the owed count starts at the cadence, not at the PIP start', () => {
  // 10, 17, 24, 31 Aug + 31 Aug's following weeks up to the week of 3 Sep.
  const owed = pip.weeksOwed(pip.WEEKLY_OWED_FROM, TODAY);
  assert.equal(owed[0], '2026-08-10');
  assert.equal(owed[owed.length - 1], '2026-08-31', 'the week containing 3 Sep');
  assert.equal(owed.length, 4);
});

// ── Refusal 4: the current week is not late until it is late ─────────────────

test('on Monday morning the current week is due, not late', () => {
  const r = pip.assess({ weekly: [], today: '2026-08-31', nowHour: 9 });
  assert.equal(r.weekly.current.state, 'due');
  assert.ok(!r.weekly.missing.includes('2026-08-31'), 'not missed before midday');
});

test('on Monday afternoon with nothing written it is late', () => {
  const r = pip.assess({ weekly: [], today: '2026-08-31', nowHour: 14 });
  assert.equal(r.weekly.current.state, 'late');
  assert.ok(r.weekly.missing.includes('2026-08-31'));
});

test('later in the week with nothing written it is late whatever the hour', () => {
  const r = pip.assess({ weekly: [], today: '2026-09-03', nowHour: 9 });
  assert.equal(r.weekly.current.state, 'late');
});

test('a week written but not sent says exactly that', () => {
  const r = pip.assess({
    weekly: [{ week: '2026-08-31', published: true, sent: false }],
    today: '2026-08-31',
    nowHour: 14,
  });
  assert.equal(r.weekly.current.state, 'written-not-sent');
});

// ── Refusal 3: an unreadable store is a gap, never a miss ────────────────────

test('a failed read is a named gap and never a clean record', () => {
  const r = pip.assess({
    weekly: [],
    log: null,
    gaps: [{ source: 'weekly-risk', why: 'db down' }],
    today: TODAY,
  });
  assert.equal(r.known, false);
  assert.equal(r.gaps[0].source, 'weekly-risk');
  assert.equal(r.log, null, 'a log that could not be read is null, never zeroes');
});

test('a genuinely clean read is known', () => {
  const r = pip.assess({ weekly: [], today: TODAY });
  assert.equal(r.known, true);
});

// ── The competency figures are LIFTED, never recomputed ──────────────────────

test('log figures come straight from management-log', () => {
  const log = {
    lateLogged: [{ id: 1 }, { id: 2 }],
    missingOwner: [{ id: 3 }],
    missingDue: [],
    baseline: { stillOpen: 4, count: 9, targetDate: '2026-09-11' },
    breachesFiveDay: [{ id: 5 }],
    overdueCount: 6,
    hrUnknown: [{ id: 7 }],
    hrGap: [],
  };
  const r = pip.assess({ weekly: [], log, today: TODAY });
  assert.equal(r.log.lateLogged, 2);
  assert.equal(r.log.missingOwner, 1);
  assert.equal(r.log.baselineStillOpen, 4);
  assert.equal(r.log.baselineCount, 9);
  assert.equal(r.log.breachesFiveDay, 1);
  assert.equal(r.log.overdueCount, 6);
});

test('hrUnknown is carried but is not a finding', () => {
  const log = { baseline: { stillOpen: 0, count: 0 }, hrUnknown: [{ id: 1 }, { id: 2 }], hrGap: [] };
  const r = pip.assess({ weekly: [], log, today: TODAY });
  assert.equal(r.log.hrUnknown, 2);
  assert.equal(r.log.hrGap, 0, 'nothing measured these; they are a question for Nick');
});

// ── No score, ever ───────────────────────────────────────────────────────────

test('the payload carries no score, percentage or grade', () => {
  const log = {
    lateLogged: [], missingOwner: [], missingDue: [],
    baseline: { stillOpen: 2, count: 9, targetDate: '2026-09-11' },
    breachesFiveDay: [], overdueCount: 0, hrUnknown: [], hrGap: [],
  };
  const r = pip.assess({
    weekly: [{ week: '2026-08-10', published: true, sent: true }],
    log,
    today: TODAY,
  });
  const flat = JSON.stringify(r).toLowerCase();
  for (const banned of ['percent', 'pct', 'score', 'grade', 'rating', 'rag', 'completion']) {
    assert.ok(!flat.includes(banned), `must not expose "${banned}"`);
  }
});

test('the window states dates and a day count, not a proportion', () => {
  const r = pip.assess({ weekly: [], today: TODAY });
  assert.equal(r.window.start, '2026-07-27');
  assert.equal(r.window.review, '2026-09-11');
  assert.equal(r.window.end, '2026-10-11');
  assert.equal(r.window.daysToReview, 8);
  assert.equal(r.window.daysToEnd, 38);
  assert.equal(r.window.phase, 'before-review');
});

test('after the review the phase changes, because the standard does', () => {
  const r = pip.assess({ weekly: [], today: '2026-09-20' });
  assert.equal(r.window.phase, 'after-review');
  assert.ok(r.window.daysToReview < 0);
});

// ── Dates ────────────────────────────────────────────────────────────────────

test('weekCommencing puts Sunday in the week that is ending', () => {
  assert.equal(pip.weekCommencing('2026-09-06'), '2026-08-31');
  assert.equal(pip.weekCommencing('2026-09-07'), '2026-09-07');
});

test('dates are parsed locally, so a UTC-running Pi does not flip a day', () => {
  // Parsed as UTC, 2026-09-03 becomes 2 Sep in any negative offset and the whole
  // week arithmetic shifts. Pinned by asserting the Monday, not the raw parse.
  assert.equal(pip.weekCommencing('2026-09-03'), '2026-08-31');
});

test('an unreadable date yields null rather than a wrong number', () => {
  assert.equal(pip.daysBetween('not-a-date', '2026-09-03'), null);
  assert.equal(pip.weekCommencing(''), null);
});
