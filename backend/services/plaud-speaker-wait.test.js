'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assessSpeakerNaming, decideSpeakerHold } = require('./plaud-sync');

const HOUR = 60 * 60 * 1000;

// ⚠ Copied from LIVE recordings, not invented. This repo has been bitten repeatedly by
// a fixture built on a guessed identifier (`sleep_core_hours`, `meeting_alert`), where
// the suite stayed green over a feature that had never worked. These are the real shapes.
//
// From the 2026-08-25 Isabel Busk 1-2-1 — note the third segment: PLAUD merged two
// voices, naming raw "Speaker 2" as Nick Ward. Named, and wrong. Nothing here can see
// that, which is exactly why the gate claims only that names were ASSIGNED.
const LIVE_NAMED = [
  { content: 'Gizmo recording.', speaker: 'Nick Ward', original_speaker: 'Speaker 1' },
  { content: 'Before we start, I am going to do a different one-to-one.', speaker: 'Nick Ward', original_speaker: 'Speaker 1' },
  { content: 'They are all right.', speaker: 'Nick Ward', original_speaker: 'Speaker 2' },
  { content: 'Um.', speaker: 'Isabel Busk', original_speaker: 'Speaker 3' }
];

// From 2026-08-27 10:01:04 — transcribed, never named.
const LIVE_UNNAMED = [
  { content: 'Other file, right. Cool.', speaker: 'Speaker 1', original_speaker: 'Speaker 1' },
  { content: 'So majority of these will be gone.', speaker: 'Speaker 2', original_speaker: 'Speaker 2' },
  { content: 'I can see there is a lot saying work in progress.', speaker: 'Speaker 1', original_speaker: 'Speaker 1' }
];

// ── assessSpeakerNaming ──────────────────────────────────────────────────────

test('a live named transcript reads as complete', () => {
  const naming = assessSpeakerNaming(LIVE_NAMED);
  assert.equal(naming.known, true);
  assert.equal(naming.complete, true);
  assert.equal(naming.total, 3);
  assert.equal(naming.namedCount, 3);
  assert.deepEqual(naming.unnamed, []);
});

test('a live unnamed transcript reads as incomplete and names the slots', () => {
  const naming = assessSpeakerNaming(LIVE_UNNAMED);
  assert.equal(naming.known, true);
  assert.equal(naming.complete, false);
  assert.deepEqual(naming.unnamed, ['Speaker 1', 'Speaker 2']);
  assert.match(naming.reason, /2 of 2 still unnamed/);
});

test('a partly named transcript is not complete', () => {
  const naming = assessSpeakerNaming([
    { speaker: 'Nick Ward', original_speaker: 'Speaker 1' },
    { speaker: 'Speaker 2', original_speaker: 'Speaker 2' }
  ]);
  assert.equal(naming.complete, false);
  assert.equal(naming.namedCount, 1);
  assert.deepEqual(naming.unnamed, ['Speaker 2']);
});

test('a slot named on ANY segment counts as named', () => {
  // Attribution is per utterance and PLAUD is not consistent across a long recording.
  // Requiring every line to agree would hold a fully named meeting on one stray label.
  const naming = assessSpeakerNaming([
    { speaker: 'Speaker 1', original_speaker: 'Speaker 1' },
    { speaker: 'Nick Ward', original_speaker: 'Speaker 1' }
  ]);
  assert.equal(naming.complete, true);
  assert.equal(naming.speakers[0].name, 'Nick Ward');
});

test('a name of the "Speaker N" form is not a name', () => {
  // Guards the case where slot label and assigned name differ but the assigned one is
  // still generic — two differing strings alone must not read as an assignment.
  const naming = assessSpeakerNaming([{ speaker: 'Speaker 1', original_speaker: 'Speaker 2' }]);
  assert.equal(naming.complete, false);
  assert.deepEqual(naming.unnamed, ['Speaker 2']);
});

test('somebody actually called "Speakerman" is a name', () => {
  const naming = assessSpeakerNaming([{ speaker: 'Speakerman', original_speaker: 'Speaker 1' }]);
  assert.equal(naming.complete, true);
});

test('no segments is UNKNOWN, never "nobody is named"', () => {
  // The two license opposite behaviour: holding on an absence would wait out the full
  // deadline on every recording whose transcript never arrives.
  for (const input of [[], null, undefined, 'nonsense']) {
    const naming = assessSpeakerNaming(input);
    assert.equal(naming.known, false, `input ${JSON.stringify(input)}`);
    assert.equal(naming.complete, false);
  }
});

test('a single-voice recording is flagged solo', () => {
  assert.equal(assessSpeakerNaming([LIVE_UNNAMED[0]]).solo, true);
  assert.equal(assessSpeakerNaming(LIVE_UNNAMED).solo, false);
});

// ── decideSpeakerHold ────────────────────────────────────────────────────────

const NOW = new Date('2026-09-01T10:00:00Z');
const unnamed = () => assessSpeakerNaming(LIVE_UNNAMED);
const named = () => assessSpeakerNaming(LIVE_NAMED);

test('named pulls immediately', () => {
  const d = decideSpeakerHold({ naming: named(), firstSeenAt: NOW.toISOString(), now: NOW, maxHoldMs: HOUR });
  assert.equal(d.hold, false);
  assert.equal(d.outcome, 'named');
});

test('unnamed and inside the deadline holds', () => {
  const d = decideSpeakerHold({
    naming: unnamed(),
    firstSeenAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    now: NOW,
    maxHoldMs: HOUR
  });
  assert.equal(d.hold, true);
  assert.equal(d.outcome, 'waiting');
  assert.equal(d.waitedMs, 30 * 60 * 1000);
});

test('the deadline PULLS rather than dropping', () => {
  // The whole safety of holding rests on this: a late transcript is a nuisance, one
  // that never arrives is a lost meeting.
  const d = decideSpeakerHold({
    naming: unnamed(),
    firstSeenAt: new Date(NOW.getTime() - HOUR).toISOString(),
    now: NOW,
    maxHoldMs: HOUR
  });
  assert.equal(d.hold, false);
  assert.equal(d.outcome, 'timeout');
});

test('a solo recording is NEVER held', () => {
  // PLAUD has nobody to tell apart, so waiting burns the full deadline every time and
  // then pulls exactly what was available at the start.
  const d = decideSpeakerHold({
    naming: assessSpeakerNaming([LIVE_UNNAMED[0]]),
    firstSeenAt: NOW.toISOString(),
    now: NOW,
    maxHoldMs: HOUR
  });
  assert.equal(d.hold, false);
  assert.equal(d.outcome, 'solo');
});

test('nothing to judge is never held', () => {
  const d = decideSpeakerHold({ naming: assessSpeakerNaming([]), firstSeenAt: NOW.toISOString(), now: NOW, maxHoldMs: HOUR });
  assert.equal(d.hold, false);
  assert.equal(d.outcome, 'unjudgeable');
});

test('an unmeasurable deadline PULLS rather than holding blind', () => {
  // A hold that cannot measure its own clock is a recording that never arrives.
  for (const firstSeenAt of [null, undefined, '', 'not-a-date']) {
    const d = decideSpeakerHold({ naming: unnamed(), firstSeenAt, now: NOW, maxHoldMs: HOUR });
    assert.equal(d.hold, false, `firstSeenAt ${JSON.stringify(firstSeenAt)}`);
    assert.equal(d.outcome, 'unmeasurable');
  }
});

test('an unreadable "now" also pulls', () => {
  const d = decideSpeakerHold({ naming: unnamed(), firstSeenAt: NOW.toISOString(), now: 'not-a-date', maxHoldMs: HOUR });
  assert.equal(d.hold, false);
  assert.equal(d.outcome, 'unmeasurable');
});

test('a first-seen stamp in the future still expires normally', () => {
  // Clock skew or a restored backup must not produce a negative wait that can never
  // reach the deadline.
  const future = new Date(NOW.getTime() + 5 * HOUR).toISOString();
  assert.equal(decideSpeakerHold({ naming: unnamed(), firstSeenAt: future, now: NOW, maxHoldMs: HOUR }).waitedMs, 0);
  assert.equal(decideSpeakerHold({ naming: unnamed(), firstSeenAt: future, now: NOW, maxHoldMs: 0 }).outcome, 'timeout');
});

test('disabled never holds', () => {
  const d = decideSpeakerHold({ naming: unnamed(), firstSeenAt: NOW.toISOString(), now: NOW, maxHoldMs: HOUR, enabled: false });
  assert.equal(d.hold, false);
  assert.equal(d.outcome, 'disabled');
});

test('the decision is PURE — same inputs, same answer', () => {
  const args = {
    naming: unnamed(),
    firstSeenAt: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(),
    now: NOW,
    maxHoldMs: HOUR
  };
  assert.deepEqual(decideSpeakerHold(args), decideSpeakerHold(args));
});
