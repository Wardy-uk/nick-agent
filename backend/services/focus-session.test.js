'use strict';

/**
 * The focus session (#88) and the return prompt (#89).
 *
 * What these pin down is not the timer — it is the handful of places where a
 * session container could quietly start lying:
 *
 *   - elapsed must be FOCUS time, not wall clock, or "twenty minutes in" is
 *     wrong the moment you are pulled away, which is the only case #89 is for;
 *   - an assumed length must stay labelled all the way to the read, exactly as
 *     in time-fit (#87);
 *   - a runaway session goes stale and ASKS — it never auto-completes (that
 *     invents a win) and never vanishes (that loses the thread);
 *   - starting something else interrupts, never discards.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-focus-')), 'a.db');

const fs2 = require('./focus-session');
const db = require('../db/database');

const MIN = 60000;
// Mid-morning on a Monday, so nothing here crosses a day boundary by accident.
const T0 = new Date(2026, 7, 17, 10, 0, 0, 0).getTime();

test.before(async () => { await db.init(); });

function reset() {
  db.setState('focus_session', '');
  db.setState('focus_session_history', '');
}

// ── Starting ─────────────────────────────────────────────────────────────────

test('a session holds the one thing, and knows how long it is meant to be', () => {
  reset();
  const { ok, session } = fs2.start({ text: 'Write the Q3 escalation review', minutes: 60 }, T0);
  assert.equal(ok, true);
  assert.equal(session.text, 'Write the Q3 escalation review');
  assert.equal(session.status, 'active');
  assert.equal(session.plannedMinutes, 60);
  assert.equal(session.plannedAssumed, false);
});

test('an un-estimated task is assumed thirty minutes AND SAYS SO', () => {
  reset();
  // The #87 rule, unchanged: a card that quietly treats an unknown as half an
  // hour is right until it isn't, and then it is never trusted again.
  const { session } = fs2.start({ text: 'Unestimated thing' }, T0);
  assert.equal(session.plannedMinutes, fs2.ASSUMED_MINUTES);
  assert.equal(session.plannedAssumed, true);
});

test("a task's own estimate is used, and is not an assumption", () => {
  reset();
  const { id } = require('./task-store').createTask({
    text: 'Approve the leave requests', estimateMinutes: 15, skipExport: true,
  });
  const { session } = fs2.start({ taskId: id }, T0);
  assert.equal(session.plannedMinutes, 15);
  assert.equal(session.plannedAssumed, false);
  // Started from a task id alone, it still knows what it is about.
  assert.match(session.text, /leave requests/i);
});

test('a session survives the read — it is state, not a variable', () => {
  reset();
  fs2.start({ text: 'Persisted thing', minutes: 30 }, T0);
  assert.equal(fs2.current(T0 + MIN).text, 'Persisted thing');
});

// ── Elapsed is focus time ────────────────────────────────────────────────────

test('elapsed counts focus time, never wall clock', () => {
  reset();
  fs2.start({ text: 'Deep work', minutes: 60 }, T0);
  fs2.pause({ source: 'escalation', detail: 'NT-28075 landed' }, T0 + 20 * MIN);

  // An hour goes by while paused. That hour is not work.
  const view = fs2.current(T0 + 80 * MIN);
  assert.equal(view.elapsedMinutes, 20);
  assert.equal(view.status, 'paused');

  fs2.resume(T0 + 80 * MIN);
  assert.equal(fs2.current(T0 + 90 * MIN).elapsedMinutes, 30);
});

test('remaining and overrun are both stated, and overrun is not an error', () => {
  reset();
  fs2.start({ text: 'Longer than it looked', minutes: 30 }, T0);
  const view = fs2.current(T0 + 45 * MIN);
  assert.equal(view.remainingMinutes, 0);
  assert.equal(view.overrun, true);
  assert.equal(view.overrunMinutes, 15);
  // Still running. Going over is information, not a reason to stop the clock.
  assert.equal(view.status, 'active');
});

// ── Interruption and return (#89) ────────────────────────────────────────────

test('a running session is not something to be told to get back to', () => {
  reset();
  fs2.start({ text: 'In progress', minutes: 60 }, T0);
  assert.equal(fs2.recovery(T0 + 10 * MIN), null);
});

test('a paused session produces the prompt this whole thing exists for', () => {
  reset();
  fs2.start({ text: 'The thing I was doing', minutes: 30 }, T0);
  fs2.pause({ source: 'escalation', detail: 'escalation arrived' }, T0 + 20 * MIN);

  const rec = fs2.recovery(T0 + 25 * MIN);
  assert.equal(rec.kind, 'resume');
  assert.match(rec.prompt, /20 minutes into "The thing I was doing"/);
  // The number that makes coming back thinkable: ten minutes left is a
  // decision, "the task" is a wall.
  assert.match(rec.question, /10 minutes left/);
  assert.deepEqual(rec.options, ['resume', 'done', 'abandon']);
});

test('the return prompt admits when the remaining figure rests on a guess', () => {
  reset();
  fs2.start({ text: 'Unestimated' }, T0);
  fs2.pause({}, T0 + 10 * MIN);
  assert.match(fs2.recovery(T0 + 11 * MIN).question, /assuming half an hour/);
});

test('starting something else interrupts the first thing, it does not discard it', () => {
  reset();
  fs2.start({ text: 'Original work', minutes: 60 }, T0);
  const blocked = fs2.start({ text: 'Escalation', minutes: 30 }, T0 + 20 * MIN);
  // Without force it reports the conflict rather than choosing for him.
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'session-active');
  assert.equal(blocked.session.text, 'Original work');

  const forced = fs2.start({ text: 'Escalation', minutes: 30, force: true }, T0 + 20 * MIN);
  assert.equal(forced.ok, true);
  assert.equal(forced.interrupted, true);
  assert.equal(fs2.current(T0 + 21 * MIN).text, 'Escalation');
});

test('an arriving escalation is noted but never pauses on Nick\'s behalf', () => {
  reset();
  fs2.start({ text: 'Focus work', minutes: 60 }, T0);
  const res = fs2.noteInterruption({ source: 'escalation', detail: 'NT-28075' }, T0 + 15 * MIN);
  assert.equal(res.ok, true);
  // NEURO cannot know whether he actually switched, and guessing would put that
  // guess into the one number the return prompt rests on.
  assert.equal(res.session.status, 'active');
  assert.equal(res.session.interruptions, 1);
  assert.equal(res.session.lastInterruption.atMinutes, 15);
  assert.equal(fs2.current(T0 + 20 * MIN).elapsedMinutes, 20);
});

test('nothing is noted against a session that is not running', () => {
  reset();
  assert.equal(fs2.noteInterruption({ source: 'escalation' }, T0).ok, false);
});

test('coming back is recorded against the interruption that caused the break', () => {
  reset();
  fs2.start({ text: 'Work', minutes: 30 }, T0);
  fs2.pause({ source: 'meeting' }, T0 + 10 * MIN);
  fs2.resume(T0 + 40 * MIN);
  // Returning is the outcome the feature is for, so it is worth being able to
  // tell a return from a fresh start later.
  assert.ok(fs2.current(T0 + 41 * MIN).lastInterruption.resumedAt);
});

// ── Going stale ──────────────────────────────────────────────────────────────

test('a session that runs away goes stale rather than claiming four hours of focus', () => {
  reset();
  fs2.start({ text: 'Left running at the desk', minutes: 30 }, T0);
  const view = fs2.current(T0 + 5 * 60 * MIN);
  assert.equal(view.stale, true);

  const rec = fs2.recovery(T0 + 5 * 60 * MIN);
  assert.equal(rec.kind, 'settle');
  assert.match(rec.prompt, /never closed it/);
  assert.match(rec.question, /Did that get done\?/);
  // It asks. It does not decide — auto-completing invents a win, and deleting
  // loses the thread.
  assert.deepEqual(rec.options, ['done', 'abandon', 'restart']);
});

test('a small task overrunning a little is an ordinary Tuesday, not a lost thread', () => {
  reset();
  fs2.start({ text: 'Quick reply', minutes: 5 }, T0);
  assert.equal(fs2.current(T0 + 20 * MIN).stale, false);
});

test('nobody is still twenty minutes into yesterday', () => {
  reset();
  fs2.start({ text: 'Yesterday work', minutes: 240 }, T0);
  // Well inside its own generous estimate, but a day has turned over.
  const nextMorning = new Date(2026, 7, 18, 9, 0, 0, 0).getTime();
  assert.equal(fs2.current(nextMorning).stale, true);
  assert.equal(fs2.recovery(nextMorning).kind, 'settle');
});

test('a stale session is closed and kept, never silently dropped, when a new one starts', () => {
  reset();
  fs2.start({ text: 'Forgotten thing', minutes: 30 }, T0);
  const later = T0 + 6 * 60 * MIN;
  fs2.start({ text: 'Today\'s thing', minutes: 30 }, later);

  assert.equal(fs2.current(later).text, "Today's thing");
  const past = fs2.history();
  assert.equal(past[0].text, 'Forgotten thing');
  assert.equal(past[0].endedReason, 'expired');
});

test('a long-paused session stops asking to be resumed and starts asking to be settled', () => {
  reset();
  fs2.start({ text: 'Paused this morning', minutes: 30 }, T0);
  fs2.pause({}, T0 + 10 * MIN);
  assert.equal(fs2.recovery(T0 + 60 * MIN).kind, 'resume');
  assert.equal(fs2.recovery(T0 + (fs2.PAUSE_STALE_MINUTES + 20) * MIN).kind, 'settle');
});

// ── Finishing ────────────────────────────────────────────────────────────────

test('finishing records the real duration against the planned one', () => {
  reset();
  fs2.start({ text: 'Measured work', minutes: 30 }, T0);
  fs2.pause({}, T0 + 10 * MIN);
  fs2.resume(T0 + 40 * MIN);
  const res = fs2.finish({}, T0 + 55 * MIN);

  assert.equal(res.ok, true);
  assert.equal(res.actualMinutes, 25);          // 10 worked + 15 worked, not 55
  assert.equal(fs2.current(T0 + 56 * MIN), null);

  const past = fs2.history();
  assert.equal(past[0].actualMinutes, 25);
  assert.equal(past[0].plannedMinutes, 30);
  // The body of evidence #87 said did not exist yet. Recorded, not yet consumed.
  assert.equal(past[0].plannedAssumed, false);
});

test('finishing can close the underlying task, and does it the normal way', () => {
  reset();
  const { id } = require('./task-store').createTask({ text: 'Session-completed task', skipExport: true });
  fs2.start({ taskId: id }, T0);
  const res = fs2.finish({ completeTask: true }, T0 + 10 * MIN);

  assert.equal(res.taskCompleted, true);
  assert.equal(db.getTaskRow(id).status, 'done');
  // Through task-store, so it logs task_done and lands in momentum and wins like
  // everything else. A private completion route would be invisible to the panel
  // that asked for the session in the first place.
  const wins = db.getActivityForDate(require('./time-fit').dateStr(new Date()));
  assert.ok(wins.some(r => r.event_type === 'task_done'));
});

test('abandoning is a legitimate ending and keeps the record', () => {
  reset();
  fs2.start({ text: 'Not happening today', minutes: 30 }, T0);
  const res = fs2.abandon(T0 + 8 * MIN);
  assert.equal(res.ok, true);
  assert.equal(fs2.current(T0 + 9 * MIN), null);
  assert.equal(fs2.history()[0].endedReason, 'abandoned');
});

test('the whole read is one call, and says nothing when there is nothing', () => {
  reset();
  const s = fs2.status(T0);
  assert.equal(s.session, null);
  assert.equal(s.recovery, null);
  assert.equal(s.assumedMinutes, fs2.ASSUMED_MINUTES);
});

test('being pulled away inside the first minute does not read as "0 minutes into"', () => {
  reset();
  fs2.start({ text: 'Barely begun', minutes: 30 }, T0);
  // A real sequence — start something, phone goes.
  fs2.pause({ source: 'escalation' }, T0 + 20000);
  assert.match(fs2.recovery(T0 + 30000).prompt, /had just started/);
});
