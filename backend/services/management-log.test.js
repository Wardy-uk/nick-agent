'use strict';

/**
 * Pins the competency 3/4 arithmetic.
 *
 * The baseline is the part worth guarding hardest: it is a statement about
 * 27 July, and the obvious implementation — "count what is overdue now" —
 * silently answers a different question every day it is run.
 */

const test = require('node:test');
const assert = require('node:assert');

const log = require('./management-log');

/** A holiday inside the window, to prove the count is working days not calendar. */
const HOLIDAY = new Set(['2026-08-31']);   // Summer bank holiday, a Monday

function row(over = {}) {
  return {
    id: 1,
    entry_date: '2026-08-12',
    logged_at: '2026-08-12T09:00:00.000Z',
    type: 'action',
    person: null,
    summary: 'An item',
    owner: 'Nick',
    due_date: '2026-08-14',
    status: 'open',
    resolved_date: null,
    hr_logged: 1,
    ...over,
  };
}

// ── Working-day arithmetic ───────────────────────────────────────────────────

test('working days skip weekends', () => {
  // Fri 14 Aug → Mon 17 Aug is one working day, not three calendar days.
  assert.equal(log.workingDaysBetween('2026-08-14', '2026-08-17'), 1);
  assert.equal(log.workingDaysBetween('2026-08-17', '2026-08-21'), 4);
  assert.equal(log.workingDaysBetween('2026-08-17', '2026-08-17'), 0);
});

test('a bank holiday inside the window does not count — a naive count reports a breach that is not one', () => {
  // Fri 28 Aug → Tue 1 Sep. Mon 31 Aug is the Summer bank holiday.
  assert.equal(log.workingDaysBetween('2026-08-28', '2026-09-01', HOLIDAY), 1);
  assert.equal(log.workingDaysBetween('2026-08-28', '2026-09-01'), 2, 'without the holiday set it is plain Mon-Fri');
});

// ── Competency 4: the baseline ───────────────────────────────────────────────

test('the baseline counts what was overdue AT 27 July, not what is overdue now', () => {
  const rows = [
    // Due before the baseline and still open — in.
    row({ id: 1, due_date: '2026-07-01', status: 'open' }),
    // Due before the baseline but closed BEFORE it — out.
    row({ id: 2, due_date: '2026-07-01', status: 'done', resolved_date: '2026-07-20' }),
    // Due before the baseline, closed AFTER it — it WAS overdue on 27 July, so in.
    row({ id: 3, due_date: '2026-07-01', status: 'done', resolved_date: '2026-08-05' }),
    // Due after the baseline — cannot have been overdue then, however late it is now.
    row({ id: 4, due_date: '2026-08-14', status: 'open' }),
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.equal(a.baseline.count, 2);
  assert.deepEqual(a.baseline.items.map(i => i.id), [1, 3]);
  assert.equal(a.baseline.stillOpen, 1, 'only #1 is still open — that is the number that must reach zero');
  assert.equal(a.baseline.date, '2026-07-27');
  assert.equal(a.baseline.targetDate, '2026-09-11');
});

test('overdue-now is a separate count from the baseline', () => {
  const rows = [row({ id: 4, due_date: '2026-08-14', status: 'open' })];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.equal(a.baseline.count, 0);
  assert.equal(a.overdueCount, 1);
  assert.equal(a.overdue[0].workingDaysOverdue, 1, 'Fri 14th to Mon 17th');
});

test('the five-working-day standard is measured in working days', () => {
  const rows = [
    row({ id: 1, due_date: '2026-08-07', status: 'open' }),   // 6 working days by the 17th
    row({ id: 2, due_date: '2026-08-11', status: 'open' }),   // 4 working days
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.equal(a.overdueCount, 2);
  assert.deepEqual(a.breachesFiveDay.map(b => b.id), [1]);
});

test('overdue is ranked worst-first', () => {
  const rows = [
    row({ id: 1, due_date: '2026-08-13' }),
    row({ id: 2, due_date: '2026-07-01' }),
    row({ id: 3, due_date: '2026-08-10' }),
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.deepEqual(a.overdue.map(o => o.id), [2, 3, 1]);
});

// ── Competency 3: logged within two working days ─────────────────────────────

test('an item logged more than two working days after it happened is a finding', () => {
  const rows = [
    // Happened Mon 10th, logged Wed 12th — two working days, compliant.
    row({ id: 1, entry_date: '2026-08-10', logged_at: '2026-08-12T09:00:00Z' }),
    // Happened Mon 10th, logged Fri 14th — four working days.
    row({ id: 2, entry_date: '2026-08-10', logged_at: '2026-08-14T09:00:00Z' }),
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.deepEqual(a.lateLogged.map(l => l.id), [2]);
  assert.equal(a.lateLogged[0].workingDays, 4);
});

test('a conversation over a weekend is not late — the rule is working days', () => {
  // Happened Fri 14th, logged Tue 18th: Mon + Tue = 2 working days.
  const rows = [row({ id: 1, type: 'conversation', entry_date: '2026-08-14', logged_at: '2026-08-18T09:00:00Z' })];
  const a = log.assess(rows, { today: '2026-08-18' });
  assert.deepEqual(a.lateLogged, []);
});

test('an open item without an owner or a due date is a gap in the log itself', () => {
  const rows = [row({ id: 1, owner: null, due_date: null, status: 'open' })];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.equal(a.missingOwner.length, 1);
  assert.equal(a.missingDue.length, 1);
  assert.equal(a.overdueCount, 0, 'no due date means not yet overdue — it means unfollowable');
});

test('a closed item is not chased for a missing owner', () => {
  const rows = [row({ id: 1, owner: null, due_date: null, status: 'done', resolved_date: '2026-08-15' })];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.deepEqual(a.missingOwner, []);
  assert.equal(a.totals.closed, 1);
});

// ── People HR ────────────────────────────────────────────────────────────────

test('a conversation or concern not in People HR is a finding; a plain action is not', () => {
  const rows = [
    row({ id: 1, type: 'conversation', hr_logged: 0 }),
    row({ id: 2, type: 'concern', hr_logged: 0 }),
    row({ id: 3, type: 'action', hr_logged: 0 }),
    row({ id: 4, type: 'conversation', hr_logged: 1 }),
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.deepEqual(a.hrGap.map(h => h.id), [1, 2]);
});

test('assess needs no database, no vault and no network', () => {
  assert.doesNotThrow(() => log.assess([], { today: '2026-08-17' }));
  const a = log.assess([], { today: '2026-08-17' });
  assert.deepEqual(a.totals, { rows: 0, open: 0, closed: 0 });
  assert.equal(a.baseline.count, 0);
});
