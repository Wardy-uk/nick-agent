'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectMeetingNotes, readFrontmatter } = require('./meeting-notes-source');

// A scratch vault, never the real one (#119).
function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mtg-'));
  fs.mkdirSync(path.join(root, 'Meetings', '2026', '08'), { recursive: true });
  return root;
}

function writeNote(root, rel, frontmatter, eol = '\n') {
  const full = path.join(root, 'Meetings', rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const body = ['---']
    .concat(Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`))
    .concat(['---', '', 'Some notes.', ''])
    .join(eol);
  fs.writeFileSync(full, body);
  return full;
}

test('a meeting counts only when a PLAUD note proves it happened', () => {
  // Nick's rule, and the reason this source reads notes rather than the diary:
  // a meeting in the calendar does not mean he attended it. An accepted invite
  // is a plan — meetings get declined in the moment, run without him, or are
  // sat through while he works on something else, and none of that is finished
  // work. The Plaud note proves he was there AND that it got processed.
  const root = makeVault();

  writeNote(root, '2026/08/real.md', {
    plaud_id: '"abc123"', title: '"Support Improvement Plan"',
    type: 'meeting', date: '2026-08-14', source: 'PLAUD',
  });
  // The SAME meeting: one leaves both a summary and a transcript, and counting
  // both would double every meeting Nick had.
  writeNote(root, '2026/08/transcript.md', {
    plaud_id: '"abc123"', title: '"Support Improvement Plan"',
    type: 'transcript', date: '2026-08-14', source: 'PLAUD',
  });
  // Hand-written: not evidence of a recorded, processed meeting.
  writeNote(root, '2026/08/hand.md', { title: '"Some thoughts"', type: 'meeting', date: '2026-08-14' });
  // Out of the window.
  writeNote(root, '2026/08/old.md', {
    plaud_id: '"zzz"', title: '"Ancient"', type: 'meeting', date: '2026-01-05', source: 'PLAUD',
  });

  const { rows, error } = collectMeetingNotes('2026-08-01', '2026-08-31', root);

  assert.equal(error, null);
  assert.equal(rows.length, 1, 'the transcript, the hand-written note and the old one are all out');
  assert.match(rows[0].text, /Support Improvement Plan/);
  assert.equal(rows[0].dateKey, '2026-08-14');
  assert.equal(rows[0].source, 'meeting');
  assert.ok(rows[0].evidence.startsWith('note:'), 'the note IS the evidence');
  // Keyed on the RECORDING, not the path — imports.js re-routes notes into
  // canonical folders, and a moved note must not count a second time.
  assert.equal(rows[0].dedupeKey, 'meeting:abc123');
});

test('archived and transcript folders are skipped', () => {
  const root = makeVault();
  writeNote(root, 'Archive/2026/08/archived.md', {
    plaud_id: '"a1"', title: '"Archived meeting"', type: 'meeting', date: '2026-08-14', source: 'PLAUD',
  });
  writeNote(root, 'transcripts/2026/08/t1.md', {
    plaud_id: '"t1"', title: '"A transcript"', type: 'meeting', date: '2026-08-14', source: 'PLAUD',
  });
  const { rows } = collectMeetingNotes('2026-08-01', '2026-08-31', root);
  assert.equal(rows.length, 0);
});

test('an unreadable vault is a GAP, never a day with no meetings', () => {
  // The distinction this whole ledger exists to preserve: "none happened" and
  // "the folder every Plaud note lands in is missing" are different facts, and
  // only one of them is about Nick.
  const missing = collectMeetingNotes('2026-08-01', '2026-08-31', path.join(os.tmpdir(), 'nope-not-here'));
  assert.equal(missing.rows.length, 0);
  assert.match(missing.error, /Meetings\/ not found/);

  const unset = collectMeetingNotes('2026-08-01', '2026-08-31', '');
  assert.equal(unset.rows.length, 0);
  assert.match(unset.error, /OBSIDIAN_VAULT_PATH/);
});

test('CRLF frontmatter still parses', () => {
  // The vault is authored on Windows, so most notes are CRLF. In a JS regex
  // \r is a line terminator, so an anchored /^key:\s*(.*)$/ fails on every
  // CRLF line — the parse returns nothing and the note vanishes from the scan
  // with no error at all. one-to-one-detect learned this the hard way.
  const fm = readFrontmatter('---\r\nplaud_id: "x1"\r\ntype: meeting\r\ndate: 2026-08-14\r\n---\r\n\r\nbody');
  assert.equal(fm.plaud_id, 'x1');
  assert.equal(fm.type, 'meeting');
  assert.equal(fm.date, '2026-08-14');

  // And end to end, since that is where it actually bit.
  const root = makeVault();
  writeNote(root, '2026/08/crlf.md', {
    plaud_id: '"crlf1"', title: '"CRLF meeting"', type: 'meeting', date: '2026-08-14', source: 'PLAUD',
  }, '\r\n');
  const { rows } = collectMeetingNotes('2026-08-01', '2026-08-31', root);
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /CRLF meeting/);
});

test('a note falls back to the filename date when frontmatter has none', () => {
  const root = makeVault();
  writeNote(root, '2026/08/2026-08-19 – Standup.md', {
    plaud_id: '"f1"', title: '"Standup"', type: 'meeting', source: 'PLAUD',
  });
  const { rows } = collectMeetingNotes('2026-08-01', '2026-08-31', root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dateKey, '2026-08-19');
});
