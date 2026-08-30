'use strict';

/**
 * Transitions — the seams of the day.
 *
 * PURE, so this pins without a Pi, a vault or a clock. What it really pins is
 * the handful of places a transition prompt could start lying: firing on a solo
 * work block, firing over an unread diary, or interrupting a meeting to talk
 * about meetings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextTransition, POST_MEETING_MINUTES } = require('./transitions');

const NOW = new Date('2026-09-01T10:00:00Z');

function at(offsetMins) {
  return new Date(NOW.getTime() + offsetMins * 60000).toISOString();
}

/** A meeting: other people in it. */
function meeting(startMins, endMins, subject = 'Team standup', extra = {}) {
  return { start: at(startMins), end: at(endMins), subject, attendeesOther: true, ...extra };
}

/** A solo block: exactly the same shape, no other people. */
function soloBlock(startMins, endMins, subject = 'Focus block') {
  return { start: at(startMins), end: at(endMins), subject, attendeesOther: false };
}

const seen = (events) => ({ known: true, events });

test('a meeting starting shortly says leave now, and offers only prep', () => {
  const t = nextTransition({ calendar: seen([meeting(8, 38, '1-2-1 with Hope')]), now: NOW });
  assert.equal(t.kind, 'leave-now');
  assert.match(t.prompt, /1-2-1 with Hope/);
  assert.match(t.prompt, /8 minutes/);
  assert.equal(t.tab, 'prep');
  // ⚠ Nothing offered here changes the diary. It proposes; it never acts.
  assert.deepEqual(t.options, ['prep', 'dismiss']);
});

test('a meeting that just finished asks for the follow-ups', () => {
  const t = nextTransition({ calendar: seen([meeting(-40, -3, 'Support review')]), now: NOW });
  assert.equal(t.kind, 'post-meeting');
  assert.match(t.question, /capture/i);
  assert.equal(t.tab, 'capture');
});

test('⚠ a SOLO block is not a meeting, in either direction', () => {
  // Half of Nick's diary is time blocked out for solo work. "You just finished
  // a meeting, capture the follow-ups" after an hour of writing alone is the
  // kind of wrong that gets a feature switched off.
  assert.equal(nextTransition({ calendar: seen([soloBlock(-60, -2)]), now: NOW }), null);
  assert.equal(nextTransition({ calendar: seen([soloBlock(5, 65)]), now: NOW }), null);
});

test('⚠ an UNDECIDABLE attendee list fails closed', () => {
  // The NOVA bridge supplies no attendee list, so `attendeesOther` is null.
  // Unknown must never be announced as a meeting.
  const unknown = { start: at(5), end: at(35), subject: 'Something', attendeesOther: null };
  assert.equal(nextTransition({ calendar: seen([unknown]), now: NOW }), null);
});

test('⚠ an unreadable diary produces NO transition at all', () => {
  // "I could not read the diary" and "there is nothing coming up" license
  // opposite behaviour. Falling through to silence-by-accident is the same
  // false all-clear the whole attention layer exists to prevent — so an
  // unreadable calendar must not even reach the calendar branches.
  const t = nextTransition({ calendar: { known: false }, now: NOW });
  assert.equal(t, null);

  // And it must not be rescued into a calendar prompt by a session either.
  const withSession = nextTransition({
    calendar: { known: false },
    recovery: { kind: 'resume', prompt: 'p', question: 'q', options: ['resume'], session: { id: 'fs_1' } },
    now: NOW,
  });
  assert.equal(withSession.kind, 'session-resume', 'the session prompt still stands on its own');
});

test('being IN a meeting is silence — a prompt is still an interruption', () => {
  const t = nextTransition({ calendar: seen([meeting(-10, 20, 'In progress')]), now: NOW });
  assert.equal(t, null);
});

test('leaving outranks capturing, which outranks coming back', () => {
  const recovery = { kind: 'resume', prompt: 'p', question: 'q', options: ['resume'], session: { id: 'fs_1' } };

  // All three true at once: one just ended, the next is imminent, and there is
  // a paused session. The time-critical one wins.
  const all = nextTransition({
    calendar: seen([meeting(-40, -2, 'Ended'), meeting(6, 36, 'Next up')]),
    recovery,
    now: NOW,
  });
  assert.equal(all.kind, 'leave-now');

  const ended = nextTransition({ calendar: seen([meeting(-40, -2, 'Ended')]), recovery, now: NOW });
  assert.equal(ended.kind, 'post-meeting');

  const quiet = nextTransition({ calendar: seen([]), recovery, now: NOW });
  assert.equal(quiet.kind, 'session-resume');
});

test('the session prompt is carried VERBATIM, never re-phrased', () => {
  // focus-session.recovery() owns what a returning prompt says. A second
  // wording of the same fact is how two surfaces drift.
  const recovery = {
    kind: 'shrink',
    prompt: '"Restructure the rota" was too big to start.',
    question: 'What is the smallest next bit of it?',
    options: ['shrink', 'resume', 'abandon'],
    session: { id: 'fs_9' },
  };
  const t = nextTransition({ calendar: seen([]), recovery, now: NOW });
  assert.equal(t.kind, 'session-shrink');
  assert.equal(t.prompt, recovery.prompt);
  assert.equal(t.question, recovery.question);
  assert.deepEqual(t.options, recovery.options);
});

test('a quiet moment is null, which is a correct answer', () => {
  assert.equal(nextTransition({ calendar: seen([]), now: NOW }), null);
  assert.equal(nextTransition({}), null);
});

test('the post-meeting window closes, rather than nagging all afternoon', () => {
  const justOutside = meeting(-90, -(POST_MEETING_MINUTES + 5), 'Long gone');
  assert.equal(nextTransition({ calendar: seen([justOutside]), now: NOW }), null);
});
