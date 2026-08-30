'use strict';

/**
 * The desktop surfaces must consume the canonical attention contract.
 *
 * ⚠ THE REGRESSION THIS EXISTS FOR. `BriefingPanel` POSTed
 * `/api/focus/action-done` when Nick pressed "Do it". That route calls
 * `nextActionEngine.logOutcome()` and `engine.dismiss()` — so the button that
 * merely OPENED a thing recorded it as a completed outcome and hid the card.
 * The card vanishing looks exactly like the button having worked, which is why
 * it survived so long.
 *
 * There is no state of the world in which starting or opening something should
 * log a completion, so the assertion is absolute: no desktop panel references
 * that route at all. A grep is the right shape of test here — the failure was a
 * URL string, and the desktop has no test runner of its own.
 *
 * Lives in backend/services because `node --test` is only run from backend/.
 * It is not a backend service, and this comment is here so nobody moves it
 * somewhere "tidier" where it would silently stop running.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const COMPONENTS = path.join(__dirname, '..', '..', 'frontend', 'src', 'components');
const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function read(rel, base = COMPONENTS) {
  return fs.readFileSync(path.join(base, rel), 'utf-8');
}

/**
 * Code only.
 *
 * ⚠ The comments in these files DESCRIBE the bug — several of them name
 * `/api/focus/action-done` in order to say why it is gone — and a rule that
 * fails on its own explanation would be a rule that pressures the next person
 * to delete the explanation. The rule here is about what the file CALLS, so the
 * prose is stripped before it is applied. (Note this is the opposite call from
 * `widget-source.test.js`, and deliberately: that rule is about the bytes
 * surviving a copy/paste, so a backslash in a comment breaks it for real.)
 */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

// Every desktop file that renders work. Listed rather than globbed, so adding a
// new work surface is a deliberate act that includes adding it here.
const WORK_SURFACES = ['BriefingPanel.jsx', 'FocusPanel.jsx', 'AdhdPanel.jsx', 'AttentionCard.jsx'];

test('no desktop work surface logs an outcome — /api/focus/action-done is gone', () => {
  for (const file of WORK_SURFACES) {
    const source = code(read(file));
    assert.ok(
      !source.includes('action-done'),
      `${file} still references /api/focus/action-done — that logs a completed outcome and dismisses the item`
    );
  }
  // Positive control: the route itself still exists (it stays for backward
  // compatibility), so a passing test above means the CALLERS were removed and
  // not that the string vanished from the repo.
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'focus.js'), 'utf-8');
  assert.ok(routeSource.includes('/action-done'), 'positive control: the legacy route should still be registered');
});

test('the desktop work surfaces render the shared canonical card, not their own', () => {
  for (const file of ['BriefingPanel.jsx', 'FocusPanel.jsx', 'AdhdPanel.jsx']) {
    const source = read(file);
    assert.ok(source.includes('AttentionCard'), `${file} must render the shared AttentionCard`);
    assert.ok(source.includes('useAttention'), `${file} must read the canonical feed`);
  }
});

test('opening an item calls nothing — navigation is not an action', () => {
  const card = read('AttentionCard.jsx');
  // The `open` handler must resolve a destination and navigate. If it ever
  // acquires a request, that request is the next `action-done`.
  const openBody = card.slice(card.indexOf('const open = ()'), card.indexOf('const start = ()'));
  assert.ok(openBody.length > 0, 'the open handler should be findable');
  assert.ok(!/apiFetch|fetch\(/.test(openBody), 'Open context must not make a request');
  assert.ok(openBody.includes('onNavigate'), 'Open context must navigate');
});

test('starting a session tells the record and moves no state', () => {
  const card = read('AttentionCard.jsx');
  const startBody = card.slice(card.indexOf('const start = ()'), card.indexOf('const done = ()'));
  assert.ok(startBody.includes('/api/session/start'), 'Start this must start a focus session');
  // The only lifecycle call it may make is `start`, which is a no-op on state.
  assert.ok(startBody.includes("onAct?.(card, 'start')"));
  for (const forbidden of ["'complete'", "'dismiss'", "'defer'", "'acknowledge'"]) {
    assert.ok(!startBody.includes(forbidden), `Start this must not submit ${forbidden}`);
  }
});

test('the legacy suppression path is reachable ONLY when a card has no record', () => {
  const hook = code(fs.readFileSync(path.join(SRC, 'useAttention.js'), 'utf-8'));
  // The canonical branch is guarded on `card.recordId` and returns before the
  // fallback. If that guard ever goes, both paths run and the surfaces silently
  // drift back to the suppression timer.
  const actBody = hook.slice(hook.indexOf('const act = useCallback'));
  const canonicalAt = actBody.indexOf('if (card.recordId)');
  const legacyAt = actBody.indexOf('LEGACY[action]');
  assert.ok(canonicalAt > -1, 'the canonical branch must be guarded on recordId');
  assert.ok(legacyAt > canonicalAt, 'the legacy branch must sit after the canonical one');
  // And `action-done` must not be among the legacy paths at all.
  assert.ok(!hook.includes('action-done'));
});

test('an unreadable pool is never rendered as a clear day on any desktop surface', () => {
  for (const file of ['BriefingPanel.jsx', 'FocusPanel.jsx', 'AdhdPanel.jsx']) {
    const source = read(file);
    assert.ok(
      source.includes('poolAvailable === false'),
      `${file} must distinguish "I could not see your work" from "nothing pending"`
    );
    assert.ok(
      /not an all-clear/i.test(source),
      `${file} must say out loud that an unreadable pool is not an all-clear`
    );
  }
});
