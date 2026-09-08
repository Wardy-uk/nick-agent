'use strict';

/**
 * A task card must be able to say when it arrived and how.
 *
 * Pinned here rather than in a route test because the describer is PURE — it
 * takes a row and a clock and returns words, so the rules that matter (an
 * opaque id is never a label; an unknown source is named as itself; a missing
 * date is never today) pin without a database, a vault or a network.
 *
 * The live case that motivated it is a fixture: task #251, source
 * `email-promotion`, `origin_path: email:AAMk…` — a MUST due today that Nick
 * could not identify at all.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  describeTaskProvenance,
  describeDate,
  SOURCE_HOW,
} = require('../../shared/task-provenance.cjs');

const NOW = new Date('2026-09-07T12:00:00');

// The row as it actually stands in the live DB, copied from it rather than
// invented — an invented identifier is how `sleep_core_hours` and
// `meeting_alert` both shipped green.
const TASK_251 = {
  id: 251,
  text: 'Review what happened and explain where the process broke down',
  source: 'email-promotion',
  origin_path: 'email:AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTE4LWQyNmMzN2UyMTBmOQBGAAAA',
  origin_line: null,
  created_at: '2026-09-07 10:18:56',
};

test('the date is read off the string and rendered as a person reads it', () => {
  const p = describeTaskProvenance({ source: 'manual', created_at: '2026-08-25 09:00:00' }, { now: NOW });
  assert.equal(p.addedDate, '2026-08-25');
  assert.equal(p.added, 'Added 13 days ago');
  assert.equal(p.addedAgeDays, 13);
});

test('an older task gets the date itself, not an unreadable day count', () => {
  const p = describeTaskProvenance({ source: 'manual', created_at: '2026-06-01 09:00:00' }, { now: NOW });
  assert.equal(p.added, 'Added 1 Jun 2026');
});

test('today and yesterday are named', () => {
  assert.equal(
    describeTaskProvenance({ source: 'manual', created_at: '2026-09-07 10:18:56' }, { now: NOW }).added,
    'Added today',
  );
  assert.equal(
    describeTaskProvenance({ source: 'manual', created_at: '2026-09-06 23:59:00' }, { now: NOW }).added,
    'Added yesterday',
  );
});

test('NEGATIVE: a missing date says so and is never rendered as today', () => {
  const p = describeTaskProvenance({ source: 'manual' }, { now: NOW });
  assert.equal(p.addedKnown, false);
  assert.equal(p.addedDate, null);
  assert.equal(p.added, 'Added — date not recorded');
  assert.ok(!/today/i.test(p.added), 'an absent date must never read as today');
});

test('a bare YYYY-MM-DD is not put through Date(), so it cannot slip a day', () => {
  // The trap: new Date('2026-08-25') is UTC midnight, which renders as the 24th
  // west of here. Sliced out of the string instead — the rule the calendar had
  // to learn twice.
  const d = describeDate('2026-08-25', NOW);
  assert.equal(d.label, '25 Aug 2026');
  assert.equal(d.iso, '2026-08-25');
});

test('#251: an email-sourced task says it came from an email, never the Graph id', () => {
  const p = describeTaskProvenance(TASK_251, { now: NOW });
  assert.equal(p.how, SOURCE_HOW['email-promotion']);
  assert.equal(p.from.kind, 'email');
  assert.equal(p.from.label, 'An email — sender not recorded');
  assert.equal(p.added, 'Added today');
});

test('NEGATIVE: no Graph id reaches a label, on any field a card renders', () => {
  const p = describeTaskProvenance(TASK_251, { now: NOW });
  for (const field of [p.how, p.added, p.from.label, p.from.detail]) {
    if (field == null) continue;
    assert.ok(!/AAMk/.test(field), `a Graph id must never be a label: ${field}`);
  }
  // It still travels, for matching a row back to its source.
  assert.ok(p.from.ref.startsWith('email:'));
});

test('with the sender recorded, the card names who asked and what about', () => {
  const p = describeTaskProvenance({
    ...TASK_251,
    origin_detail: JSON.stringify({
      email: { from: 'Naomi Wentworth', subject: 'Sandford escalation', received: '2026-09-05' },
    }),
  }, { now: NOW });
  assert.equal(p.from.label, 'Email from Naomi Wentworth');
  assert.ok(p.from.detail.includes('Sandford escalation'));
});

test('a meeting-promoted task names the note, with the path as the detail', () => {
  const p = describeTaskProvenance({
    source: 'meeting-promotion',
    origin_path: 'Meetings/2026/08/2026-08-25 Hope 1-2-1.md',
    origin_line: 14,
    created_at: '2026-08-25 09:00:00',
  }, { now: NOW });
  assert.equal(p.from.label, '2026-08-25 Hope 1-2-1');
  assert.equal(p.from.context, 'Meetings note');
  assert.equal(p.from.detail, 'Meetings/2026/08/2026-08-25 Hope 1-2-1.md:14');
  assert.equal(p.known, true);
});

test('a household capture names the person who made it', () => {
  const p = describeTaskProvenance({ source: 'capture:Helen', created_at: '2026-09-01 08:00:00' }, { now: NOW });
  assert.equal(p.how, 'Captured by Helen on the house page');
  assert.equal(p.known, true);
});

test('NEGATIVE: an unrecognised source is named as itself, never guessed at', () => {
  const p = describeTaskProvenance({ source: 'some-new-writer', created_at: '2026-09-01 08:00:00' }, { now: NOW });
  assert.equal(p.how, 'Recorded as “some-new-writer”');
  assert.equal(p.known, false, 'an unknown source must not claim to be known');
});

test('NEGATIVE: only `manual` may say a person typed it', () => {
  assert.equal(describeTaskProvenance({ source: 'manual' }).how, 'You typed it in');

  // `unattributed` is the gap value createTask stores when a writer forgot to
  // name itself. The whole reason it exists is that 'manual' used to be a CLAIM
  // rather than a fact, so it must read as a gap.
  const gap = describeTaskProvenance({ source: 'unattributed' });
  assert.equal(gap.known, false);
  assert.ok(/not recorded/i.test(gap.how));
  assert.ok(!/you typed|you added/i.test(gap.how));

  // And so must a row with no source at all.
  const none = describeTaskProvenance({});
  assert.equal(none.known, false);
  assert.ok(!/you typed|you added/i.test(none.how));
});

test('every live task source is described — measured against the store, not guessed', () => {
  // The distinct `source` values in the live DB on 7 Sep 2026. A writer landing
  // here without a phrase renders as `Recorded as "..."`, which is honest but
  // is a prompt to add one.
  const live = [
    'master-todo-import', 'meeting-promotion', 'management-log', 'nova-121',
    'vantage-finding', 'chat', 'email-promotion', 'jira-assigned', 'manual',
    'apple-reminders', 'eod-session', 'sara-capture', 'standup-session', 'vantage-plan',
  ];
  for (const s of live) {
    assert.ok(SOURCE_HOW[s], `no wording for a source that is actually in the store: ${s}`);
  }
});

test('the shape takes a toTodoShape row as well as a raw DB row', () => {
  const camel = describeTaskProvenance({
    taskSource: 'meeting-promotion',
    originPath: 'Meetings/x.md',
    originLine: 2,
    createdAt: '2026-09-06',
  }, { now: NOW });
  assert.equal(camel.how, SOURCE_HOW['meeting-promotion']);
  assert.equal(camel.added, 'Added yesterday');
  assert.equal(camel.from.label, 'x');
});

test('unparseable origin_detail is kept as a note rather than thrown away', () => {
  const p = describeTaskProvenance({ source: 'manual', origin_detail: 'raised at the SLT meeting' });
  assert.equal(p.from.label, 'raised at the SLT meeting');
});
