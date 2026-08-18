'use strict';

/**
 * Pins the Working Time Regulations arithmetic and the approval gate.
 *
 * These are PIP competency 1's success measure expressed as code — "all sampled
 * approvals evidence completion of the five-step checklist with no WTR breach" —
 * so the rules are tested rather than trusted. `assess()` and `rollingAverage()`
 * are pure and take their rows, so none of this needs a database or a clock.
 */

const test = require('node:test');
const assert = require('node:assert');

const overtime = require('./overtime');

const PERSON = 'Sam';

function entry(work_date, hours, over = {}) {
  return { person: PERSON, work_date, hours, outcome: 'approved', ...over };
}

// ── The 48-hour rolling average ──────────────────────────────────────────────

test('the average is total working time, not overtime alone', () => {
  // 37.5 contracted every week for 17 weeks, plus 17 hours of overtime, is
  // 37.5 + 1 = 38.5. Averaging only the overtime would report 1h/week and look
  // gloriously compliant while saying nothing about the limit.
  const entries = Array.from({ length: 17 }, (_, i) => entry(`2026-0${i < 4 ? 5 : 6}-0${(i % 9) + 1}`, 1));
  const r = overtime.rollingAverage(entries, 37.5, '2026-08-18');
  assert.equal(r.weeks, 17);
  assert.ok(r.averageHours > 37.5, 'contracted hours are the floor, not the measure');
});

test('no contracted hours yields a null average, never an assumed one', () => {
  const r = overtime.rollingAverage([entry('2026-08-10', 6)], null, '2026-08-18');
  assert.equal(r.averageHours, null);
  assert.match(r.reason, /no contracted hours/);
});

test('declined overtime does not count toward the limit; pending does', () => {
  const asOf = '2026-08-18';
  const declined = overtime.rollingAverage(
    [entry('2026-08-10', 40, { outcome: 'declined' })], 37.5, asOf,
  );
  assert.equal(declined.overtimeHours, 0, 'declined hours were never worked');

  const pending = overtime.rollingAverage(
    [entry('2026-08-10', 40, { outcome: 'pending' })], 37.5, asOf,
  );
  // A limit you can stay under by being slow with paperwork is not a limit.
  assert.equal(pending.overtimeHours, 40, 'the hours were worked whether or not admin caught up');
});

test('hours outside the 17-week window are excluded', () => {
  const r = overtime.rollingAverage(
    [entry('2026-01-05', 100), entry('2026-08-10', 5)], 37.5, '2026-08-18',
  );
  assert.equal(r.overtimeHours, 5, 'January is well outside a 17-week window ending in August');
});

// ── The regulation flags ─────────────────────────────────────────────────────

test('breaching 48h with no opt-out on file BLOCKS approval', () => {
  const claim = entry('2026-08-18', 200, { outcome: 'pending' });
  const a = overtime.assess({
    claim, entries: [], asOf: '2026-08-18',
    profile: { contracted_hours: 40, optout_signed: null },
  });
  assert.ok(a.wouldExceed);
  const f = a.flags.find(x => x.code === 'wtr-48h-no-optout');
  assert.equal(f.severity, 'breach');
  assert.ok(a.blocking.length, 'a breach must stop the approval, not annotate it');
});

test('breaching 48h WITH a signed opt-out warns but does not block', () => {
  const claim = entry('2026-08-18', 200, { outcome: 'pending' });
  const a = overtime.assess({
    claim, entries: [], asOf: '2026-08-18',
    profile: { contracted_hours: 40, optout_signed: 1, optout_date: '2026-01-15' },
  });
  assert.ok(a.wouldExceed);
  assert.equal(a.flags.find(x => x.code === 'wtr-48h-optout').severity, 'warn');
  assert.equal(a.blocking.length, 0, 'a valid opt-out makes this permitted, not merely tolerated');
});

test('an unknown opt-out status is reported as unknown, not as absent', () => {
  const a = overtime.assess({
    claim: entry('2026-08-18', 2, { outcome: 'pending' }), entries: [], asOf: '2026-08-18',
    profile: { contracted_hours: 37.5, optout_signed: null },
  });
  const f = a.flags.find(x => x.code === 'optout-unknown');
  assert.match(f.message, /never asked/, '"not asked" and "no opt-out" are different facts');
});

test('missing contracted hours blocks approval outright', () => {
  const a = overtime.assess({
    claim: entry('2026-08-18', 4, { outcome: 'pending' }), entries: [], asOf: '2026-08-18',
    profile: null,
  });
  assert.equal(a.blocking[0].code, 'no-baseline');
});

// ── Step 1: the evidence that was missing in the first place ─────────────────

test('absent activity evidence is reported, never treated as a passed check', () => {
  const a = overtime.assess({
    claim: entry('2026-08-18', 4, { outcome: 'pending' }), entries: [], asOf: '2026-08-18',
    profile: { contracted_hours: 37.5, optout_signed: 0 }, activity: null,
  });
  assert.ok(a.flags.some(f => f.code === 'no-activity-evidence'));
});

test('zero logged work is a prompt for better evidence, not an accusation', () => {
  const a = overtime.assess({
    claim: entry('2026-08-18', 4, { outcome: 'pending' }), entries: [], asOf: '2026-08-18',
    profile: { contracted_hours: 37.5, optout_signed: 0 },
    activity: { ticketsTouched: 0, ticketsSolved: 0 },
  });
  const f = a.flags.find(x => x.code === 'no-logged-work');
  assert.equal(f.severity, 'warn');
  // The finding was approving without checking. The correction is to check —
  // not to assume an absence of Jira activity means nobody worked.
  assert.match(f.message, /does not mean no work happened/);
});

// ── An unreadable log must never read as a clean one ─────────────────────────

test('status() reports unavailable when the log cannot be read, never a compliant zero', () => {
  // Caught on the first deploy: status() returned { available: true,
  // totalClaims: 0 } against an uninitialised database, because the swallowing
  // list() handed it an empty array. That would have published "0 overtime
  // hours, no checklist gaps" off the back of a dead database AND cleared the
  // weekly report's publication blocker — a false all-clear on a PIP
  // competency.
  const db = require('../db/database');
  const original = db.all;
  db.all = () => { throw new Error('Database not initialized'); };
  try {
    const s = overtime.status();
    assert.equal(s.available, false, 'a failed read is not an empty log');
    assert.match(s.reason, /unreadable/);
    assert.equal(s.totalClaims, undefined, 'no counts may be published from a failed read');
  } finally {
    db.all = original;
  }
});

// ── The checklist ────────────────────────────────────────────────────────────

test('all five steps are required, and an unanswered one is not a passed one', () => {
  assert.equal(overtime.STEPS.length, 5);
  const bare = { chk_activity: 1, chk_48h: 1, chk_optout: null, chk_rest: 1, chk_recorded: 1 };
  const out = overtime.outstandingSteps(bare);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'chk_optout');

  const failed = { chk_activity: 0, chk_48h: 1, chk_optout: 1, chk_rest: 1, chk_recorded: 1 };
  assert.equal(overtime.outstandingSteps(failed).length, 0,
    'a check recorded as FAILED has been answered — it blocks approval elsewhere, not here');
});
