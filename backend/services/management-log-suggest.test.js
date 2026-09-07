'use strict';

/**
 * Pins the rules that decide whether a recorded meeting is offered as a
 * management conversation.
 *
 * `assess()` is pure, so all of this runs without a vault, a database or a
 * clock. The fixtures are copied from the LIVE vault rather than invented —
 * this repo has been bitten more than once by a test written over an identifier
 * nobody ships (`sleep_core_hours`, `meeting_alert`), which is green and proves
 * nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const s = require('./management-log-suggest');

const ROSTER = [
  { name: 'Isabel Busk', uniqueFirstName: 'Isabel' },
  { name: 'Maria Pappa', uniqueFirstName: 'Maria' },
  { name: 'Naomi Wentworth', uniqueFirstName: 'Naomi' },
  { name: 'Stephen Mitchell', uniqueFirstName: 'Stephen' },
  { name: 'Zoe Rees', uniqueFirstName: 'Zoe' },
  { name: 'Abdi Mohamed', uniqueFirstName: 'Abdi' },
  { name: 'Hope Goodall', uniqueFirstName: 'Hope' },
  { name: 'Luke Scaife', uniqueFirstName: 'Luke' },
  { name: 'Kayleigh Russell', uniqueFirstName: 'Kayleigh' },
  { name: 'Heidi Power', uniqueFirstName: 'Heidi' },
  { name: 'Adele Norman-Swift', uniqueFirstName: 'Adele' },
  // ⚠ Nathan Rutland is a report and Nathan Button exists in the vault, so the
  // bare first name identifies nobody. That is the four-Lucys rule.
  { name: 'Nathan Rutland', uniqueFirstName: null },
];

function note(over = {}) {
  const { frontmatter = {}, ...rest } = over;
  return {
    relativePath: 'Meetings/2026/08/2026-08-10 – A meeting.md',
    body: 'Some discussion.',
    frontmatter: {
      type: 'meeting',
      title: 'A meeting',
      date: '2026-08-10',
      created_at: '2026-08-10T09:59:40',
      plaud_id: 'abc123',
      people: [],
      ...frontmatter,
    },
    ...rest,
  };
}

const run = (notes, over = {}) => s.assess({ notes, roster: ROSTER, rows: [], dismissed: [], ok: true, ...over });

// ── Formal 1-2-1s are excluded, three ways ──────────────────────────────────

test('a 1-2-1 is excluded by its meeting-type', () => {
  const a = run([note({ frontmatter: { 'meeting-type': '1-1', title: 'Catch-up with Maria', people: ['Maria Pappa'] } })]);
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.oneToOne, 1);
});

test('a 1-2-1 is excluded by its folder, even with no meeting-type at all', () => {
  // Older PLAUD notes predate the field entirely — Hope's 30 Apr 1-2-1 is the
  // real case. Without the folder test they would all be offered.
  const a = run([note({
    relativePath: 'Meetings/1-2-1/Hope Goodall/2026-04-30 Performance and KPIs.md',
    frontmatter: { title: 'Performance and KPIs', people: ['Hope Goodall'] },
  })]);
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.oneToOne, 1);
});

test('a 1-2-1 is excluded by its title when it sits loose in Meetings/YYYY/MM', () => {
  // Live path, verbatim: 1-2-1s do NOT all live under the 1-2-1 tree.
  const a = run([note({
    relativePath: 'Meetings/2026/04/2026-04-22 – 1-1 Nathan 1-2-1 Return-to-Work, AI Support Workflow.md',
    frontmatter: { title: '1-1 Nathan 1-2-1 Return-to-Work', people: ['Nathan Rutland'] },
  })]);
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.oneToOne, 1);
});

// ── What counts as a management conversation ────────────────────────────────

test('a meeting naming a direct report is offered', () => {
  // The clearest live case: one person, plainly a management conversation, and
  // it is not on the log.
  const a = run([note({
    frontmatter: { title: 'Meeting Counter-Offer to Retain Isabel Busk', people: ['[[People/Isabel Busk|Isabel Busk]]'] },
  })]);
  assert.equal(a.suggestions.length, 1);
  assert.equal(a.suggestions[0].person, 'Isabel Busk');
  assert.equal(a.suggestions[0].type, 'conversation', 'a recording is evidence a discussion happened, not that an action was agreed');
});

test('a project meeting naming nobody on the team is not offered', () => {
  const a = run([note({ frontmatter: { title: 'Project Meeting Onboarding Tool Integration' } })]);
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.noReport, 1);
});

test('a bare first name that points at two people identifies nobody', () => {
  // Nathan Rutland reports to Nick; Nathan Button does not. Matching the first
  // name would file a meeting under a person who was never in it.
  const a = run([note({ frontmatter: { title: 'Sync with Nathan about the portal' } })]);
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.noReport, 1);
});

test('a first name is not matched inside a longer word', () => {
  const a = run([note({ frontmatter: { title: 'Williamson account review' } })]);
  assert.equal(a.suggestions.length, 0, '"Willi" must not match "Williamson", and no report is named');
});

// ── The measured boundary: 3 people in, 4 out ───────────────────────────────

test('three named reports is still a management conversation', () => {
  // ⚠ The live 29 Jul note, and the reason MAX_PEOPLE is 3 rather than 2. It is
  // the single clearest management conversation in the vault and it has three
  // people in it.
  const a = run([note({
    frontmatter: {
      title: 'Accommodation vs. Uniform Policy: Targeted WFH and Neurodivergent Support to Mitigate Attrition',
      people: ['Isabel Busk', 'Maria Pappa', 'Naomi Wentworth'],
    },
  })]);
  assert.equal(a.suggestions.length, 1);
  assert.equal(a.suggestions[0].people.length, 3);
  assert.equal(a.suggestions[0].person, null, 'no single subject — the panel asks rather than guessing');
});

test('four named reports reads as a team meeting and is NOT offered', () => {
  // ⚠ NEGATIVE, and the other half of the measurement. Live 30 Jul note. Every
  // one of the 24 notes at 4+ is a recurring ceremony; offering them buries the
  // dozen that matter.
  const a = run([note({
    frontmatter: {
      title: 'Weekly Meeting: Queue Management, Ticket Hygiene, and Staffing',
      people: ['Adele Norman-Swift', 'Heidi Power', 'Naomi Wentworth', 'Stephen Mitchell'],
    },
  })]);
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.tooManyPeople, 1, 'and it is counted, not silently dropped');
});

test('the daily standup is never offered', () => {
  const a = run([note({
    frontmatter: {
      title: 'Daily Standup',
      people: ROSTER.slice(0, 9).map(r => r.name),
    },
  })]);
  assert.equal(a.suggestions.length, 0);
});

// ── Prep is not evidence ────────────────────────────────────────────────────

test('a prep note is never offered — it is not evidence a conversation happened', () => {
  const a = run([note({ frontmatter: { type: 'meeting-prep', title: 'Prep for Maria', people: ['Maria Pappa'] } })]);
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.notOneToOneCandidate, 1);
});

// ── Dates and stamps ────────────────────────────────────────────────────────

test('an undated note is refused rather than dated today', () => {
  // `entry_date` is when the conversation HAPPENED and the whole competency-3
  // measurement hangs off it. A guess there is a measurement about nothing.
  const a = run([note({
    relativePath: 'Meetings/loose/Some note.md',
    frontmatter: { title: 'Chat with Maria', date: '', start_at: '', people: ['Maria Pappa'] },
  })]);
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.undated, 1);
});

test('a note with no usable timestamp is offered, but NOT as contemporaneous', () => {
  // ⚠ The important half. It is still worth logging; it just cannot claim to
  // have been recorded on the day, so accepting it logs as today and shows as
  // late. Guessing would manufacture competency-3 compliance out of nothing.
  const a = run([note({ frontmatter: { title: 'Chat with Maria', created_at: '', start_at: '', people: ['Maria Pappa'] } })]);
  assert.equal(a.suggestions.length, 1);
  assert.equal(a.suggestions[0].contemporaneous, false);
  assert.equal(a.suggestions[0].recordedAt, null, 'null, never a guessed stamp');
});

test('an unparseable timestamp is treated as absent, not as a date', () => {
  const a = run([note({ frontmatter: { title: 'Chat with Maria', created_at: 'not a date', start_at: '', people: ['Maria Pappa'] } })]);
  assert.equal(a.suggestions[0].contemporaneous, false);
});

// ── Never offered twice ─────────────────────────────────────────────────────

test('a suggestion already on the log by source is not offered again', () => {
  const n = note({ frontmatter: { title: 'Counter-offer', people: ['Isabel Busk'] } });
  const a = run([n], { rows: [{ id: 1, source: 'plaud:abc123', entry_date: '2026-08-10', person: 'Isabel' }] });
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.alreadyLogged, 1);
});

test('a hand-typed row with the same date and person suppresses it too', () => {
  // ⚠ The 19 seeded rows were typed by hand and carry no path, so without this
  // loose match every one of them would come back as a fresh suggestion.
  const n = note({ frontmatter: { title: 'Counter-offer', people: ['Isabel Busk'] } });
  const a = run([n], { rows: [{ id: 1, source: 'manual', entry_date: '2026-08-10', person: 'Isabel Busk' }] });
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.alreadyLogged, 1);
});

test('a row on a different date does not suppress it', () => {
  const n = note({ frontmatter: { title: 'Counter-offer', people: ['Isabel Busk'] } });
  const a = run([n], { rows: [{ id: 1, source: 'manual', entry_date: '2026-07-01', person: 'Isabel Busk' }] });
  assert.equal(a.suggestions.length, 1, 'two conversations with one person are two conversations');
});

test('a dismissal sticks', () => {
  const n = note({ frontmatter: { title: 'Counter-offer', people: ['Isabel Busk'] } });
  const id = s.suggestionId(n);
  const a = run([n], { dismissed: [id] });
  assert.equal(a.suggestions.length, 0);
  assert.equal(a.skipped.dismissed, 1);
});

test('the id is keyed on the recording, so a dismissal survives a re-scan', () => {
  // Never on array position, which changes the moment a note is added.
  assert.equal(s.suggestionId(note()), 'plaud:abc123');
  const noPlaud = note({ frontmatter: { plaud_id: '' } });
  assert.equal(s.suggestionId(noPlaud), `note:${noPlaud.relativePath}`);
});

test('the literal string "undefined" is not accepted as a recording id', () => {
  // PLAUD's `get_file` once returned prose after its JSON, and every note it
  // wrote carried `plaud_id: "undefined"`. Keying on that would collapse every
  // affected note onto one id, so one dismissal would hide them all.
  const n = note({ frontmatter: { plaud_id: 'undefined' } });
  assert.equal(s.suggestionId(n), `note:${n.relativePath}`);
});

// ── Honesty ─────────────────────────────────────────────────────────────────

test('an unreadable vault is ok:false, never an empty list', () => {
  const a = s.assess({ notes: [], roster: ROSTER, rows: [], dismissed: [], ok: false, gaps: ['vault not mounted'] });
  assert.equal(a.ok, false);
  assert.deepEqual(a.suggestions, []);
  assert.equal(a.gaps[0], 'vault not mounted', 'and it says why');
});

test('newest first — last week needs an owner more than June does', () => {
  const a = run([
    note({ relativePath: 'a.md', frontmatter: { title: 'Older', date: '2026-06-01', plaud_id: 'a', people: ['Maria Pappa'] } }),
    note({ relativePath: 'b.md', frontmatter: { title: 'Newer', date: '2026-08-20', plaud_id: 'b', people: ['Maria Pappa'] } }),
  ]);
  assert.deepEqual(a.suggestions.map(x => x.summary), ['Newer', 'Older']);
});

test('every skip reason is counted, so nothing is dropped silently', () => {
  const a = run([
    note({ relativePath: 'a.md', frontmatter: { plaud_id: 'a', 'meeting-type': '1-1', people: ['Maria Pappa'] } }),
    note({ relativePath: 'b.md', frontmatter: { plaud_id: 'b', title: 'Nothing to do with the team' } }),
    note({ relativePath: 'c.md', frontmatter: { plaud_id: 'c', type: 'meeting-prep', people: ['Maria Pappa'] } }),
  ]);
  assert.equal(a.skipped.oneToOne, 1);
  assert.equal(a.skipped.noReport, 1);
  assert.equal(a.skipped.notOneToOneCandidate, 1);
  assert.equal(a.scanned, 3, 'and the total read is reported beside them');
});
