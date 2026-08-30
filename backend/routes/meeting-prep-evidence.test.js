'use strict';

/**
 * Gate 4 — meeting prep must show its evidence.
 *
 * This is prep for a room Nick is about to walk into with a real colleague, and
 * the material is an AUTOMATED PARSE of 232 meeting notes whose own service
 * notes say some rows are misparses. So the standard is not "is it useful", it
 * is:
 *
 *   * every commitment says WHERE IT CAME FROM;
 *   * nothing asserts that a person failed, ignored or promised anything —
 *     it reports what a note recorded, and lets Nick weigh it;
 *   * a source that could not be READ is named, never rendered as "nothing
 *     there". "Hope owes you nothing" and "I couldn't check what Hope owes you"
 *     are opposite facts, and only one of them is good news.
 *
 * Asserted against the SOURCE, because `_buildPrep` is a private function
 * reached only through routes that need Graph, a vault and a live DB — and the
 * rules here are structural, not behavioural.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'meeting-prep-view.js');

function source() {
  // Mixed CRLF/LF repo — normalise before any line-anchored matching.
  return fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
}

test('positive control — the scan can find the prep builder at all', () => {
  const s = source();
  assert.ok(s.includes('function _buildPrep'), 'the control failed; the assertions below prove nothing');
  assert.ok(s.includes('waitingOn'), 'the commitment enrichment is gone');
});

test('a commitment carries its source note and date', () => {
  const s = source();
  const block = s.slice(s.indexOf('att.waitingOn = open.map'), s.indexOf('owed.push'));
  assert.ok(block.includes('sourcePath'), 'the note it came from must reach the prep sheet');
  assert.ok(block.includes('sourceDate'), 'and when it was said');
  // `source_path` sat in the table unused for the whole life of the feature.
  // Dropping it here put an unattributed "they owe you this" in front of Nick.
  assert.ok(block.includes('sightings'), 'how many times it has been seen is part of weighing it');
});

test('the topic line ATTRIBUTES rather than asserts', () => {
  const s = source();
  // It used to read `${open.length} outstanding from ${first}` — stating as
  // fact that a named colleague owes something, on the strength of a parse.
  assert.ok(
    !/\$\{open\.length\} outstanding from \$\{first\}/.test(s),
    'the unattributed assertion is back'
  );
  assert.ok(s.includes('Noted as outstanding for'), 'the attributed phrasing is gone');
  // And an unattributed row says so rather than hiding the absence.
  assert.ok(s.includes('no source recorded'), 'a commitment with no source must admit it');
});

test('every enrichment failure is NAMED in prep.gaps', () => {
  const s = source();
  const start = s.indexOf('function _buildPrep');
  const body = s.slice(start);
  assert.ok(body.includes('gaps: []'), 'prep must carry a gaps array');

  // ⚠ The real assertion: no silent catch survives inside the builder. Each one
  // used to fail to a console.warn or to nothing at all, so an unreachable
  // vault rendered as a prep sheet with no commitments on it — indistinguishable
  // from a colleague who owes Nick nothing.
  const end = body.indexOf('\nfunction ', 1);
  const builder = end === -1 ? body : body.slice(0, end);
  assert.equal(
    (builder.match(/\} catch \{\}/g) || []).length,
    0,
    'a silent catch in the prep builder renders an unread source as an empty one'
  );
  const pushes = (builder.match(/prep\.gaps\.push/g) || []).length;
  assert.ok(pushes >= 5, `expected every enrichment to name its failure, found ${pushes}`);
});

test('sending still requires confirmation — prep drafts nothing outbound', () => {
  const s = source();
  // Gate 4's hard rule: drafting is allowed, sending is not, and this file must
  // not acquire a send path by accident. `waiting-on.queueChase` remains the
  // only route to a chase, and it queues a sara_action for approval.
  for (const name of ['sendMail(', 'sendDm(', 'graphWrite(']) {
    assert.ok(!s.includes(name), `meeting prep must not call ${name} — sending needs explicit approval`);
  }
});
