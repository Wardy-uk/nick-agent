'use strict';

/**
 * Tests for the PURE iCalendar reader.
 *
 * Everything here runs with no network and no iCloud account, which is the point:
 * the reason for pulling the diary server-side is that its failure modes become
 * inspectable, and a parser you can only exercise against a live account is one
 * nobody exercises.
 *
 * The bias throughout is that a MISSING event is the expensive failure.
 * `calendar_cache` answers "is Nick free", so anything that under-reports books
 * a meeting over a real commitment — which is why the recurrence tests are the
 * bulk of this file and why unsupported rules must be reported rather than
 * quietly dropped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ical = require('./ical');

const TZ = 'Europe/London';
const ev = (lines) => ical.parseComponents(`BEGIN:VEVENT\n${lines.join('\n')}\nEND:VEVENT`)[0];
const starts = (r) => r.occurrences.map((o) => o.start);

// ── Text ─────────────────────────────────────────────────────────────────────

test('folded lines are rejoined before anything else looks at them', () => {
  const lines = ical.unfoldLines('SUMMARY:a very long\n  title that folded\nDTSTART:20260905');
  assert.deepEqual(lines, ['SUMMARY:a very long title that folded', 'DTSTART:20260905']);
});

test('a value is split on the FIRST colon, so a URL survives', () => {
  // The older reader in obsidian.js splits on the last colon and mangles this.
  const p = ical.parseLine('LOCATION:https://teams.microsoft.com/l/meetup?id=1');
  assert.equal(p.value, 'https://teams.microsoft.com/l/meetup?id=1');
});

test('parameters are read, because TZID lives there', () => {
  const p = ical.parseLine('DTSTART;TZID=America/New_York:20260905T090000');
  assert.equal(p.params.TZID, 'America/New_York');
  assert.equal(p.value, '20260905T090000');
});

test('a VALARM cannot end the event it sits inside', () => {
  // `split('BEGIN:VEVENT')` reads the alarm's END as the event's, and every
  // event with a reminder set loses its tail — including its DTSTART.
  const c = ical.parseComponents(
    'BEGIN:VEVENT\nSUMMARY:a\nBEGIN:VALARM\nTRIGGER:-PT15M\nEND:VALARM\nDTSTART:20260905T090000\nEND:VEVENT',
  );
  assert.equal(c.length, 1);
  assert.ok(ical.prop(c[0], 'DTSTART'), 'DTSTART survives the alarm');
  assert.equal(ical.prop(c[0], 'TRIGGER'), null, "the alarm's own props do not leak onto the event");
});

test('escaped text is unescaped once, in one place', () => {
  assert.equal(ical.unescapeText('Coffee\\, then\\; talk\\nline two'), 'Coffee, then; talk\nline two');
});

// ── Time ─────────────────────────────────────────────────────────────────────

test('a UTC value is converted against NEURO_TIMEZONE, not the host clock', () => {
  // The bug this repo has already paid for twice: during BST an unconverted
  // 08:00Z renders as 08:00 for a 09:00 meeting.
  assert.equal(ical.parseIcalDate('20260905T080000Z', {}, TZ).iso, '2026-09-05T09:00:00');
  // ...and in GMT there is no shift, which is what proves it is a real
  // conversion rather than a hardcoded +1.
  assert.equal(ical.parseIcalDate('20260105T080000Z', {}, TZ).iso, '2026-01-05T08:00:00');
});

test('a TZID value is converted from that zone', () => {
  assert.equal(
    ical.parseIcalDate('20260905T090000', { TZID: 'America/New_York' }, TZ).iso,
    '2026-09-05T14:00:00',
  );
});

test('a FLOATING value is left exactly as written', () => {
  // "09:00 wherever you are". Converting it moves an event that was correct.
  assert.equal(ical.parseIcalDate('20260905T090000', {}, TZ).iso, '2026-09-05T09:00:00');
});

test('a DATE value is all-day and carries no time', () => {
  const d = ical.parseIcalDate('20260905', {}, TZ);
  assert.equal(d.isDate, true);
  assert.equal(d.date, '2026-09-05');
});

test('an unparseable value is null, never a guess', () => {
  assert.equal(ical.parseIcalDate('not-a-date', {}, TZ), null);
});

// ── Recurrence ───────────────────────────────────────────────────────────────

test('a non-recurring event yields exactly one occurrence', () => {
  const r = ical.expandRecurrence(
    ev(['DTSTART:20260905T090000', 'DTEND:20260905T100000']),
    '2026-09-01T00:00:00', '2026-09-30T00:00:00', TZ,
  );
  assert.deepEqual(starts(r), ['2026-09-05T09:00:00']);
  assert.equal(r.unsupported, null);
});

test('a weekly event fills the window — the whole reason this expands locally', () => {
  // Unexpanded, this shows ONCE and three weeks read as free.
  const r = ical.expandRecurrence(
    ev(['DTSTART:20260829T090000', 'DTEND:20260829T120000', 'RRULE:FREQ=WEEKLY']),
    '2026-08-25T00:00:00', '2026-09-20T00:00:00', TZ,
  );
  assert.deepEqual(starts(r), [
    '2026-08-29T09:00:00', '2026-09-05T09:00:00', '2026-09-12T09:00:00', '2026-09-19T09:00:00',
  ]);
});

test('BYDAY produces every named weekday', () => {
  const r = ical.expandRecurrence(
    ev(['DTSTART:20260901T090000', 'DTEND:20260901T093000', 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH']),
    '2026-09-01T00:00:00', '2026-09-12T00:00:00', TZ,
  );
  assert.deepEqual(starts(r), [
    '2026-09-01T09:00:00', '2026-09-03T09:00:00', '2026-09-08T09:00:00', '2026-09-10T09:00:00',
  ]);
});

test('COUNT and UNTIL both end the series', () => {
  const byCount = ical.expandRecurrence(
    ev(['DTSTART:20260901T090000', 'DTEND:20260901T093000', 'RRULE:FREQ=DAILY;COUNT=3']),
    '2026-09-01T00:00:00', '2026-09-30T00:00:00', TZ,
  );
  assert.equal(byCount.occurrences.length, 3);

  const byUntil = ical.expandRecurrence(
    ev(['DTSTART:20260901T090000', 'DTEND:20260901T093000', 'RRULE:FREQ=DAILY;UNTIL=20260903T235900Z']),
    '2026-09-01T00:00:00', '2026-09-30T00:00:00', TZ,
  );
  assert.deepEqual(starts(byUntil), [
    '2026-09-01T09:00:00', '2026-09-02T09:00:00', '2026-09-03T09:00:00',
  ]);
});

test('an EXDATE instance still consumes one of COUNT', () => {
  // COUNT bounds the recurrence SET and EXDATE removes from it, so this is three
  // occurrences and not four. Counting after exclusion silently extends a series
  // past where the organiser ended it.
  const r = ical.expandRecurrence(
    ev(['DTSTART:20260901T090000', 'DTEND:20260901T093000',
      'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE:20260902T090000']),
    '2026-09-01T00:00:00', '2026-09-30T00:00:00', TZ,
  );
  assert.deepEqual(starts(r), ['2026-09-01T09:00:00', '2026-09-03T09:00:00', '2026-09-04T09:00:00']);
});

test('the 31st of a 30-day month DOES NOT OCCUR, and is never slid', () => {
  // Regression: this emitted `2026-02-31T09:00:00` — not a date — into the row
  // set. Sliding it to the 28th would be worse still: a commitment on a day
  // nobody agreed to.
  const r = ical.expandRecurrence(
    ev(['DTSTART:20260131T090000', 'DTEND:20260131T093000', 'RRULE:FREQ=MONTHLY;COUNT=3']),
    '2026-01-01T00:00:00', '2026-12-30T00:00:00', TZ,
  );
  assert.deepEqual(starts(r), ['2026-01-31T09:00:00', '2026-03-31T09:00:00', '2026-05-31T09:00:00']);
  for (const s of starts(r)) {
    assert.ok(!s.startsWith('2026-02'), 'February never has a 31st');
  }
});

test('an unsupported rule is REPORTED, and still yields the base occurrence', () => {
  // Silence here is the dangerous option: a dropped series reads as a free week.
  const r = ical.expandRecurrence(
    ev(['DTSTART:20260901T090000', 'DTEND:20260901T093000', 'RRULE:FREQ=MONTHLY;BYSETPOS=2;BYDAY=TU']),
    '2026-09-01T00:00:00', '2026-12-30T00:00:00', TZ,
  );
  assert.match(r.unsupported, /BYSETPOS/);
  assert.equal(r.occurrences.length, 1, 'the first instance is still surfaced');
});

test('an unknown FREQ is reported rather than guessed', () => {
  const r = ical.expandRecurrence(
    ev(['DTSTART:20260901T090000', 'DTEND:20260901T093000', 'RRULE:FREQ=HOURLY']),
    '2026-09-01T00:00:00', '2026-09-02T00:00:00', TZ,
  );
  assert.match(r.unsupported, /HOURLY/);
});

test('an event with no DTSTART is refused, not defaulted to now', () => {
  const r = ical.expandRecurrence(ev(['SUMMARY:orphan']), '2026-09-01T00:00:00', '2026-09-30T00:00:00', TZ);
  assert.deepEqual(r.occurrences, []);
  assert.match(r.unsupported, /DTSTART/);
});

test('an occurrence overlapping the window edge is kept', () => {
  // A meeting that started before the window but is still running is not a past
  // event, and dropping it makes a busy morning look free.
  const r = ical.expandRecurrence(
    ev(['DTSTART:20260905T083000', 'DTEND:20260905T093000']),
    '2026-09-05T09:00:00', '2026-09-06T00:00:00', TZ,
  );
  assert.equal(r.occurrences.length, 1);
});
