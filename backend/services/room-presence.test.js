'use strict';

// Reading the room from SARA. The tests that matter are the refusals: this is
// meant to feed automation, and a confident wrong room turns lights on above
// someone who is not there.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const rp = require('./room-presence');

function withFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  rp._reset();
  return fn().finally(() => { global.fetch = real; rp._reset(); });
}
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('a sure room is reported, and says it measured the WATCH', async () => {
  await withFetch(ok({ room: 'kitchen', confidence: 'sure', margin: 2.9, checkedAt: 'T' }), async () => {
    const r = await rp.read();
    assert.equal(r.known, true);
    assert.equal(r.room, 'kitchen');
    assert.equal(r.subject, 'watch', 'never silently a claim about where the man is');
  });
});

// ⚠ Each of the classifier's three refusals must survive the trip intact.
test('unsure is NOT a location, and keeps the reason', async () => {
  await withFetch(ok({ room: 'kitchen', confidence: 'unsure', why: 'kitchen and bedroom are close' }), async () => {
    const r = await rp.read();
    assert.equal(r.known, false, 'a coin toss between two rooms is not a location');
    assert.equal(r.room, null);
    assert.match(r.why, /close/);
  });
});

test('none is not a location', async () => {
  await withFetch(ok({ room: null, confidence: 'none', why: 'no rooms have been calibrated' }), async () => {
    const r = await rp.read();
    assert.equal(r.known, false);
    assert.match(r.why, /calibrated/);
  });
});

test('an unreachable SARA is unknown, never a room', async () => {
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    const r = await rp.read();
    assert.equal(r.known, false);
    assert.equal(r.room, null);
    assert.match(r.why, /could not reach/);
  });
});

// ⚠ A 200 carrying the wrong shape is not an answer — a proxy error page parses
// as JSON perfectly well and has no `confidence` in it.
test('a 200 with the wrong shape is refused', async () => {
  for (const body of [{ error: 'nope' }, {}, null, { room: 'kitchen' }]) {
    await withFetch(ok(body), async () => {
      const r = await rp.read();
      assert.equal(r.known, false);
      assert.equal(r.room, null);
    });
  }
});

test('a non-200 is unknown', async () => {
  await withFetch(async () => ({ ok: false, status: 502, json: async () => ({}) }), async () => {
    assert.equal((await rp.read()).known, false);
  });
});

test('the answer is cached, so polling surfaces do not hammer SARA', async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ room: 'kitchen', confidence: 'sure' }) }; }, async () => {
    await rp.read(); await rp.read(); await rp.read();
    assert.equal(calls, 1);
  });
});
