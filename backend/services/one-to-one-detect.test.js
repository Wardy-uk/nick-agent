'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// These pin the two rules that make 1-2-1 detection trustworthy:
//   1. a prep note is not evidence a 1-2-1 happened
//   2. a note only counts for someone who dominates its mentions
// Both were learned the hard way — Heidi had five prep notes generated off a
// stale date with no meeting behind any of them, and group meetings were being
// credited to whoever was named most.

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-121-'));
  fs.mkdirSync(path.join(root, 'People'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Meetings', '2026', '07'), { recursive: true });
  return root;
}

function person(root, name, extra = '') {
  fs.writeFileSync(path.join(root, 'People', `${name}.md`),
    `---\ntype: person\nrole: Analyst\nmanager: "[[People/Nick Ward|Nick Ward]]"\ndirect-report: true\ncadence: fortnightly\n${extra}---\n\n# ${name}\n`);
}

function meeting(root, filename, frontmatter, body, { crlf = false } = {}) {
  const content = `---\n${frontmatter}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(root, 'Meetings', '2026', '07', filename),
    crlf ? content.replace(/\n/g, '\r\n') : content);
}

function load(root) {
  process.env.OBSIDIAN_VAULT_PATH = root;
  delete require.cache[require.resolve('./one-to-one-detect')];
  return require('./one-to-one-detect');
}

test('a prep note does not count as a held 1-2-1', () => {
  const root = makeVault();
  person(root, 'Heidi Power');
  meeting(root, '2026-07-15 – 1-1 Heidi Power Prep.md',
    'type: meeting-prep\ndate: 2026-07-15\nmeeting-type: "1-1"\nperson: "[[People/Heidi Power|Heidi Power]]"\ngenerated-by: neuro',
    'Heidi Power prep. '.repeat(30));

  const r = load(root).scan();
  assert.equal(r.byPerson['Heidi Power'], undefined, 'prep must not create 1-2-1 history');
  assert.equal(r.skippedPrep, 1);
});

test('a real meeting note counts, and carries its highlights', () => {
  const root = makeVault();
  person(root, 'Heidi Power');
  meeting(root, '2026-07-02 – 1-2-1 Meeting Heidi Power.md',
    'type: meeting\ndate: 2026-07-02\nmeeting-type: "1-1"',
    `${'Heidi '.repeat(20)}\n\n- Agreed Heidi will own the queue hygiene checklist from next sprint onwards.\n- Location: [Insert Location]\n- Date & Time: 2026-07-02 09:00`);

  const r = load(root).scan();
  const list = r.byPerson['Heidi Power'];
  assert.equal(list.length, 1);
  assert.equal(list[0].date, '2026-07-02');
  assert.equal(list[0].highlights.length, 1, 'template boilerplate must be filtered out');
  assert.match(list[0].highlights[0], /queue hygiene/);
});

test('CRLF notes parse — \\r is a regex line terminator and silently broke this', () => {
  const root = makeVault();
  person(root, 'Kayleigh Russell');
  meeting(root, '2026-07-01 – 1-2-1 Kayleigh.md',
    'type: meeting\ndate: 2026-07-01\nmeeting-type: "1-1"',
    'Kayleigh '.repeat(20), { crlf: true });

  const r = load(root).scan();
  assert.ok(r.byPerson['Kayleigh Russell'], 'CRLF note must not be skipped');
  assert.equal(r.byPerson['Kayleigh Russell'][0].date, '2026-07-01');
});

test('a group meeting is not credited to whoever is named most', () => {
  const root = makeVault();
  person(root, 'Stephen Mitchell');
  person(root, 'Heidi Power');
  person(root, 'Naomi Wentworth');
  meeting(root, '2026-07-04 – Remote Work Adjustment.md',
    'type: meeting\ndate: 2026-07-04\nmeeting-type: "1-1"',
    `${'Stephen '.repeat(21)} ${'Heidi '.repeat(11)} ${'Naomi '.repeat(6)}`);

  const r = load(root).scan();
  assert.equal(Object.keys(r.byPerson).length, 0, 'no one dominates — must stay unattributed');
  assert.equal(r.unattributed, 1);
});

test('a frontmatter link resolves the note when the body agrees', () => {
  const root = makeVault();
  person(root, 'Sebastian Broome');
  person(root, 'Luke Scaife');
  meeting(root, '2026-07-08 – 1-1 Team Performance.md',
    'type: meeting\ndate: 2026-07-08\nmeeting-type: "1-1"\npeople:\n  - "[[People/Sebastian Broome|Sebastian Broome]]"',
    `${'Sebastian '.repeat(40)} Luke`);

  const r = load(root).scan();
  assert.ok(r.byPerson['Sebastian Broome'], 'the linked person owns the note');
  assert.equal(r.byPerson['Luke Scaife'], undefined);
  assert.equal(r.byPerson['Sebastian Broome'][0].via, 'frontmatter');
});

test('an incomplete Plaud people link cannot turn a group meeting into a 1-2-1', () => {
  // The real case: the 4 Jun note links only Stephen but the meeting was with
  // Stephen, Heidi and Naomi. The body has to back the link up.
  const root = makeVault();
  person(root, 'Stephen Mitchell');
  person(root, 'Heidi Power');
  person(root, 'Naomi Wentworth');
  meeting(root, '2026-07-09 – Remote Work Adjustment.md',
    'type: meeting\ndate: 2026-07-09\nmeeting-type: "1-1"\npeople:\n  - "[[People/Stephen Mitchell|Stephen Mitchell]]"',
    `${'Stephen '.repeat(21)} ${'Heidi '.repeat(11)} ${'Naomi '.repeat(6)}`);

  const r = load(root).scan();
  assert.equal(r.byPerson['Stephen Mitchell'], undefined, 'must stay unattributed');
});

test('a title naming two of the team is a group meeting, whatever the ratios', () => {
  const root = makeVault();
  person(root, 'Stephen Mitchell');
  person(root, 'Heidi Power');
  meeting(root, '2026-07-12 – group.md',
    'type: meeting\ndate: 2026-07-12\nmeeting-type: "1-1"\ntitle: "Remote Work Adjustment — Stephen Mitchell, Heidi"',
    'Stephen '.repeat(40));

  const r = load(root).scan();
  assert.equal(r.byPerson['Stephen Mitchell'], undefined);
});

test('a summary and its transcript on the same day are one 1-2-1', () => {
  const root = makeVault();
  person(root, 'Hope Goodall');
  meeting(root, '2026-07-10 – 1-1 Hope summary.md',
    'type: meeting\ndate: 2026-07-10\nmeeting-type: "1-1"', 'Hope '.repeat(20));
  meeting(root, '2026-07-10 – 1-1 Hope transcript.md',
    'type: transcript\ndate: 2026-07-10\nmeeting-type: "1-1"', 'Hope '.repeat(20));

  const list = load(root).scan().byPerson['Hope Goodall'];
  assert.equal(list.length, 1, 'deduped by person+date');
  assert.equal(list[0].noteType, 'meeting', 'the summary is the note of record');
});

test('an orphaned transcript still proves the 1-2-1 happened', () => {
  const root = makeVault();
  person(root, 'Hope Goodall');
  meeting(root, '2026-07-11 – 1-1 Hope only a transcript.md',
    'type: transcript\ndate: 2026-07-11\nmeeting-type: "1-1"', 'Hope '.repeat(20));

  const list = load(root).scan().byPerson['Hope Goodall'];
  assert.equal(list.length, 1);
  assert.equal(list[0].noteType, 'transcript');
});

test('archived people drop off the roster', () => {
  const root = makeVault();
  person(root, 'Arman Shazad', 'archived: true\n');
  person(root, 'Abdi Mohamed');

  const roster = load(root).buildRoster();
  assert.deepEqual(roster.people.map(p => p.name), ['Abdi Mohamed']);
});

test('syncPeopleNotes never moves a recorded date backwards', () => {
  const root = makeVault();
  // Note already records a LATER 1-2-1 than anything on disk — a meeting held
  // but not yet written up. The scan must not overwrite it with the older one.
  person(root, 'Zoe Rees', 'last-1-2-1: 2026-08-01\n');
  meeting(root, '2026-07-01 – 1-2-1 Zoe.md',
    'type: meeting\ndate: 2026-07-01\nmeeting-type: "1-1"', 'Zoe '.repeat(20));

  const result = load(root).syncPeopleNotes({ apply: false });
  const change = result.changes.find(c => c.person === 'Zoe Rees');
  assert.equal(change.action, 'already-current');
});
