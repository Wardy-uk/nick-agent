'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveContext, cannotSee, ACTIVITY, INPUT_BLOCKS, PRE_MEETING_MINUTES } = require('./context-state');

// A working Tuesday, mid-morning. Every test pins its own `now` — this module is
// pure precisely so the suite cannot break on a date rollover.
const TUE_0930 = new Date('2026-08-18T09:30:00');
const TUE_1430 = new Date('2026-08-18T14:30:00');
const TUE_1700 = new Date('2026-08-18T17:00:00');
const SAT_1100 = new Date('2026-08-22T11:00:00');

// Everything known, everything calm. Tests override one block at a time so each
// assertion is about the rule it names and not about the fixture.
function calm(over = {}) {
  return {
    calendar: { known: true, events: [] },
    focusSession: { known: true, active: null },
    queue: { known: true, breaching: 0, unseenEscalations: 0 },
    location: { known: true, place: 'office', source: 'owntracks' },
    presence: { known: true, present: true },
    rituals: { known: true, standupOutstanding: false, eodOutstanding: false },
    workingDay: { known: true, isWorkingDay: true, reason: null },
    ...over,
  };
}

function meeting(start, end, over = {}) {
  return { start, end, subject: 'Team catch-up', attendeesOther: true, ...over };
}

// ── The floor: missing is not zero ───────────────────────────────────────────

test('no inputs at all is unknown, not steady', () => {
  const c = resolveContext({}, TUE_0930);
  assert.equal(c.activity, ACTIVITY.UNKNOWN);
  assert.deepEqual(c.unknowns, INPUT_BLOCKS);
  assert.equal(c.confidence.level, 'low');
});

test('steady and unknown are different facts', () => {
  const steady = resolveContext(calm(), TUE_0930);
  assert.equal(steady.activity, ACTIVITY.STEADY);
  assert.equal(steady.unknowns.length, 0);
  assert.notEqual(steady.activity, resolveContext({}, TUE_0930).activity);
});

test('an unreadable queue is NOT a quiet all-clear', () => {
  // The queue block is absent. It must land in `unknowns` and be stated, never
  // be read as "nothing is breaching".
  const c = resolveContext(calm({ queue: { known: false } }), TUE_0930);
  assert.ok(c.unknowns.includes('queue'));
  assert.ok(c.reasons.some((r) => r.includes('Could not read') && r.includes('queue')));
  assert.ok(c.confidence.basis.includes('inputs-missing'));
});

test('absent and known:false are the same fact', () => {
  const a = resolveContext(calm({ presence: { known: false } }), TUE_0930);
  const b = resolveContext(calm({ presence: undefined }), TUE_0930);
  assert.deepEqual(a.unknowns, b.unknowns);
  assert.equal(a.confidence.score, b.confidence.score);
});

// ── Meetings: fails closed on anything it cannot judge ────────────────────────

test('a meeting with other people wins, and SARA goes quiet', () => {
  const c = resolveContext(
    calm({ calendar: { known: true, events: [meeting('2026-08-18T09:00:00', '2026-08-18T10:00:00')] } }),
    TUE_0930,
  );
  assert.equal(c.activity, ACTIVITY.IN_MEETING);
  assert.equal(c.quiet, true);
  assert.match(c.summary, /Team catch-up/);
});

test('a solo block is NOT a meeting — attendeesOther must be exactly true', () => {
  for (const attendeesOther of [false, undefined, null, 1, 'yes']) {
    const c = resolveContext(
      calm({ calendar: { known: true, events: [meeting('2026-08-18T09:00:00', '2026-08-18T10:00:00', { attendeesOther })] } }),
      TUE_0930,
    );
    assert.equal(c.activity, ACTIVITY.STEADY, `attendeesOther=${String(attendeesOther)} must not read as a meeting`);
    assert.equal(c.quiet, false);
  }
});

test('an event we could not judge is reported, not silently dropped', () => {
  const c = resolveContext(
    calm({ calendar: { known: true, events: [meeting('2026-08-18T09:35:00', '2026-08-18T10:00:00', { attendeesOther: null })] } }),
    TUE_0930,
  );
  assert.ok(c.reasons.some((r) => /could not be judged/.test(r)));
});

test('all-day, cancelled and free events are not meetings', () => {
  for (const over of [{ isAllDay: true }, { isCancelled: true }, { showAs: 'free' }]) {
    const c = resolveContext(
      calm({ calendar: { known: true, events: [meeting('2026-08-18T09:00:00', '2026-08-18T10:00:00', over)] } }),
      TUE_0930,
    );
    assert.equal(c.activity, ACTIVITY.STEADY, `${JSON.stringify(over)} must not read as a meeting`);
  }
});

test('pre-meeting fires inside the window and not outside it', () => {
  const inside = resolveContext(
    calm({ calendar: { known: true, events: [meeting('2026-08-18T09:35:00', '2026-08-18T10:00:00')] } }),
    TUE_0930,
  );
  assert.equal(inside.activity, ACTIVITY.PRE_MEETING);
  assert.match(inside.summary, /5 minutes/);

  const outside = resolveContext(
    calm({ calendar: { known: true, events: [meeting('2026-08-18T11:00:00', '2026-08-18T11:30:00')] } }),
    TUE_0930,
  );
  assert.equal(outside.activity, ACTIVITY.STEADY);
  assert.equal(PRE_MEETING_MINUTES, 10);
});

// ── Priority order ───────────────────────────────────────────────────────────

test('being in a meeting outranks a breaching queue', () => {
  const c = resolveContext(
    calm({
      calendar: { known: true, events: [meeting('2026-08-18T09:00:00', '2026-08-18T10:00:00')] },
      queue: { known: true, breaching: 4, unseenEscalations: 2 },
    }),
    TUE_0930,
  );
  assert.equal(c.activity, ACTIVITY.IN_MEETING);
});

test('a live queue outranks a focus session and a ritual', () => {
  const c = resolveContext(
    calm({
      queue: { known: true, breaching: 0, unseenEscalations: 3 },
      focusSession: { known: true, active: { taskTitle: 'Write the risk report' } },
      rituals: { known: true, standupOutstanding: true, eodOutstanding: false },
    }),
    TUE_0930,
  );
  assert.equal(c.activity, ACTIVITY.FIREFIGHTING);
  assert.match(c.summary, /3 unseen escalations/);
});

test('a live queue outranks away, and the conflict is recorded', () => {
  const c = resolveContext(
    calm({
      queue: { known: true, breaching: 2, unseenEscalations: 0 },
      presence: { known: true, present: false },
    }),
    TUE_1430,
  );
  assert.equal(c.activity, ACTIVITY.FIREFIGHTING);
  assert.equal(c.contradictions.length, 1);
  assert.ok(c.confidence.basis.includes('contradiction-present'));
});

// ── Rituals are windowed ─────────────────────────────────────────────────────

test('standup only counts in the morning, EOD only late', () => {
  const rituals = { known: true, standupOutstanding: true, eodOutstanding: true };
  assert.equal(resolveContext(calm({ rituals }), TUE_0930).label, 'Standup outstanding');
  assert.equal(resolveContext(calm({ rituals }), TUE_1430).activity, ACTIVITY.STEADY);
  assert.equal(resolveContext(calm({ rituals }), TUE_1700).label, 'EOD outstanding');
});

test('a ritual is never chased on a non-working day', () => {
  const c = resolveContext(
    calm({
      rituals: { known: true, standupOutstanding: true, eodOutstanding: false },
      workingDay: { known: true, isWorkingDay: false, reason: 'weekend' },
    }),
    SAT_1100,
  );
  assert.equal(c.activity, ACTIVITY.OFF);
  assert.equal(c.quiet, true);
});

test('a non-working day still yields to a live queue', () => {
  const c = resolveContext(
    calm({
      queue: { known: true, breaching: 1, unseenEscalations: 0 },
      workingDay: { known: true, isWorkingDay: false, reason: 'holiday' },
    }),
    SAT_1100,
  );
  assert.equal(c.activity, ACTIVITY.FIREFIGHTING);
});

// ── Away ─────────────────────────────────────────────────────────────────────

test('away comes from presence OR location', () => {
  const byPresence = resolveContext(calm({ presence: { known: true, present: false } }), TUE_1430);
  assert.equal(byPresence.activity, ACTIVITY.AWAY);

  const byLocation = resolveContext(calm({ location: { known: true, place: 'away', source: 'owntracks' } }), TUE_1430);
  assert.equal(byLocation.activity, ACTIVITY.AWAY);
});

test('place is reported separately from activity', () => {
  const c = resolveContext(calm(), TUE_1430);
  assert.deepEqual(c.place, { known: true, name: 'office', source: 'owntracks' });

  const blind = resolveContext(calm({ location: { known: false } }), TUE_1430);
  assert.equal(blind.place.known, false);
  assert.equal(blind.place.name, null);
});

// ── Confidence is earned by inputs, not by how firm the answer sounds ─────────

test('confidence falls as inputs go missing', () => {
  const full = resolveContext(calm({ queue: { known: true, breaching: 1, unseenEscalations: 0 } }), TUE_1430);
  const partial = resolveContext(
    calm({ queue: { known: true, breaching: 1, unseenEscalations: 0 }, calendar: { known: false }, presence: { known: false } }),
    TUE_1430,
  );
  assert.ok(partial.confidence.score < full.confidence.score);
  assert.match(partial.confidence.rationale, /could not be read/);
});

test('the calm default is marked as a weak signal', () => {
  const steady = resolveContext(calm(), TUE_1430);
  assert.ok(steady.confidence.basis.includes('weak-signal-default'));
  const firm = resolveContext(calm({ queue: { known: true, breaching: 1, unseenEscalations: 0 } }), TUE_1430);
  assert.ok(firm.confidence.score > steady.confidence.score);
});

test('score is clamped', () => {
  const c = resolveContext(calm({ queue: { known: true, breaching: 1, unseenEscalations: 0 } }), TUE_1430);
  assert.ok(c.confidence.score >= 0.2 && c.confidence.score <= 0.95);
});

test('"high" means EVERY input answered, not just a high score', () => {
  // Measured on the live box: 4 of 7 inputs scored exactly 0.75 and called
  // itself high while its own rationale said three could not be read. `level`
  // is what decides whether the gate may hide work, so it is capped by coverage.
  const blind = resolveContext(
    calm({
      queue: { known: true, breaching: 1, unseenEscalations: 0 },
      calendar: { known: false },
      location: { known: false },
      presence: { known: false },
    }),
    TUE_1430,
  );
  assert.ok(blind.confidence.score >= 0.75, 'the score is still what the arithmetic says');
  assert.equal(blind.confidence.level, 'moderate', 'but the level refuses to claim high with inputs missing');

  const full = resolveContext(calm({ queue: { known: true, breaching: 1, unseenEscalations: 0 } }), TUE_1430);
  assert.equal(full.confidence.level, 'high');
});

// ── A gap is only worth saying when it could have changed the answer ─────────

test('a gap that could not have outranked the answer is not mentioned', () => {
  // OwnTracks was down for weeks, so location is permanently unreadable. The
  // first version said "I can't tell where you are" on EVERY screen, forever —
  // an honesty line that never changes is an apology you learn to skip.
  // Mid-standup, location could only ever have argued for `away`, which ritual
  // already beats.
  assert.equal(cannotSee(['location'], ACTIVITY.RITUAL), null);
  assert.equal(cannotSee(['location'], ACTIVITY.IN_MEETING), null);
  assert.equal(cannotSee(['queue'], ACTIVITY.PRE_MEETING), null);
});

test('the same gap IS mentioned when it would have won', () => {
  // On a steady afternoon, `away` outranks `steady` — so not knowing is worth
  // saying out loud.
  assert.equal(cannotSee(['location'], ACTIVITY.STEADY), "I can't tell where you are.");
  assert.equal(cannotSee(['calendar'], ACTIVITY.FIREFIGHTING), "I can't see your diary.");
});

test('an unreadable context keeps every gap in play', () => {
  const line = cannotSee(['calendar', 'location'], ACTIVITY.UNKNOWN);
  assert.match(line, /see your diary/);
  assert.match(line, /tell where you are/);
  assert.equal(cannotSee(['location'], null), "I can't tell where you are.");
});

test('gaps read as a sentence, however many there are', () => {
  assert.equal(cannotSee([], ACTIVITY.STEADY), null);
  assert.equal(cannotSee(['calendar', 'location'], ACTIVITY.STEADY), "I can't see your diary or tell where you are.");
  const three = cannotSee(['calendar', 'queue', 'location'], ACTIVITY.STEADY);
  assert.equal(three, "I can't see your diary, see your queue or tell where you are.");
});

test('the full picture survives the filter', () => {
  // Nothing is hidden — only the ambient line is filtered. `unknowns` still
  // carries everything for the detail panel.
  const c = resolveContext(
    calm({ rituals: { known: true, standupOutstanding: true, eodOutstanding: false }, location: { known: false } }),
    TUE_0930,
  );
  assert.equal(c.activity, ACTIVITY.RITUAL);
  assert.equal(c.cannotSee, null, 'not worth interrupting with');
  assert.deepEqual(c.unknowns, ['location'], 'but still recorded in full');
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('pure: same inputs and same now give the same answer, and inputs are not mutated', () => {
  const inputs = calm({ calendar: { known: true, events: [meeting('2026-08-18T09:35:00', '2026-08-18T10:00:00')] } });
  const before = JSON.stringify(inputs);
  const a = resolveContext(inputs, TUE_0930);
  const b = resolveContext(inputs, TUE_0930);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(inputs), before, 'inputs must not be mutated');
});

test('now is HONOURED, not read from the wall clock', () => {
  // A silent revert to `new Date()` must fail here in the week it is written.
  const rituals = { known: true, standupOutstanding: true, eodOutstanding: true };
  const morning = resolveContext(calm({ rituals }), TUE_0930);
  const evening = resolveContext(calm({ rituals }), TUE_1700);
  assert.notEqual(morning.label, evening.label);
  assert.equal(morning.at, TUE_0930.toISOString());
});

// ── On duty ─────────────────────────────────────────────────────────────────
// `duty` decides what KIND of thing a surface shows; `activity` decides ranking.
// They are separate questions and these tests exist to keep them separate.

const { resolveDuty, ON_DUTY_START_HOUR, ON_DUTY_END_HOUR } = require('./context-state');

const WORKING = { known: true, isWorkingDay: true };
const NOT_WORKING = (reason) => ({ known: true, isWorkingDay: false, reason });

test('duty: a weekday in hours is on duty', () => {
  const d = resolveDuty(WORKING, new Date('2026-08-18T09:30:00'));
  assert.equal(d.onDuty, true);
  assert.equal(d.known, true);
});

test('duty: a non-working day is off duty, and says WHICH kind', () => {
  // "Annual leave" and "Sunday" license the same behaviour but are different
  // facts, and the reason is the interesting half on a day off.
  const leave = resolveDuty(NOT_WORKING('annual leave'), new Date('2026-08-18T09:30:00'));
  assert.equal(leave.onDuty, false);
  assert.match(leave.reason, /annual leave/);

  const weekend = resolveDuty(NOT_WORKING('weekend'), new Date('2026-08-16T09:30:00'));
  assert.equal(weekend.onDuty, false);
  assert.match(weekend.reason, /weekend/);
});

test('duty: a working day outside hours is off duty', () => {
  // The case that motivated this: a Tuesday at 21:00 is a working DAY, so
  // `activity` is steady and the widget would otherwise still be nagging.
  const late = resolveDuty(WORKING, new Date('2026-08-18T21:00:00'));
  assert.equal(late.onDuty, false);
  assert.match(late.reason, /Outside working hours/);

  const early = resolveDuty(WORKING, new Date('2026-08-18T06:30:00'));
  assert.equal(early.onDuty, false);
});

test('duty: the boundaries are inclusive at the start and exclusive at the end', () => {
  assert.equal(resolveDuty(WORKING, new Date('2026-08-18T08:00:00')).onDuty, true);
  assert.equal(resolveDuty(WORKING, new Date('2026-08-18T17:59:00')).onDuty, true);
  assert.equal(resolveDuty(WORKING, new Date('2026-08-18T18:00:00')).onDuty, false);
});

test('duty: UNKNOWN fails towards ON duty, and says so', () => {
  // Off-duty rendering HIDES work. Hiding work because we could not read the
  // calendar is the failure that ends the feature, so unknown must never be
  // the reason a surface goes quiet — but it must still be distinguishable.
  const d = resolveDuty({ known: false }, new Date('2026-08-18T09:30:00'));
  assert.equal(d.onDuty, true);
  assert.equal(d.known, false);
  assert.match(d.reason, /Could not tell/);
});

test('duty rides on the context, and is not the same field as activity', () => {
  const ctx = resolveContext(calm({ workingDay: NOT_WORKING('bank holiday') }), TUE_0930);
  assert.equal(ctx.duty.onDuty, false);
  assert.equal(ctx.activity, ACTIVITY.OFF);

  // The separation that matters: a working day, in hours, but away from the
  // desk is still ON duty.
  const away = resolveContext(
    calm({ workingDay: WORKING, location: { known: true, place: 'away' } }),
    TUE_0930
  );
  assert.equal(away.activity, ACTIVITY.AWAY);
  assert.equal(away.duty.onDuty, true);
});

test('the duty window is deliberately wider than the booking window', () => {
  // Pinned against task-blocks rather than assumed equal: they answer different
  // questions ("can a meeting go here" vs "is he working"), so a change to
  // either should be a visible decision instead of silent drift.
  const { DAY_START_MIN, DAY_END_MIN } = require('./task-blocks');
  assert.ok(
    ON_DUTY_START_HOUR * 60 <= DAY_START_MIN,
    'duty must start no later than the first bookable minute'
  );
  assert.ok(
    ON_DUTY_END_HOUR * 60 >= DAY_END_MIN,
    'duty must end no earlier than the last bookable minute'
  );
});
