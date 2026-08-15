'use strict';

/**
 * The content-hash gate, pinned against the flood it exists to stop.
 *
 * `scanRecentNotes` selects notes by file MTIME inside a 7-day window. On 14 Aug
 * the restamp-people backfill rewrote `people:` frontmatter across ~229 meeting
 * notes; every mtime jumped into the window, the nightly sweep re-read the
 * entire meetings corpus, and 911 candidates landed in one night. One
 * automation's bulk rewrite triggering another's flood is why this recurs on
 * every clean-up pass.
 *
 * The property: a rewrite that does not change the BODY is a no-op.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-candidates-'));
const vault = path.join(root, 'vault');
fs.mkdirSync(path.join(vault, 'Meetings', '2026', '08'), { recursive: true });
process.env.NEURO_DB_PATH = path.join(root, 'candidates.db');
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const { syncNoteActionCandidates } = require('./action-candidates');

const REL = 'Meetings/2026/08/2026-08-14 – ProCo review.md';

function write(frontmatterStamp, body) {
  const content = [
    '---',
    'type: note',
    `updated: ${frontmatterStamp}`,
    'people:',
    '  - "[[People/Stephen Mitchell]]"',
    '---',
    '',
    body,
  ].join('\n');
  fs.writeFileSync(path.join(vault, REL), content, 'utf-8');
}

// PLAUD states ownership in the prose, which is what extractMeetingActions reads.
const BODY_ONE = [
  '## Next Arrangements',
  '- Nick to send Stephen the revised rota',
  '- Nick to chase finance for the ProCo approval',
].join('\n');

test.before(async () => { await db.init(); });

test('the first pass extracts candidates', () => {
  write('2026-08-13', BODY_ONE);
  const r = syncNoteActionCandidates(REL);
  assert.ok(r.created > 0, 'expected candidates on first sight');
});

test('a frontmatter-only restamp creates nothing — this is the 911 bug', () => {
  // Exactly what restamp-people does: rewrite the `people:` block, bump the
  // stamp, leave the body alone. The mtime moves; the content does not.
  write('2026-08-14', BODY_ONE);
  const r = syncNoteActionCandidates(REL);
  assert.equal(r.unchanged, true, 'an unchanged body must short-circuit');
  assert.equal(r.created, 0);
});

test('a real edit to the body is still picked up', () => {
  write('2026-08-14', `${BODY_ONE}\n- Nick to book the Q4 capacity review with Catherine`);
  const r = syncNoteActionCandidates(REL);
  assert.notEqual(r.unchanged, true);
  assert.ok(r.created > 0, 'a new action line must produce a new candidate');
});
