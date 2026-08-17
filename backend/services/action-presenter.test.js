'use strict';

/**
 * The approval screen is only safe if it describes the action the executor will
 * actually run. Two ways that breaks, and one test each:
 *
 *  1. Someone adds a case to `executeAction` and no presenter — the card falls
 *     back to "no presenter", which is safe but useless. The coverage test
 *     fails at the moment the case is added, not the day it reaches the queue.
 *  2. A presenter says "approve" for a payload the executor would refuse. Every
 *     blocker below mirrors an `{ ok:false }` guard in suggestion-engine; if a
 *     guard is added there and not here, approve is enabled on something that
 *     cannot work, which is the failure mode this whole item exists to remove.
 *
 * Parsing the switch out of the source rather than listing the types by hand is
 * deliberate: a hand-written list is a second thing to forget to update.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const presenter = require('./action-presenter');

/** Every `case 'x':` inside executeAction, read from the source. */
function executorTypes() {
  const src = fs.readFileSync(path.join(__dirname, 'suggestion-engine.js'), 'utf8');
  const start = src.indexOf('async function executeAction');
  assert.ok(start > 0, 'executeAction not found — this test needs rewriting, not deleting');
  const body = src.slice(start);
  return [...body.matchAll(/^\s*case '([a-z_]+)':/gm)].map(m => m[1]);
}

test('every executeAction case has a presenter', () => {
  const missing = executorTypes().filter(t => !presenter.KNOWN_TYPES.includes(t));
  assert.deepEqual(missing, [], `action types with no presenter: ${missing.join(', ')}`);
});

test('no presenter describes a type the executor cannot run', () => {
  const types = executorTypes();
  const orphans = presenter.KNOWN_TYPES.filter(t => !types.includes(t));
  assert.deepEqual(orphans, [], `presenters for types executeAction has no case for: ${orphans.join(', ')}`);
});

test('outbound actions show the full stored body, not a summary', () => {
  const body = 'Hi Lucy,\n\nWhere did that get to?\n\nNick';
  for (const [type, payload] of [
    ['reply_email', { emailId: 'AAA', body, subject: 'Re: feeds' }],
    ['chase_commitment', { waitingKey: 'lucy::x', person: 'Lucy', to: { email: 'l@nurtur.tech' }, body }],
    ['chase_agenda', { eventId: 'E1', body, organizer: { name: 'Sam', address: 's@nurtur.tech' } }],
  ]) {
    const d = presenter.describe({ type, payload });
    assert.equal(d.body, body, `${type} must render the stored body verbatim`);
    assert.equal(d.kind, presenter.OUTBOUND, `${type} is outbound`);
    assert.equal(d.canApprove, true, `${type} with a complete payload should be approvable`);
  }
});

test('a missing send field blocks approval and says why', () => {
  const cases = [
    ['reply_email', { emailId: 'AAA' }, /nothing to send/i],
    ['reply_email', { body: 'hi' }, /emailId/],
    ['chase_agenda', { eventId: 'E1', body: 'hi' }, /organiser address/i],
    ['chase_agenda', { eventId: 'E1', organizer: { email: 'a@b.c' } }, /nothing to send/i],
    ['complete_task', { filePath: 'Tasks/x.md', lineNumber: 3 }, /taskId or an msId/],
    ['capture_todo', {}, /no task text/i],
    ['escalate_ticket', {}, /ticketKey/],
    ['respond_meeting', {}, /eventId/],
    ['draft_reply', {}, /emailId/],
    ['schedule_focus_block', { start: 'not a date' }, /unparseable/i],
  ];
  for (const [type, payload, re] of cases) {
    const d = presenter.describe({ type, payload });
    assert.equal(d.canApprove, false, `${type} ${JSON.stringify(payload)} should be blocked`);
    assert.ok(d.blockers.some(b => re.test(b)), `${type} blocker should match ${re}, got ${JSON.stringify(d.blockers)}`);
  }
});

test('chase without a stored address warns but does not block — the executor re-resolves', () => {
  const d = presenter.describe({ type: 'chase_commitment', payload: { waitingKey: 'lucy::x', person: 'Lucy' } });
  assert.equal(d.canApprove, true, 'the executor falls back to the directory rather than refusing outright');
  assert.ok(d.warnings.some(w => /ambiguous|address/i.test(w)), 'must say the address is not stored');
  assert.equal(d.link?.view, 'people', 'point at where the address is actually set');
});

test('schedule_focus_block is only outbound when it invites someone', () => {
  const alone = presenter.describe({ type: 'schedule_focus_block', payload: { subject: 'Deep work' } });
  assert.equal(alone.kind, presenter.WRITE);
  assert.equal(alone.warnings.length, 0);
  assert.equal(alone.canApprove, true, 'no start time is fine — the executor defaults to the next half hour');

  const withGuests = presenter.describe({
    type: 'schedule_focus_block',
    payload: { subject: '1-2-1', attendees: [{ email: 'a@b.c' }, { email: 'd@e.f' }] },
  });
  assert.equal(withGuests.kind, presenter.OUTBOUND);
  assert.ok(withGuests.warnings.some(w => /real invite to 2 people/.test(w)));
});

test('draft_reply is labelled as the first of two gates and sends nothing', () => {
  const d = presenter.describe({ type: 'draft_reply', payload: { emailId: 'AAA', from: 'Stephen Mitchell' } });
  assert.equal(d.kind, presenter.WRITE, 'gate 1 writes a draft — it is not outbound');
  assert.match(d.note, /Gate 1 of 2/);
  assert.match(d.summary, /nothing is sent/i);
});

test('an unknown type still gets a card, and it cannot be approved', () => {
  const d = presenter.describe({ type: 'teleport_nick', payload: {} });
  assert.equal(d.canApprove, false);
  assert.ok(d.blockers.some(b => /no case for/.test(b)));
  assert.equal(d.label, 'teleport_nick', 'never hide a pending action — that is the hole this list closes');
});

test('navigation actions are approvable and marked as changing nothing', () => {
  for (const type of ['open_ticket', 'open_task', 'open_email', 'open_standup', 'open_meeting_prep']) {
    const d = presenter.describe({ type, payload: {} });
    assert.equal(d.kind, presenter.NAVIGATE, `${type} changes nothing`);
    assert.equal(d.canApprove, true);
  }
});

test('a navigation card names the destination it actually goes to', () => {
  const prep = presenter.describe({
    type: 'open_meeting_prep',
    payload: { navigate: 'meeting-prep', title: 'Team Standup', start: '2026-08-17T09:45:00.0000000' },
  });
  assert.match(prep.summary, /Team Standup/, 'the meeting is the whole content of the card');
  assert.ok(prep.fields.some(f => f.label === 'Starts' && f.value === '09:45'), 'clock time, sliced not parsed');

  // The rows already in the queue: a meeting-prep nudge stored under open_task,
  // which used to render as "jump to your task list" and go somewhere else.
  const legacy = presenter.describe({ type: 'open_task', payload: { navigate: 'meeting-prep' } });
  assert.match(legacy.summary, /meeting-prep/, 'must not claim it opens the task list');

  const real = presenter.describe({ type: 'open_task', payload: { navigate: 'todos', filter: 'overdue' } });
  assert.match(real.summary, /tasks \(overdue\)/);
});
