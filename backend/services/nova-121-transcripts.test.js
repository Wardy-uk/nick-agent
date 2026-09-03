'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { _internals } = require('./nova-121-transcripts');
const { attribute, peopleLinks, oneToOneSignal, attributeFromEvents } = _internals;

/**
 * Attribution is the dangerous part.
 *
 * Plaud names recordings by timestamp, so a title rarely says whose 1-2-1 it was, and it
 * has previously filed one against Nick with the other person logged as "Unknown Speaker
 * 1" (see Nathan Rutland's holding note in the vault). Bind the wrong transcript and one
 * person's conversation lands on another person's permanent record — and NOVA's extractor
 * then closes THAT person's actions from words they never said.
 *
 * So the rule these pin is: when in doubt, return null and let a human pick. A wrong
 * name is far worse than no name, because NOVA renders an empty dropdown for null and
 * a confident, wrong one otherwise.
 */

const REPORTS = [
  { name: 'Nathan Rutland' }, { name: 'Zoe Rees' },
  { name: 'Hope Goodall' }, { name: 'Sebastian Broome' },
];

const VAULT = process.env.OBSIDIAN_VAULT_PATH || '/vault';
const at = (rel) => path.join(VAULT, rel.replace(/\//g, path.sep));

test.before(() => { process.env.OBSIDIAN_VAULT_PATH = VAULT; });

test('the 1-2-1 folder a note is filed in wins — a human already decided', () => {
  const r = attribute({ title: 'Weekly catch-up' }, at('Meetings/1-2-1/Nathan Rutland/2026-08-25 note.md'), REPORTS);
  assert.equal(r.person, 'Nathan Rutland');
  assert.match(r.attribution, /folder/);
});

test('a single linked direct report is the answer', () => {
  const fm = { people__list: ['"[[People/Nick Ward|Nick Ward]]"', '"[[People/Zoe Rees|Zoe Rees]]"'] };
  const r = attribute(fm, at('Meetings/2026/08/2026-08-21 recording.md'), REPORTS);
  assert.equal(r.person, 'Zoe Rees');
});

test('TWO linked direct reports is not a 1-2-1 — it answers null, loudly', () => {
  // The real case this guards: "Remote Work Adjustment — Stephen, Heidi, Naomi" is
  // nobody's 1-2-1, and putting it on one of their records would be a fabrication.
  const fm = { people__list: [
    '"[[People/Nick Ward|Nick Ward]]"',
    '"[[People/Zoe Rees|Zoe Rees]]"',
    '"[[People/Hope Goodall|Hope Goodall]]"',
  ] };
  const r = attribute(fm, at('Meetings/2026/08/2026-08-21 recording.md'), REPORTS);
  assert.equal(r.person, null);
  assert.match(r.attribution, /ambiguous/);
});

test('Nick being on the note never counts as the other party', () => {
  // Every 1-2-1 note links Nick. If he were counted, every note would look ambiguous.
  const fm = { people__list: ['"[[People/Nick Ward|Nick Ward]]"', '"[[People/Nathan Rutland|Nathan Rutland]]"'] };
  assert.equal(attribute(fm, at('Meetings/2026/08/x.md'), REPORTS).person, 'Nathan Rutland');
});

test('someone who is not a direct report is ignored, not attributed', () => {
  const fm = { people__list: ['"[[People/Alex Carr|Alex Carr]]"', '"[[People/Nick Ward|Nick Ward]]"'] };
  const r = attribute(fm, at('Meetings/2026/08/x.md'), REPORTS);
  assert.equal(r.person, null);
});

test('a first name in the title is used, and labelled as the weak signal it is', () => {
  const r = attribute({ title: '08-21 One-on-One with Hope — progression' }, at('Meetings/2026/08/x.md'), REPORTS);
  assert.equal(r.person, 'Hope Goodall');
  assert.match(r.attribution, /title/);
});

test('a timestamped Plaud title attributes to nobody', () => {
  // The common case: "2026-08-21 08-21-121202". Guessing from this would be inventing.
  const r = attribute({ title: '08-21-121202' }, at('Meetings/2026/08/2026-08-21 08-21-121202.md'), REPORTS);
  assert.equal(r.person, null);
  assert.match(r.attribution, /could not tell/);
});

test('a first name that only appears as a substring does not match', () => {
  // "Hope" inside "Hopefully" must not attribute a recording to Hope Goodall.
  const r = attribute({ title: 'Hopefully the last release meeting' }, at('Meetings/2026/08/x.md'), REPORTS);
  assert.equal(r.person, null);
});

test('peopleLinks reads the YAML list form the vault actually uses', () => {
  assert.deepEqual(
    peopleLinks({ people__list: ['"[[People/Sebastian Broome|Sebastian Broome]]"', '"[[People/Nick Ward|Nick Ward]]"'] }),
    ['Sebastian Broome', 'Nick Ward'],
  );
  assert.deepEqual(peopleLinks({}), []);
});

// ---------------------------------------------------------------------------
// Participants — the signal that actually works
// ---------------------------------------------------------------------------
//
// The first cut ignored Plaud's own participant line and fell back to guessing from the
// title, so most candidates arrived as "could not tell from the note". The summary says
// who was in the room, by voice.

const { participantsFrom, summaryExcerptFrom } = _internals;

test('participants are read from the summary body', () => {
  assert.deepEqual(
    participantsFrom('> Participants: [Nick Ward] [Maria Pappa]\n## Meeting Notes'),
    ['Nick Ward', 'Maria Pappa'],
  );
});

test('a comma-separated list parses the same way', () => {
  // The vault contains both spacings; neither is more correct than the other.
  assert.deepEqual(
    participantsFrom('> Participants: [Zoe Rees], [Nick Ward], [Stephen Mitchell]'),
    ['Zoe Rees', 'Nick Ward', 'Stephen Mitchell'],
  );
});

test('"Speaker N" is a failure to identify a voice, not a person', () => {
  // Treating it as a name would attribute a 1-2-1 to somebody who was never named — and
  // Plaud has already filed one of Nick's 1-2-1s with the other party as "Unknown Speaker 1".
  assert.deepEqual(
    participantsFrom('> Participants: [Speaker 1] [Nick Ward] [Speaker 3]'),
    ['Nick Ward'],
  );
});

test('no participants line is an empty list, not a throw', () => {
  assert.deepEqual(participantsFrom('## Meeting Notes\n- something'), []);
  assert.deepEqual(participantsFrom(''), []);
});

test('attribution prefers who was heard over what the title says', () => {
  // The title names Zoe; the room contained Nathan. The recording is Nathan's.
  const body = '> Participants: [Nick Ward] [Nathan Rutland]\n## Meeting Notes\n- x';
  const r = attribute({ title: 'One-to-One with Zoe about handover' }, at('Meetings/2026/08/x.md'), REPORTS, body);
  assert.equal(r.person, 'Nathan Rutland');
  assert.match(r.attribution, /heard speaking/);
});

test('two direct reports in the room is not a 1-2-1', () => {
  const body = '> Participants: [Nick Ward] [Nathan Rutland] [Zoe Rees]';
  const r = attribute({ title: 'Catch-up' }, at('Meetings/2026/08/x.md'), REPORTS, body);
  assert.equal(r.person, null);
  assert.match(r.attribution, /not a 1-2-1/);
});

test('the excerpt is the meeting notes, not the Recording boilerplate', () => {
  const body = [
    '# Title', '## Recording', '- Plaud ID: `abc`', '- Duration: 46m',
    '## Summary', '> Meeting Information', '> Participants: [Nick Ward] [Zoe Rees]',
    '## Meeting Notes', '### Performance', '- Zoe handled 389 tickets last month.',
  ].join('\n');
  const out = summaryExcerptFrom(body);
  assert.match(out, /389 tickets/);
  assert.doesNotMatch(out, /Plaud ID/);
  assert.doesNotMatch(out, /Meeting Information/, 'the quoted preamble is identical on every note');
});

/**
 * Which notes count as a 1-2-1 at all.
 *
 * The title was the only test for months and it silently lost most of them: Plaud titles
 * a note by what was DISCUSSED, so Stephen's monthly 1-2-1 arrived as "Meeting: Team KPIs,
 * Ticket Management, AI Tooling and Escalation Workflow" and Isabel's as "Performance
 * Review: Isabel Busk KPIs". Both carried `meeting-type: 1-1` in frontmatter, both were
 * skipped, and both showed in NOVA as somebody with no 1-2-1 since the spring — which is
 * the failure this feature exists to prevent.
 */

test('a topical title with meeting-type 1-1 is a 1-2-1 — the case that was being lost', () => {
  // Stephen's, verbatim from the vault.
  assert.equal(
    oneToOneSignal({ 'meeting-type': '1-1' }, 'Meetings/2026/08/x.md',
      '08-18 Meeting: Team KPIs, Ticket Management, AI Tooling, and Escalation Workflow'),
    'soft');
});

test("the vault router's own verdict counts, even with no meeting-type", () => {
  assert.equal(
    oneToOneSignal(
      { plaud_route_reason: 'Deterministic PLAUD routing: identified a 1-2-1/performance note for Isabel Busk.' },
      'Meetings/2026/08/x.md', 'Performance Review: Isabel Busk KPIs, Workflows, and Operational Planning'),
    'soft');
});

test('a folder or a title is an explicit claim, and outranks frontmatter', () => {
  assert.equal(oneToOneSignal({}, 'Meetings/1-2-1/Zoe Rees/x.md', 'Catch-up'), 'explicit');
  assert.equal(oneToOneSignal({ 'meeting-type': 'Project Meeting' }, 'Meetings/2026/08/x.md',
    '08-20 One-to-One Meeting: Maria KPIs'), 'explicit');
});

test('an ordinary team meeting is still not a 1-2-1', () => {
  assert.equal(
    oneToOneSignal({ 'meeting-type': 'Project Meeting' }, 'Meetings/2026/08/x.md',
      '08-18 Weekly Meeting: Ticket Status Review and Integration Issues'),
    null);
});

test('meeting-type must be the whole value, not a substring of prose', () => {
  // Guards the regex being anchored. "Weekly 1-1s roundup" is not a meeting type.
  assert.equal(oneToOneSignal({ 'meeting-type': 'Team meeting about 1-1s' },
    'Meetings/2026/08/x.md', 'Roundup'), null);
});

/**
 * The router names the person when it files the note, and that was being thrown away.
 * It is the only attribution available on the HR-flavoured notes — "Performance Review:
 * …" — where Plaud logged no participants line at all.
 */
test('the router-named person beats a bare first name in the title', () => {
  const r = attribute(
    { title: 'Performance Review: Nathan and the team',
      plaud_route_reason: 'Deterministic PLAUD routing: identified a 1-2-1/performance note for Zoe Rees.' },
    at('Meetings/2026/08/x.md'), REPORTS, '');
  assert.equal(r.person, 'Zoe Rees');
  assert.match(r.attribution, /router/);
});

test('a router-named person who is not a direct report is not used', () => {
  const r = attribute(
    { title: 'Performance Review: catch-up',
      plaud_route_reason: 'Deterministic PLAUD routing: identified a 1-2-1/performance note for Chris Middleton.' },
    at('Meetings/2026/08/x.md'), REPORTS, '');
  assert.equal(r.person, null);
});

test('who was actually in the room still outranks the router', () => {
  const body = '> Participants: [Nick Ward] [Nathan Rutland]';
  const r = attribute(
    { title: 'Performance Review',
      plaud_route_reason: 'Deterministic PLAUD routing: identified a 1-2-1/performance note for Zoe Rees.' },
    at('Meetings/2026/08/x.md'), REPORTS, body);
  assert.equal(r.person, 'Nathan Rutland');
  assert.match(r.attribution, /heard speaking/);
});

/**
 * Calendar matching, and the timezone trap underneath it.
 *
 * Plaud's API returns UTC with NO marker — `2026-08-19T13:02:21` is a 1-2-1 that started
 * at 14:02, which Plaud's own UI shows as 14:02. Graph is asked for London wall-clock and
 * also answers with a naked string. Two naked strings in different zones: compare them
 * directly and the matching works perfectly from late October to late March and is an
 * hour out for the rest of the year. These pin both sides of that.
 */

const DIARY = [
  { name: 'Zoe Rees', email: 'zoe.rees@nurtur.tech' },
  { name: 'Nathan Rutland', email: 'nathan.rutland@nurtur.tech' },
];
const ev = (start, end, attendees, extra = {}) => ({
  start, end, subject: 'Catch-up',
  attendees: attendees.map((a) => (typeof a === 'string' ? { name: a, email: '' } : a)),
  ...extra,
});

test('BST: a 13:02 UTC recording matches the 14:00 meeting, not the 13:00 one', () => {
  const events = [
    ev('2026-08-19T13:00:00', '2026-08-19T13:30:00', ['Nathan Rutland']),
    ev('2026-08-19T14:00:00', '2026-08-19T14:45:00', ['Zoe Rees']),
  ];
  // 34 minutes, the real duration of that recording.
  const r = attributeFromEvents(events, '2026-08-19T13:02:21', 2047000, DIARY);
  assert.equal(r.person, 'Zoe Rees', 'the naive string compare would have said Nathan');
  assert.match(r.attribution, /diary/);
});

test('GMT: no offset to apply in winter, and the match still lands', () => {
  const events = [ev('2026-01-14T10:00:00', '2026-01-14T10:30:00', ['Nathan Rutland'])];
  const r = attributeFromEvents(events, '2026-01-14T10:02:00', 1500000, DIARY);
  assert.equal(r.person, 'Nathan Rutland');
});

test('a report is matched on email even when the diary spells the name differently', () => {
  const events = [ev('2026-08-19T14:00:00', '2026-08-19T14:45:00',
    [{ name: 'Zoë Rees (Support)', email: 'Zoe.Rees@nurtur.tech' }])];
  const r = attributeFromEvents(events, '2026-08-19T13:02:21', 2047000, DIARY);
  assert.equal(r.person, 'Zoe Rees');
});

test('two direct reports in the diary is a team meeting, and says so', () => {
  const events = [ev('2026-08-19T14:00:00', '2026-08-19T15:00:00', ['Zoe Rees', 'Nathan Rutland'])];
  const r = attributeFromEvents(events, '2026-08-19T13:02:21', 2047000, DIARY);
  assert.equal(r.person, null);
  assert.match(r.attribution, /not a 1-2-1/);
});

test('all-day, cancelled and free events are not meetings', () => {
  for (const extra of [{ isAllDay: true }, { showAs: 'cancelled' }, { showAs: 'free' }]) {
    const events = [ev('2026-08-19T14:00:00', '2026-08-19T14:45:00', ['Zoe Rees'], extra)];
    assert.equal(attributeFromEvents(events, '2026-08-19T13:02:21', 2047000, DIARY).person, null,
      `${JSON.stringify(extra)} should not attribute`);
  }
});

test('a meeting nowhere near the recording is not a match', () => {
  const events = [ev('2026-08-19T09:00:00', '2026-08-19T09:30:00', ['Zoe Rees'])];
  const r = attributeFromEvents(events, '2026-08-19T13:02:21', 2047000, DIARY);
  assert.equal(r.person, null);
  assert.equal(r.attribution, null, 'no overlap is silence, not a verdict');
});

test('a calendar that could not be read is silence, never "nothing was booked"', () => {
  // The distinction matters: null must not be reported to Nick as a finding.
  for (const events of [null, undefined, []]) {
    const r = attributeFromEvents(events, '2026-08-19T13:02:21', 2047000, DIARY);
    assert.equal(r.person, null);
    assert.equal(r.attribution, null);
  }
});

test('the organiser counts as somebody in the room', () => {
  const events = [ev('2026-08-19T14:00:00', '2026-08-19T14:45:00', [],
    { organizer: 'Zoe Rees', organizerEmail: 'zoe.rees@nurtur.tech' })];
  assert.equal(attributeFromEvents(events, '2026-08-19T13:02:21', 2047000, DIARY).person, 'Zoe Rees');
});

test('a recording of unknown length still matches the meeting it started in', () => {
  const events = [ev('2026-08-19T14:00:00', '2026-08-19T14:45:00', ['Zoe Rees'])];
  assert.equal(attributeFromEvents(events, '2026-08-19T13:02:21', null, DIARY).person, 'Zoe Rees');
});
