'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { _internals } = require('./nova-121-transcripts');
const { attribute, peopleLinks } = _internals;

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
