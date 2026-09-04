'use strict';

// What yesterday actually came to, and whether the standup can see it.
//
// Three separate blindnesses, all of which let SARA chase a commitment Nick had
// closed and told her about at EOD the night before:
//   1. the EOD **Done:** bullets were written into the daily note and parsed by
//      nothing, so the only durable record of that conversation was discarded
//      (the session itself lives in agent_state under its own date and is never
//      loaded again);
//   2. _renderContext read acc.yesterday.focus, a key that object has never
//      carried, so every standup opened with "committed to 0 things, 0 done"
//      however full the note was;
//   3. nothing read completions at all — the task context is the OPEN pool, so
//      a task closed yesterday leaves it and leaves no trace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-yesterday-'));
process.env.NEURO_DB_PATH = path.join(root, 'yesterday.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Daily'), { recursive: true });

const acc = require('./standup-accountability');
const session = require('./standup-session');

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeDay(offsetDays, body) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const ds = dateStr(d);
  fs.writeFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Daily', `${ds}.md`), body);
  return ds;
}

// Exactly the shape _renderEodSection writes, so the two halves cannot drift.
const NOTE = [
  '## Focus Today',
  '- [ ] Productivity metrics for Naomi',
  '- [x] Sign the risk assessment',
  '',
  '## EOD',
  '',
  '**Done:**',
  '- Productivity metrics for Naomi',
  '- Sign the risk assessment',
  "**Didn't go to plan:** Ran out of afternoon",
  '**Tomorrow starts with:** Escalation review',
  '**Mood:** fine',
].join('\n');

test('the EOD Done bullets are read back — they are the only record of that conversation', () => {
  const parsed = acc.parseDailyNote(NOTE);
  assert.deepEqual(
    parsed.eodItems.map(i => i.text),
    ['Productivity metrics for Naomi', 'Sign the risk assessment']
  );

  // Negative: the lines AFTER the list are not work he finished. Reading
  // "Tomorrow starts with" back as done would invent a completion out of a plan.
  const texts = parsed.eodItems.map(i => i.text.toLowerCase()).join(' ');
  assert.ok(!texts.includes('escalation review'), 'tomorrow-first was read as finished work');
  assert.ok(!texts.includes('fine'), 'mood was read as finished work');

  // And the line that was already parsed still is.
  assert.equal(parsed.didntGo, 'Ran out of afternoon');
});

test('yesterday carries the items themselves, not just a count', () => {
  const ds = writeDay(-1, NOTE);
  const a = acc.buildAccountability();
  assert.equal(a.yesterday.date, ds);
  assert.equal(a.yesterday.committed, 2);
  assert.equal(a.yesterday.done, 1);
  assert.deepEqual(
    a.yesterday.items.map(i => i.text),
    ['Productivity metrics for Naomi', 'Sign the risk assessment']
  );
  assert.deepEqual(a.yesterday.items.map(i => i.done), [false, true]);
  assert.deepEqual(a.yesterday.eodItems, ['Productivity metrics for Naomi', 'Sign the risk assessment']);
});

test('a commitment reported done at EOD is STAMPED, never folded away', () => {
  const ds = writeDay(-1, NOTE);
  const a = acc.buildAccountability();
  const open = a.openCommitments.find(c => /productivity metrics/i.test(c.text));

  // Still carried: an unticked box is the record, and his own account of the day
  // is evidence rather than a tick. Folding it away would close work on prose.
  assert.ok(open, 'the unticked commitment stopped being carried');
  assert.equal(open.reportedDoneOn, ds);
});

test('a commitment no EOD mentioned carries no claim about it', () => {
  writeDay(-1, NOTE);
  writeDay(-2, ['## Focus Today', '- [ ] Rewrite the escalation matrix'].join('\n'));
  const a = acc.buildAccountability();
  const other = a.openCommitments.find(c => /escalation matrix/i.test(c.text));
  assert.equal(other.reportedDoneOn, null);
});

test('the context states what yesterday actually held', () => {
  const rendered = session._renderContext({
    dateKey: '2026-09-04',
    accountability: {
      yesterday: {
        date: '2026-09-03',
        committed: 2,
        done: 1,
        items: [
          { text: 'Productivity metrics for Naomi', done: false },
          { text: 'Sign the risk assessment', done: true },
        ],
        eodItems: ['Productivity metrics for Naomi'],
        eodDone: true,
      },
    },
  });

  assert.match(rendered, /committed to 2 things, 1 ticked off/);
  // The regression itself: the counts were computed correctly and then not used.
  assert.ok(!/committed to 0 things/.test(rendered), 'yesterday rendered empty again');
  assert.match(rendered, /\[ \] Productivity metrics for Naomi/);
  assert.match(rendered, /\[x\] Sign the risk assessment/);
  assert.match(rendered, /At EOD he said these were done/);
});

test('an EOD that listed nothing is not the same as no EOD at all', () => {
  const withEod = session._renderContext({
    dateKey: '2026-09-04',
    accountability: { yesterday: { date: '2026-09-03', committed: 1, done: 0, items: [], eodItems: [], eodDone: true } },
  });
  const without = session._renderContext({
    dateKey: '2026-09-04',
    accountability: { yesterday: { date: '2026-09-03', committed: 1, done: 0, items: [], eodItems: [], eodDone: false } },
  });
  assert.match(withEod, /did an EOD but listed nothing/);
  assert.match(without, /No EOD was done/);
});

test('finished work is stated as DONE, from the ledger rather than a checkbox', () => {
  const rendered = session._renderContext({
    dateKey: '2026-09-04',
    closed: {
      known: true,
      date: '2026-09-03',
      items: [{ text: 'Productivity metrics for Naomi', source: 'task' }],
    },
  });
  assert.match(rendered, /FINISHED ON 2026-09-03/);
  assert.match(rendered, /Productivity metrics for Naomi \[task\]/);
  assert.match(rendered, /do NOT chase it/);
});

test('a ledger it could not read is a named gap, never an empty finished list', () => {
  const rendered = session._renderContext({
    dateKey: '2026-09-04',
    closed: { known: false, date: null, reason: 'db locked' },
  });
  assert.match(rendered, /could not be read/);
  // "Nothing was finished" and "I could not look" license opposite things to
  // say, so the honest version must never render as the first.
  assert.ok(!/nothing was recorded as finished/.test(rendered), 'an unreadable ledger read as an empty one');
});

test('a day with nothing recorded says so, and says it differently', () => {
  const rendered = session._renderContext({
    dateKey: '2026-09-04',
    closed: { known: true, date: '2026-09-03', items: [] },
  });
  assert.match(rendered, /nothing was recorded as finished/);
});

test('a capped list says what it dropped — a truncated day reads as the whole of it', () => {
  const rendered = session._renderContext({
    dateKey: '2026-09-04',
    closed: {
      known: true,
      date: '2026-09-03',
      total: 19,
      items: [{ text: 'Productivity metrics for Naomi', source: 'task' }],
    },
  });
  assert.match(rendered, /18 more not listed/);
});

test('rituals are not finished work — the standup already says whether one happened', () => {
  // Guards the gather, not the render: "Standup done" and "End of day done" are
  // wins, and on the first live run the pair of them took two of the twelve
  // slots off real commitments.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'standup-session.js'), 'utf8');
  assert.match(src, /w\.source !== 'ritual'/);
  assert.match(src, /w\.source !== 'git'/);
});
