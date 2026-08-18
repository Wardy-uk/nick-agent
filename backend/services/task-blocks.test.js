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
  isOutcomeWritten, renderStub, outcomeNotePath, slugify, findSlot,
  MIN_OUTCOME_CHARS, DAY_START_MIN, DAY_END_MIN, SEARCH_DAYS,
} = require('./task-blocks');

const TASK = { id: 58, text: 'Build succession plan — cover for HoTS and emerging team leads' };
const BLOCK = { date_key: '2026-08-19', start_time: '14:00', end_time: '15:00', minutes: 60 };

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
