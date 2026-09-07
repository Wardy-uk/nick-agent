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
  // `shrink` joined this list in Gate 3, deliberately. The moment Nick is
  // looking at something he walked away from is exactly when "this is too big"
  // is the true answer, and a menu without that option pushes him to abandon
  // instead — which loses the thread and reads as failure.
  assert.deepEqual(rec.options, ['resume', 'shrink', 'done', 'abandon']);
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

  // ⚠ THE HALF THIS TEST WAS NAMED AFTER AND NEVER CHECKED.
  //
  // It asserted only that the NEW session was current, which is true whether
  // the old one was archived or destroyed — and it was destroyed: `_pause` then
  // `_write(existing)`, then `_write(session)` overwrote the same single KV row
  // and nothing was ever archived. Twenty minutes of work, its shrinks and its
  // elapsed time simply vanished, on the one path AttentionCard uses.
  //
  // A green test whose name makes a claim its assertions do not check is how
  // that shipped, so the claim is now asserted.
  const history = fs2.history();
  const parked = history.find((s) => s.text === 'Original work');
  assert.ok(parked, 'the interrupted session must survive in history');
  assert.equal(parked.endedReason, 'switched', 'switched is neither abandoned nor completed');
  assert.equal(parked.actualMinutes, 20, 'and it keeps the focus time it actually had');
});

test('a switch records what was interrupted, including what it had been cut down to', () => {
  reset();
  fs2.start({ text: 'Rewrite the escalation policy', minutes: 60 }, T0);
  fs2.shrink({ step: 'open the doc and list the headings' }, T0 + 5 * MIN);
  fs2.start({ text: 'Something urgent', minutes: 15, force: true }, T0 + 12 * MIN);

  const parked = fs2.history().find((s) => s.text === 'Rewrite the escalation policy');
  assert.ok(parked);
  // The shrink is the most useful thing the session recorded — losing it loses
  // the evidence `friction` and `initiation-signals` both read.
  assert.equal(parked.shrinks, 1);
  assert.equal(parked.finalStep, 'open the doc and list the headings');
  assert.equal(parked.originalText, 'Rewrite the escalation policy');
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

// ── Gate 3: making it smaller ────────────────────────────────────────────────
//
// The one control that lowers the barrier rather than raising awareness. Every
// assertion below is really the same one: shrinking must never be recorded,
// phrased or scored as a failure.

test('shrinking names a smaller step and the session carries straight on', () => {
  reset();
  fs2.start({ text: 'Write the Q3 escalation review', minutes: 60 }, T0);
  const { ok, session } = fs2.shrink({ step: 'Open last quarter\'s review and copy the headings' }, T0 + 5 * MIN);

  assert.equal(ok, true);
  assert.equal(session.nextStep, 'Open last quarter\'s review and copy the headings');
  // Naming the smaller thing IS the unblocking. Making him press a second
  // button to say what he has just said is friction at the exact moment the
  // feature exists to remove it.
  assert.equal(session.status, 'active');
  assert.equal(session.shrinks, 1);
  // The thread back to what it came from is preserved.
  assert.equal(session.originalText, 'Write the Q3 escalation review');
});

test('too big with NO step is its own state, not a pause', () => {
  reset();
  fs2.start({ text: 'Restructure the support rota', minutes: 30 }, T0);
  const { session } = fs2.shrink({}, T0 + 3 * MIN);

  // "Not now" and "I'm stuck on how big this is" are different problems and
  // need different prompts. Collapsing them loses the only one worth acting on.
  assert.equal(session.status, 'needs-smaller');
  // The clock is banked — he is not working while deciding.
  assert.equal(session.elapsedMinutes, 3);

  const prompt = fs2.recovery(T0 + 10 * MIN);
  assert.equal(prompt.kind, 'shrink');
  assert.match(prompt.question, /smallest/i);
  // The answer is offered first; letting it go is offered without ceremony.
  assert.equal(prompt.options[0], 'shrink');
  assert.ok(prompt.options.includes('abandon'));
});

test('naming the step from needs-smaller starts the clock again', () => {
  reset();
  fs2.start({ text: 'Restructure the support rota' }, T0);
  fs2.shrink({}, T0 + 2 * MIN);
  const { session } = fs2.shrink({ step: 'List who is on nights this month' }, T0 + 6 * MIN);

  assert.equal(session.status, 'active');
  assert.equal(session.nextStep, 'List who is on nights this month');
  assert.equal(session.shrinks, 2, 'both shrinks are kept — the count IS the finding');
});

test('being pulled away reads differently from choosing to stop', () => {
  reset();
  fs2.start({ text: 'Draft the risk summary' }, T0);
  fs2.stepAway({ source: 'escalation', detail: 'NT-88 came in' }, T0 + 12 * MIN);

  const prompt = fs2.recovery(T0 + 40 * MIN);
  assert.equal(prompt.kind, 'resume');
  // "I was pulled away" is not something he did, and saying it back to him as
  // though it were is the register this voice rejects.
  assert.match(prompt.prompt, /pulled away/);
  assert.match(prompt.prompt, /NT-88/);
  // Shrink is on EVERY return prompt: looking at a thing you walked away from
  // is exactly when "this is too big" is the true answer.
  assert.ok(prompt.options.includes('shrink'));
});

test('a banked state does not go stale on the wall clock', () => {
  reset();
  fs2.start({ text: 'Short thing', minutes: 15 }, T0);
  fs2.stepAway({ source: 'meeting' }, T0 + 5 * MIN);

  // Three hours later, still the same day. A 15-minute task times out on the
  // wall clock in 90 minutes — but the clock is not RUNNING in a banked state,
  // so asking "did this happen?" about something he may pick up after lunch is
  // the wrong question.
  const prompt = fs2.recovery(T0 + 180 * MIN);
  assert.equal(prompt.kind, 'resume', 'still a return prompt, not a settle');
  assert.equal(prompt.session.stale, false);
});

test('the next step and the shrink count survive into history', () => {
  reset();
  fs2.start({ text: 'Big vague thing' }, T0);
  fs2.shrink({ step: 'Do the first small bit' }, T0 + 2 * MIN);
  fs2.finish({}, T0 + 20 * MIN);

  const [record] = fs2.history();
  // Once the live session is archived this is the ONLY place the finding
  // survives, so it has to travel with the record.
  assert.equal(record.shrinks, 1);
  assert.equal(record.finalStep, 'Do the first small bit');
  assert.equal(record.originalText, 'Big vague thing');
});

test('a session can be started with its first concrete step already named', () => {
  reset();
  const { session } = fs2.start({ text: 'Prep the 1-2-1', nextStep: 'Read last month\'s note' }, T0);
  assert.equal(session.nextStep, 'Read last month\'s note');
  // Nothing invents one. A step NEURO made up is a step he has no reason to
  // believe in, and the point is that it is small enough to actually begin.
  reset();
  const bare = fs2.start({ text: 'Prep the 1-2-1' }, T0);
  assert.equal(bare.session.nextStep, null);
});

// ── Gate 3: the private body-double ─────────────────────────────────────────

test('a check-in is asked for only on a RUNNING session, and only after a while', () => {
  reset();
  fs2.start({ text: 'Long piece of writing', minutes: 60 }, T0);

  // Asking "still on this?" in the first minutes is noise.
  assert.equal(fs2.current(T0 + 5 * MIN).dueCheckIn, false);
  assert.equal(fs2.current(T0 + 25 * MIN).dueCheckIn, true);

  // And never about something he is not currently doing.
  fs2.stepAway({ source: 'meeting' }, T0 + 26 * MIN);
  assert.equal(fs2.current(T0 + 60 * MIN).dueCheckIn, false);
});

test('saying "still here" resets the ask WITHOUT touching the clock', () => {
  reset();
  fs2.start({ text: 'Long piece of writing', minutes: 60 }, T0);
  const before = fs2.current(T0 + 25 * MIN).elapsedMinutes;

  const { ok, session } = fs2.checkIn({}, T0 + 25 * MIN);
  assert.equal(ok, true);
  assert.equal(session.checkIns, 1);
  assert.equal(session.dueCheckIn, false);
  // ⚠ A check-in is a statement about PRESENCE, not about time. Quietly moving
  // the estimate because he said hello would make the one honest number here
  // dishonest.
  assert.equal(session.elapsedMinutes, before);
  assert.equal(session.plannedMinutes, 60);

  // It comes back round once enough time has passed again.
  assert.equal(fs2.current(T0 + 50 * MIN).dueCheckIn, true);
});

test('a check-in on nothing, or on a paused session, is refused not invented', () => {
  reset();
  assert.equal(fs2.checkIn({}, T0).ok, false);
  fs2.start({ text: 'A thing' }, T0);
  fs2.pause({}, T0 + MIN);
  const r = fs2.checkIn({}, T0 + 2 * MIN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-running');
});

test('a reflection is optional and rides into history when given', () => {
  reset();
  fs2.start({ text: 'Wrote the thing' }, T0);
  fs2.checkIn({}, T0 + 21 * MIN);
  fs2.finish({ reflection: 'Easier once I had the headings down.' }, T0 + 40 * MIN);

  const [record] = fs2.history();
  assert.equal(record.reflection, 'Easier once I had the headings down.');
  assert.equal(record.checkIns, 1);

  // And finishing without one is a perfectly good outcome — a box you have to
  // fill to close a session is a reason not to close sessions.
  reset();
  fs2.start({ text: 'Another thing' }, T0);
  fs2.finish({}, T0 + 10 * MIN);
  assert.equal(fs2.history()[0].reflection, null);
});
