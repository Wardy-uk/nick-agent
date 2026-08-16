'use strict';

/**
 * #119 — `npm test` used to write to the real vault.
 *
 * `npm test` is bare `node --test`, which globs `test-*.js`, `*-test.js`,
 * `*_test.js` and `test.js` anywhere under the cwd. All four Tier smoke scripts
 * were named `test-*.js`, so they ran on every invocation and were counted in
 * the suite total while asserting nothing. `test-tier1.js` defaulted
 * OBSIDIAN_VAULT_PATH to Nick's real vault and created a prep note and a meeting
 * note in it, unlinking them afterwards — so every test run churned a live
 * Syncthing-replicated vault, and a throw between create and unlink left a stray
 * note behind. It also made the suite count differ by machine, depending on
 * whether that hardcoded path resolved.
 *
 * Two things are pinned here, and the first is the load-bearing one: the scripts
 * are no longer DISCOVERABLE. Renaming them to `smoke-*` is what takes them out
 * of the suite; refusing to run without an explicit vault path is the belt to
 * that braces, and covers running one by hand.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCRIPTS = path.join(__dirname);

// The globs `node --test` uses to discover a file as a test. `*.test.js` is
// deliberately absent: that IS the convention for real tests in this repo
// (this file included), so matching it would be the wrong assertion.
const DISCOVERED_AS_TEST = [/^test-.*\.js$/, /^.*-test\.js$/, /^.*_test\.js$/, /^test\.js$/];

test('no script in backend/scripts is discovered by node --test', () => {
  const files = fs.readdirSync(SCRIPTS).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 0, 'sanity: expected to find scripts to check');

  const discovered = files.filter(f => DISCOVERED_AS_TEST.some(re => re.test(f)));
  assert.deepStrictEqual(
    discovered, [],
    `these would run on every npm test while asserting nothing: ${discovered.join(', ')}. ` +
    'Name a smoke script `smoke-*.js`, not `test-*.js`.'
  );
});

test('every smoke script refuses to run without an explicit vault path', () => {
  const smoke = fs.readdirSync(SCRIPTS).filter(f => /^smoke-.*\.js$/.test(f));
  assert.ok(smoke.length >= 3, `sanity: expected the Tier smoke scripts, found ${smoke.length}`);

  for (const f of smoke) {
    const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');

    // Positive assertion first. A "does not contain X" check over a file we
    // failed to read properly passes by absence, which is worthless — so prove
    // we are looking at real source before asserting anything is missing.
    assert.ok(src.length > 200, `sanity: ${f} looks empty`);
    assert.ok(
      src.includes('OBSIDIAN_VAULT_PATH'),
      `sanity: ${f} does not mention OBSIDIAN_VAULT_PATH at all`
    );

    // smoke-apply-matrix builds its own mkdtemp vault and never reads the env
    // var as an input, so it has nothing to refuse.
    if (f === 'smoke-apply-matrix.js') continue;

    assert.match(
      src, /Refusing to run/,
      `${f} must refuse to run when OBSIDIAN_VAULT_PATH is unset`
    );
    assert.ok(
      !/Nicks knowledge base/.test(src),
      `${f} hardcodes the real vault path — that default is the whole bug`
    );
  }
});
