'use strict';

/**
 * When ritual nudges must NOT fire.
 *
 * `leaveState` is pure — it takes the stored value and `now` — so the boundary
 * days pin without a DB or a clock. Those boundaries are the whole feature: a
 * leave button that ends at the wrong moment on the last day is worse than none,
 * because it goes off while Nick is still on holiday.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// `leaveState` is pure, but `nudgeSuppression` reads the leave key and the
// bank-holiday cache, so it needs a database. A SCRATCH one — never the real
// file (see mistakes.md, 2026-08-13).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-leave-'));
process.env.NEURO_DB_PATH = path.join(root, 'leave.db');

const db = require('../db/database');
const { leaveState, nudgeSuppression, setLeave, clearLeave } = require('./nudges');

test.before(async () => { await db.init(); });

// ── The other reason nudges stay quiet ──────────────────────────────────────
//
// `nudgeSuppression` takes `now`, so the bank-holiday branch is checkable
// without waiting for one. This is the branch that fires first in anger:
// Monday 31 Aug 2026 is the Summer bank holiday.

test('a bank holiday suppresses ritual nudges', () => {
  const s = nudgeSuppression(new Date('2026-08-31T09:00:00'));
  assert.equal(s.suppressed, true, 'the Summer bank holiday is not a working day');
  assert.match(String(s.reason), /holiday|working/i, 'and it says which reason it was');
});

test('a weekend suppresses ritual nudges', () => {
  assert.equal(nudgeSuppression(new Date('2026-08-29T09:00:00')).suppressed, true, 'Saturday');
  assert.equal(nudgeSuppression(new Date('2026-08-30T09:00:00')).suppressed, true, 'Sunday');
});

test('an ordinary working day does NOT suppress', () => {
  const s = nudgeSuppression(new Date('2026-08-27T09:00:00'));
  assert.equal(s.suppressed, false, 'Thursday 27 Aug is a normal working day');
  assert.equal(s.reason, null);
});

test('leave beats a working day, and clearing it lets nudges resume', () => {
  // The round trip through the store, which is what the button actually does.
  const thursday = new Date('2026-08-27T09:00:00');
  clearLeave();
  assert.equal(nudgeSuppression(thursday).suppressed, false);

  setLeave(1, thursday);
  const on = nudgeSuppression(thursday);
  assert.equal(on.suppressed, true);
  assert.equal(on.reason, 'annual leave', 'the reason names leave, not the weekday');

  clearLeave();
  assert.equal(nudgeSuppression(thursday).suppressed, false, 'back early must actually work');
});

const at = (iso) => new Date(iso);

test('no stored value means not on leave', () => {
  assert.equal(leaveState(null).onLeave, false);
  assert.equal(leaveState('').onLeave, false);
});

test('junk in the store is not leave, and does not throw', () => {
  // A cleared value writes '', and an older format must not read as "on leave
  // for ever" — silence with no way to notice is the worst failure here.
  assert.equal(leaveState('yes').onLeave, false);
  assert.equal(leaveState('1787000000000').onLeave, false);
});

test('today counts as being on leave', () => {
  const s = leaveState('2026-08-27', at('2026-08-27T09:00:00'));
  assert.equal(s.onLeave, true);
  assert.equal(s.daysRemaining, 1);
});

test('leave lasts to the END of the last day, not to the moment it was set', () => {
  // The reason `until` is a DATE and not a timestamp. Pressing the button at
  // 09:00 on Friday for one day must still be leave at 16:00 that Friday.
  assert.equal(leaveState('2026-08-27', at('2026-08-27T16:30:00')).onLeave, true);
  assert.equal(leaveState('2026-08-27', at('2026-08-27T23:59:00')).onLeave, true);
});

test('the day after the last day, nudges resume', () => {
  const s = leaveState('2026-08-27', at('2026-08-28T07:00:00'));
  assert.equal(s.onLeave, false);
  assert.equal(s.expired, true, 'expired is distinct from never-set');
});

test('a week off reports the days remaining, counting today', () => {
  const s = leaveState('2026-08-31', at('2026-08-27T09:00:00'));
  assert.equal(s.onLeave, true);
  assert.equal(s.daysRemaining, 5, '27,28,29,30,31');
});

test('leave is read in LOCAL time, so it does not end early in the evening', () => {
  // The Pi may run UTC. Using toISOString() here would roll the date over at
  // 01:00 BST and end leave a day early.
  const lateEvening = at('2026-08-27T23:30:00');
  assert.equal(leaveState('2026-08-27', lateEvening).onLeave, true);
});

test('a far-future date is still just leave, not an error', () => {
  assert.equal(leaveState('2026-12-25', at('2026-08-27T09:00:00')).onLeave, true);
});
