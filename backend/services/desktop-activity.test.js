'use strict';

/**
 * The desktop reporter's server half.
 *
 * The pure functions run on plain arrays and a fixed clock. The privacy tests
 * are the important ones: the reporter already sends only a process name, and
 * `sanitiseApp` exists so that a careless FUTURE reporter is truncated here
 * rather than trusted. A window title reaching the database would leak customer
 * names and ticket subjects, and it would do so silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-desk-')), 'a.db');

const db = require('../db/database');
const desk = require('./desktop-activity');

// Several tests below write through the store, so the scratch DB has to exist
// before any of them run — `record()` is not pure and says so.
test.before(async () => { await db.init(); });

const NOW = new Date('2026-08-25T14:00:00');
const ago = mins => new Date(NOW.getTime() - mins * 60000).toISOString();

/** Newest-first samples every 2 minutes, all active, in one app. */
const stream = (count, app, { from = 0, idleSeconds = 5, locked = false } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    at: ago(from + i * 2), app, idleSeconds, locked,
  }));

// ── The privacy line ─────────────────────────────────────────────────────────

test('a window title cannot survive the sanitiser', () => {
  // Every one of these is a real title shape from this machine, and every one
  // would be a leak: a filename, a customer name, a ticket subject.
  for (const [title, expected] of [
    ['risk-assessment-naomi.docx - Word', 'risk'],
    ['NT-14855 Sandford escalation - Outlook', 'NT'],
    ['ambient.js - nuero - Visual Studio Code', 'ambient.js'],
    // Note the colon goes too — the allowlist keeps word characters and a
    // handful of punctuation, so a drive letter or a scheme cannot carry the
    // rest of the string with it.
    ['C:\\Users\\NickW\\secrets.txt', 'C'],
    ['https://jira.example.com/browse/NT-1', 'https'],
  ]) {
    assert.equal(desk.sanitiseApp(title), expected, `"${title}" must be cut at the first separator`);
  }
});

test('an ordinary process name passes through unharmed', () => {
  assert.equal(desk.sanitiseApp('Code'), 'Code');
  assert.equal(desk.sanitiseApp('msedge.exe'), 'msedge');
  assert.equal(desk.sanitiseApp('  OUTLOOK  '), 'OUTLOOK');
  assert.equal(desk.sanitiseApp(''), null);
  assert.equal(desk.sanitiseApp(null), null);
});

test('anything that gets through is still bounded', () => {
  const long = 'a'.repeat(500);
  assert.ok(desk.sanitiseApp(long).length <= 40);
});

test('a LOCKED sample stores no app at all', () => {
  // What he had open before walking away is not something to keep a record of.
  const stored = desk.record({ app: 'Code', locked: true, idleSeconds: 300 });
  assert.equal(stored.app, null);
  assert.equal(stored.locked, true);
});

// ── The run ──────────────────────────────────────────────────────────────────

test('an unbroken stretch in one app is measured', () => {
  const r = desk.currentRun(stream(100, 'Code'), NOW);
  assert.equal(r.known, true);
  assert.equal(r.app, 'Code');
  assert.equal(r.label, 'VS Code', 'the card reads a name, not a binary');
  assert.ok(r.minutes >= 190 && r.minutes <= 200, `got ${r.minutes}`);
});

test('a GAP in the samples ends the run rather than being bridged', () => {
  // The laptop slept through lunch. That hour was not four hours of coding, and
  // bridging it is how a break becomes part of the run.
  const before = stream(10, 'Code');
  const after = stream(10, 'Code', { from: 90 });
  const r = desk.currentRun([...before, ...after], NOW);
  assert.ok(r.minutes < 30, `run should stop at the gap, got ${r.minutes}`);
});

test('switching app ends the run', () => {
  const r = desk.currentRun([...stream(5, 'Code'), ...stream(50, 'msedge', { from: 10 })], NOW);
  assert.equal(r.app, 'Code');
  assert.ok(r.minutes < 20);
});

test('idle ends the run, and being idle NOW is not working at all', () => {
  const r = desk.currentRun([{ at: ago(1), app: 'Code', idleSeconds: 3600 }], NOW);
  assert.equal(r.known, true, 'the laptop reported — that much IS known');
  assert.equal(r.app, null);
  assert.equal(r.why, 'idle');
});

test('a laptop that has gone quiet is UNKNOWN, never "not working"', () => {
  // Same rule as the stale phone and the watch on charge. Asleep, off, or off
  // the tailnet all look identical, and none of them means he stopped working.
  const r = desk.currentRun(stream(20, 'Code', { from: 45 }), NOW);
  assert.equal(r.known, false);
  assert.match(r.why, /last reported/);
});

test('no samples at all is unknown, not idle', () => {
  const r = desk.currentRun([], NOW);
  assert.equal(r.known, false);
  assert.equal(r.app, null);
});

test('atLaptop separates "not there" from "cannot see"', () => {
  const away = desk.atLaptop([{ at: ago(1), app: 'Code', idleSeconds: 3600 }], NOW);
  assert.deepEqual({ known: away.known, at: away.at }, { known: true, at: false });

  const blind = desk.atLaptop([], NOW);
  assert.equal(blind.known, false);
  assert.equal(blind.at, false, 'and `at:false` on an unknown must never be read as "not there"');
});

// ── The observation ──────────────────────────────────────────────────────────

test('three hours in one app is worth a word; two is not', () => {
  const short = desk.assessDesk({ run: { known: true, app: 'Code', label: 'VS Code', minutes: 120, since: ago(120) }, now: NOW });
  assert.equal(short, null);

  const long = desk.assessDesk({ run: { known: true, app: 'Code', label: 'VS Code', minutes: 195, since: ago(195) }, now: NOW });
  assert.ok(long);
  assert.match(long.text, /3h 15m in VS Code/);
  assert.equal(long.kind, 'long-focus');
});

test('it states the fact and does not judge him for it', () => {
  const o = desk.assessDesk({ run: { known: true, app: 'Code', label: 'VS Code', minutes: 240, since: ago(240) }, now: NOW });
  const words = `${o.text} ${o.suggestion}`;
  // Four hours on one thing is a good day as often as it is a stuck one.
  for (const banned of [/too long/i, /you should/i, /obsess/i, /unhealthy/i, /burn/i, /stop/i]) {
    assert.ok(!banned.test(words), `must not contain ${banned}`);
  }
  assert.ok(o.because && o.evidence.length);
});

test('a mention is not repeated on every poll', () => {
  const run = { known: true, app: 'Code', label: 'VS Code', minutes: 200, since: ago(200) };
  const justSaid = desk.assessDesk({ run, lastMentioned: ago(10), now: NOW });
  assert.equal(justSaid, null, 'polled surfaces would otherwise repeat it every few seconds');

  const later = desk.assessDesk({ run, lastMentioned: ago(120), now: NOW });
  assert.ok(later, 'but it comes back once the reminder interval has passed');
});

test('an unknown or idle laptop produces no observation', () => {
  assert.equal(desk.assessDesk({ run: { known: false }, now: NOW }), null);
  assert.equal(desk.assessDesk({ run: { known: true, app: null }, now: NOW }), null);
  assert.equal(desk.assessDesk({ run: null, now: NOW }), null);
});

// ── Storage ──────────────────────────────────────────────────────────────────

test('samples round-trip, stay ordered and stay bounded', () => {
  db.setState(desk.STATE_KEY, JSON.stringify({ samples: [], mentioned: {} }));

  // Posted out of order, as a reporter catching up after a sleep would.
  desk.record({ app: 'Code', at: ago(10), idleSeconds: 2 });
  desk.record({ app: 'Code', at: ago(30), idleSeconds: 2 });
  desk.record({ app: 'Code', at: ago(20), idleSeconds: 2 });

  const s = desk.samples();
  assert.equal(s.length, 3);
  assert.ok(s[0].at > s[1].at && s[1].at > s[2].at, 'newest first regardless of arrival order');

  for (let i = 0; i < desk.MAX_SAMPLES + 50; i += 1) desk.record({ app: 'Code', idleSeconds: 1 });
  assert.equal(desk.samples().length, desk.MAX_SAMPLES, 'the buffer is bounded');
});

test('the long-run observation remembers having been said', () => {
  db.setState(desk.STATE_KEY, JSON.stringify({
    samples: stream(120, 'Code'),
    mentioned: {},
  }));
  const first = desk.longRunObservation(NOW);
  assert.ok(first, 'a 4-hour run is reported');
  const second = desk.longRunObservation(NOW);
  assert.equal(second, null, 'and not reported again a moment later');
});

// ── More than one machine ────────────────────────────────────────────────────
//
// Everything below is about the failure that has no symptom. With one host
// installed all of it passes trivially; the moment a second one reports, the old
// single-ring implementation was wrong in ways that produce plausible numbers
// and log nothing.

test('the legacy single ring migrates into per-host buckets, losslessly', () => {
  db.setState(desk.STATE_KEY, JSON.stringify({
    samples: [
      { at: ago(2), app: 'Code', idleSeconds: 1, locked: false, host: 'LAPTOP' },
      { at: ago(4), app: 'chrome', idleSeconds: 1, locked: false, host: 'DESK' },
      { at: ago(6), app: 'Code', idleSeconds: 1, locked: false, host: 'LAPTOP' },
      { at: ago(8), app: 'Code', idleSeconds: 1, locked: false },   // no host at all
    ],
    mentioned: { Code: ago(5) },
  }));

  assert.equal(desk.samples().length, 4, 'every sample survives the migration');
  assert.equal(desk.samples({ host: 'LAPTOP' }).length, 2);
  assert.equal(desk.samples({ host: 'DESK' }).length, 1);
  assert.equal(desk.samples({ host: desk.UNKNOWN_HOST }).length, 1,
    'a sample with no hostname goes somewhere nameable, not nowhere');

  // The mention is carried, not dropped: staying quiet slightly too long beats
  // repeating the line the moment we deploy.
  assert.equal(desk.longRunObservation(NOW), null);
});

test('a second machine does not evict the first machine samples', () => {
  db.setState(desk.STATE_KEY, '');
  for (let i = 0; i < desk.MAX_SAMPLES; i += 1) desk.record({ app: 'Code', host: 'LAPTOP', idleSeconds: 1 });
  assert.equal(desk.samples({ host: 'LAPTOP' }).length, desk.MAX_SAMPLES);

  for (let i = 0; i < 50; i += 1) desk.record({ app: 'chrome', host: 'DESK', idleSeconds: 1 });
  assert.equal(desk.samples({ host: 'LAPTOP' }).length, desk.MAX_SAMPLES,
    'the laptop keeps its full window — a shared ring would have halved it');
  assert.equal(desk.samples({ host: 'DESK' }).length, 50);
});

test('interleaved machines do not cut each other runs short', () => {
  // The bug this whole change exists for. Two hosts, samples alternating in
  // time. In ONE list, the other machine's sample sits mid-run in a different
  // app and ends it, so a three-hour stretch reports as two minutes — quietly,
  // with nothing logged.
  const laptop = stream(90, 'Code');                       // 3 hours, newest-first
  const deskPc = stream(90, 'chrome', { from: 1, idleSeconds: 4000 }); // on, but idle

  const merged = [...laptop, ...deskPc].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const naive = desk.currentRun(merged, NOW);
  assert.ok(naive.minutes < 10, 'proof the old shape was broken: one list reads the run as minutes');

  const across = desk.runAcross({ LAPTOP: laptop, DESK: deskPc }, NOW);
  assert.equal(across.app, 'Code');
  assert.ok(across.minutes >= 170, `the real run survives (${across.minutes} min)`);
  assert.equal(across.host, 'LAPTOP', 'and it says which machine it is talking about');
});

test('an ACTIVE machine outranks one that is merely switched on', () => {
  const across = desk.runAcross({
    IDLE_BOX: stream(30, 'chrome', { idleSeconds: 4000 }),
    LAPTOP: stream(30, 'Code', { from: 1 }),
  }, NOW);
  assert.equal(across.host, 'LAPTOP');
  assert.equal(across.app, 'Code');
  assert.equal(across.hosts.length, 2, 'both machines are reported either way');
});

test('a run is only unbroken if he was not on the OTHER machine during it', () => {
  // Two hours in Code on the laptop, but he was actively on the desktop forty
  // minutes ago. Each list in isolation says two hours; that is true of the list
  // and false about the man.
  const across = desk.runAcross({
    LAPTOP: stream(60, 'Code'),
    DESK: stream(5, 'chrome', { from: 40 }),
  }, NOW);

  assert.equal(across.host, 'LAPTOP');
  assert.ok(across.minutes <= 45, `the run starts after the interruption (got ${across.minutes})`);
  assert.deepEqual(across.otherHostsActive, ['DESK'], 'and names what interrupted it');
});

test('an idle other machine does not interrupt anything', () => {
  const across = desk.runAcross({
    LAPTOP: stream(60, 'Code'),
    DESK: stream(30, 'chrome', { from: 10, idleSeconds: 4000 }),
  }, NOW);
  assert.ok(across.minutes >= 110, 'a switched-on machine he is not using is not a break');
  assert.deepEqual(across.otherHostsActive, []);
});

test('no machines at all is unknown, and says so', () => {
  const across = desk.runAcross({}, NOW);
  assert.equal(across.known, false);
  assert.equal(across.host, null);
  assert.deepEqual(across.hosts, []);
  assert.match(across.why, /never reported/);
});

test('the number of hosts is bounded', () => {
  db.setState(desk.STATE_KEY, '');
  for (let i = 0; i < desk.MAX_HOSTS + 3; i += 1) {
    desk.record({ app: 'Code', host: `BOX${i}`, idleSeconds: 1 });
  }
  assert.equal(desk.hosts().length, desk.MAX_HOSTS,
    'a reporter with a rolling hostname cannot grow the blob without limit');
});

test('the long-run memory is per machine', () => {
  db.setState(desk.STATE_KEY, JSON.stringify({
    hosts: {
      LAPTOP: { samples: stream(120, 'Code'), mentioned: {} },
    },
  }));
  assert.ok(desk.longRunObservation(NOW), 'the laptop run is reported');
  assert.equal(desk.longRunObservation(NOW), null, 'and not repeated');

  // A different machine running the same app long is a separate fact, and must
  // not be silenced by the first machine having been mentioned.
  const state = JSON.parse(db.getState(desk.STATE_KEY));
  state.hosts.DESK = { samples: stream(120, 'Code', { from: 1 }), mentioned: {} };
  // Push the laptop out of contention so DESK is the primary.
  state.hosts.LAPTOP.samples = stream(5, 'Code', { from: 600 });
  db.setState(desk.STATE_KEY, JSON.stringify(state));
  assert.ok(desk.longRunObservation(NOW), 'the second machine gets its own mention');
});
