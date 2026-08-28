'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ═══════════════════════════════════════════════════════
// Transcripts live where PLAUD_TRANSCRIPT_FOLDER says (27 Aug 2026)
//
// `plaud-sync` writes transcripts to `PLAUD_TRANSCRIPT_FOLDER`, which the Pi sets
// to `Plaud/Transcripts` — all 311 are there. Two other places still name the
// code default `Meetings/transcripts`, which holds ZERO files. Scanning an empty
// folder finds nothing and raises nothing, which is why neither was noticed:
//
//   1. knowledge-memory's RAW_FOLDERS — the raw-intake pass had never read a
//      transcript, and the +3 promotion score for one was dead code.
//   2. imports.canonicalizePlaudTranscript — would relocate all 311 and leave
//      every summary's `transcript_path:` pointing at a file that had moved.
//
// Same species as the metric-name mismatch in apple-health and the `get_file`
// parse bug the same day: a wrong path returns zero rows, not an error.
// ═══════════════════════════════════════════════════════

const { RAW_FOLDERS } = require('./knowledge-memory');

test('the raw-intake scan covers the folder transcripts are actually in', () => {
  assert.ok(
    RAW_FOLDERS.includes('Plaud/Transcripts'),
    'the configured transcript folder must be scanned, or no transcript is ever raw intake'
  );

  // The old location is KEPT, not swapped: canonicalizePlaudTranscript can still
  // put a rescued stray there, and a folder that is empty today is not a folder
  // that stays empty.
  assert.ok(RAW_FOLDERS.includes('Meetings/transcripts'));
});

// The guard is a pure prefix decision, restated here so it pins without a vault.
// It must read the SAME env var plaud-sync writes with, or the two disagree about
// where a transcript belongs and the disagreement is a mass file move.
function alreadyInPlace(currentRelative, configuredFolder) {
  const root = String(configuredFolder || 'Meetings/transcripts')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return currentRelative.startsWith(`${root}/`);
}

test('a transcript already in the configured folder is never relocated', () => {
  const cfg = 'Plaud/Transcripts';

  assert.equal(alreadyInPlace('Plaud/Transcripts/2026-08-25 Weekly-Sync.md', cfg), true);
  // Trailing/leading slashes and backslashes must not defeat the match.
  assert.equal(alreadyInPlace('Plaud/Transcripts/x.md', '/Plaud/Transcripts/'), true);
  assert.equal(alreadyInPlace('Plaud/Transcripts/x.md', 'Plaud\\Transcripts'), true);
});

test('a genuinely stray transcript is still rescued', () => {
  const cfg = 'Plaud/Transcripts';

  // The case canonicalizePlaudTranscript exists for — must NOT be short-circuited.
  assert.equal(alreadyInPlace('Imports/some-loose-transcript.md', cfg), false);
  assert.equal(alreadyInPlace('Meetings/2026/08/stray.md', cfg), false);

  // A near-miss folder name is not the configured one.
  assert.equal(alreadyInPlace('Plaud/TranscriptsOld/x.md', cfg), false);
  assert.equal(alreadyInPlace('Meetings/_transcripts/x.md', cfg), false);
});

test('with no env var set, the default folder is what is protected', () => {
  // Unconfigured deployments keep the original behaviour exactly.
  assert.equal(alreadyInPlace('Meetings/transcripts/2026/08/x.md', undefined), true);
  assert.equal(alreadyInPlace('Plaud/Transcripts/x.md', undefined), false);
});

// ═══════════════════════════════════════════════════════
// Frontmatter quotes (27 Aug 2026)
//
// `parseFrontmatter` does NOT strip surrounding quotes, and plaud-sync writes
// every scalar quoted. `normalizePlaudId` in knowledge-memory already stripped
// them — which is why grouping by id worked while everything else silently did
// not. Two consequences, both invisible: the note_type split never matched, and
// `new Date('"2026-07-16T..."')` is Invalid Date, so a consolidated note for a
// July meeting was dated TODAY and filed under the current month.
// ═══════════════════════════════════════════════════════

const cleanQuoted = (value) => String(value || '').trim().replace(/^"+|"+$/g, '');

test('a quoted frontmatter date must not silently become today', () => {
  const quoted = '"2026-07-16T13:00:44"';

  // The bug: quoted value parses to Invalid Date, and the fallback is now().
  assert.ok(Number.isNaN(new Date(quoted).getTime()), 'precondition: quoted date is unparseable');

  const fixed = new Date(cleanQuoted(quoted));
  assert.ok(!Number.isNaN(fixed.getTime()));
  assert.equal(fixed.toISOString().slice(0, 7), '2026-07', 'must keep the meeting month, not the sync month');
});

test('quoted note_type must still match', () => {
  assert.notEqual('"summary"', 'summary', 'precondition: the raw value carries its quotes');
  assert.equal(cleanQuoted('"summary"'), 'summary');
  assert.equal(cleanQuoted('"transcript"'), 'transcript');
  assert.equal(cleanQuoted('summary'), 'summary', 'unquoted legacy notes keep working');
  assert.equal(cleanQuoted(undefined), '');
});
