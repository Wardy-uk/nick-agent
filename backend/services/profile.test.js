'use strict';

/**
 * What SARA knows about Nick as a person.
 *
 * Two tests carry this file. `provenance survives into the context block`,
 * because a fact recovered from a ChatGPT memory dump entitles her to a
 * different sentence from one he said last Tuesday. And the stability test,
 * asserted on the rendered TEXT rather than the parsed fields — the identical
 * bug bit `catalogue.js` the same morning and its field-comparing test could
 * never see it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-profile-'));
process.env.OBSIDIAN_VAULT_PATH = root;

const profile = require('./profile');

// ── The format holds up to being hand-edited ─────────────────────────────────

test('facts parse with their source and date', () => {
  const p = profile.parse([
    '## Outside work', '',
    '- Plays D&D and runs a campaign <!--p:interview 2026-08-31-->',
    '- Likes hiking <!--p:seed-->', '',
  ].join('\n'));

  const outside = p.facts['outside work'];
  assert.equal(outside.length, 2);
  assert.equal(outside[0].source, 'interview');
  assert.equal(outside[0].at, '2026-08-31');
  assert.equal(outside[1].source, 'seed');
  assert.equal(outside[1].at, null);
});

test('⚠ an EMPTY profile does not grow on every save', () => {
  // `render` writes a blockquote intro and an *(nothing yet)* placeholder. Left
  // unrecognised by `parse` they are preserved into `preamble`, written again
  // under the header, and read back on the next save — one more copy per write,
  // for ever. Every NEW profile is empty, so every profile would have it.
  //
  // ⚠ Asserted on the TEXT. A test comparing parsed fields is blind to this,
  // which is exactly how it survived in catalogue.js until this morning.
  const first = profile.render(profile.parse(''), { today: '2026-08-31' });
  let text = first;
  for (let i = 0; i < 4; i += 1) {
    text = profile.render(profile.parse(text), { today: '2026-08-31' });
  }
  assert.equal(text, first, 'four saves must leave the file byte-identical');
});

test('a populated profile is stable too', () => {
  const md = profile.render(
    profile.parse('## Outside work\n\n- Plays D&D <!--p:interview 2026-08-31-->\n'),
    { today: '2026-08-31' },
  );
  assert.equal(profile.render(profile.parse(md), { today: '2026-08-31' }), md);
});

test('a line he typed himself is PRESERVED', () => {
  // It is a file about him and he will edit it. A writer that silently drops
  // what it did not expect is one he stops trusting with the thing he most
  // needs it to hold.
  const md = '## Outside work\n\n- Plays D&D <!--p:interview-->\n\nSome note I added myself.\n';
  assert.ok(profile.render(profile.parse(md)).includes('Some note I added myself.'));
});

// ── Provenance ───────────────────────────────────────────────────────────────

test('⚠ provenance survives into the context block, and changes the wording', () => {
  // "I think you mentioned" is a different sentence from "you told me", and
  // letting her speak with equal confidence about both is how a half-remembered
  // detail from an old chat export becomes a confident assertion about his life.
  const p = profile.parse([
    '## Outside work', '',
    '- Plays D&D and runs a campaign <!--p:interview 2026-08-31-->',
    '- Once mentioned liking hiking <!--p:seed-->', '',
  ].join('\n'));

  const block = profile.contextBlock(p);
  assert.match(block, /Plays D&D and runs a campaign \(told me\)/);
  assert.match(block, /Once mentioned liking hiking \(mentioned\)/);
  assert.match(block, /hold the first more loosely/, 'and the difference is explained to her');
});

test('an empty profile produces NO block at all', () => {
  // An empty block costs tokens to say nothing, and worse would read to her as
  // "he has no personal life" rather than "nobody has told me yet".
  assert.equal(profile.contextBlock(profile.parse('')), null);
  assert.equal(profile.contextBlock(null), null);
});

test('gaps name what the interview should still go after', () => {
  const p = profile.parse('## Outside work\n\n- Plays D&D <!--p:interview-->\n');
  const gaps = profile.gaps(p);
  assert.ok(!gaps.includes('Outside work'));
  assert.ok(gaps.includes('People who matter'));
  assert.equal(gaps.length, profile.SECTIONS.length - 1);
});

// ── Writing ──────────────────────────────────────────────────────────────────

test('facts round-trip to a real file in the vault', () => {
  const result = profile.addFacts(
    [{ text: 'Plays D&D and runs a campaign', section: 'Outside work' }],
    { source: 'interview', at: '2026-08-31' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.added.length, 1);

  const file = path.join(root, 'Me', 'About Nick.md');
  assert.ok(fs.existsSync(file), 'it really is a file in the vault');
  const text = fs.readFileSync(file, 'utf-8');
  assert.match(text, /Plays D&D/);
  assert.match(text, /private: true/, 'and it is marked private');
});

test('the same fact twice is one fact', () => {
  // He will mention D&D more than once. A profile that grows a duplicate every
  // time is one that stops being readable.
  const again = profile.addFacts(
    [{ text: 'plays d&d and runs a campaign', section: 'Outside work' }],
    { source: 'conversation' },
  );
  assert.equal(again.added.length, 0);
  assert.equal(again.duplicates.length, 1);
});

test('an unknown section falls into the catch-all rather than inventing a heading', () => {
  // A model must not be able to grow the shape of the file. Only Nick can, by
  // editing it.
  profile.addFacts([{ text: 'Something uncategorised', section: 'Wildly Invented Heading' }], { source: 'seed' });
  const found = profile.read();
  assert.ok(!found.profile.sections.includes('Wildly Invented Heading'));
  assert.ok(found.profile.facts['what i care about'].some(f => f.text === 'Something uncategorised'));
});

test('an empty fact list writes nothing at all', () => {
  const before = fs.readFileSync(path.join(root, 'Me', 'About Nick.md'), 'utf-8');
  profile.addFacts([{ text: '   ' }], { source: 'seed' });
  assert.equal(fs.readFileSync(path.join(root, 'Me', 'About Nick.md'), 'utf-8'), before);
});
