'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Scratch DB, never the live one. And an EMPTY scratch vault: one-to-one-detect
// is a source here, and #119 exists because a test once created notes in the
// real vault. Both are set before anything is required.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wins-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wins-vault-'));
// A path that is not a git repo. The failure it produces is the point of one of
// the tests below — a source that cannot be read must be NAMED, not counted 0.
process.env.WINS_GIT_REPOS = path.join(tmp, 'not-a-repo');

const db = require('../db/database');
const wins = require('./wins');

test.before(async () => { await db.init(); });

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('commits fold to one row per repo per day, carrying the count', () => {
  const day = (iso) => new Date(iso);
  const folded = wins.foldCommits([
    { repo: 'nuero', at: day('2026-08-17T09:00:00Z'), dateKey: '2026-08-17', subject: 'fix: the dedupe never fired' },
    { repo: 'nuero', at: day('2026-08-17T14:00:00Z'), dateKey: '2026-08-17', subject: 'fix: one pending send' },
    { repo: 'nuero', at: day('2026-08-16T10:00:00Z'), dateKey: '2026-08-16', subject: 'feat: wins ledger' },
    { repo: 'daypilot', at: day('2026-08-17T11:00:00Z'), dateKey: '2026-08-17', subject: 'chore: bump' },
  ]);

  assert.equal(folded.length, 3, 'two repos on one day plus one on another is three rows, not four commits');
  const nueroToday = folded.find(f => f.dedupeKey === 'git:nuero:2026-08-17');
  assert.equal(nueroToday.count, 2);
  assert.match(nueroToday.text, /2 commits to nuero/);
  // At ~9 commits a day, one row per commit would make git 90% of the ledger and
  // bury the admin work that is the whole reason this feature exists.
  assert.ok(folded.every(f => f.source === 'git'));
});

test('a folded commit row keeps the LATEST commit time, so the day sorts correctly', () => {
  const folded = wins.foldCommits([
    { repo: 'nuero', at: new Date('2026-08-17T09:00:00Z'), dateKey: '2026-08-17', subject: 'early' },
    { repo: 'nuero', at: new Date('2026-08-17T18:00:00Z'), dateKey: '2026-08-17', subject: 'late' },
  ]);
  assert.equal(folded[0].occurredAt.toISOString(), '2026-08-17T18:00:00.000Z');
});

test('a typical day is the median of recent working days, or nothing at all', () => {
  // This replaced the streak. The streak counted consecutive days with any win,
  // which was fine while the ledger only knew about ticked tasks and worthless
  // the moment meetings were counted honestly: it jumped 4 to 35 in one
  // backfill and became effectively unbreakable. A number that cannot go down
  // is not a signal, and NEURO has plenty of those already.
  const anchor = new Date(2026, 7, 17, 10, 0, 0); // Mon 17 Aug

  // Thu 13, Fri 14, and the three weekdays before. Today is excluded (still in
  // progress) and so are weekends (a quiet Sunday is not a bad day).
  const byDay = new Map([
    ['2026-08-17', 99],
    ['2026-08-14', 7], ['2026-08-13', 4], ['2026-08-12', 4],
    ['2026-08-11', 3], ['2026-08-10', 30],
  ]);
  assert.equal(wins.typicalDay(byDay, anchor), 4, 'median, so one huge day cannot drag it up');

  // Below five days of data it refuses to answer rather than inventing a
  // baseline from three points — the same refusal stress-score makes.
  const thin = new Map([['2026-08-14', 7], ['2026-08-13', 4]]);
  assert.equal(wins.typicalDay(thin, anchor), null);

  // A day with no ledger data is not a zero — it is a day nobody asked about.
  assert.equal(wins.typicalDay(new Map(), anchor), null);
});

test('a bare SQLite timestamp is read as UTC, not local', () => {
  // CURRENT_TIMESTAMP writes UTC with no marker. Reading it as local shifts a
  // win across midnight and breaks a streak for no reason a human can see.
  const parsed = wins.parseDbTime('2026-08-17 23:30:00');
  assert.equal(parsed.toISOString(), '2026-08-17T23:30:00.000Z');
  // Anything carrying its own offset is left alone.
  assert.equal(wins.parseDbTime('2026-08-17T23:30:00.000Z').toISOString(), '2026-08-17T23:30:00.000Z');
  assert.equal(wins.parseDbTime(null), null);
  assert.equal(wins.parseDbTime('not a date'), null);
});

// ── Collection and sync ──────────────────────────────────────────────────────

test('an unreadable source is named as a gap, never counted as zero', () => {
  const { gaps } = wins.collect({ since: '2026-08-01', until: '2026-08-31' });
  assert.ok(
    gaps.some(g => /git unreadable/.test(g)),
    'WINS_GIT_REPOS points at a non-repo, so git must appear in gaps'
  );
  // This is the whole bug being fixed, restated as a test: a wins count that
  // silently reads 0 while the work is happening is what made the Momentum
  // card useless. A count that cannot say what it could not see is the same
  // failure wearing a new number.
});

test('detected work becomes wins, and syncing twice adds nothing', () => {
  db.logActivity('task_done', { text: 'Send the weekly risk report' }, '2026-08-17');
  db.logActivity('standup_done', { hour: 9 }, '2026-08-17');
  db.run(
    `INSERT INTO sara_actions (type, payload, status, created_at, resolved_at)
     VALUES ('reply_email', ?, 'executed', '2026-08-17 09:00:00', '2026-08-17 09:05:00')`,
    [JSON.stringify({ subject: 'Integration Partner Escalation' })]
  );
  // Excluded on purpose: approving one CREATES a task, it finishes nothing, and
  // it is bulk-generated nightly in the hundreds.
  db.run(
    `INSERT INTO sara_actions (type, payload, status, created_at, resolved_at)
     VALUES ('capture_todo', '{}', 'executed', '2026-08-17 09:00:00', '2026-08-17 09:06:00')`
  );

  const first = wins.sync({ since: '2026-08-01', until: '2026-08-31' });
  assert.ok(first.added >= 3, `expected at least 3 wins, got ${first.added}`);

  const rows = wins.feed({ dateKey: '2026-08-17' }).wins;
  assert.ok(rows.some(r => /weekly risk report/.test(r.text)), 'a completed task is a win');
  assert.ok(rows.some(r => r.source === 'ritual'), 'standup is a ritual win');
  assert.ok(rows.some(r => /Integration Partner/.test(r.text)), 'a sent reply action is a win');
  assert.ok(!rows.some(r => r.kind === 'capture_todo'), 'capture_todo finishes nothing');

  // Idempotency is not a nicety. sync() runs hourly, on startup and over a
  // backfill range; if a second sighting inflated the count, the number would
  // climb on its own and Nick would stop trusting it inside a week.
  const second = wins.sync({ since: '2026-08-01', until: '2026-08-31' });
  assert.equal(second.added, 0, 'a second sync must add nothing');
  assert.equal(wins.feed({ dateKey: '2026-08-17' }).total, rows.length);
});

test('wins landing in the same second keep their true order', () => {
  // activity_log's created_at has second precision and getActivityForRange
  // orders by it, so a tie comes back in NO guaranteed order — the first cut of
  // this module read them in query order and the feed shuffled "what you did
  // today". collect() sorts on activity id so the wins ids follow the real
  // sequence and the feed's id tie-break means something.
  db.getDb().prepare('DELETE FROM wins').run();
  db.logActivity('task_done', { text: 'FIRST thing' }, '2026-08-16');
  db.logActivity('task_done', { text: 'SECOND thing' }, '2026-08-16');
  db.logActivity('task_done', { text: 'THIRD thing' }, '2026-08-16');
  wins.sync({ since: '2026-08-01', until: '2026-08-31' });

  const rows = wins.feed({ dateKey: '2026-08-16' }).wins;
  assert.deepEqual(
    rows.map(r => r.text.split(' ')[0]),
    ['THIRD', 'SECOND', 'FIRST'],
    'newest first, and the order must be the order they actually happened'
  );
});

test('every detected win carries evidence', () => {
  const rows = wins.feed({ dateKey: '2026-08-17' }).wins;
  assert.ok(rows.length > 0);
  for (const r of rows) {
    if (r.source === 'manual') continue; // the one source allowed none
    assert.ok(r.evidence, `${r.kind} has no evidence — that makes it an assertion, which is what the tickbox already was`);
  }
});

test('a manual win is recorded and marked manual, so nothing pretends it was detected', () => {
  wins.logManual('Had the difficult conversation with the vendor', new Date(2026, 7, 17, 15, 0, 0));
  const rows = wins.feed({ dateKey: '2026-08-17' }).wins;
  const manual = rows.find(r => r.source === 'manual');
  assert.ok(manual, 'a win with no artefact still counts — excluding it is its own dishonesty');
  assert.equal(manual.evidence, null);
  assert.equal(wins.logManual('   '), null, 'blank is not a win');
});

test('summary counts today, the week and the all-time total', () => {
  const s = wins.summary(new Date(2026, 7, 17, 16, 0, 0));
  assert.ok(s.doneToday >= 4);
  assert.equal(s.last7.length, 7);
  assert.equal(s.last7[6].date, '2026-08-17', 'today is last in the sparkline');
  assert.ok(s.total >= s.doneToday);
  assert.ok(s.bySource.length > 0, 'the breakdown is what makes the number readable back');
  // The gaps travel with the summary. Any surface showing the count can show
  // what it could not see, which is the difference between a number and a claim.
  assert.ok(s.knownGaps.length >= 2);
  // Meetings USED to be listed here, on a reason that turned out to be wrong —
  // they are a real source now. What remains is gapped for reasons that do
  // hold: no Jira transition signal, and no stored dismissal reason.
  assert.ok(!s.knownGaps.some(g => /^meetings —/.test(g)), 'meetings are sourced now');
  assert.ok(s.knownGaps.some(g => /jira/i.test(g)));
  assert.ok(s.knownGaps.some(g => /vault writes/i.test(g)));
});

test('"this week" is the calendar week, and it resets on a Monday', () => {
  // The bug, exactly: on Monday 31 Aug the widget read "64 finished this week"
  // because the count reached back seven days into the week before.
  const insert = (dateKey, text) => db.run(
    'INSERT OR IGNORE INTO wins (kind, source, date_key, text, count, dedupe_key, occurred_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ['task_done', 'test', dateKey, text, 1, `weekboundary:${dateKey}:${text}`, `${dateKey} 09:00:00`, `${dateKey} 09:00:00`]
  );
  insert('2026-08-27', 'last Thursday');
  insert('2026-08-30', 'the Sunday that ends the old week');
  insert('2026-08-31', 'Monday morning');

  const monday = wins.summary(new Date(2026, 7, 31, 9, 30, 0));
  assert.equal(monday.weekStart, '2026-08-31', 'the week starts on the Monday');
  assert.equal(monday.doneThisWeek, monday.doneToday,
    'on a Monday morning, the week is only what today holds');
  // Negative: the days that would have been swept in by a rolling window.
  assert.ok(monday.doneLast7 > monday.doneThisWeek,
    'the rolling window still sees the week before — it is just not called "this week"');

  // Sunday belongs to the week that is ENDING, not the one about to start.
  const sunday = wins.summary(new Date(2026, 7, 30, 20, 0, 0));
  assert.equal(sunday.weekStart, '2026-08-24');
});

test('the feed paginates newest first', () => {
  const page = wins.feed({ limit: 2, offset: 0 });
  assert.equal(page.wins.length, 2);
  assert.ok(page.total > 2);
  assert.equal(page.hasMore, true);
  const later = new Date(page.wins[0].occurredAt).getTime();
  const earlier = new Date(page.wins[1].occurredAt).getTime();
  assert.ok(later >= earlier, 'newest first — this is the git log half of the feature');
});

test('nonsense pagination falls back to the default rather than the nearest legal value', () => {
  // #69's rule: limit=-5 clamping to 1 returns one row and looks like the truth.
  const page = wins.feed({ limit: -5, offset: -3 });
  assert.ok(page.wins.length > 1);
});

test('1-2-1s that cannot be read are a NAMED gap, not a silent zero', () => {
  // The scratch vault has no Meetings/ or People/, so one-to-one-detect returns
  // ok:false with a reason. That must surface.
  //
  // This is the test that would have caught the real bug: the first cut called
  // getRecent() with no arguments — its signature is getRecent(name, limit) —
  // so it read byPerson[undefined], returned [] and contributed ZERO wins from
  // the day it shipped, reporting that as "no 1-2-1s happened". A source that
  // cannot distinguish "none" from "never asked" is the exact failure this
  // module was built to remove.
  const { gaps, rows } = wins.collect({ since: '2026-08-01', until: '2026-08-31' });
  assert.ok(
    gaps.some(g => /1-2-1s not counted/.test(g)),
    `expected a named 1-2-1 gap, got: ${JSON.stringify(gaps)}`
  );
  assert.ok(!rows.some(r => r.source === 'one-to-one'), 'and no invented 1-2-1 rows');
});

// The meeting source moved to services/meeting-notes-source.js and is covered
// by its own suite. It is driven by PLAUD NOTES now, not by calendar events:
// a meeting in the diary does not mean Nick attended it.

test('the headline states the day, and says nothing at all about zero', () => {
  // Pure — a summary in, a string out. Shared by the tick acknowledgement in
  // SARA and the EOD nudge so the two cannot word it differently.
  assert.equal(wins.headline({ doneToday: 13, typical: 4 }), '13 finished today — double your usual');
  assert.equal(wins.headline({ doneToday: 6, typical: 4 }), '6 finished today — above your usual 4');
  // An ordinary day is stated plainly. Dressing it up is how the line stops
  // being read, and an average day is not a failure that needs softening.
  assert.equal(wins.headline({ doneToday: 4, typical: 4 }), '4 finished today');
  // No baseline yet: state the count, claim no comparison.
  assert.equal(wins.headline({ doneToday: 3, typical: null }), '3 finished today');

  // There is no encouraging version of zero. A cheerful line over an empty
  // count is the register the voice spec rejects, and a quiet day is exactly
  // where an invented win would read as false.
  assert.equal(wins.headline({ doneToday: 0, typical: 4 }), null);
  assert.equal(wins.headline(null), null);
  assert.equal(wins.headline({}), null);
});

test('one standup is one win, however many rows it wrote', () => {
  // Found on the live ledger within an hour of deploying: "Standup done" twice
  // in one afternoon. standup_done is logged from four call sites (three in
  // routes/standup.js, plus nudges.js and standup-session.js) and a single
  // standup routinely writes more than one row. Counting each is how the number
  // stops being true, which is the only property it has.
  db.getDb().prepare('DELETE FROM wins').run();
  db.logActivity('standup_done', { hour: 9 }, '2026-08-15');
  db.logActivity('standup_done', { hour: 9 }, '2026-08-15');
  db.logActivity('eod_done', {}, '2026-08-15');
  wins.sync({ since: '2026-08-01', until: '2026-08-31' });

  const rituals = wins.feed({ dateKey: '2026-08-15' }).wins.filter(w => w.source === 'ritual');
  assert.equal(rituals.length, 2, 'one standup and one EOD, not three rows');
  assert.equal(rituals.filter(r => r.kind === 'standup_done').length, 1);

  // A ritual on a DIFFERENT day is still its own win.
  db.logActivity('standup_done', { hour: 9 }, '2026-08-16');
  wins.sync({ since: '2026-08-01', until: '2026-08-31' });
  assert.equal(wins.feed({ dateKey: '2026-08-16' }).wins.filter(w => w.kind === 'standup_done').length, 1);
});

test('the feed formats local time itself, so no caller has to', () => {
  // /api/wins served `time: undefined` to everything that was not the Today
  // tab, because the conversion lived in adhd-dashboard. And it is a
  // CONVERSION, never a slice of the ISO string — slicing shows BST an hour
  // early, which is the bug every calendar time in NEURO used to have.
  db.getDb().prepare('DELETE FROM wins').run();
  wins.logManual('Something worth remembering', new Date(2026, 7, 15, 14, 37, 0));
  const [win] = wins.feed({ dateKey: '2026-08-15' }).wins;
  assert.equal(win.time, '14:37', 'local wall-clock, not the UTC slice');
});

test('a Microsoft or vault completion is one win however often the box is ticked', () => {
  // The bug: task-store owns ONE of the three things SARA can complete, and it
  // was the only one logging `task_done`. The other two now do — and a vault
  // checkbox can be unticked and ticked again, which keyed on the activity row
  // would read as two finished tasks.
  db.getDb().prepare('DELETE FROM wins').run();
  db.getDb().prepare('DELETE FROM activity_log').run();

  db.logActivity('task_done', { text: 'Succession plan', msId: 'AAMk-123', owner: 'microsoft' }, '2026-08-15');
  db.logActivity('task_done', { text: 'Book the room', filePath: 'Daily/2026-08-15.md', lineNumber: 12, owner: 'vault' }, '2026-08-15');
  db.logActivity('task_done', { text: 'Book the room', filePath: 'Daily/2026-08-15.md', lineNumber: 12, owner: 'vault' }, '2026-08-15');
  wins.sync({ since: '2026-08-01', until: '2026-08-31' });

  const done = wins.feed({ dateKey: '2026-08-15' }).wins.filter(w => w.kind === 'task_done');
  assert.equal(done.length, 2, 'the re-tick folds; the Microsoft one still counts');
  assert.ok(done.some(w => w.text === 'Succession plan'));
});

test("a NEURO task's own completion still keys on the activity row", () => {
  // NEGATIVE. Thousands of task-store rows are already in the ledger under
  // `activity:<id>`. Changing that formula would re-insert every one inside the
  // sync window under a new key — the count silently doubling itself.
  assert.equal(wins._completionKey({ event_type: 'task_done', id: 9 }, { taskId: 12, text: 'x' }), null);
  assert.equal(wins._completionKey({ event_type: 'standup_done', id: 9 }, { msId: 'a' }), null);
  assert.equal(wins._completionKey({ event_type: 'task_done', id: 9 }, { msId: 'a' }), 'task:ms:a');
  assert.equal(
    wins._completionKey({ event_type: 'task_done', id: 9 }, { filePath: 'Daily/x.md', lineNumber: 0 }),
    'task:file:Daily/x.md#0',
    'line 0 is a real line — not falsy-checked away'
  );
});
