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

test('streak skips weekends and does not break on a day still in progress', () => {
  // Mon 17 Aug 2026 as the anchor. Fri 14th and Thu 13th are working days.
  const anchor = new Date(2026, 7, 17, 10, 0, 0);
  const have = new Set(['2026-08-17', '2026-08-14', '2026-08-13']);
  assert.equal(wins.streakFrom(have, anchor), 3, 'the weekend between Fri and Mon must not break it');

  // Today empty is a day in progress, not a broken streak — the count starts
  // at yesterday. Getting this wrong means the streak reads 0 every morning,
  // which is the single most demoralising possible bug in this feature.
  const withoutToday = new Set(['2026-08-14', '2026-08-13']);
  assert.equal(wins.streakFrom(withoutToday, anchor), 2);

  // A genuine gap on a working day does end it.
  assert.equal(wins.streakFrom(new Set(['2026-08-17', '2026-08-13']), anchor), 1);
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
  assert.ok(s.knownGaps.some(g => /meeting/i.test(g)));
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

test('a meeting Nick sat in is a win; an hour he blocked out is not', () => {
  db.getDb().prepare('DELETE FROM wins').run();
  const me = 'nickw@nurtur.tech';
  const now = new Date('2026-08-17T18:00:00Z');
  const ev = (over) => ({
    id: 'e1', subject: 'Support sync', isAllDay: false, isCancelled: false,
    showAs: 'busy', isOrganizer: true,
    start: '2026-08-17T09:00:00Z', end: '2026-08-17T10:00:00Z',
    attendees: [{ email: me }, { email: 'stephen@nurtur.tech' }],
    ...over,
  });

  const res = wins.recordMeetingsHeld([
    ev({}),
    // Half the diary is time blocked out to work alone. Nick's own distinction,
    // measured on 96 real events: 23 of them were this.
    ev({ id: 'e2', subject: 'Deep work', attendees: [{ email: me }] }),
    ev({ id: 'e3', subject: 'Cancelled thing', isCancelled: true }),
    ev({ id: 'e4', subject: 'Marked free', showAs: 'free' }),
    // A diary is a plan until it has happened — the ledger is finished work.
    ev({ id: 'e5', subject: 'Later today', end: '2026-08-17T23:00:00Z' }),
    // An unanswered invite is not a yes. Fails closed, same as plaud.
    ev({ id: 'e6', subject: 'Never responded', isOrganizer: null, responseStatus: null }),
  ], { me, now });

  assert.equal(res.added, 1, 'only the real, finished, accepted meeting counts');
  const rows = wins.feed({ dateKey: '2026-08-17' }).wins;
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /Support sync/);
  assert.equal(rows[0].source, 'meeting');
  assert.ok(rows[0].evidence.startsWith('event:'), 'the calendar event is what proves it');

  // Idempotent: calendar-sync runs every few minutes.
  assert.equal(wins.recordMeetingsHeld([ev({})], { me, now }).added, 0);
});

test('no signed-in address means no meetings counted, not all of them', () => {
  // Fail closed. Without an identity nothing can tell Nick's own attendee entry
  // from anyone else's, so every solo focus block would read as a meeting.
  db.getDb().prepare('DELETE FROM wins').run();
  const res = wins.recordMeetingsHeld([{
    id: 'x', subject: 'Anything', isOrganizer: true, showAs: 'busy',
    start: '2026-08-17T09:00:00Z', end: '2026-08-17T10:00:00Z',
    attendees: [{ email: 'a@b.c' }, { email: 'd@e.f' }],
  }], { me: null, now: new Date('2026-08-17T18:00:00Z') });
  assert.equal(res.added, 0);
  assert.equal(res.skipped, 'identity-unknown');
});

test('the headline states the day, and says nothing at all about zero', () => {
  // Pure — a summary in, a string out. Shared by the tick acknowledgement in
  // SARA and the EOD nudge so the two cannot word it differently.
  assert.equal(wins.headline({ doneToday: 5, streakDays: 4 }), '5 finished today · 4-day streak');
  assert.equal(wins.headline({ doneToday: 1, streakDays: 1 }), '1 finished today',
    'a one-day "streak" is just today, and naming it as a streak is padding');
  assert.equal(wins.headline({ doneToday: 3, streakDays: 0 }), '3 finished today');

  // There is no encouraging version of zero. A cheerful line over an empty
  // count is the register the voice spec rejects, and a quiet day is exactly
  // where an invented win would read as false.
  assert.equal(wins.headline({ doneToday: 0, streakDays: 4 }), null);
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
