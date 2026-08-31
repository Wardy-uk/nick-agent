'use strict';

/**
 * Ambient observations.
 *
 * `assess()` is pure, so all of this runs on plain objects and a fixed clock.
 * The NEGATIVE tests are the important half: every one of them is a case where
 * saying something would be worse than saying nothing, and the whole feature is
 * one bad week of nagging away from being muted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ambient = require('./ambient');

// A Tuesday afternoon, on duty, phone reporting.
const NOW = new Date('2026-08-25T14:00:00');
const iso = minsAgo => new Date(NOW.getTime() - minsAgo * 60000).toISOString();
const dayKey = daysAgo => {
  const d = new Date(NOW.getTime() - daysAgo * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const livePhone = (over = {}) => ({
  lastReportAt: iso(5),
  activity: 'Still',
  activitySince: iso(120),
  focusMode: false,
  ...over,
});

/** A logging habit that IS live: food on 5 of the last 7 days, none today. */
const loggedDays = (value, { skipToday = true } = {}) =>
  Array.from({ length: 7 }, (_, i) => ({
    day: dayKey(i),
    value: i === 0 && skipToday ? 0 : value,
  }));

const kinds = r => r.observations.map(o => o.kind);

// ── The rule the file turns on ───────────────────────────────────────────────

test('NOT LOGGED is not NOT EATEN — the whole design turns on this', () => {
  // Live data: dietary_energy_consumed last has a sample on 30 Mar 2026 and
  // dietary_water on 3 Feb 2025. A naive read tells Nick he has not eaten,
  // every lunchtime, for five months.
  const r = ambient.assess({
    phone: livePhone({ activitySince: iso(5) }),
    dietEnergy: Array.from({ length: 7 }, (_, i) => ({ day: dayKey(i), value: 0 })),
    water: Array.from({ length: 7 }, (_, i) => ({ day: dayKey(i), value: 0 })),
  }, NOW);

  assert.equal(kinds(r).includes('not-eaten'), false);
  assert.equal(kinds(r).includes('low-water'), false);
  // And it says WHY, so the gap is visible rather than silent.
  assert.match(r.unknowns.find(u => u.input === 'food').why, /missed habit/);
});

test('once he IS logging, a blank day means something and is said', () => {
  const r = ambient.assess({
    phone: livePhone({ activitySince: iso(5) }),
    dietEnergy: loggedDays(2100),
  }, NOW);
  const eaten = r.observations.find(o => o.kind === 'not-eaten');
  assert.ok(eaten, 'a live habit with a blank today is a real observation');
  assert.match(eaten.because, /6 of the last 7 days/);
});

test('a single logged day is not a habit', () => {
  const sparse = Array.from({ length: 7 }, (_, i) => ({ day: dayKey(i), value: i === 3 ? 1800 : 0 }));
  const r = ambient.assess({ phone: livePhone(), dietEnergy: sparse }, NOW);
  assert.equal(kinds(r).includes('not-eaten'), false);
  assert.match(r.unknowns.find(u => u.input === 'food').why, /only 1 of the last 7/);
});

test('morning is not a missed lunch', () => {
  const morning = new Date('2026-08-25T09:30:00');
  const r = ambient.assess({ phone: livePhone(), dietEnergy: loggedDays(2100) }, morning);
  assert.equal(kinds(r).includes('not-eaten'), false);
});

// ── Sedentary ────────────────────────────────────────────────────────────────

test('sitting still a long time is worth a word', () => {
  const r = ambient.assess({ phone: livePhone({ activitySince: iso(150) }) }, NOW);
  const sat = r.observations.find(o => o.kind === 'sedentary');
  assert.ok(sat);
  assert.match(sat.text, /2h 30m/);
});

test('a short sit is not sedentary', () => {
  const r = ambient.assess({ phone: livePhone({ activitySince: iso(20) }) }, NOW);
  assert.equal(kinds(r).includes('sedentary'), false);
});

test('a phone that has gone quiet is UNKNOWN, never still', () => {
  // The exact trap: a phone switched off and a phone reporting `Still` are
  // identical if you only read the value. Live on 31 Aug the phone was 14 hours
  // stale, which would have read as fourteen hours of sitting down.
  const r = ambient.assess({
    phone: livePhone({ lastReportAt: iso(14 * 60), activitySince: iso(14 * 60) }),
  }, NOW);
  assert.equal(kinds(r).includes('sedentary'), false);
  assert.equal(r.phoneLive, false);
  assert.match(r.unknowns.find(u => u.input === 'phone').why, /too old/);
});

test('Focus mode vetoes the nudge outright', () => {
  // He has explicitly told the phone to leave him alone. That is a stronger and
  // more current statement than anything this file can infer.
  const r = ambient.assess({ phone: livePhone({ activitySince: iso(200), focusMode: true }) }, NOW);
  assert.equal(kinds(r).includes('sedentary'), false);
});

test('off duty, the suggestion changes but the observation does not', () => {
  const onDuty = ambient.assess({ phone: livePhone({ activitySince: iso(150) }), duty: { onDuty: true } }, NOW);
  const offDuty = ambient.assess({ phone: livePhone({ activitySince: iso(150) }), duty: { onDuty: false } }, NOW);
  assert.equal(onDuty.observations[0].text, offDuty.observations[0].text);
  assert.match(offDuty.observations[0].suggestion, /round the house/);
});

// ── Exercise ─────────────────────────────────────────────────────────────────

const exerciseDays = mins => mins.map((m, i) => ({ day: dayKey(i), complete: true, exerciseMinutes: m }));

test('a broken exercise habit is noticed', () => {
  const days = exerciseDays([0, 2, 0, ...Array.from({ length: 25 }, () => 40)]);
  const r = ambient.assess({ phone: livePhone({ activitySince: iso(5) }), days }, NOW);
  const none = r.observations.find(o => o.kind === 'no-exercise');
  assert.ok(none);
  assert.match(none.because, /of your last 28 days/);
});

test('someone who never records exercise is never told he has stopped', () => {
  // There is no habit to have broken, and saying so invents a standard he never
  // set — the same error as telling him he has not eaten when he does not log.
  const days = exerciseDays(Array.from({ length: 28 }, () => 0));
  const r = ambient.assess({ phone: livePhone({ activitySince: iso(5) }), days }, NOW);
  assert.equal(kinds(r).includes('no-exercise'), false);
});

test('one quiet day is not a gap', () => {
  const days = exerciseDays([0, 45, 30, ...Array.from({ length: 25 }, () => 40)]);
  const r = ambient.assess({ phone: livePhone({ activitySince: iso(5) }), days }, NOW);
  assert.equal(kinds(r).includes('no-exercise'), false);
});

test('an incomplete day cannot count towards a gap', () => {
  const days = [
    { day: dayKey(0), complete: false, exerciseMinutes: 0 },
    ...exerciseDays([0, 0]).map((d, i) => ({ ...d, day: dayKey(i + 1) })),
    ...Array.from({ length: 25 }, (_, i) => ({ day: dayKey(i + 3), complete: true, exerciseMinutes: 40 })),
  ];
  const r = ambient.assess({ phone: livePhone({ activitySince: iso(5) }), days }, NOW);
  // Two complete quiet days is not three.
  assert.equal(kinds(r).includes('no-exercise'), false);
});

// ── Health signals ───────────────────────────────────────────────────────────

test('a health finding is passed through WITH its caveat', () => {
  // health-signals attaches a caveat to every finding precisely because Apple
  // Health cannot separate exercise, illness, alcohol and a hard week. Dropping
  // it is how a reading becomes a diagnosis.
  const r = ambient.assess({
    phone: livePhone({ activitySince: iso(5) }),
    signals: {
      findings: [{
        id: 'rhr-elevated',
        level: 'warn',
        title: 'Resting heart rate up for 3 days',
        detail: '82bpm against your usual 78bpm.',
        caveat: 'Could be a bug coming on, a heavy week, alcohol or hard exercise — this cannot tell those apart.',
        evidence: [{ day: dayKey(1), rhr: 82 }],
      }],
      unknowns: [],
    },
  }, NOW);
  const f = r.observations.find(o => o.kind === 'health-signal');
  assert.ok(f);
  assert.match(f.caveat, /cannot tell those apart/);
});

test('a health finding outranks a glass of water', () => {
  const r = ambient.assess({
    phone: livePhone({ activitySince: iso(150) }),
    water: loggedDays(2000),
    signals: { findings: [{ id: 'hrv-suppressed', level: 'warn', title: 'HRV below your normal range', caveat: 'x' }], unknowns: [] },
  }, NOW);
  assert.equal(r.observations[0].kind, 'health-signal');
});

// ── Silence, and honesty about it ────────────────────────────────────────────

test('nothing to say is a correct answer and is not padded', () => {
  const r = ambient.assess({
    phone: livePhone({ activity: 'Walking', activitySince: iso(10) }),
    days: exerciseDays(Array.from({ length: 28 }, () => 40)),
    dietEnergy: loggedDays(2100, { skipToday: false }),
    water: loggedDays(2000, { skipToday: false }),
    signals: { findings: [], unknowns: [] },
  }, NOW);
  assert.deepEqual(r.observations, []);
  assert.equal(r.allClear, true);
});

test('"nothing to say" and "I could not look" are different facts', () => {
  const blind = ambient.assess({}, NOW);
  assert.deepEqual(blind.observations, []);
  assert.equal(blind.allClear, false, 'an empty list with unknowns is NOT an all-clear');
  assert.ok(blind.unknowns.length > 0);
});

test('the list is bounded, and what was dropped is counted', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: `f${i}`, level: 'warn', title: `Finding ${i}`, caveat: 'x',
  }));
  const r = ambient.assess({ phone: livePhone({ activitySince: iso(150) }), signals: { findings: many, unknowns: [] } }, NOW);
  assert.equal(r.observations.length, ambient.MAX_OBSERVATIONS);
  assert.ok(r.dropped > 0);
});

test('nothing here diagnoses, scores or moralises', () => {
  const r = ambient.assess({
    phone: livePhone({ activitySince: iso(200) }),
    days: exerciseDays([0, 0, 0, ...Array.from({ length: 25 }, () => 40)]),
    dietEnergy: loggedDays(2100),
    water: loggedDays(2000),
  }, NOW);
  const words = r.observations.map(o => `${o.text} ${o.suggestion || ''}`).join(' ');
  for (const banned of [
    /you've got this/i, /well done/i, /be kind to yourself/i, /lazy/i,
    /you should have/i, /failed/i, /streak/i, /score/i, /unhealthy/i,
  ]) {
    assert.ok(!banned.test(words), `ambient copy must not contain ${banned}`);
  }
  // Every observation states its evidence, so none of them is an opinion.
  for (const o of r.observations) {
    assert.ok(o.because, `${o.kind} must say what it is based on`);
    assert.ok(Array.isArray(o.evidence) && o.evidence.length, `${o.kind} must carry evidence`);
  }
});

test('loggingHabit is honest about the difference between none and a few', () => {
  const none = ambient.loggingHabit([{ day: 'a', value: 0 }, { day: 'b', value: 0 }], { label: 'food' });
  assert.equal(none.live, false);
  assert.match(none.why, /nothing logged/);

  const some = ambient.loggingHabit([{ day: 'a', value: 1 }, { day: 'b', value: 0 }], { label: 'food' });
  assert.equal(some.live, false);
  assert.match(some.why, /only 1 of/);

  const live = ambient.loggingHabit([{ day: 'a', value: 1 }, { day: 'b', value: 1 }], { label: 'food' });
  assert.equal(live.live, true);
});
