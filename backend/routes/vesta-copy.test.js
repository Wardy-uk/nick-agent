'use strict';

/**
 * VESTA names Nick. It never says "his".
 *
 * Nick, 31 Aug 2026: *"vesta should not say 'his' anything — it should always be
 * 'Nicks'. eg Nicks Calendar."*
 *
 * The reason is what makes it worth a test rather than a one-off edit: VESTA is
 * a SHARED surface that two people read. A third-person pronoun makes it sound
 * like a system describing somebody who is not in the room — which is exactly
 * what it should not feel like to the person holding the phone.
 *
 * ⚠ Scanned from the SOURCE, like `widget-source.test.js` and
 * `push-types.test.js`, because `vesta/` has no test runner of its own — the
 * backend suite is the only thing that will ever read these files. Comments are
 * stripped first: this is a rule about what is RENDERED, and the notes
 * explaining the rule necessarily contain the words it bans (the exemption
 * `widget-source.test.js` had to remove for exactly that reason is instructive —
 * a rule with a carve-out for the bits describing it is not a rule, so here the
 * comments are removed rather than exempted).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'vesta', 'src');

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(jsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Everything a reader could see: source minus comments. */
function rendered(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments, incl. JSX {/* ... */}
    .replace(/^\s*\/\/.*$/gm, ' ')       // whole-line comments
    .replace(/\s\/\/.*$/gm, ' ');        // trailing comments
}

// Third person about Nick. `she`/`her` are not banned — VESTA is written TO the
// person using it, and those appear in no rendered string anyway.
const THIRD_PERSON = /\b(his|him)\b/i;

test('no rendered string in VESTA refers to Nick in the third person', () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 5, 'the scan must actually be reading the app');

  const offences = [];
  for (const file of files) {
    const body = rendered(fs.readFileSync(file, 'utf-8'));
    body.split('\n').forEach((line, i) => {
      if (THIRD_PERSON.test(line)) {
        offences.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }

  assert.deepEqual(offences, [], `VESTA must name Nick, not say "his":\n${offences.join('\n')}`);
});

/**
 * ⚠ The positive control. Without it this test passes just as well when the
 * scan is broken, the directory has moved, or the comment-stripper eats the
 * whole file — which is the failure this codebase has shipped more than once.
 */
test('the scan would actually catch it', () => {
  assert.ok(THIRD_PERSON.test('<Section title="His diary">'), 'must catch the original wording');
  assert.ok(THIRD_PERSON.test('the details are his'), 'and a trailing one');
  // And must NOT fire on the words it would be annoying to ban.
  assert.equal(THIRD_PERSON.test('const hidden = true;'), false);
  assert.equal(THIRD_PERSON.test('className="shelf"'), false);
  assert.equal(THIRD_PERSON.test('history.push()'), false);

  // The stripper must remove a comment, and only a comment.
  const sample = '/* his diary */\nconst title = "Nick\'s calendar"; // his\n';
  assert.equal(THIRD_PERSON.test(rendered(sample)), false);
  assert.ok(rendered(sample).includes("Nick's calendar"), 'and must not eat the code');
});
