'use strict';

/**
 * What SARA shows, and what Nick could say next.
 *
 * The composer is PURE, so all of this pins without a Pi, a vault or a clock.
 * Most of what follows is a REFUSAL — the dashboards are easy and the honesty
 * is the product, so the honesty is what is under test.
 *
 *   run: node --test backend/services/sara-surface.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const surface = require('./sara-surface');
const { compose, surfaceFor, SURFACES, MAX_UTTERANCES } = surface;

// A payload shaped like `attention.build()`'s, with only what the composer reads.
function payload(over = {}) {
  return Object.assign({
    context: { activity: 'steady', duty: { onDuty: true, known: true } },
    primary: null,
    secondary: [],
    agenda: { known: true, scope: 'today', events: [] },
    weeklyTarget: null,
    poolAvailable: true,
    gaps: [],
  }, over);
}

function card(over = {}) {
  return Object.assign({
    kind: 'item',
    id: 'todo-overdue-top',
    type: 'todo',
    title: 'Succession plan',
    say: 'Overdue by three days.',
    urgency: 'high',
    tab: 'tasks',
    recordId: 'rec_1',
    actions: ['acknowledge', 'defer', 'open', 'complete', 'dismiss'],
  }, over);
}

const sentences = (r) => r.utterances.map((u) => u.say);
const intents = (r) => r.utterances.map((u) => u.intent);

// ── Positive control ────────────────────────────────────────────────────────

test('positive control — a steady payload composes a real dashboard', () => {
  // Without this every refusal below passes on a composer that returns nothing,
  // which proves only that it is broken.
  const r = compose(payload({
    agenda: {
      known: true, scope: 'today',
      events: [{ start: '2026-08-31T14:30:00', subject: '1-2-1 — Naomi', attendeesOther: true }],
    },
    primary: card(),
  }));

  assert.equal(r.surface, SURFACES.STEADY);
  assert.equal(r.dashboard.kind, SURFACES.STEADY);
  assert.ok(r.dashboard.rows.length >= 2, 'the meeting and the open item should both be rows');
  assert.match(r.dashboard.rows[0].what, /Naomi/);
  assert.ok(r.utterances.length > 1);
});

// ── Which dashboard ─────────────────────────────────────────────────────────

test('surface FOLLOWS context.activity and does not re-derive it', () => {
  // The moment this starts adding conditions of its own it has become a second
  // opinion about what kind of moment this is — which is what `inference.js`
  // was retired for.
  const map = {
    'in-meeting': SURFACES.IN_MEETING,
    'pre-meeting': SURFACES.PRE_MEETING,
    firefighting: SURFACES.FIREFIGHTING,
    'in-focus-session': SURFACES.SESSION,
    ritual: SURFACES.RITUAL,
    off: SURFACES.OFF_DUTY,
    steady: SURFACES.STEADY,
  };
  for (const [activity, expected] of Object.entries(map)) {
    assert.equal(surfaceFor(payload({ context: { activity } })), expected, activity);
  }
});

test('⚠ an unreadable pool outranks EVERY activity', () => {
  // A dashboard drawn over work SARA could not see is a confident picture of a
  // day nobody read. `blind` is the only override, and it is absolute.
  for (const activity of ['steady', 'firefighting', 'in-meeting', 'off', 'ritual']) {
    const r = compose(payload({ context: { activity }, poolAvailable: false }));
    assert.equal(r.surface, SURFACES.BLIND, `${activity} should still be blind`);
  }
});

test('⚠ the blind dashboard REFUSES an all-clear, in words', () => {
  const r = compose(payload({
    poolAvailable: false,
    gaps: [{ input: 'calendar', why: 'Graph auth expired' }],
  }));
  assert.match(r.dashboard.note, /all-clear/i);
  assert.match(r.dashboard.note, /couldn.t look/i);
  // The gap is NAMED, not counted.
  assert.match(r.dashboard.rows[0].what, /calendar/i);
  assert.match(r.dashboard.rows[0].note, /Graph auth expired/);
});

test('⚠ an unrecognised activity is steady, never nothing', () => {
  // A missing surface renders as a blank screen, and silence is never a valid
  // answer for a screen.
  assert.equal(surfaceFor(payload({ context: { activity: 'teleporting' } })), SURFACES.STEADY);
  assert.equal(surfaceFor(payload({ context: {} })), SURFACES.STEADY);
  assert.equal(surfaceFor(null), SURFACES.BLIND);
  const r = compose(null);
  assert.ok(r.dashboard, 'a null payload must still produce a dashboard');
  assert.ok(r.utterances.length > 0);
});

// ── Honesty inside a dashboard ──────────────────────────────────────────────

test('⚠ "I couldn’t read your diary" is never rendered as an empty day', () => {
  const unread = compose(payload({ agenda: { known: false, events: [] } }));
  assert.equal(unread.dashboard.rows.length, 0);
  assert.match(unread.dashboard.note, /couldn.t read your diary/i);

  // An empty diary that WAS read is a different fact, and good news.
  const empty = compose(payload({ agenda: { known: true, scope: 'today', events: [] } }));
  assert.equal(empty.dashboard.note, null, 'a read-but-empty diary must not claim it was unreadable');
});

test('⚠ gaps ride on EVERY dashboard, not only the blind one', () => {
  // A partly-read day is the normal case. A dashboard showing four of five
  // sources without saying so is "partly live rendered as total confidence".
  const r = compose(payload({
    context: { activity: 'steady' },
    gaps: [{ input: 'queue', why: 'timeout' }],
  }));
  assert.notEqual(r.surface, SURFACES.BLIND);
  assert.equal(r.dashboard.gaps.length, 1);
  assert.equal(r.dashboard.gaps[0].input, 'queue');
});

test('⚠ calendar times are SLICED, never parsed into a Date', () => {
  // The backend already asked Graph for Europe/London wall-clock times.
  // Re-parsing re-applies an offset and shows every BST event an hour out —
  // NEURO's calendar had this bug once and VESTA's had it after.
  assert.equal(surface._internals.timeOf({ start: '2026-08-31T14:30:00' }), '14:30');
  const r = compose(payload({
    agenda: { known: true, scope: 'today', events: [{ start: '2026-08-31T14:30:00', subject: 'Sync' }] },
  }));
  assert.equal(r.dashboard.rows[0].when, '14:30', 'a BST event must not shift');
});

test('⚠ "on your own" is said only when the brain KNOWS', () => {
  // `attendeesOther` is three-valued: null means we could not tell, and half
  // Nick's diary is solo blocks, so a guess is wrong in a way he would notice.
  const r = compose(payload({
    agenda: {
      known: true, scope: 'today',
      events: [
        { start: '2026-08-31T10:00:00', subject: 'A', attendeesOther: true },
        { start: '2026-08-31T11:00:00', subject: 'B', attendeesOther: false },
        { start: '2026-08-31T12:00:00', subject: 'C', attendeesOther: null },
      ],
    },
  }));
  assert.equal(r.dashboard.rows[0].meta, 'with others');
  assert.equal(r.dashboard.rows[1].meta, 'on your own');
  assert.equal(r.dashboard.rows[2].meta, null, 'undecidable must say nothing at all');
});

test('⚠ firefighting never renders an empty box', () => {
  // The brain called it firefighting, so something IS live. An empty
  // escalations panel under that word reads as an all-clear at the moment it is
  // least true, so an unmatched pool is shown rather than dropped.
  const r = compose(payload({
    context: { activity: 'firefighting' },
    primary: card({ type: 'todo', title: 'Something live', urgency: 'critical' }),
  }));
  assert.equal(r.surface, SURFACES.FIREFIGHTING);
  assert.equal(r.dashboard.rows.length, 1);
  assert.equal(r.dashboard.rows[0].level, 'crit');
});

test('⚠ in a meeting she says WHY the screen is empty', () => {
  const r = compose(payload({ context: { activity: 'in-meeting' } }));
  assert.equal(r.dashboard.rows.length, 0);
  assert.ok(r.dashboard.note && r.dashboard.note.length > 0,
    'an empty screen with no reason is indistinguishable from a broken one');
});

// ── The session ─────────────────────────────────────────────────────────────

test('⚠ an ASSUMED duration survives all the way to the figure', () => {
  // "Thirty minutes" and "half an hour because nobody said" are different
  // claims. Laundering the second into the first is what #87 rules out.
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: { taskTitle: 'Succession plan', elapsedMinutes: 22, plannedMinutes: 30, plannedAssumed: true },
  });
  assert.match(r.dashboard.figure.ofLabel, /assumed/);

  const typed = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: { taskTitle: 'x', elapsedMinutes: 10, plannedMinutes: 45, plannedAssumed: false },
  });
  assert.match(typed.dashboard.figure.ofLabel, /planned/);
});

test('⚠ elapsed comes from the session, never re-derived from startedAt', () => {
  // It is FOCUS time with paused stretches excluded. A surface computing it
  // from the start time would silently show wall clock and be wrong the moment
  // Nick is pulled away — the one case the return prompt exists for.
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: {
      taskTitle: 'x',
      startedAt: '2026-08-31T09:00:00.000Z',  // hours ago
      elapsedMinutes: 12,                      // but only 12 minutes of focus
      plannedMinutes: 30,
    },
  });
  assert.equal(r.dashboard.figure.value, 12);
});

test('⚠ an overrun is stated, and the bar is clamped', () => {
  // An overrun is normal. A bar past its end reads as broken, so the fact rides
  // on `overrun` instead.
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: { taskTitle: 'x', elapsedMinutes: 90, plannedMinutes: 30, overrun: true },
  });
  assert.equal(r.dashboard.figure.pct, 100);
  assert.equal(r.dashboard.figure.overrun, true);
  assert.ok(r.dashboard.note);
});

test('⚠ a shrink is stated as evidence, never as failure', () => {
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), {
    session: { taskTitle: 'Succession plan', elapsedMinutes: 5, plannedMinutes: 30, shrinkCount: 2 },
  });
  const line = JSON.stringify(r.dashboard);
  assert.match(line, /made smaller 2 times/);
  // The forbidden-wording rule the friction service already follows.
  for (const word of ['avoid', 'failed', 'struggling', 'procrastin', 'again']) {
    assert.doesNotMatch(line.toLowerCase(), new RegExp(word), `"${word}" must not appear`);
  }
});

test('an unreadable session says so rather than drawing a zeroed bar', () => {
  const r = compose(payload({ context: { activity: 'in-focus-session' } }), { session: null });
  assert.equal(r.dashboard.figure, null);
  assert.match(r.dashboard.note, /couldn.t read it/i);
});

// ── Off duty ────────────────────────────────────────────────────────────────

test('⚠ off duty shows what he DID, never what he owes', () => {
  // That distinction is the whole reason `resolveDuty` exists, and putting the
  // pool here would undo it.
  const r = compose(payload({
    context: { activity: 'off' },
    primary: card({ title: 'Succession plan', urgency: 'high' }),
    weeklyTarget: { state: 'on-track', done: 28, target: 24 },
  }));
  assert.equal(r.surface, SURFACES.OFF_DUTY);
  assert.equal(r.dashboard.figure.value, 28);
  assert.doesNotMatch(JSON.stringify(r.dashboard.rows), /Succession plan/,
    'an ordinary open task must not appear on the off-duty surface');
});

test('⚠ a CRITICAL item still shows off duty', () => {
  // Hiding a breaching escalation because it is Saturday is the wrong failure.
  const r = compose(payload({
    context: { activity: 'off' },
    primary: card({ title: 'NT-14855 breaching', urgency: 'critical' }),
  }));
  assert.match(JSON.stringify(r.dashboard.rows), /NT-14855/);
});

test('⚠ an unset weekly target is NOT a target of zero', () => {
  // A target of zero renders as "you did none of the nothing you set".
  const unset = compose(payload({ context: { activity: 'off' }, weeklyTarget: { state: 'unset' } }));
  assert.equal(unset.dashboard.figure, null);
  assert.match(unset.dashboard.rows[0].what, /No target set/i);

  // And "I couldn't count" is a third state, not a bad week.
  const unknown = compose(payload({
    context: { activity: 'off' },
    weeklyTarget: { state: 'unknown', reason: 'ledger unreadable' },
  }));
  assert.equal(unknown.dashboard.figure, null);
  assert.equal(unknown.dashboard.rows[0].level, 'warn');
});

// ── Utterances ──────────────────────────────────────────────────────────────

test('⚠ NOTHING an utterance offers leaves the building', () => {
  // No utterance may send an email, book a meeting or chase a person. Those
  // queue behind the approval gate on the desktop, and an ambient surface that
  // can send is one that can send by accident.
  const forbidden = ['send', 'reply', 'email', 'book', 'chase', 'approve', 'invite'];
  for (const activity of ['steady', 'pre-meeting', 'firefighting', 'in-focus-session', 'ritual', 'off', 'in-meeting']) {
    for (const poolAvailable of [true, false]) {
      const r = compose(payload({ context: { activity }, poolAvailable, primary: card() }),
        { session: { taskTitle: 'x', elapsedMinutes: 1, plannedMinutes: 30 } });
      const blob = JSON.stringify(r.utterances).toLowerCase();
      for (const word of forbidden) {
        assert.doesNotMatch(blob, new RegExp(word), `"${word}" reachable on ${activity}`);
      }
      for (const i of intents(r)) {
        assert.ok(['act', 'session', 'navigate', 'ask', 'reveal', 'refresh'].includes(i.kind),
          `unknown intent kind "${i.kind}" on ${activity}`);
      }
    }
  }
});

test('⚠ utterances are BOUNDED by what the record allows', () => {
  // `attention-lifecycle` decides which verbs a card accepts — an escalation is
  // deliberately not dismissable. Offering a sentence NEURO will refuse is
  // worse than offering none, because he will have said it out loud first.
  const r = compose(payload({
    primary: card({ actions: ['acknowledge', 'open'] }),
  }));
  const acts = r.utterances.filter((u) => u.intent.kind === 'act').map((u) => u.intent.action);
  assert.ok(acts.includes('acknowledge'));
  assert.ok(!acts.includes('dismiss'), 'dismiss was offered on a card that refuses it');
  assert.ok(!acts.includes('complete'), 'complete was offered on a card that refuses it');
});

test('⚠ a card with NO recordId gets no act utterances at all', () => {
  // The engine's suppression is a timer and cannot express "seen it" or "this
  // is finished". Substituting it is the exact bug the lifecycle replaced.
  const r = compose(payload({ primary: card({ recordId: undefined }) }));
  assert.equal(r.utterances.filter((u) => u.intent.kind === 'act').length, 0);
  // It still says something useful rather than going silent.
  assert.ok(r.utterances.length > 1);
});

test('⚠ "not now" carries HOW LONG and WHY', () => {
  // A snooze whose length SARA picked is one Nick has no reason to trust, and a
  // thing put off three times for `too-big` is a different problem from one put
  // off for `not-now`. Neither is recoverable after the gesture.
  const r = compose(payload({ primary: card() }));
  const defers = r.utterances.filter((u) => u.intent.action === 'defer');
  assert.ok(defers.length >= 2);
  for (const d of defers) {
    assert.ok(Number.isFinite(d.intent.minutes), 'a deferral with no length');
    assert.ok(typeof d.intent.reason === 'string' && d.intent.reason, 'a deferral with no reason');
  }
  assert.ok(defers.some((d) => d.intent.reason === 'too-big'));
});

test('⚠ "Make it smaller" LEADS on the session surface', () => {
  // Nick's difficulty is INITIATION. Shrinking is the only control that lowers
  // the barrier rather than rescheduling it; a menu without it first pushes him
  // to abandon, which loses the thread and reads as failure.
  const r = compose(payload({ context: { activity: 'in-focus-session' }, primary: card() }), {
    session: { taskTitle: 'x', elapsedMinutes: 5, plannedMinutes: 30 },
  });
  assert.equal(sentences(r)[0], 'Make it smaller');
});

test('⚠ "Show me everything" is always present, and always last', () => {
  // The escape hatch is non-negotiable: Nick's failure mode is avoidance, and a
  // thing he cannot find is worse than a menu he does not need.
  for (const activity of ['steady', 'in-meeting', 'firefighting', 'off', 'in-focus-session', 'ritual']) {
    for (const poolAvailable of [true, false]) {
      const r = compose(payload({ context: { activity }, poolAvailable, primary: card() }));
      const last = r.utterances[r.utterances.length - 1];
      assert.equal(last.say, 'Show me everything', `missing on ${activity}/${poolAvailable}`);
      assert.equal(last.intent.kind, 'reveal');
      assert.ok(r.utterances.length <= MAX_UTTERANCES,
        `the fallback must not become the menu it replaced (${r.utterances.length})`);
    }
  }
});

test('⚠ every utterance reads as a SENTENCE, not a UI verb', () => {
  // One vocabulary, so the mute path teaches the spoken path. "Defer" and
  // "Dismiss" are things an interface says; they are not things Nick says.
  const banned = new Set(['defer', 'dismiss', 'acknowledge', 'complete', 'snooze', 'submit', 'ok', 'cancel']);
  for (const activity of ['steady', 'firefighting', 'in-focus-session', 'off', 'ritual', 'in-meeting']) {
    const r = compose(payload({ context: { activity }, primary: card() }),
      { session: { taskTitle: 'x', elapsedMinutes: 1, plannedMinutes: 30 } });
    for (const s of sentences(r)) {
      assert.ok(!banned.has(s.trim().toLowerCase()), `"${s}" is a UI verb, not a sentence`);
      assert.ok(s.length > 2, `"${s}" is too terse to be something anyone would say`);
    }
  }
});

test('⚠ session verbs are `session` intents, never `act` ones', () => {
  // The attention lifecycle accepts acknowledge / defer / open / start /
  // complete / dismiss. `shrink`, `step-away` and `finish` live on
  // `/api/session/*` and it will 400 on all three — so routing them through an
  // `act` intent would be exactly the "a sentence NEURO will refuse" failure
  // the bounding rule exists to prevent. Caught by reading the routes rather
  // than assuming the two verb sets matched.
  const LIFECYCLE = new Set(['acknowledge', 'defer', 'open', 'start', 'complete', 'dismiss']);
  const SESSION = new Set(['shrink', 'step-away', 'finish', 'pause', 'resume', 'check-in']);

  const r = compose(payload({ context: { activity: 'in-focus-session' }, primary: card() }), {
    session: { taskTitle: 'Succession plan', elapsedMinutes: 5, plannedMinutes: 30 },
  });
  const sess = r.utterances.filter((u) => u.intent.kind === 'session');
  assert.ok(sess.length >= 2, 'the session surface lost its session verbs');
  for (const u of sess) assert.ok(SESSION.has(u.intent.action), `${u.intent.action} is not a session verb`);

  // And across every surface, an `act` intent may only carry a lifecycle verb.
  for (const activity of ['steady', 'pre-meeting', 'firefighting', 'ritual', 'in-focus-session', 'off']) {
    const c = compose(payload({ context: { activity }, primary: card() }),
      { session: { taskTitle: 'x', elapsedMinutes: 1, plannedMinutes: 30 } });
    for (const u of c.utterances.filter((x) => x.intent.kind === 'act')) {
      assert.ok(LIFECYCLE.has(u.intent.action),
        `act intent carries "${u.intent.action}", which the lifecycle will refuse (${activity})`);
    }
  }
});
