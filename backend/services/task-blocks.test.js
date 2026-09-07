'use strict';

/**
 * Task blocks — pushing a task into the calendar, and the write-up that closes
 * it (18 Aug 2026).
 *
 * The property worth defending above all others: **NEURO writes the stub, so a
 * detector that merely finds the file would create the evidence for its own
 * test.** That is the whole feature failing silently — the task marked done, in
 * the one screen Nick uses to find what he owes, with nothing written. The first
 * test in this file is that one, and it is the reason the rest exist.
 *
 * Everything pinned here is pure: no DB, no vault, no network, no clock beyond
 * the one it is handed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-blocks-')), 'a.db');

const {
  isOutcomeWritten, renderStub, outcomeNotePath, slugify, findSlot, resolveWindow,
  HUB_OPEN, HUB_CLOSE, OUTCOME_HUB,
  renderChecklist, parseChecklist, syncChecklistInNote, LIST_OPEN, LIST_CLOSE,
  MIN_OUTCOME_CHARS, DAY_START_MIN, DAY_END_MIN, SEARCH_DAYS, latestEndFor, blockSubject, liveBlock,
} = require('./task-blocks');

const TASK = { id: 58, text: 'Build succession plan — cover for HoTS and emerging team leads' };
const BLOCK = { date_key: '2026-08-19', start_time: '14:00', end_time: '15:00', minutes: 60 };

// A batch: several short jobs in one window.
const BATCH = [
  { id: 61, text: 'Approve the Sandford refund' },
  { id: 62, text: 'Reply to Chris about headcount' },
  { id: 63, text: 'File the FOC report' },
];

// ── The stub must not release the task ───────────────────────────────────────

test('the stub NEURO wrote does not count as a write-up', () => {
  const verdict = isOutcomeWritten(renderStub(TASK, BLOCK));
  assert.equal(verdict.written, false,
    'a freshly written stub read as a completed write-up — the feature would mark work done with nothing in it');
  assert.equal(verdict.chars, 0, 'nothing in the stub is content: it is all frontmatter, headings and marked template');
});

test('a real summary under the headings releases it', () => {
  const raw = renderStub(TASK, BLOCK).replace(
    '## What came of it\n',
    '## What came of it\nDrafted the cover matrix for both team leads. Chris still owes me the 2nd-line gap.\n'
  );
  assert.equal(isOutcomeWritten(raw).written, true);
});

test('a heading with nothing under it is not a write-up', () => {
  const raw = renderStub(TASK, BLOCK) + '\n## Another heading\n### And a sub-heading\n';
  assert.equal(isOutcomeWritten(raw).written, false, 'headings are scaffolding, not content');
});

test('one word does not clear the bar, and the reason says so', () => {
  const raw = renderStub(TASK, BLOCK).replace('## What came of it\n', '## What came of it\ndone\n');
  const verdict = isOutcomeWritten(raw);
  assert.equal(verdict.written, false);
  assert.match(verdict.reason, /characters/);
  assert.ok(verdict.chars > 0 && verdict.chars < MIN_OUTCOME_CHARS);
});

test('an empty bullet list is not a write-up', () => {
  const raw = renderStub(TASK, BLOCK) + '\n- \n- \n- [ ] \n';
  assert.equal(isOutcomeWritten(raw).written, false);
});

test('a missing note is not written, and says which', () => {
  assert.equal(isOutcomeWritten(null).written, false);
  assert.equal(isOutcomeWritten(null).reason, 'no note');
  assert.equal(isOutcomeWritten('').reason, 'stub is empty');
});

test('CRLF is normalised before anything is matched', () => {
  // `\r` is a JS line terminator, so an anchored regex silently fails on every
  // line of a Windows-authored note — the vault is full of them, and both
  // meeting-notes-source and one-to-one-detect were bitten by exactly this.
  const written = renderStub(TASK, BLOCK).replace(
    '## What came of it\n',
    '## What came of it\nGot the whole cover matrix down and sent it to Chris for review.\n'
  );
  assert.equal(isOutcomeWritten(written.replace(/\n/g, '\r\n')).written, true);
  assert.equal(isOutcomeWritten(renderStub(TASK, BLOCK).replace(/\n/g, '\r\n')).written, false);
});

test("Nick's own blockquote counts — only the marked template is stripped", () => {
  // The reason the stub is fenced with markers rather than the template being
  // recognised by shape: quoting an email in a write-up is a write-up.
  const raw = renderStub(TASK, BLOCK).replace(
    '## What came of it\n',
    '## What came of it\n> Chris: "leave the 2nd-line gap with me until Friday" — so it is parked.\n'
  );
  assert.equal(isOutcomeWritten(raw).written, true);
});

test('the stub carries the task id, so a renamed note is still findable', () => {
  assert.match(renderStub(TASK, BLOCK), /^task_id: 58$/m);
});

// ── Paths ────────────────────────────────────────────────────────────────────

test('the note path is dated, foldered by year and month, and safe on Windows', () => {
  const p = outcomeNotePath({ text: 'Fix NT-14855: SLA/reporting? *urgent*' }, '2026-08-19');
  assert.match(p, /^Tasks\/Outcomes\/2026\/08\/2026-08-19 /);
  assert.equal(/[\\:*?"<>|]/.test(p.split('/').pop()), false, 'a character Windows refuses would make the write fail');
});

test('a very long task still yields a usable filename', () => {
  const slug = slugify('x'.repeat(400));
  assert.ok(slug.length <= 60);
});

test('a task whose text is entirely punctuation still gets a name', () => {
  assert.equal(slugify('***'), 'task', 'an empty filename would throw at write time');
});

// ── Finding a slot ───────────────────────────────────────────────────────────

// Wed 19 Aug 2026 is a plain working day.
const at = (day, hh, mm) => new Date(2026, 7, day, hh, mm, 0, 0);
const ev = (day, from, to, over = {}) => ({
  date: `2026-08-${String(day).padStart(2, '0')}`,
  start: `2026-08-${String(day).padStart(2, '0')}T${from}:00`,
  end: `2026-08-${String(day).padStart(2, '0')}T${to}:00`,
  subject: 'Something', isAllDay: false, showAs: 'busy', ...over,
});

test('an empty diary gives the first slot of the working day', () => {
  const slot = findSlot({ minutes: 60, events: [], now: at(19, 7, 0) });
  assert.equal(slot.date, '2026-08-19');
  assert.equal(slot.startTime, '09:00');
  assert.equal(slot.endTime, '10:00');
});

test('mid-morning, the slot starts from now — not from the top of the day', () => {
  const slot = findSlot({ minutes: 30, events: [], now: at(19, 11, 3) });
  // 11:03 + 10 minutes lead, rounded up to the next five.
  assert.equal(slot.startTime, '11:15');
});

test('a meeting is a wall, and the block lands after it', () => {
  const slot = findSlot({ minutes: 60, events: [ev(19, '09:00', '12:00')], now: at(19, 7, 0) });
  assert.equal(slot.startTime, '12:00');
});

test('a gap too small for the task plus its buffer is skipped', () => {
  // 09:00-10:00 free is 60 minutes, and a 60-minute task needs 65 with the
  // buffer. Taking it would have Nick walk into the 10:00 with the task still
  // open — the exact failure BUFFER_MINUTES exists to prevent.
  const slot = findSlot({
    minutes: 60,
    events: [ev(19, '10:00', '11:00'), ev(19, '11:00', '12:00')],
    now: at(19, 7, 0),
  });
  assert.equal(slot.startTime, '12:00');
});

test('free and cancelled events are not walls; tentative ones are', () => {
  const free = findSlot({ minutes: 30, events: [ev(19, '09:00', '10:00', { showAs: 'free' })], now: at(19, 7, 0) });
  assert.equal(free.startTime, '09:00');
  const cancelled = findSlot({ minutes: 30, events: [ev(19, '09:00', '10:00', { showAs: 'cancelled' })], now: at(19, 7, 0) });
  assert.equal(cancelled.startTime, '09:00');
  const tentative = findSlot({ minutes: 30, events: [ev(19, '09:00', '10:00', { showAs: 'tentative' })], now: at(19, 7, 0) });
  assert.equal(tentative.startTime, '10:00');
});

test('an all-day marker does not block the day', () => {
  const slot = findSlot({ minutes: 30, events: [ev(19, '00:00', '00:00', { isAllDay: true })], now: at(19, 7, 0) });
  assert.equal(slot.startTime, '09:00');
});

test('a full day rolls to the next one', () => {
  const slot = findSlot({ minutes: 60, events: [ev(19, '09:00', '18:00')], now: at(19, 7, 0) });
  assert.equal(slot.date, '2026-08-20');
  assert.equal(slot.startTime, '09:00');
});

test('nothing is ever scheduled to finish after the working day ends', () => {
  const slot = findSlot({ minutes: 120, events: [ev(19, '09:00', '16:00')], now: at(19, 7, 0) });
  // 16:00 + 2h would end at 18:00, past 17:30 — so it must not be offered today.
  assert.notEqual(slot.date, '2026-08-19');
});

test('a weekend is skipped', () => {
  // Sat 22 Aug 2026.
  const slot = findSlot({ minutes: 30, events: [], now: at(22, 9, 0) });
  assert.equal(slot.date, '2026-08-24', 'Monday');
});

test('a bank holiday is skipped, because the set says so', () => {
  // Mon 31 Aug 2026 is the summer bank holiday — the one that sat inside the
  // live 1-2-1 booking window when #25 was found.
  const slot = findSlot({
    minutes: 30, events: [], now: at(31, 8, 0), nonWorking: new Set(['2026-08-31']),
  });
  assert.equal(slot.date, '2026-09-01');
});

test('no room gives a reason, never a silent null', () => {
  // Every day in the search window solid. Built from real Dates rather than by
  // adding to the day-of-month, or the fixture rolls off the end of August into
  // dates that match nothing and the test passes for the wrong reason.
  const events = [];
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const d = new Date(2026, 7, 19 + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    events.push({
      date: key, start: `${key}T09:00:00`, end: `${key}T18:00:00`,
      subject: 'Solid', isAllDay: false, showAs: 'busy',
    });
  }
  const slot = findSlot({ minutes: 60, events, now: at(19, 7, 0) });
  assert.equal(slot.date, undefined);
  assert.match(slot.reason, /no 60-minute gap/);
});

test('a zero or missing duration is refused rather than booked', () => {
  assert.match(findSlot({ minutes: 0, events: [], now: at(19, 9, 0) }).reason, /no duration/);
  assert.match(findSlot({ events: [], now: at(19, 9, 0) }).reason, /no duration/);
});

test('the working window is the whole day, not the 1-2-1 windows', () => {
  // one-to-one-booking's 10:00-12:00 / 14:00-16:30 pair is a rule about meetings
  // with other people in them. Applying it here would refuse most of the day.
  assert.equal(DAY_START_MIN, 9 * 60);
  assert.equal(DAY_END_MIN, 17 * 60 + 30);
});

// ── Batching: several tasks in one window ────────────────────────────────────

test('a batch stub does not count as a write-up either', () => {
  // The trap this pins: the checklist of task names is real text sitting in the
  // note. Unfenced, it would read as prose and release every batch the instant
  // it was created — the empty-stub bug again, wearing a different hat.
  const verdict = isOutcomeWritten(renderStub(BATCH, BLOCK));
  assert.equal(verdict.written, false,
    'the batch checklist read as a write-up — every batch would complete on creation');
  assert.equal(verdict.chars, 0);
});

test('ticking every box is still not a summary', () => {
  const raw = renderStub(BATCH, BLOCK).replace(/- \[ \]/g, '- [x]');
  assert.equal(isOutcomeWritten(raw).written, false,
    'a checklist records what was in the window; it does not say what came of it');
});

test('a batch releases on prose, same as a single task', () => {
  const raw = renderStub(BATCH, BLOCK).replace(
    '## What came of it\n',
    '## What came of it\nCleared the refund and the FOC report. Headcount reply still needs Chris.\n'
  );
  assert.equal(isOutcomeWritten(raw).written, true);
});

test('the batch checklist survives into the finished note', () => {
  // Fenced separately from the stub precisely so it is not scaffolding: three
  // weeks later, "what did I get through in that half hour" is the question and
  // the task names are the answer.
  const raw = renderStub(BATCH, BLOCK);
  for (const t of BATCH) assert.ok(raw.includes(t.text), `${t.text} missing from the note`);
});

test('a batch stub carries every task id', () => {
  assert.match(renderStub(BATCH, BLOCK), /^task_ids: \[61, 62, 63\]$/m);
});

test('a single-task stub carries both id forms, so older notes still resolve', () => {
  const raw = renderStub(TASK, BLOCK);
  assert.match(raw, /^task_ids: \[58\]$/m);
  assert.match(raw, /^task_id: 58$/m);
});

test('a batch note is named for the sitting, not for whichever task was first', () => {
  const p = outcomeNotePath(BATCH, '2026-08-19', '14:00');
  assert.match(p, /2026-08-19 Focus block 1400 \(3 tasks\)\.md$/);
  assert.ok(!p.includes('Sandford'), 'naming it after one of three buries the other two');
});

test('two batches on one day do not collide on a filename', () => {
  assert.notEqual(
    outcomeNotePath(BATCH, '2026-08-19', '09:00'),
    outcomeNotePath(BATCH, '2026-08-19', '14:00')
  );
});

test('an unclosed fence fails towards "not written"', () => {
  // A truncated or hand-mangled note must not read as complete. Failing the
  // safe way means Nick is asked again, not that a task closes on nothing.
  const raw = renderStub(TASK, BLOCK).replace('<!-- /neuro:task-outcome-stub -->', '');
  assert.equal(isOutcomeWritten(raw).written, false);
});

// ── How long the window is ───────────────────────────────────────────────────

test('an explicit duration wins and is never snapped to a bucket', () => {
  // The block is a real window in a real diary. A 45-minute request that
  // silently became an hour is the feature disagreeing with Nick in his own
  // calendar. Buckets are for the estimate written back onto the task.
  const w = resolveWindow([{ estimate_minutes: 15 }], 45);
  assert.equal(w.minutes, 45);
  assert.equal(w.assumed, false);
  assert.equal(w.basis, 'requested');
});

test('with every task estimated, the window is their sum and is not a guess', () => {
  const w = resolveWindow([{ estimate_minutes: 5 }, { estimate_minutes: 15 }, { estimate_minutes: 5 }], null);
  assert.equal(w.minutes, 25);
  assert.equal(w.assumed, false);
  assert.equal(w.basis, 'estimates');
});

test('a partly estimated batch is ASSUMED, not a sum', () => {
  // Filling the gaps with the assumption and presenting the total as a sum
  // launders a guess into a measurement — the one thing #87 rules out.
  const w = resolveWindow([{ estimate_minutes: 5 }, { estimate_minutes: null }], null);
  assert.equal(w.assumed, true);
  assert.equal(w.basis, 'assumed');
});

test('nothing estimated falls back to the assumption and says so', () => {
  const w = resolveWindow([{ estimate_minutes: null }], null);
  assert.equal(w.minutes, 30);
  assert.equal(w.assumed, true);
});

test('a zero or negative request is ignored rather than obeyed', () => {
  assert.equal(resolveWindow([{ estimate_minutes: 15 }], 0).basis, 'estimates');
  assert.equal(resolveWindow([{ estimate_minutes: 15 }], -10).basis, 'estimates');
});

// ── The checklist boxes are the ticks ────────────────────────────────────────

test('the checklist reflects what has been ticked, not always empty', () => {
  // A blank checklist beside a card showing three ticked is two screens
  // disagreeing about the same fact — and the one being typed into looks wrong.
  const lines = renderChecklist([
    { id: 61, text: 'Done one', awaiting: true },
    { id: 62, text: 'Not done', awaiting: false },
  ]);
  assert.ok(lines.some(l => l.startsWith('- [x] Done one')));
  assert.ok(lines.some(l => l.startsWith('- [ ] Not done')));
});

test('each line carries its task id, so a tick cannot land on the wrong task', () => {
  const raw = renderChecklist([{ id: 61, text: 'Something', awaiting: false }]).join('\n');
  assert.match(raw, /<!--t:61-->/);
});

test('the boxes read back exactly, ticked and unticked', () => {
  const raw = renderChecklist([
    { id: 61, text: 'Ticked', awaiting: true },
    { id: 62, text: 'Untouched', awaiting: false },
  ]).join('\n');
  const ticks = parseChecklist(raw);
  assert.equal(ticks.get(61), true);
  assert.equal(ticks.get(62), false);
});

test('a line without its id comment is ignored rather than guessed at', () => {
  // A wrong guess here completes the wrong task, which is the failure mode this
  // whole feature keeps running into.
  const raw = [LIST_OPEN, '- [x] Reworded past recognition', LIST_CLOSE].join('\n');
  assert.equal(parseChecklist(raw).size, 0);
});

test('nothing outside the fence is read as a tick', () => {
  const raw = ['- [x] A checklist Nick wrote himself <!--t:99-->', LIST_OPEN, LIST_CLOSE].join('\n');
  assert.equal(parseChecklist(raw).size, 0, 'only the block checklist decides which tasks are ticked');
});

test('syncing the checklist leaves the rest of the note untouched', () => {
  // Surgical, following vault-hygiene: the note may already hold the write-up,
  // and regenerating it wholesale to fix some checkboxes would throw that away.
  const original = renderStub(BATCH, BLOCK).replace(
    '## What came of it\n',
    '## What came of it\nCleared two of the three; the refund needs Maria.\n'
  );
  const synced = syncChecklistInNote(original, BATCH.map((t, i) => ({ ...t, awaiting: i === 0 })));

  assert.ok(synced.includes('Cleared two of the three; the refund needs Maria.'), 'the write-up was lost');
  assert.match(synced, /- \[x\] Approve the Sandford refund/);
  assert.match(synced, /- \[ \] File the FOC report/);
  assert.equal(isOutcomeWritten(synced).written, true);
});

test('a ticked checklist still does not count as a write-up', () => {
  const all = syncChecklistInNote(renderStub(BATCH, BLOCK), BATCH.map(t => ({ ...t, awaiting: true })));
  assert.equal(isOutcomeWritten(all).written, false,
    'ticking boxes records what was done, it does not say what came of it');
});

// ---------------------------------------------------------------------------
// Lengthening a block — the diary decides how far
// ---------------------------------------------------------------------------

const EXT_BLOCK = { id: 7, date_key: '2026-09-10', start_time: '10:00', end_time: '10:30' };
const extEv = (start, end, over = {}) => ({
  date: '2026-09-10', start: `2026-09-10T${start}:00`, end: `2026-09-10T${end}:00`,
  subject: 'Standup', isAllDay: false, showAs: 'busy', ...over,
});

test('an empty diary lets a block run to the end of the working day', () => {
  const r = latestEndFor(EXT_BLOCK, []);
  assert.equal(r.known, true);
  assert.equal(r.latestEndMin, DAY_END_MIN);
  assert.equal(r.blockedBy, null);
});

test('the next meeting caps it, with a buffer, and is NAMED', () => {
  const r = latestEndFor(EXT_BLOCK, [extEv('12:00', '12:30', { subject: '1-2-1 with Hope' })]);
  // Below 12:00 by the buffer time-fit already uses — borrowed, not re-picked.
  assert.ok(r.latestEndMin < 12 * 60);
  assert.equal(r.blockedBy, '1-2-1 with Hope');
});

test('an unreadable diary caps NOTHING and says so — never a free afternoon', () => {
  // ⚠ The whole point. A null limit read as "no wall" would lengthen a real
  // event straight over a meeting nobody could see.
  const r = latestEndFor(EXT_BLOCK, [], { known: false });
  assert.equal(r.known, false);
  assert.equal(r.latestEndMin, null);
  assert.match(r.reason, /could not be read/);
});

test("free, cancelled and all-day events are not walls — findSlot's own rule", () => {
  // Two answers about what counts as busy is how the search that PLACED a block
  // and the extension that lengthens it come to disagree about one diary.
  for (const over of [{ showAs: 'free' }, { showAs: 'cancelled' }, { isAllDay: true }]) {
    const r = latestEndFor(EXT_BLOCK, [extEv('11:00', '11:30', over)]);
    assert.equal(r.latestEndMin, DAY_END_MIN, JSON.stringify(over));
  }
  // A tentative one IS a wall, same rule.
  assert.ok(latestEndFor(EXT_BLOCK, [extEv('11:00', '11:30', { showAs: 'tentative' })]).latestEndMin < 11 * 60);
});

test('a block cannot be capped by itself, or by anything behind it', () => {
  // readCalendar folds NEURO's own blocks in as events, so this block is in the
  // very list it is being measured against.
  const self = extEv('10:00', '10:30', { subject: 'NEURO focus block' });
  const earlier = extEv('09:00', '09:30');
  const r = latestEndFor(EXT_BLOCK, [self, earlier]);
  assert.equal(r.latestEndMin, DAY_END_MIN);
});

test("another day is not this block's wall", () => {
  const r = latestEndFor(EXT_BLOCK, [
    extEv('11:00', '11:30', { date: '2026-09-11', start: '2026-09-11T11:00:00' }),
  ]);
  assert.equal(r.latestEndMin, DAY_END_MIN);
});

// ── The calendar subject ─────────────────────────────────────────────────────
//
// Three things in this estate were called "focus" and none showed the others:
// Nick's own recurring `Focus time` blocks, NEURO's task blocks, and the in-app
// focus session. He blocked time for weekly-risk prep, went looking for the
// session, found a "Focus" event and concluded NEURO had lost it. Nothing had.

test('a block is a Task block, never a Focus anything', () => {
  const one = blockSubject([{ text: 'Write the weekly risk summary' }]);
  const many = blockSubject([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);

  assert.equal(one, 'Task block: Write the weekly risk summary');
  assert.equal(many, 'Task block: 3 tasks');

  // The word is given up entirely: this subject lands in a shared work calendar
  // beside Nick's own "Focus time" blocks, and colleagues read it.
  for (const s of [one, many]) {
    assert.ok(!/focus/i.test(s), `must not say "focus": ${s}`);
  }
});

test('the subject is bounded, because Graph truncates and a task can be a paragraph', () => {
  const long = blockSubject([{ text: 'x'.repeat(500) }]);
  assert.ok(long.length <= 200);
});

test('an empty or malformed list still produces a usable subject', () => {
  assert.equal(blockSubject([]), 'Task block: 0 tasks');
  assert.equal(blockSubject([{}]), 'Task block: a task');
  assert.equal(blockSubject(null), 'Task block: 0 tasks');
});

// ── The live block ───────────────────────────────────────────────────────────
//
// A task block put time in the diary and a focus session tracked the doing, and
// nothing connected them: Nick blocked an hour for weekly-risk prep, arrived at
// it, and NEURO had no idea the two were related.

const AT = (h, m = 0) => new Date(2026, 8, 7, h, m); // 7 Sep 2026, local
const TODAY = '2026-09-07';

const blockRow = (over = {}) => ({
  blockId: 1,
  status: 'scheduled',
  passed: false,
  dateKey: TODAY,
  startTime: '15:00',
  endTime: '16:00',
  minutes: 60,
  minutesAssumed: false,
  tasks: [{ taskId: 10, text: 'Write the summary', awaiting: false, allottedMinutes: null }],
  ...over,
});

test('a block whose window is running is offered', () => {
  const live = liveBlock([blockRow()], AT(15, 12));
  assert.ok(live);
  assert.equal(live.running, true);
  assert.equal(live.startsInMinutes, -12);
  assert.equal(live.tasks.length, 1);
});

test('it is offered a few minutes early, so the block can start on time', () => {
  assert.ok(liveBlock([blockRow()], AT(14, 57)), 'inside the lead');
  assert.equal(liveBlock([blockRow()], AT(14, 30)), null, 'half an hour out is not now');
});

test('a finished window is not this — it owes a write-up instead', () => {
  assert.equal(liveBlock([blockRow()], AT(16, 1)), null);
  assert.equal(liveBlock([blockRow({ passed: true })], AT(15, 30)), null);
});

test('only a scheduled block is offered', () => {
  for (const status of ['awaiting-writeup', 'released', 'complete', 'dropped']) {
    assert.equal(liveBlock([blockRow({ status })], AT(15, 30)), null, status);
  }
});

test('a ticked task is not offered again', () => {
  const live = liveBlock([blockRow({
    tasks: [
      { taskId: 10, text: 'done already', awaiting: true },
      { taskId: 11, text: 'still to do', awaiting: false },
    ],
  })], AT(15, 30));
  assert.deepEqual(live.tasks.map(t => t.taskId), [11]);
});

test('a block whose tasks are all ticked says so rather than looking empty', () => {
  const live = liveBlock([blockRow({
    tasks: [{ taskId: 10, text: 'done', awaiting: true }],
  })], AT(15, 30));
  assert.equal(live.tasks.length, 0);
  assert.equal(live.allTicked, true, 'all ticked and nothing in the block are different facts');
});

test('a task with a session already running is marked, not re-offered as fresh', () => {
  const live = liveBlock([blockRow({
    tasks: [
      { taskId: 10, text: 'being worked on', awaiting: false },
      { taskId: 11, text: 'not started', awaiting: false },
    ],
  })], AT(15, 30), { sessionTaskIds: [10] });
  assert.equal(live.tasks.find(t => t.taskId === 10).running, true);
  assert.equal(live.tasks.find(t => t.taskId === 11).running, false);
  assert.equal(live.anyRunning, true);
});

test('overlapping blocks pick the one that started first', () => {
  const live = liveBlock([
    blockRow({ blockId: 2, startTime: '15:30', endTime: '16:30' }),
    blockRow({ blockId: 1, startTime: '15:00', endTime: '16:00' }),
  ], AT(15, 40));
  assert.equal(live.blockId, 1);
});

test('a block on another day is never live', () => {
  assert.equal(liveBlock([blockRow({ dateKey: '2026-09-08' })], AT(15, 30)), null);
});

test('nothing to read yields null rather than throwing', () => {
  assert.equal(liveBlock([], AT(15, 30)), null);
  assert.equal(liveBlock(null, AT(15, 30)), null);
  assert.equal(liveBlock([blockRow({ startTime: 'nonsense' })], AT(15, 30)), null);
});

// An outcome note is not an orphan (7 Sep 2026).
//
// Every note NEURO wrote here linked to nothing and was linked to by nothing:
// 15 of the vault's 58 orphans were its own output. These pin the hub link and,
// more importantly, the two things that make adding one safe.

test('a fresh stub carries a hub link, so it is never born an orphan', () => {
  const raw = renderStub(TASK, BLOCK);
  assert.ok(raw.includes('[[' + OUTCOME_HUB + ']]'), 'the note must link somewhere');
  assert.ok(raw.includes(HUB_OPEN) && raw.includes(HUB_CLOSE), 'and it must be fenced');
});

test('the hub link does NOT count as a write-up', () => {
  // ⚠ The whole reason it is fenced. Unfenced it is 25 characters of prose
  // against a MIN_OUTCOME_CHARS of 25 — it would clear the bar on its own and
  // release every block the moment it was created, which is the empty-stub bug
  // for the third time.
  const verdict = isOutcomeWritten(renderStub(TASK, BLOCK));
  assert.equal(verdict.written, false);
  assert.equal(verdict.chars, 0, 'the hub must be stripped entirely, not merely fall under the bar');
});

test('the hub is a hub, never the day — a future block must not invent a broken link', () => {
  // Blocks are scheduled ahead, so the daily note for the date usually does not
  // exist yet. Linking `[[2026-09-15]]` would trade an orphan for a BROKEN link,
  // and one of the live orphans was dated a week into the future.
  const raw = renderStub(TASK, { ...BLOCK, date_key: '2026-09-15' });
  assert.ok(!raw.includes('[[2026-09-15]]'), 'must not link a daily note that may not exist');
});
