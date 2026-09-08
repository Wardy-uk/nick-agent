'use strict';

/**
 * The RescueTime second opinion.
 *
 * Two groups matter more than the rest:
 *
 *  - the SANITISER, because RescueTime holds full window titles and its activity
 *    rows carry query strings verbatim. One real row pulled on 2 Sep 2026 was an
 *    OAuth callback with its parameters attached. Anything that leaks through
 *    here reaches vault embeddings and cloud model prompts.
 *
 *  - the AGREEMENT rules, because the whole reason to integrate at all is that
 *    `desktop_daily` can audit RescueTime. A check that flags the wrong thing,
 *    or flags nothing, puts us back where August was.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-rt-')), 'a.db');
delete process.env.RESCUETIME_API_KEY;

const db = require('../db/database');
const rt = require('./rescuetime');

test.before(async () => { await db.init(); });

// ── The privacy line ─────────────────────────────────────────────────────────

test('an activity row cannot smuggle a query string, a path or a title', () => {
  // The first of these is REAL — copied verbatim from the live API on 2 Sep.
  for (const [raw, expected] of [
    ['web.plaud.ai&response_type=code id_token&scope=name email&response_mode=web_message&frame_id=e8ca',
      'web.plaud.ai'],
    ['nurturtech.atlassian.net/browse/NT-14855', 'nurturtech.atlassian.net'],
    ['nova.nurtur.tech?ticket=Sandford', 'nova.nurtur.tech'],
    ['mail.google.com/mail/u/0/#inbox', 'mail.google.com'],
    ['www.rescuetime.com', 'rescuetime.com'],
  ]) {
    const out = rt.sanitiseActivity(raw);
    assert.equal(out.kind, 'domain', `${raw} is a hostname`);
    assert.equal(out.value, expected, `"${raw}" must be cut to its bare host`);
  }
});

test('an application name stays an application name, and is not mistaken for a host', () => {
  // Every one of these is a real activity name from the live account.
  for (const [raw, expected] of [
    ['Visual Studio Code', 'Visual Studio Code'],
    ['Microsoft Teams', 'Microsoft Teams'],
    ['SQL Server Mgmt Studio', 'SQL Server Mgmt Studio'],
    ['MS Terminal Services Client', 'MS Terminal Services Client'],
    ['lockapp', 'lockapp'],
  ]) {
    const out = rt.sanitiseActivity(raw);
    assert.equal(out.kind, 'app', `${raw} is an app`);
    assert.equal(out.value, expected);
  }
});

test('a window title reaching the activity field is cut, not stored', () => {
  // RescueTime holds full window titles. If one ever arrives through the
  // activity field it must lose everything after the first separator — the same
  // rule, and the same function, the desktop agent uses.
  for (const [raw, banned] of [
    ['NT-14855 Sandford escalation - Outlook', /Sandford/],
    ['risk-assessment-naomi.docx - Word', /naomi/i],
    ['ambient.js - nuero - Visual Studio Code', /nuero/],
  ]) {
    const out = rt.sanitiseActivity(raw);
    assert.ok(out, `${raw} produced nothing`);
    assert.ok(!banned.test(out.value), `a name survived the sanitiser: ${out.value}`);
    assert.ok(out.value.length <= 40);
  }
});

test('a bare FILENAME is never mistaken for a hostname', () => {
  // `risk-assessment-naomi.docx` satisfies every rule a hostname does, and
  // carries a colleague's name. restrict_kind=document is never requested, which
  // is precisely why a cheap guard is worth having.
  for (const raw of ['risk-assessment-naomi.docx', 'Q3-headcount.xlsx', 'notes.md', 'query.sql']) {
    const out = rt.sanitiseActivity(raw);
    assert.notEqual(out.kind, 'domain', `${raw} must not be stored as a website`);
  }
  // And a real hostname with a hyphen still works.
  assert.deepEqual(rt.sanitiseActivity('my-site.co.uk'), { kind: 'domain', value: 'my-site.co.uk' });
});

test('no fold ever produces a productivity figure', () => {
  const days = rt.foldDays(
    [{ Date: '2026-09-01', 'Time Spent (seconds)': 3600, Category: 'Software Development', Productivity: 2 }],
    [{ Date: '2026-09-01', 'Time Spent (seconds)': 600, Activity: 'jira.example.com', Productivity: 2 }]
  );
  const blob = JSON.stringify(days);
  assert.ok(!/productivity|pulse/i.test(blob),
    'the pulse measured as a coding-vs-meetings ratio NEURO already derives — it must not be carried');
});

// ── Parsing ──────────────────────────────────────────────────────────────────

test('rows are read by header NAME, so a reordered table still parses', () => {
  const parsed = rt.parseRows({
    row_headers: ['Category', 'Number of People', 'Date', 'Time Spent (seconds)'],
    rows: [['Email', 1, '2026-09-01', 1800]],
  }, ['Date', 'Time Spent (seconds)', 'Category']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows[0].Category, 'Email');
  assert.equal(parsed.rows[0]['Time Spent (seconds)'], 1800);
});

test('an unexpected shape REFUSES rather than returning an empty day', () => {
  // A silently empty result reads as "he did nothing", which is the exact
  // failure this integration exists to detect.
  const parsed = rt.parseRows({ row_headers: ['Rank', 'Activity'], rows: [[1, 'Code']] },
    ['Date', 'Time Spent (seconds)']);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /expected/);
  assert.match(parsed.error, /Date/);
});

test('the day key comes from RescueTime and is never re-derived', () => {
  const days = rt.foldDays([
    { Date: '2026-09-01T00:00:00', 'Time Spent (seconds)': 3600, Category: 'Email' },
  ], []);
  assert.ok(days['2026-09-01'], 'the account timezone decides the day, not ours');
  assert.equal(days['2026-09-01'].totalMinutes, 60);
});

// ── The agreement check ──────────────────────────────────────────────────────

const deskDay = (over = {}) => ({
  // The real 1 Sep row: present 617, active 521. Both, because the audit
  // judges against ACTIVE, and a fixture carrying only present would let the
  // denominator quietly go back to counting idle time against RescueTime.
  day: '2026-09-01', host: 'LAPTOP', present_minutes: 617, active_minutes: 521,
  sample_count: 299, complete: 1, ...over,
});

test('the 1 Sep failure is caught', () => {
  // The real numbers: RescueTime 0.16h, agent 10.29h, same machine, same day.
  const v = rt.assessDay({ total_minutes: 9.6 }, [deskDay()]);
  assert.equal(v.state, 'under');
  assert.equal(v.host, 'LAPTOP');
  assert.match(v.why, /0\.2h|0\.1h/);
  assert.match(v.why, /8\.7h/);
});

// A day spent working on a machine the agent is not installed on: the laptop
// is switched on and untouched. Judged against present minutes that was an
// accusation (6 Sep 2026, ratio 0.04). Judged against active time it is the
// refusal it always should have been.
test('a machine left on and idle cannot referee, and is never a verdict', () => {
  const v = rt.assessDay({ total_minutes: 5.7 },
    [deskDay({ day: '2026-09-06', present_minutes: 130, active_minutes: 0, sample_count: 69 })]);
  assert.equal(v.state, 'unknown', 'no work done at the machine is not evidence against RescueTime');
  assert.equal(v.ratio, null);
  assert.match(v.why, /no activity/);
});

test('idle time is not counted against RescueTime', () => {
  // Real 7 Sep: 421.5 reported, 459 active, 527 present. Against active that is
  // 0.92; against present it was 0.80 - agreeing either way here, but this is
  // the mechanism that produced the 0.45 and 0.04 days.
  const v = rt.assessDay({ total_minutes: 421.5 },
    [deskDay({ day: '2026-09-07', present_minutes: 527, active_minutes: 459, sample_count: 252 })]);
  assert.equal(v.state, 'agree');
  assert.ok(v.ratio > 0.9, 'judged against active time, got ' + v.ratio);
});

test('RescueTime logging NOTHING against a measured day is caught, not treated as absence', () => {
  const v = rt.assessDay(null, [deskDay()]);
  assert.equal(v.state, 'under');
  assert.equal(v.ratio, 0);
  assert.match(v.why, /logged nothing/);
});

test('a normal day agrees', () => {
  const v = rt.assessDay({ total_minutes: 500 }, [deskDay()]);
  assert.equal(v.state, 'agree');
  assert.ok(v.ratio > 0.7 && v.ratio < 1.1);
});

test('RescueTime reporting MORE is never flagged', () => {
  // It legitimately sees another machine, or time before the agent was installed.
  // Flagging this would be a permanent false alarm on a working feed.
  const v = rt.assessDay({ total_minutes: 900 }, [deskDay()]);
  assert.equal(v.state, 'agree', 'over-reporting is not a fault');
});

test('a day the agent did not properly cover cannot referee', () => {
  const unfinished = rt.assessDay({ total_minutes: 5 }, [deskDay({ complete: 0 })]);
  assert.equal(unfinished.state, 'unknown');
  assert.match(unfinished.why, /not finished/);

  const thin = rt.assessDay({ total_minutes: 5 }, [deskDay({ sample_count: 12 })]);
  assert.equal(thin.state, 'unknown', 'our own blind spot must never be blamed on RescueTime');
  assert.match(thin.why, /too thin/);

  const absent = rt.assessDay({ total_minutes: 5 }, []);
  assert.equal(absent.state, 'unknown');
});

test('the comparison names which machine it used, because RescueTime cannot say', () => {
  const v = rt.assessDay({ total_minutes: 400 }, [
    deskDay({ host: 'DESK', present_minutes: 120, active_minutes: 90, sample_count: 90 }),
    deskDay({ host: 'LAPTOP', present_minutes: 600, active_minutes: 500, sample_count: 290 }),
  ]);
  assert.equal(v.host, 'LAPTOP', 'the busiest machine that day');
});

// ── Calibration ──────────────────────────────────────────────────────────────

test('it does not accuse RescueTime before it has enough days to mean it', () => {
  const pairs = [
    { day: '2026-09-01', state: 'under' },
    { day: '2026-09-02', state: 'agree' },
  ];
  const c = rt.coverage(pairs);
  assert.equal(c.state, 'calibrating', 'two days is not evidence of a pattern');
  assert.equal(c.needed, rt.MIN_CALIBRATION_DAYS);
  assert.match(c.why, /comparable days/);
});

test('with enough days, a single missed day is reported and named', () => {
  const pairs = Array.from({ length: 9 }, (_, i) => ({ day: `2026-09-0${i + 1}`, state: 'agree' }));
  pairs[3].state = 'under';
  const c = rt.coverage(pairs);
  assert.equal(c.state, 'under');
  assert.equal(c.under, 1);
  assert.deepEqual(c.days, ['2026-09-04'], 'naming the day is what makes it actionable');
});

test('unknown days count towards neither verdict', () => {
  const pairs = [
    ...Array.from({ length: 7 }, (_, i) => ({ day: `d${i}`, state: 'agree' })),
    ...Array.from({ length: 5 }, (_, i) => ({ day: `u${i}`, state: 'unknown' })),
  ];
  const c = rt.coverage(pairs);
  assert.equal(c.state, 'agree');
  assert.equal(c.judged, 7, 'only days both sides could speak about are judged');
  assert.equal(c.unknown, 5, 'and the ones neither could are reported, not hidden');
});

// ── The credential ───────────────────────────────────────────────────────────

test('the key is stored, reported by SOURCE, and never returned', () => {
  assert.equal(rt.isConfigured(), false);
  assert.equal(rt.credentialSource(), null);

  assert.equal(rt.setStoredKey('short').ok, false, 'an obviously wrong key is refused');
  const secret = 'B63PBB1TtWWBQtz0rpoP9yes8ZrXNjAXk9tHGB9a';
  assert.equal(rt.setStoredKey(secret).ok, true);
  assert.equal(rt.isConfigured(), true);
  assert.equal(rt.credentialSource(), 'stored');

  // Nothing that reports status may carry the value.
  const status = JSON.stringify(rt.coverageReport(5));
  assert.ok(!status.includes(secret), 'the key must never appear in a status payload');

  rt.clearStoredKey();
  assert.equal(rt.isConfigured(), false);
});

test('an env key wins over a stored one, and is reported as such', () => {
  rt.setStoredKey('storedkeystoredkeystoredkey123');
  process.env.RESCUETIME_API_KEY = 'envkeyenvkeyenvkeyenvkey1234';
  try {
    assert.equal(rt.key(), 'envkeyenvkeyenvkeyenvkey1234', 'a deployment pinning the key is never overridden');
    assert.equal(rt.credentialSource(), 'env');
  } finally {
    delete process.env.RESCUETIME_API_KEY;
    rt.clearStoredKey();
  }
});

test('an unconfigured sync refuses before the network', async () => {
  const out = await rt.sync();
  assert.equal(out.ok, false);
  assert.equal(out.gaps[0].why, 'not-configured',
    '"we were never told the key" needs a different fix from "RescueTime is down"');
});

// ── The empty-overwrite guard ────────────────────────────────────────────────

test('an empty day never overwrites a day that had hours', () => {
  const stored = { total_minutes: 480 };
  const refused = rt.shouldStore(stored, 0);
  assert.equal(refused.write, false,
    'a zero answer for a day we already recorded time for is not evidence of a quiet day');
  assert.match(refused.why, /8\.0h/, 'and it says what it is protecting');

  // Everything else writes: RescueTime is the authority on its own numbers.
  assert.equal(rt.shouldStore(stored, 500).write, true);
  assert.equal(rt.shouldStore(stored, 10).write, true, 'a smaller but real figure is a correction, not a loss');
  assert.equal(rt.shouldStore(null, 0).write, true, 'a genuinely empty new day is fine to record');
});
