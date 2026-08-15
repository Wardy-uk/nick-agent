'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-standup-'));
process.env.NEURO_DB_PATH = path.join(root, 'standup.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const db = require('../db/database');
const session = require('./standup-session');

test.before(async () => { await db.init(); });

function fixture(kind = 'standup') {
  const s = session._emptySession(kind, {
    dateKey: '2026-08-14',
    accountability: {
      openCommitments: [
        { key: 'ship the qa framework', text: 'Ship the QA framework', daysCarried: 5 },
        { key: 'book 1-2-1 with abdi', text: 'Book 1-2-1 with Abdi', daysCarried: 1 },
        { key: 'review sla report', text: 'Review SLA report', daysCarried: 4 },
      ],
    },
    queue: { total: 42, at_risk_count: 3, open_p1s: 1 },
    musts: [],
  });
  return s;
}

test.beforeEach(() => { session.clear('standup', '2026-08-14'); session.clear('eod', '2026-08-14'); });

test('a session survives a restart — the transcript is server-side, not in the browser', () => {
  const s = fixture();
  s.messages.push({ role: 'user', content: 'Ship the QA framework today.' });
  session.save(s);

  // Simulate a fresh process: drop the module cache, reload against the same DB.
  delete require.cache[require.resolve('./standup-session')];
  const reloaded = require('./standup-session');

  const resumed = reloaded.load('standup', '2026-08-14');
  assert.ok(resumed, 'session should survive');
  assert.equal(resumed.messages.at(-1).content, 'Ship the QA framework today.');
});

test('resolving a commitment records the decision on the session', async () => {
  const s = fixture();
  await session.executeTool(s, 'resolve_commitment', { key: 'ship the qa framework', decision: 'today' });
  assert.equal(s.outcome.commitments.length, 1);
  assert.equal(s.outcome.commitments[0].decision, 'today');
});

test('re-resolving the same commitment replaces rather than stacks', async () => {
  const s = fixture();
  await session.executeTool(s, 'resolve_commitment', { key: 'ship the qa framework', decision: 'carry' });
  await session.executeTool(s, 'resolve_commitment', { key: 'ship the qa framework', decision: 'dropped' });
  assert.equal(s.outcome.commitments.length, 1);
  assert.equal(s.outcome.commitments[0].decision, 'dropped');
});

test('"scheduled" creates a real dated task — otherwise it is a carry in disguise', async () => {
  const s = fixture();
  await session.executeTool(s, 'resolve_commitment', {
    key: 'review sla report',
    decision: 'scheduled',
    due_date: '2026-08-20',
    note: 'Review SLA report',
  });
  const created = require('./task-store').listTasks({ status: 'all', includeDone: true })
    .find(t => t.text === 'Review SLA report');
  assert.ok(created, 'a scheduled commitment must become a dated task');
  assert.equal(created.due_date, '2026-08-20');
});

test('set_focus marks the session ready to write', async () => {
  const s = fixture();
  const result = await session.executeTool(s, 'set_focus', {
    items: ['Ship QA framework v1', 'Reply to the Abdi escalation'],
    blockers: 'Waiting on Engineering',
  });
  assert.equal(result.ok, true);
  assert.equal(s.state, 'ready');
  assert.equal(s.outcome.focus.length, 2);
});

test('set_focus refuses an empty commitment list', async () => {
  const s = fixture();
  const result = await session.executeTool(s, 'set_focus', { items: [] });
  assert.equal(result.ok, false);
  assert.notEqual(s.state, 'ready');
});

test('the daily note keeps the headings accountability parses back tomorrow', async () => {
  const s = fixture();
  await session.executeTool(s, 'resolve_commitment', { key: 'ship the qa framework', decision: 'today' });
  await session.executeTool(s, 'resolve_commitment', { key: 'review sla report', decision: 'dropped' });
  await session.executeTool(s, 'set_focus', { items: ['Reply to the Abdi escalation'], blockers: 'None' });

  const note = session._renderDailyNote(s);

  // The contract with standup-accountability.parseDailyNote().
  assert.match(note, /^## Focus Today$/m);
  assert.match(note, /^## Carry-Overs$/m);
  assert.match(note, /type: daily/);

  // Committed carry-over is promoted into Focus with its age preserved.
  assert.match(note, /- \[ \] Ship the QA framework #focus #carried-5d/);
  // Dropped is recorded explicitly so it stops rolling forward silently.
  assert.match(note, /~~Review SLA report~~/);
  // Undecided still carries.
  assert.match(note, /- \[ \] Book 1-2-1 with Abdi #carried-1d/);
  // Queue context comes from the snapshot taken at session start.
  assert.match(note, /42 open tickets, 3 at risk, 1 P1s/);
});

test('an EOD section records what landed and what did not', async () => {
  const s = fixture('eod');
  await session.executeTool(s, 'set_eod_summary', {
    done: ['Shipped QA framework v1'],
    didnt_go: 'Never got to the SLA report',
    tomorrow_first: 'Finish the SLA report',
    mood: 'drained but fine',
  });

  const out = session._renderEodSection(s);
  assert.match(out, /^## EOD$/m);
  assert.match(out, /Shipped QA framework v1/);
  assert.match(out, /\*\*Didn't go to plan:\*\* Never got to the SLA report/);

  // "Tomorrow starts with" has to become a real task or it evaporates overnight.
  const task = require('./task-store').listTasks({ status: 'all', includeDone: true })
    .find(t => t.text === 'Finish the SLA report');
  assert.ok(task, 'tomorrow\'s first thing must be captured as a task');
});

test('finishing writes the note and closes the session', () => {
  const s = fixture();
  s.outcome.focus = ['Reply to the Abdi escalation'];
  s.state = 'ready';
  session.save(s);

  // Explicit date, like every other call in this file. Without it finish()
  // resolved today internally and this passed only on 14 Aug itself.
  const result = session.finish('standup', '2026-08-14');
  assert.equal(result.ok, true);
  assert.equal(session.load('standup', '2026-08-14').state, 'finished');
  assert.match(require('./obsidian').readTodayDailyNote() || '', /Reply to the Abdi escalation/);
});

test('the context tells the model to chase carried work, with the keys to do it', () => {
  const rendered = session._renderContext(fixture().context);
  assert.match(rendered, /CARRIED/);
  assert.match(rendered, /carried 5 days/);
  assert.match(rendered, /key: ship the qa framework/);
});

test('the schedule knows Nick works Monday to Friday', () => {
  // Friday: tomorrow is Saturday, so the next working day is Monday.
  const fri = session.buildSchedule(new Date(2026, 7, 14, 18, 0));
  assert.equal(fri.today.name, 'Friday');
  assert.equal(fri.tomorrow.name, 'Saturday');
  assert.equal(fri.tomorrow.working, false);
  assert.deepEqual(fri.nextWorkingDay, { name: 'Monday', date: '2026-08-17' });

  // Midweek: tomorrow IS the next working day.
  const tue = session.buildSchedule(new Date(2026, 7, 11, 9, 0));
  assert.equal(tue.tomorrow.working, true);
  assert.equal(tue.nextWorkingDay.date, '2026-08-12');

  // Saturday itself is not a working day, and Sunday is not the answer.
  const sat = session.buildSchedule(new Date(2026, 7, 15, 10, 0));
  assert.equal(sat.today.working, false);
  assert.equal(sat.nextWorkingDay.date, '2026-08-17');
});

test('a Friday session is told not to say "tomorrow"', () => {
  const rendered = session._renderSchedule(session.buildSchedule(new Date(2026, 7, 14, 18, 0)));
  assert.match(rendered, /TODAY: Friday 2026-08-14/);
  assert.match(rendered, /NOT a working day/);
  assert.match(rendered, /next working day is Monday 2026-08-17/);

  // Midweek must NOT carry the weekend warning, or it reads as noise every day.
  const midweek = session._renderSchedule(session.buildSchedule(new Date(2026, 7, 11, 9, 0)));
  assert.doesNotMatch(midweek, /NOT a working day/);
});

test('every session context leads with the day, not just the date', () => {
  const rendered = session._renderContext(fixture().context);
  assert.match(rendered.split('\n')[0], /^TODAY: (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d{4}-\d{2}-\d{2}/);
});
