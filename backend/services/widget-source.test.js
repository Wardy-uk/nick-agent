'use strict';

/**
 * The Scriptable widget must survive a copy/paste through Safari.
 *
 * It is the one file in this repo that reaches its runtime by being COPIED as
 * TEXT — scanned off a QR, selected in Safari, pasted into Scriptable — rather
 * than deployed. A backslash does not reliably survive that trip: `/\/+$/`
 * arrived on Nick's phone as a syntax error and the whole widget refused to
 * parse, which reads exactly like "the widget is broken" rather than "the
 * transport ate a character".
 *
 * Same species as the mistakes-log entry about regex-bearing JS in a heredoc.
 * The fix there was "don't send it through the pipeline"; here the pipeline is
 * unavoidable, so the file has to be written to survive it.
 *
 * Lives in backend/services because `node --test` is only run from backend/ —
 * it is not a backend service, and this comment is here so nobody moves it
 * somewhere "tidier" where it would silently stop running.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WIDGET = path.join(__dirname, '..', '..', 'sara', 'widget', 'neuro-attention.js');

function source() {
  return fs.readFileSync(WIDGET, 'utf8');
}

test('the widget file exists where the tests expect it', () => {
  // Positive control: without this, every assertion below would pass by
  // absence the moment the file moved.
  assert.ok(fs.existsSync(WIDGET), `expected the widget at ${WIDGET}`);
  assert.ok(source().length > 5000, 'widget source looks truncated');
});

test('the widget contains NO backslashes anywhere', () => {
  const lines = source().split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(String.fromCharCode(92)) !== -1) {
      offenders.push(`  line ${i + 1}: ${lines[i].trim()}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'Backslashes do not survive the copy/paste trip to Scriptable. Use '
    + 'String.fromCharCode() for control characters, split/join instead of '
    + 'regex replace, and endsWith/slice instead of anchored patterns.\n'
    + offenders.join('\n')
  );
});

test('the widget parses as JavaScript', () => {
  // It is never require()d by anything, so nothing else would ever catch a
  // syntax error in it before the phone did. Wrapped in an async body because
  // the script uses top-level await, exactly as Scriptable runs it.
  assert.doesNotThrow(
    () => new Function(`return (async () => { ${source()} })`),
    'widget source does not parse'
  );
});

test('the version marker is present and bumped shape', () => {
  // The marker is what makes "did my edit land?" answerable on the phone at a
  // glance; losing it costs a diagnostic round trip, which it already has once.
  assert.match(source(), /const VERSION = 'v\d+';/, 'VERSION constant missing');
});

test('the token is never hardcoded in the widget', () => {
  // The repo is public. The PIN leaked this way in July; this file is the one
  // most likely to reacquire a credential, because pasting one in is the
  // quickest way to make it work on the phone.
  const src = source();
  assert.ok(src.indexOf('Keychain.get') !== -1, 'widget should read the token from the Keychain');
  assert.ok(
    !/X-NEURO-API-TOKEN['"]\s*:\s*['"][A-Za-z0-9]{8,}/.test(src),
    'a literal token appears to be embedded in the widget'
  );
});
