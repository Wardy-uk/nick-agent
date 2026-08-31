'use strict';

// Nick's location INSIDE the house, on the mount that is exempt from the PIN and
// reachable from the public internet. The boundary is the product here, so every
// test below is a refusal.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const capture = require('../services/capture-links');

test('`presence` is NOT a default scope', () => {
  // An account created without asking for it must never receive it.
  assert.ok(!capture.normaliseScopes(undefined).includes('presence'));
  assert.ok(!capture.normaliseScopes([]).includes('presence'));
  assert.ok(!capture.normaliseScopes(['tasks']).includes('presence'));
});

test('it is never bundled with another scope', () => {
  // Wanting the shopping list is not consent to being told which room he is in.
  for (const s of ['calendar', 'kitchen', 'shared-tasks']) {
    assert.ok(!capture.normaliseScopes([s]).includes('presence'),
      `${s} must not carry presence with it`);
  }
});

test('it can be granted deliberately, and revoked', () => {
  const granted = capture.normaliseScopes(['tasks', 'presence']);
  assert.ok(granted.includes('presence'));
  assert.ok(!capture.normaliseScopes(['tasks']).includes('presence'));
});

// ⚠ The route must not mount the block at all without the scope — absent, not
// hidden. A client filtering it out would mean the boundary had moved into the
// browser, which is the one thing this mount may never rely on.
test('the home route mounts presence ONLY behind the scope', () => {
  const src = require('fs').readFileSync(require.resolve('./vesta.js'), 'utf8');
  const idx = src.indexOf('out.presence');
  assert.ok(idx > 0, 'the block exists');
  const guard = src.lastIndexOf("hasScope(req.account, 'presence')", idx);
  assert.ok(guard > 0 && guard < idx, 'every write to out.presence sits inside the scope check');
});

// ⚠ Coarse by construction. A room name is "he is in the kitchen"; a stream of
// signal strengths and timestamps is a record of what someone did all day.
test('nothing but the room name can reach her', () => {
  const src = require('fs').readFileSync(require.resolve('./vesta.js'), 'utf8');
  const block = src.slice(src.indexOf("hasScope(req.account, 'presence')"),
    src.indexOf('// ── Calendar'));
  // ⚠ Comments STRIPPED before scanning. The first version of this test read the
  // raw block and failed on the comment that lists these very fields to say they
  // are excluded — a guard that cannot tell a mention from a use is a guard that
  // punishes documenting the rule.
  const NL = String.fromCharCode(10);
  const code = block
    .split(NL)
    .filter((l) => !l.trim().startsWith('//'))
    .join(NL);
  for (const leak of ['rssi', 'scores', 'margin', 'sensors', 'history', 'confidence']) {
    assert.ok(!code.includes(leak), `${leak} must not reach the public mount`);
  }
  // Positive control: the thing that IS meant to be there still is, so this
  // cannot pass by having scanned the wrong slice of the file. It has already
  // earned its keep once — it caught `room: r.room` becoming `room: w.room`
  // when the whereabouts layer landed, which a leak-only scan would have waved
  // through while silently checking nothing.
  assert.ok(code.includes('room: w.room'), 'the room itself is sent');
  assert.ok(code.includes('label: w.label'), 'and the phrase she actually reads');
});

test('an unreadable room is a named gap, never a guessed room', () => {
  const src = require('fs').readFileSync(require.resolve('./vesta.js'), 'utf8');
  const block = src.slice(src.indexOf("hasScope(req.account, 'presence')"),
    src.indexOf('// ── Calendar'));
  assert.ok(block.includes('known: false'), 'a failure reports itself');
  assert.ok(!block.includes('|| null') || block.includes("known: true"),
    'no silent fallback to an unstated room');
});
