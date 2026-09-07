'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { gate, sayLine, SECONDARY_MAX } = require('./attention');
const { ACTIVITY } = require('./context-state');

// A context of the shape resolveContext returns. Confidence is stated per-test
// because it decides whether the gate is allowed to hide anything.
function ctx(activity, over = {}) {
  return {
    activity,
    label: 'Label',
    summary: 'Summary.',
    quiet: activity === ACTIVITY.IN_MEETING || activity === ACTIVITY.OFF,
    confidence: { score: 0.8, level: 'high', basis: [], rationale: '' },
    reasons: [],
    contradictions: [],
    unknowns: [],
    ...over,
  };
}

function item(over = {}) {
  return {
    id: 'item-1', type: 'todo', title: 'Do the thing', reason: 'Overdue',
    score: 60, tier: 2, urgency: 'medium', meta: {}, ...over,
  };
}

const ESCALATION = item({ id: 'escalations-unseen', type: 'escalation', title: 'NT-1 — broken', tier: 1, score: 95, _unsuppressable: true });
const STANDUP = item({ id: 'nudge-1', type: 'nudge', title: 'Standup', tier: 1, score: 93, meta: { type: 'standup' } });
const MEETING = item({ id: 'meeting-1', type: 'meeting', title: '1-2-1 with Hope', tier: 1, score: 88 });

// ── Silence is a correct answer ──────────────────────────────────────────────

test('in a meeting: nothing is surfaced and nothing is spoken', () => {
  const g = gate(ctx(ACTIVITY.IN_MEETING), [ESCALATION, item()]);
  assert.equal(g.primary.kind, 'context');
  assert.deepEqual(g.secondary, []);
  assert.equal(g.speech, null);
  assert.equal(g.quiet, true);
  assert.equal(g.dropped.length, 2, 'everything is held, and named');
});

test('nothing is ever dropped silently', () => {
  const g = gate(ctx(ACTIVITY.IN_MEETING), [ESCALATION]);
  assert.equal(g.dropped[0].id, 'escalations-unseen');
  assert.ok(g.dropped[0].why);
});

test('an empty pool on a calm day is a null primary, not an invented card', () => {
  const g = gate(ctx(ACTIVITY.STEADY), []);
  assert.equal(g.primary, null);
  assert.equal(g.speech, null);
});

test('a context card is never spoken aloud', () => {
  // "You're in a focus session" said to someone in a focus session is pure
  // interruption. Only a real candidate earns speech.
  const g = gate(ctx(ACTIVITY.IN_FOCUS_SESSION), []);
  assert.equal(g.primary.kind, 'context');
  assert.equal(g.speech, null);
});

// ── Confidence decides how much may be HIDDEN ────────────────────────────────

test('a low-confidence read may re-order but must never hide work', () => {
  const low = ctx(ACTIVITY.IN_FOCUS_SESSION, { confidence: { level: 'low', score: 0.3 } });
  const g = gate(low, [item({ id: 'a', tier: 2 }), item({ id: 'b', tier: 3 })]);
  assert.equal(g.dropped.length, 0, 'a bad read must not remove anything');
  assert.match(g.rationale, /nothing was hidden/);

  const high = gate(ctx(ACTIVITY.IN_FOCUS_SESSION), [item({ id: 'a', tier: 2 }), item({ id: 'b', tier: 3 })]);
  assert.equal(high.dropped.length, 2, 'a confident read may protect the session');
});

test('quiet still applies at low confidence — silence fails safe', () => {
  const low = ctx(ACTIVITY.IN_MEETING, { confidence: { level: 'low', score: 0.3 } });
  const g = gate(low, [ESCALATION]);
  assert.equal(g.quiet, true);
  assert.equal(g.speech, null);
  assert.equal(g.dropped.length, 0, 'but nothing is hidden on a read we do not trust');
});

test('an unreadable context filters nothing at all', () => {
  const g = gate(ctx(ACTIVITY.UNKNOWN, { confidence: { level: 'low', score: 0.2 } }), [item({ id: 'a', tier: 3 })]);
  assert.equal(g.dropped.length, 0);
  assert.equal(g.primary.id, 'a');
  assert.match(g.rationale, /must not hide work/);
});

// ── Re-ranking, never adding ─────────────────────────────────────────────────

test('context re-ranks the pool — it never invents a candidate', () => {
  const g = gate(ctx(ACTIVITY.FIREFIGHTING), [item({ id: 'todo-a' }), ESCALATION]);
  assert.equal(g.primary.kind, 'item');
  assert.equal(g.primary.id, 'escalations-unseen', 'the queue leads, though the todo was first in');
  assert.equal(g.secondary[0].id, 'todo-a', 'the rest stays, in order');
});

test('a context primary is used only when the pool has no matching candidate', () => {
  const withItem = gate(ctx(ACTIVITY.PRE_MEETING), [MEETING, item()]);
  assert.equal(withItem.primary.kind, 'item');
  assert.equal(withItem.primary.id, 'meeting-1');

  const withoutItem = gate(ctx(ACTIVITY.PRE_MEETING), [item()]);
  assert.equal(withoutItem.primary.kind, 'context');
  assert.equal(withoutItem.secondary[0].id, 'item-1', 'the pool is untouched by the fallback');
});

test('a ritual leads only when its own nudge is in the pool', () => {
  const g = gate(ctx(ACTIVITY.RITUAL), [item({ id: 'other' }), STANDUP]);
  assert.equal(g.primary.id, 'nudge-1');

  const eod = gate(ctx(ACTIVITY.RITUAL), [item({ id: 'nudge-9', type: 'nudge', meta: { type: 'journal' } })]);
  assert.equal(eod.primary.kind, 'context', 'a journal nudge is not the ritual that is due');
});

test('a focus session lets a tier-1 interruption through and holds the rest', () => {
  const g = gate(ctx(ACTIVITY.IN_FOCUS_SESSION), [item({ id: 'b', tier: 2 }), ESCALATION]);
  assert.equal(g.primary.id, 'escalations-unseen');
  assert.deepEqual(g.dropped.map((d) => d.id), ['b']);
});

test('a non-working day keeps only what the engine marked unsuppressable', () => {
  const g = gate(ctx(ACTIVITY.OFF), [item({ id: 'todo-a' }), ESCALATION]);
  assert.equal(g.primary.id, 'escalations-unseen');
  assert.deepEqual(g.dropped.map((d) => d.id), ['todo-a']);
  assert.equal(g.speech, null, 'a day off is not spoken into');
});

test('a day off surfaces PERSONAL work and still holds the work back', () => {
  // The whole point of a day off having a feed at all. Before the domain split
  // there was nothing a Saturday could honestly surface — every task in the
  // store was work — so silence was the only correct behaviour. Now the pool
  // can hold things that are exactly as due on a Saturday as on a Tuesday.
  const g = gate(ctx(ACTIVITY.OFF), [
    item({ id: 'work-a', title: 'Write the risk report' }),
    item({ id: 'home-a', title: 'Collect the parcel', meta: { domain: 'personal' } }),
  ]);
  assert.equal(g.primary.id, 'home-a');
  // Work is DROPPED, not quietly withheld — held is not lost.
  assert.deepEqual(g.dropped.map((d) => d.id), ['work-a']);
});

test('an item with no domain is treated as WORK on a day off', () => {
  // The asymmetry: a personal item treated as work merely stays hidden on a
  // Saturday, while a work item treated as personal SURFACES on one — which is
  // the thing a day off exists to prevent. So anything not positively personal
  // is work.
  const g = gate(ctx(ACTIVITY.OFF), [
    item({ id: 'no-meta', meta: {} }),
    item({ id: 'null-domain', meta: { domain: null } }),
    item({ id: 'nonsense', meta: { domain: 'Personal Life' } }),
  ]);
  assert.equal(g.primary.kind, 'context', 'nothing personal, so the context is the answer');
  assert.deepEqual(g.dropped.map((d) => d.id).sort(), ['no-meta', 'nonsense', 'null-domain']);
});

test('a low-confidence day off still hides nothing', () => {
  // Dropping requires a confident read. A bad guess that Nick is off must not
  // hide real work — the rule that separates QUIET from DROPPING.
  const g = gate(
    ctx(ACTIVITY.OFF, { confidence: { score: 0.3, level: 'low', basis: [], rationale: '' } }),
    [item({ id: 'work-a' })],
  );
  assert.deepEqual(g.dropped, []);
  assert.equal(g.primary.id, 'work-a');
});

test('away changes nothing — not the ranking, and not the speech', () => {
  // Caught live: the rationale claimed "nothing is spoken" in the same payload
  // as a populated `speech` and `quiet:false`. Presence means "not at home",
  // the phone is in his pocket, and being out is exactly when SARA coming to
  // him is the point — so away must speak.
  const items = [item({ id: 'a', score: 70 }), item({ id: 'b', score: 60 })];
  const away = gate(ctx(ACTIVITY.AWAY), items);
  const steady = gate(ctx(ACTIVITY.STEADY), items);
  assert.equal(away.primary.id, steady.primary.id);
  assert.deepEqual(away.secondary.map((s) => s.id), steady.secondary.map((s) => s.id));
  assert.equal(away.dropped.length, 0);
  assert.equal(away.speech, steady.speech);
  assert.ok(away.speech, 'away is not a reason to go silent');
});

test('a gate never claims silence while it is speaking', () => {
  // The general invariant behind the bug above: speech and the stated reason
  // must describe the same payload. Asserted across every activity so a new
  // branch cannot reintroduce it.
  for (const activity of Object.values(ACTIVITY)) {
    const g = gate(ctx(activity), [item(), ESCALATION]);
    if (g.speech) {
      assert.equal(g.quiet, false, `${activity}: speaking while quiet`);
      assert.ok(!/nothing is spoken|not spoken/.test(g.rationale), `${activity}: rationale claims silence while speaking`);
    }
  }
});

// ── Shape ────────────────────────────────────────────────────────────────────

test('secondary is capped', () => {
  const many = Array.from({ length: 10 }, (_, i) => item({ id: `i${i}` }));
  const g = gate(ctx(ACTIVITY.STEADY), many);
  assert.equal(g.secondary.length, SECONDARY_MAX);
});

test('item and context cards are distinguishable by kind', () => {
  assert.equal(gate(ctx(ACTIVITY.STEADY), [item()]).primary.kind, 'item');
  assert.equal(gate(ctx(ACTIVITY.IN_MEETING), []).primary.kind, 'context');
});

test('speech reads as one sentence and never doubles its full stop', () => {
  const g = gate(ctx(ACTIVITY.STEADY), [item({ title: 'Do the thing', reason: 'Overdue' })]);
  assert.equal(g.speech, 'Do the thing. Overdue.');
  const noReason = gate(ctx(ACTIVITY.STEADY), [item({ reason: null })]);
  assert.equal(noReason.speech, 'Do the thing.');
});

test('pure: a garbage context degrades to no filtering rather than throwing', () => {
  const g = gate(null, [item()]);
  assert.equal(g.dropped.length, 0);
  assert.equal(g.primary.id, 'item-1');
});

// ── She says it, rather than listing fields ─────────────────────────────────

const AUG25 = new Date('2026-08-25T09:00:00');

test('an overdue task is said, not itemised', () => {
  // The shipped screen read "Marked high priority · 1 day overdue · 34 other
  // overdue" — the same facts, dumped.
  const line = sayLine(item({ type: 'todo', meta: { dueDate: '2026-08-24', overdueCount: 35 } }), AUG25);
  assert.equal(line, "It's a day over, and 34 others are behind it.");
});

test('the last one standing does not claim company', () => {
  assert.equal(
    sayLine(item({ type: 'todo', meta: { dueDate: '2026-08-18', overdueCount: 1 } }), AUG25),
    "It's 7 days over.",
  );
});

test('due-today and undated work read as themselves, not as overdue', () => {
  assert.equal(sayLine(item({ type: 'todo', meta: { dueTodayCount: 1 } }), AUG25), 'Due today.');
  assert.equal(sayLine(item({ type: 'todo', meta: { dueTodayCount: 4 } }), AUG25), 'Due today, along with 3 more.');
  assert.equal(
    sayLine(item({ type: 'todo', meta: { undatedHighCount: 1 } }), AUG25),
    'High priority, but nothing has given it a date.',
  );
});

test('an escalation says how long it has been ignored', () => {
  const one = sayLine(item({ type: 'escalation', meta: { escalations: [{ ageDays: 9 }] } }), AUG25);
  assert.equal(one, 'Raised 9 days ago, and still no reply from you.');
  assert.match(sayLine(item({ type: 'escalation', meta: { escalations: [{ ageDays: 1 }] } }), AUG25), /yesterday/);
  const many = sayLine(item({ type: 'escalation', meta: { escalations: [{}, {}], overflow: 3 } }), AUG25);
  assert.equal(many, '5 escalations are waiting on a reply from you.');
});

test('a meeting is timed from its START, not from a stale captured count', () => {
  // The collector's `minutesAway` was true when the pool was built. A card still
  // reading "in 10 min" four minutes later is quietly lying, so it is recomputed.
  const m = (start, over = {}) => item({ type: 'meeting', title: '1-2-1', meta: { start, ...over } });
  assert.equal(sayLine(m('2026-08-25T09:10:00'), AUG25), 'In 10 minutes.');
  assert.equal(sayLine(m('2026-08-25T09:10:00'), new Date('2026-08-25T09:06:00')), 'In 4 minutes.');
  assert.equal(sayLine(m('2026-08-25T09:01:00'), AUG25), 'Starting in a minute.');
  assert.equal(sayLine(m('2026-08-25T08:55:00'), AUG25), "It's started.");
  assert.equal(sayLine(m('2026-08-25T10:00:00'), AUG25), 'In about an hour.');
  assert.equal(sayLine(m('2026-08-25T09:10:00', { location: 'the Boardroom' }), AUG25), 'In 10 minutes, in the Boardroom.');
});

test('emails name the sender; the delegate pile keeps its own sentence', () => {
  assert.equal(
    sayLine(item({ type: 'email', meta: { count: 1, from: 'Emma Weston <emma@nurtur.tech>' } }), AUG25),
    'From Emma, and it needs an answer.',
  );
  assert.equal(
    sayLine(item({ type: 'email', meta: { count: 6, from: 'Emma Weston' } }), AUG25),
    '6 need an answer — the top one is from Emma.',
  );
  // No sender = the delegate variant, whose reason is already prose.
  const delegate = 'These are answerable by someone else';
  assert.equal(sayLine(item({ type: 'email', reason: delegate, meta: { count: 3 } }), AUG25), delegate);
});

test('⚠ it never invents — anything unphraseable falls back to the engine verbatim', () => {
  const raw = 'Needs action · Unread · Recent';
  assert.equal(sayLine(item({ type: 'email', reason: raw, meta: {} }), AUG25), raw);
  // A todo with no structured meta must not be dressed up either.
  assert.equal(sayLine(item({ type: 'todo', reason: raw, meta: {} }), AUG25), raw);
  assert.equal(sayLine(item({ type: 'todo', reason: null, meta: {} }), AUG25), null);
  assert.equal(sayLine(null, AUG25), null);
});

test('a malformed due date falls back rather than printing NaN', () => {
  const raw = 'Overdue';
  assert.equal(sayLine(item({ type: 'todo', reason: raw, meta: { dueDate: 'not-a-date', overdueCount: 3 } }), AUG25), raw);
});

test('what is spoken and what is read are the same composed line', () => {
  const g = gate(ctx(ACTIVITY.STEADY), [item({ type: 'todo', title: 'Brief the team', meta: { dueDate: '2026-08-24', overdueCount: 2 } })], AUG25);
  assert.equal(g.primary.say, "It's a day over, and 1 other is behind it.");
  assert.equal(g.speech, "Brief the team. It's a day over, and 1 other is behind it.");
});

test('sayLine honours the `now` it is given', () => {
  const t = item({ type: 'todo', meta: { dueDate: '2026-08-24', overdueCount: 1 } });
  assert.notEqual(sayLine(t, AUG25), sayLine(t, new Date('2026-09-01T09:00:00')));
});

test('pure: the pool is not mutated', () => {
  const items = [item({ id: 'a' }), ESCALATION];
  const before = JSON.stringify(items);
  gate(ctx(ACTIVITY.FIREFIGHTING), items);
  assert.equal(JSON.stringify(items), before);
});

// ── Agenda ──────────────────────────────────────────────────────────────────

const { agendaFor } = require('./attention');

test('agenda: an unreadable calendar is not an empty day', () => {
  // The whole point. "Your diary is clear" and "I could not read your diary"
  // license opposite behaviour and only one of them is good news.
  const a = agendaFor({ known: false }, new Date('2026-08-28T14:00:00'));
  assert.equal(a.known, false);
  assert.deepEqual(a.events, []);
});

test('agenda: only what is LEFT of today, soonest first', () => {
  const now = new Date('2026-08-28T14:00:00');
  const cal = {
    known: true,
    events: [
      { start: '2026-08-28T09:00', end: '2026-08-28T09:30', subject: 'Done already', showAs: 'busy' },
      { start: '2026-08-28T16:00', end: '2026-08-28T16:30', subject: 'Later', showAs: 'busy' },
      { start: '2026-08-28T15:00', end: '2026-08-28T15:30', subject: 'Sooner', showAs: 'busy' },
    ],
  };
  const a = agendaFor(cal, now);
  assert.equal(a.known, true);
  assert.deepEqual(a.events.map((e) => e.subject), ['Sooner', 'Later']);
  assert.equal(a.events[0].minutesAway, 60);
});

test('agenda: a meeting in progress is running, not "soon"', () => {
  // A negative countdown rendered as "in -12 minutes" is the sort of thing that
  // makes a widget look broken, so the two states are separated here rather
  // than left for each renderer to work out.
  const now = new Date('2026-08-28T14:10:00');
  const cal = {
    known: true,
    events: [{ start: '2026-08-28T14:00', end: '2026-08-28T14:30', subject: 'Now', showAs: 'busy' }],
  };
  const a = agendaFor(cal, now);
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].running, true);
  assert.ok(a.events[0].minutesAway < 0);
});

test('agenda: cancelled, all-day and free blocks are not the day\'s shape', () => {
  const now = new Date('2026-08-28T09:00:00');
  const cal = {
    known: true,
    events: [
      { start: '2026-08-28T10:00', end: '2026-08-28T10:30', subject: 'Cancelled', showAs: 'cancelled', isCancelled: true },
      { start: '2026-08-28T00:00', end: '2026-08-29T00:00', subject: 'Birthday', showAs: 'free', isAllDay: true },
      { start: '2026-08-28T11:00', end: '2026-08-28T11:30', subject: 'Free block', showAs: 'free' },
      { start: '2026-08-28T12:00', end: '2026-08-28T12:30', subject: 'Real', showAs: 'busy' },
    ],
  };
  const a = agendaFor(cal, now);
  assert.deepEqual(a.events.map((e) => e.subject), ['Real']);
});

test('agenda: an empty evening rolls forward to tomorrow, and SAYS so', () => {
  // A large widget that empties out at 17:00 every day is one that stops being
  // looked at. `scope` exists so no renderer can label tomorrow as today.
  const now = new Date('2026-08-28T17:41:00');
  const today = { known: true, events: [
    { start: '2026-08-28T17:15', end: '2026-08-28T17:30', subject: 'Gone', showAs: 'busy' },
  ] };
  const tomorrow = [
    { start: '2026-08-29T11:00', end: '2026-08-29T11:30', subject: 'Later one', showAs: 'busy' },
    { start: '2026-08-29T09:00', end: '2026-08-29T09:30', subject: 'First thing', showAs: 'busy' },
  ];
  const a = agendaFor(today, now, 4, tomorrow);
  assert.equal(a.scope, 'tomorrow');
  assert.deepEqual(a.events.map((e) => e.subject), ['First thing', 'Later one']);
  // No countdown across a day boundary — "in 15 hours" reads as imminent.
  assert.equal(a.events[0].minutesAway, null);
  assert.equal(a.events[0].running, false);
});

test('agenda: today still wins while anything is left in it', () => {
  const now = new Date('2026-08-28T14:00:00');
  const today = { known: true, events: [
    { start: '2026-08-28T16:00', end: '2026-08-28T16:30', subject: 'Still to come', showAs: 'busy' },
  ] };
  const a = agendaFor(today, now, 4, [
    { start: '2026-08-29T09:00', end: '2026-08-29T09:30', subject: 'Tomorrow', showAs: 'busy' },
  ]);
  assert.equal(a.scope, 'today');
  assert.deepEqual(a.events.map((e) => e.subject), ['Still to come']);
});

test('agenda: an unreadable diary never rolls forward', () => {
  // known:false means we could not look. Filling that with tomorrow would turn
  // "I cannot see your diary" into a confident statement about it.
  const a = agendaFor({ known: false }, new Date('2026-08-28T17:41:00'), 4, [
    { start: '2026-08-29T09:00', end: '2026-08-29T09:30', subject: 'Tomorrow', showAs: 'busy' },
  ]);
  assert.equal(a.known, false);
  assert.deepEqual(a.events, []);
});

test('agenda: rolls to the next day that HAS something, and names it', () => {
  // Friday evening, nothing tomorrow (Saturday). Rolling only one day forward
  // leaves the widget as empty as it was — which is the case Nick was looking
  // at when he said it was still a bit meh.
  const friday = new Date('2026-08-28T17:41:00');
  const today = { known: true, events: [] };
  const ahead = [
    { start: '2026-08-31T09:30', end: '2026-08-31T10:00', subject: 'Monday standup', showAs: 'busy' },
    { start: '2026-08-31T14:00', end: '2026-08-31T14:30', subject: 'Monday 1-2-1', showAs: 'busy' },
    { start: '2026-09-01T09:00', end: '2026-09-01T09:30', subject: 'Tuesday thing', showAs: 'busy' },
  ];
  const a = agendaFor(today, friday, 4, ahead);
  assert.equal(a.scope, 'monday');
  // Only the first day WITH something — not a merged list across days.
  assert.deepEqual(a.events.map((e) => e.subject), ['Monday standup', 'Monday 1-2-1']);
});

test('agenda: the day after today is still called "tomorrow"', () => {
  const a = agendaFor({ known: true, events: [] }, new Date('2026-08-28T17:41:00'), 4, [
    { start: '2026-08-29T10:00', end: '2026-08-29T10:30', subject: 'Saturday', showAs: 'busy' },
  ]);
  assert.equal(a.scope, 'tomorrow');
});

// ── The personal agenda ─────────────────────────────────────────────────────

test('a PERSONAL agenda keeps the all-day, free events a work one drops', () => {
  // The three events the phone pushed first were two bank holidays and
  // "hiking" — every one all-day, every one marked free. The work filter drops
  // exactly those, which left Nick's weekend empty.
  const sat = new Date('2026-08-29T10:00:00');
  const cal = { known: true, events: [
    { start: '2026-08-29T00:00:00', end: '2026-08-30T00:00:00', subject: 'Hiking', showAs: 'free', isAllDay: true, source: 'apple' },
    { start: '2026-08-29T14:00:00', end: '2026-08-29T15:00:00', subject: 'Work thing', showAs: 'busy', source: 'graph' },
  ] };

  const personal = agendaFor(cal, sat, 4, [], { personal: true });
  assert.deepEqual(personal.events.map((e) => e.subject), ['Hiking'],
    'personal keeps the all-day free event and excludes the work one');

  const work = agendaFor(cal, sat, 4, [], { personal: false });
  assert.deepEqual(work.events.map((e) => e.subject), ['Work thing'],
    'work is unchanged — all-day free events are still noise in a work diary');
});

test('an all-day personal event survives all day, not until midnight passed', () => {
  // An all-day event ENDS at 00:00 the following morning, so judging it on the
  // instant would make today's event vanish at one second past midnight.
  const cal = { known: true, events: [
    { start: '2026-08-29T00:00:00', end: '2026-08-30T00:00:00', subject: 'Hiking', showAs: 'free', isAllDay: true, source: 'apple' },
  ] };
  const morning = agendaFor(cal, new Date('2026-08-29T08:00:00'), 4, [], { personal: true });
  const evening = agendaFor(cal, new Date('2026-08-29T21:00:00'), 4, [], { personal: true });
  assert.equal(morning.events.length, 1);
  assert.equal(evening.events.length, 1, 'still on today at 9pm');
});

test('a personal agenda never shows work, even when work is all there is', () => {
  // The whole point of the weekend view: an empty personal agenda is correct,
  // and must not quietly fall back to the work diary.
  const cal = { known: true, events: [
    { start: '2026-08-31T10:00:00', end: '2026-08-31T10:30:00', subject: 'Team Standup', showAs: 'busy', source: 'graph' },
  ] };
  const a = agendaFor(cal, new Date('2026-08-29T10:00:00'), 4,
    [{ start: '2026-08-31T10:00:00', end: '2026-08-31T10:30:00', subject: 'Team Standup', showAs: 'busy', source: 'graph' }],
    { personal: true });
  assert.deepEqual(a.events, []);
});

test('a pinned view overrides which DIARY is read, and nothing else', () => {
  // A widget in a Smart Stack can be locked to one side of the split. A pinned
  // personal card showing work meetings under a personal heading is exactly
  // what the domain split exists to prevent.
  const sat = new Date('2026-08-29T10:00:00');
  const cal = { known: true, events: [
    { start: '2026-08-29T00:00:00', end: '2026-08-30T00:00:00', subject: 'Hiking', showAs: 'free', isAllDay: true, source: 'apple' },
    { start: '2026-08-29T14:00:00', end: '2026-08-29T15:00:00', subject: 'Work thing', showAs: 'busy', source: 'graph' },
  ] };

  assert.deepEqual(
    agendaFor(cal, sat, 4, [], { personal: true }).events.map((e) => e.subject),
    ['Hiking']
  );
  assert.deepEqual(
    agendaFor(cal, sat, 4, [], { personal: false }).events.map((e) => e.subject),
    ['Work thing']
  );
});

test('flip is the opposite of the brain, resolved on the SERVER', () => {
  // The second card in a Smart Stack. It has to be resolved here rather than in
  // the widget: the duty read is the brain's, and a client inverting its own
  // guess would be a second opinion about what kind of day it is — which is how
  // a card's agenda and its gauge come to disagree.
  const resolve = (view, brainOff) => {
    if (view === 'personal') return 'personal';
    if (view === 'work') return 'work';
    if (view === 'flip') return brainOff ? 'work' : 'personal';
    return brainOff ? 'personal' : 'work';
  };

  // Off duty: the top card is personal, so the flipped one must be work.
  assert.equal(resolve(null, true), 'personal');
  assert.equal(resolve('flip', true), 'work');

  // On duty: the top card is work, so the flipped one must be personal.
  assert.equal(resolve(null, false), 'work');
  assert.equal(resolve('flip', false), 'personal');

  // A pin outranks the brain in both directions.
  assert.equal(resolve('work', true), 'work');
  assert.equal(resolve('personal', false), 'personal');

  // The two cards in a stack must NEVER show the same side, whatever the day.
  for (const brainOff of [true, false]) {
    assert.notEqual(resolve(null, brainOff), resolve('flip', brainOff),
      'the stack would show the same card twice');
  }
});

test('the lookahead reaches a full week, so a weekly rhythm is not missed', () => {
  // Nick hikes every Saturday. A Sunday looking five days forward stopped at
  // Thursday and missed next weekend entirely — leaving the personal card blank
  // on the day he is most likely to be looking at it.
  const sunday = new Date('2026-08-30T09:00:00');
  const nextSaturday = [{
    start: '2026-09-05T00:00:00', end: '2026-09-06T00:00:00',
    subject: 'hiking', showAs: 'free', isAllDay: true, source: 'apple',
  }];

  const a = agendaFor({ known: true, events: [] }, sunday, 4, nextSaturday, { personal: true });
  assert.equal(a.events.length, 1, 'next Saturday must be reachable from Sunday');
  assert.equal(a.events[0].subject, 'hiking');
  assert.equal(a.scope, 'saturday', 'and it must be named, not called tomorrow');
});

const { sessionMatchesCard } = require('./attention');

// ── A session already running on the card ────────────────────────────────────
//
// Found live: a session had been running on "Stand up a temporary single view"
// for sixteen minutes and its own card still offered **Start this**, with
// nothing saying it was under way. Pressing it again force-switches, which
// (until the same day's fix) destroyed the running session outright.

test('a card whose task is already running is matched', () => {
  const session = { taskId: null, text: 'Stand up a temporary single view of aged/blocked/cross-team tickets' };
  const card = { title: 'Stand up a temporary single view of aged/blocked/cross-team tickets', meta: {} };
  assert.equal(sessionMatchesCard(session, card), true);
});

test('a shrunk session still belongs to the card it started from', () => {
  // The step changes on a shrink and the task does not. Matching on nextStep
  // would lose the card at exactly the moment the marker is most useful.
  const session = {
    taskId: null,
    text: 'Rewrite the escalation policy',
    nextStep: 'open the doc and list the headings',
  };
  assert.equal(
    sessionMatchesCard(session, { title: 'Rewrite the escalation policy', meta: {} }),
    true,
  );
  assert.equal(
    sessionMatchesCard(session, { title: 'open the doc and list the headings', meta: {} }),
    false,
  );
});

test('a different card is not marked as running', () => {
  const session = { taskId: null, text: 'Weekly risk meeting prep' };
  assert.equal(
    sessionMatchesCard(session, { title: 'Stand up a temporary single view', meta: {} }),
    false,
  );
});

test('task ids win over wording when both sides have one', () => {
  const session = { taskId: 42, text: 'whatever the session was called' };
  assert.equal(sessionMatchesCard(session, { title: 'a different title', meta: { task_id: 42 } }), true);
  assert.equal(sessionMatchesCard(session, { title: 'a different title', meta: { task_id: 43 } }), false);
});

test('no session, or an unreadable card, matches nothing', () => {
  assert.equal(sessionMatchesCard(null, { title: 'x', meta: {} }), false);
  assert.equal(sessionMatchesCard({ text: 'x' }, null), false);
  assert.equal(sessionMatchesCard({ text: '' }, { title: '', meta: {} }), false);
});
