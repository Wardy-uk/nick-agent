'use strict';

// Rescheduling a 1-2-1. The rules that matter are social, not arithmetic:
// the attendee has already accepted, so the move must read as "moved" and must
// not quietly happen for the fourth time without saying so.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'o21-')), 'test.db');

const booking = require('./one-to-one-booking');
const db = require('../db/database');
const { isRealEventId, recordMove, findClashExcluding, toMinutes } = booking._internals;

test.before(async () => { await db.init(); });

test('a synthesised fallback id is refused — it cannot address a real event', () => {
  // The ICS/bridge fallback mints `graph-<date>-<time>-<subject>` ids. PATCHing
  // one 404s, and finding that out AFTER Nick confirms a move is the bad outcome.
  assert.strictEqual(isRealEventId('AAMkAGI2TG93AAA='), true);
  assert.strictEqual(isRealEventId('graph-2026-08-18-14:00-1-2-1 Nick'), false);
  assert.strictEqual(isRealEventId(''), false);
  assert.strictEqual(isRealEventId(null), false);
});

test('reschedule refuses a synthesised id before touching Graph', async () => {
  const r = await booking.reschedule({
    person: 'Hope Goodall',
    eventId: 'graph-2026-08-18-14:00-x',
    start: '2026-08-19T14:00:00',
    end: '2026-08-19T14:30:00',
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /cannot address a real calendar event/i);
});

test('reschedule requires all four fields', async () => {
  const r = await booking.reschedule({ person: 'Hope Goodall', start: '2026-08-19T14:00:00' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /required/);
});

test('the event being moved does not clash with itself', async (t) => {
  // The single easiest bug here: leave the event in the working set and every
  // slot on its own day is refused, because it collides with the meeting it IS.
  const microsoft = require('./microsoft');
  t.mock.method(microsoft, 'fetchCalendarEvents', async () => ([
    { id: 'THE-ONE', date: '2026-08-19', start: '2026-08-19T14:00:00', end: '2026-08-19T14:30:00', subject: '1-2-1 — Nick / Hope', showAs: 'busy' },
  ]));

  const selfClash = await findClashExcluding('2026-08-19T14:00:00', '2026-08-19T14:30:00', 'THE-ONE');
  assert.strictEqual(selfClash, null, 'must be blind to the event being moved');

  const realClash = await findClashExcluding('2026-08-19T14:00:00', '2026-08-19T14:30:00', 'SOMETHING-ELSE');
  assert.strictEqual(realClash, '1-2-1 — Nick / Hope', 'still catches a genuine clash');
});

test('a free or cancelled event is not a wall', async (t) => {
  const microsoft = require('./microsoft');
  t.mock.method(microsoft, 'fetchCalendarEvents', async () => ([
    { id: 'A', date: '2026-08-19', start: '2026-08-19T14:00:00', end: '2026-08-19T15:00:00', subject: 'Focus', showAs: 'free' },
    { id: 'B', date: '2026-08-19', start: '2026-08-19T14:00:00', end: '2026-08-19T15:00:00', subject: 'Dropped', showAs: 'cancelled' },
  ]));
  assert.strictEqual(await findClashExcluding('2026-08-19T14:00:00', '2026-08-19T14:30:00', 'X'), null);
});

test('moves are counted and newest-first, and survive being read back', () => {
  const who = `Test Person ${Date.now()}`;
  assert.strictEqual(booking.movesFor(who).length, 0);

  recordMove(who, { from: '2026-08-19T14:00:00', to: '2026-08-20T14:00:00', reason: 'clash' });
  recordMove(who, { from: '2026-08-20T14:00:00', to: '2026-08-21T10:00:00', reason: null });

  const moves = booking.movesFor(who);
  assert.strictEqual(moves.length, 2);
  assert.strictEqual(moves[0].to, '2026-08-21T10:00:00', 'newest first');
  assert.strictEqual(moves[1].reason, 'clash');
  assert.ok(moves[0].at, 'every move is timestamped');
});

test('move history is capped so one person cannot grow the KV blob forever', () => {
  const who = `Serial Mover ${Date.now()}`;
  for (let i = 0; i < 30; i++) {
    recordMove(who, { from: `2026-08-01T14:00:00`, to: `2026-09-${String(i + 1).padStart(2, '0')}T14:00:00` });
  }
  assert.strictEqual(booking.movesFor(who).length, 20);
});

test('a repeatedly-moved 1-2-1 is called out, not silently moved again', async (t) => {
  // This is the point of the feature. one-to-one-detect catches a 1-2-1 that
  // has not HAPPENED; one slid three times looks healthy until it is 40 days
  // overdue, because nothing recorded that it moved.
  const who = 'Warned Person';
  recordMove(who, { from: '2026-08-01T14:00:00', to: '2026-08-05T14:00:00' });
  recordMove(who, { from: '2026-08-05T14:00:00', to: '2026-08-12T14:00:00' });

  const microsoft = require('./microsoft');
  t.mock.method(microsoft, 'fetchCalendarEvents', async () => ([
    {
      id: 'REAL-ID-123', date: '2026-08-19',
      start: '2026-08-19T14:00:00', end: '2026-08-19T14:30:00',
      subject: `1-2-1 — Nick / Warned`, showAs: 'busy', attendees: [], isAllDay: false,
    },
  ]));

  const r = await booking.proposeReschedule(who);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.moveCount, 2);
  assert.match(r.warning, /already been moved 2 times/);
});

test('a first move carries no warning', async (t) => {
  const microsoft = require('./microsoft');
  t.mock.method(microsoft, 'fetchCalendarEvents', async () => ([
    {
      id: 'REAL-ID-456', date: '2026-08-19',
      start: '2026-08-19T14:00:00', end: '2026-08-19T14:30:00',
      subject: '1-2-1 — Nick / Quiet', showAs: 'busy', attendees: [], isAllDay: false,
    },
  ]));
  const r = await booking.proposeReschedule(`Quiet Person ${Date.now()}`);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warning, null);
});

test('the proposal keeps the original duration rather than snapping to 30', async (t) => {
  const microsoft = require('./microsoft');
  t.mock.method(microsoft, 'fetchCalendarEvents', async () => ([
    {
      id: 'HOUR-LONG', date: '2026-08-19',
      start: '2026-08-19T14:00:00', end: '2026-08-19T15:00:00',
      subject: '1-2-1 — Nick / Long', showAs: 'busy', attendees: [], isAllDay: false,
    },
  ]));
  const r = await booking.proposeReschedule(`Long Person ${Date.now()}`);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.durationMinutes, 60);
  assert.strictEqual(toMinutes(r.proposed.end) - toMinutes(r.proposed.start), 60);
});

test('no upcoming 1-2-1 is reported plainly, not as a crash', async (t) => {
  const microsoft = require('./microsoft');
  t.mock.method(microsoft, 'fetchCalendarEvents', async () => ([]));
  const r = await booking.findOneToOne('Nobody Home');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /No upcoming 1-2-1/);
});

test('a meeting that merely names the person is not treated as their 1-2-1', async (t) => {
  const microsoft = require('./microsoft');
  t.mock.method(microsoft, 'fetchCalendarEvents', async () => ([
    {
      id: 'GROUP', date: '2026-08-19',
      start: '2026-08-19T14:00:00', end: '2026-08-19T15:00:00',
      subject: 'Team Meeting - Hope handover', showAs: 'busy', attendees: [], isAllDay: false,
    },
  ]));
  const r = await booking.findOneToOne('Hope Goodall');
  assert.strictEqual(r.ok, false, 'a handover meeting is not a 1-2-1');
});

// ── A proposal must be a proposal, not two loose fields ─────────────────────
//
// `describe()` is async. Spreading it WITHOUT awaiting yields `{}` — silently,
// with no error — so `propose()` once returned literally
// `{"awayCheck":"checked","awayNote":null}` and nothing else: no person, no
// slot, no attendee. It reached the Pi that way because the fields that were
// added were present and looked right.
//
// This asserts the source awaits at every describe() call site rather than
// exercising the network path, which needs a calendar and a vault.

test('every describe() call is awaited — spreading a promise yields {}', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./one-to-one-booking'), 'utf-8');
  const calls = [...src.matchAll(/\bdescribe\(/g)]
    // Skip the declaration itself — only CALLS need awaiting.
    .filter(m => !/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index)));
  assert.ok(calls.length >= 2, `expected at least two call sites, found ${calls.length}`);
  for (const m of calls) {
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    assert.match(before, /await\s+$/,
      `describe() called without await near: ${src.slice(m.index - 40, m.index + 30).replace(/\n/g, ' ')}`);
  }
});
