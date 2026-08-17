'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// database.js reads NEURO_DB_PATH at load time, and plan()/apply() read the
// ledger through it. Never point this at the real agent.db.
process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-plaud-admin-')), 'test.db'
);

const service = require('./plaud-admin-blocks');
const db = require('../db/database');
const { skipReason, placeBlock, attendeesOther, createdOrAccepted, firstGap, pruneLedger, blockFor } =
  service._internals;

// The lock lives in agent_state, so it needs a real (scratch) DB behind it.
test.before(async () => { await db.init(); });

const ME = 'nickw@nurtur.tech';
const NOW = new Date('2026-08-18T09:00:00'); // a Tuesday

function meeting(over = {}) {
  return {
    id: 'evt-1',
    subject: 'Integration sync',
    start: '2026-08-18T14:00:00',
    end: '2026-08-18T14:30:00',
    showAs: 'busy',
    isAllDay: false,
    isOrganizer: false,
    responseStatus: 'accepted',
    attendees: [
      { name: 'Nick Ward', email: ME, status: 'accepted' },
      { name: 'Stephen Mitchell', email: 'stephen@nurtur.tech', status: 'accepted' },
    ],
    ...over,
  };
}

function why(event, ledger = {}) {
  return skipReason(event, { me: ME, now: NOW, ledger });
}

// ── Nick's own rule: a meeting has other people in it ────────────────────────

test('a meeting with another attendee qualifies', () => {
  assert.equal(why(meeting()), null);
});

test('time blocked out for work is not a meeting', () => {
  // The whole point of the filter: a solo block has no Plaud recording, so a
  // 5-minute write-up block after it is noise.
  const solo = meeting({
    subject: 'Deep work — NOVA migration',
    isOrganizer: true,
    responseStatus: 'organizer',
    attendees: [{ name: 'Nick Ward', email: ME, status: 'accepted' }],
  });
  assert.equal(why(solo), 'no-other-attendees');
});

test('an event with no attendee list at all is not a meeting', () => {
  const solo = meeting({ isOrganizer: true, responseStatus: 'organizer', attendees: [] });
  assert.equal(why(solo), 'no-other-attendees');
});

test('attendeesOther counts by address, never by length', () => {
  // Graph lists the organiser among the attendees on some events and not
  // others, so `attendees.length >= 2` is right roughly at random.
  const solo = meeting({ attendees: [{ email: ME }] });
  assert.equal(attendeesOther(solo, ME).length, 0);
  assert.equal(attendeesOther(meeting(), ME).length, 1);
  // Case is not identity.
  assert.equal(attendeesOther(meeting({ attendees: [{ email: ME.toUpperCase() }] }), ME).length, 0);
});

test('without a signed-in address nothing qualifies', () => {
  // We cannot tell Nick's own attendee entry from anyone else's, and guessing
  // is how a focus block gets an admin block.
  assert.equal(skipReason(meeting(), { me: null, now: NOW, ledger: {} }), 'identity-unknown');
});

// ── Created or accepted, failing closed ─────────────────────────────────────

test('created counts, accepted counts, nothing else does', () => {
  assert.equal(createdOrAccepted(meeting({ isOrganizer: true, responseStatus: 'organizer' })), 'organizer');
  assert.equal(createdOrAccepted(meeting({ responseStatus: 'accepted' })), 'accepted');
  assert.equal(createdOrAccepted(meeting({ responseStatus: 'tentativelyAccepted' })), null);
  assert.equal(createdOrAccepted(meeting({ responseStatus: 'declined' })), null);
  assert.equal(createdOrAccepted(meeting({ responseStatus: 'notResponded' })), null);
});

test('a declined or unanswered invite gets no block', () => {
  assert.equal(why(meeting({ responseStatus: 'declined' })), 'not-accepted');
  assert.equal(why(meeting({ responseStatus: 'notResponded' })), 'not-accepted');
  assert.equal(why(meeting({ responseStatus: 'tentativelyAccepted' })), 'not-accepted');
});

test('an unknowable response fails CLOSED and says which it was', () => {
  // Both fields are null when the calendar came from the NOVA bridge, which has
  // no route that returns them. Unknown must not read as accepted.
  const bridged = meeting({ isOrganizer: null, responseStatus: null });
  assert.equal(why(bridged), 'response-unknown');
});

// ── Everything else that is not a meeting to write up ───────────────────────

test('all-day, cancelled, free and out-of-office are all skipped', () => {
  assert.equal(why(meeting({ isAllDay: true })), 'all-day');
  assert.equal(why(meeting({ showAs: 'cancelled' })), 'cancelled');
  assert.equal(why(meeting({ showAs: 'free' })), 'marked-free');
  assert.equal(why(meeting({ showAs: 'oof' })), 'out-of-office');
});

test('a meeting that has already ended is never backfilled', () => {
  const past = meeting({ start: '2026-08-18T07:00:00', end: '2026-08-18T07:30:00' });
  assert.equal(why(past), 'already-ended');
});

test('our own admin blocks never earn admin blocks', () => {
  const block = meeting({ subject: 'Plaud admin — Integration sync' });
  assert.equal(why(block), 'is-admin-block');
});

test('a handled meeting is never revisited, even if the block was deleted', () => {
  // Nick deleting a block is a decision. A calendar scan would recreate it
  // forever; the ledger is what lets a deletion stick.
  assert.equal(why(meeting(), { 'evt-1': { blockId: 'x' } }), 'already-handled');
});

// ── Placement ───────────────────────────────────────────────────────────────

test('the block goes straight after the meeting when the slot is free', () => {
  const events = [meeting()];
  const slot = placeBlock(meeting(), events, {});
  assert.deepEqual(
    { date: slot.date, start: slot.start, end: slot.end, spilled: slot.spilled },
    { date: '2026-08-18', start: 14 * 60 + 30, end: 14 * 60 + 35, spilled: false }
  );
});

test('back to back meetings push the block past the whole run', () => {
  const first = meeting({ id: 'a', start: '2026-08-18T14:00:00', end: '2026-08-18T14:30:00' });
  const second = meeting({ id: 'b', start: '2026-08-18T14:30:00', end: '2026-08-18T15:00:00' });
  const third = meeting({ id: 'c', start: '2026-08-18T15:00:00', end: '2026-08-18T16:00:00' });
  const slot = placeBlock(first, [first, second, third], {});
  assert.equal(slot.start, 16 * 60, 'lands after the run, not inside it');
  assert.equal(slot.spilled, false);
});

test('two meetings in one pass do not get the same slot', () => {
  // Without reserving as it goes, every meeting in a back-to-back run is handed
  // the identical free slot and the blocks stack on one another.
  const first = meeting({ id: 'a', start: '2026-08-18T14:00:00', end: '2026-08-18T15:00:00' });
  const second = meeting({ id: 'b', start: '2026-08-18T14:00:00', end: '2026-08-18T15:00:00' });
  const events = [first, second];

  const slotA = placeBlock(first, events, {});
  const blockA = blockFor(first, slotA);
  events.push({ id: 'pending-a', start: blockA.start, end: blockA.end, showAs: 'busy', isAllDay: false });

  const slotB = placeBlock(second, events, {});
  assert.notEqual(slotB.start, slotA.start);
  assert.equal(slotB.start, slotA.end);
});

test('a block is never placed earlier than now on today', () => {
  // A pass firing mid-meeting, or after one that ran over, would otherwise book
  // five minutes into the past.
  const m = meeting({ start: '2026-08-18T08:00:00', end: '2026-08-18T11:00:00' });
  const slot = placeBlock(m, [m], { '2026-08-18': 15 * 60 });
  assert.equal(slot.start, 15 * 60);
});

test('a day solid to the evening spills to the next working day', () => {
  const wall = {
    id: 'wall', start: '2026-08-18T14:00:00', end: '2026-08-18T23:00:00',
    showAs: 'busy', isAllDay: false,
  };
  const m = meeting({ start: '2026-08-18T13:00:00', end: '2026-08-18T14:00:00' });
  const slot = placeBlock(m, [m, wall], {});
  assert.equal(slot.date, '2026-08-19');
  assert.equal(slot.spilled, true);
  assert.equal(slot.start, 8 * 60);
});

test('a spill never lands on a weekend', () => {
  // Friday 21 Aug 2026, solid to the evening → Monday, not Saturday.
  const wall = {
    id: 'wall', start: '2026-08-21T14:00:00', end: '2026-08-21T23:00:00',
    showAs: 'busy', isAllDay: false,
  };
  const m = meeting({ start: '2026-08-21T13:00:00', end: '2026-08-21T14:00:00' });
  const slot = placeBlock(m, [m, wall], {});
  assert.equal(new Date(`${slot.date}T12:00:00`).getDay(), 1, 'Monday');
});

test('a free or cancelled event is not a wall', () => {
  const ghost = {
    id: 'g', start: '2026-08-18T14:30:00', end: '2026-08-18T16:00:00',
    showAs: 'cancelled', isAllDay: false,
  };
  const slot = placeBlock(meeting(), [meeting(), ghost], {});
  assert.equal(slot.start, 14 * 60 + 30);
});

test('an all-day marker does not blanket the day', () => {
  // An all-day "Leave" is caught by the working-day check; an informational
  // all-day marker must not stop a five minute block.
  const marker = {
    id: 'm', start: '2026-08-18T00:00:00', end: '2026-08-19T00:00:00',
    showAs: 'busy', isAllDay: true,
  };
  const slot = placeBlock(meeting(), [meeting(), marker], {});
  assert.equal(slot.date, '2026-08-18');
  assert.equal(slot.spilled, false);
});

test('firstGap refuses to run past the end of the day', () => {
  assert.equal(firstGap('2026-08-18', [], service._internals.DAY_END_MIN - 4, 5), null);
});

// ── The words on the block ──────────────────────────────────────────────────

test('the body carries the exact note Nick asked for', () => {
  const block = blockFor(meeting(), { date: '2026-08-18', start: 870, end: 875, spilled: false });
  assert.ok(block.body.startsWith('process and update Plaud meeting for Integration sync'));
  assert.ok(block.body.includes(service._internals.BLOCK_MARKER));
  assert.equal(block.subject, 'Plaud admin — Integration sync');
  assert.equal(block.start, '2026-08-18T14:30:00');
  assert.equal(block.end, '2026-08-18T14:35:00');
});

test('a block is five minutes', () => {
  assert.equal(service._internals.BLOCK_MINUTES, 5);
});

// ── The ledger ──────────────────────────────────────────────────────────────

test('pruning drops meetings long past and keeps the rest', () => {
  const ledger = {
    old: { meetingDate: '2026-01-01' },
    recent: { meetingDate: '2026-08-15' },
    future: { meetingDate: '2026-08-25' },
    junk: null,
  };
  const out = pruneLedger(ledger, NOW);
  assert.deepEqual(Object.keys(out).sort(), ['future', 'recent']);
});

// ── The gate ────────────────────────────────────────────────────────────────

test('the sync hook does nothing while disabled', async () => {
  delete process.env.PLAUD_ADMIN_BLOCKS_ENABLED;
  const result = await service.syncHook([meeting()]);
  assert.equal(result.skipped, 'disabled');
  assert.equal(result.created, 0);
});

// ── The run lock ────────────────────────────────────────────────────────────
// This is the bug that actually bit: the first live run created 52 blocks where
// 27 were wanted, because the scheduler's calendar-sync pass overlapped a manual
// apply and both planned against an empty ledger.

test('a second pass cannot start while one is running', () => {
  const { acquireLock, releaseLock } = service._internals;
  releaseLock();
  assert.equal(acquireLock('calendar-sync').ok, true);
  const second = acquireLock('manual');
  assert.equal(second.ok, false);
  assert.equal(second.heldBy, 'calendar-sync');
  releaseLock();
  assert.equal(acquireLock('manual').ok, true, 'released, so the next pass may run');
  releaseLock();
});

test('a lock left behind by a dead pass is taken, not honoured forever', () => {
  const { acquireLock, releaseLock, LOCK_TTL_MS } = service._internals;
  releaseLock();
  const longAgo = Date.now() - LOCK_TTL_MS - 1000;
  assert.equal(acquireLock('crashed', longAgo).ok, true);
  // A restart mid-run would otherwise wedge the feature until someone noticed.
  assert.equal(acquireLock('calendar-sync').ok, true);
  releaseLock();
});

test('a locked apply refuses instead of creating a second set', async () => {
  const { acquireLock, releaseLock } = service._internals;
  process.env.PLAUD_ADMIN_BLOCKS_ENABLED = 'true';
  releaseLock();
  acquireLock('calendar-sync');
  try {
    const result = await service.apply({ events: [meeting()], now: NOW, dryRun: false });
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 'locked');
    assert.equal(result.heldBy, 'calendar-sync');
  } finally {
    releaseLock();
    delete process.env.PLAUD_ADMIN_BLOCKS_ENABLED;
  }
});

test('a dry run never contends for the lock', async () => {
  // Looking must always be possible, including while a pass is mid-flight.
  const { acquireLock, releaseLock } = service._internals;
  releaseLock();
  acquireLock('calendar-sync');
  try {
    const result = await service.apply({ events: [meeting()], now: NOW });
    assert.equal(result.dryRun, true);
    assert.notEqual(result.skipped, 'locked');
  } finally {
    releaseLock();
  }
});

test('plan() is read-only and apply() defaults to a dry run', async () => {
  process.env.PLAUD_ADMIN_BLOCKS_ENABLED = 'true';
  try {
    const result = await service.apply({ events: [meeting()], now: NOW });
    assert.equal(result.dryRun, true);
    assert.equal(result.created, 0);
  } finally {
    delete process.env.PLAUD_ADMIN_BLOCKS_ENABLED;
  }
});
