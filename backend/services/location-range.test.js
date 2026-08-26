'use strict';

const test = require('node:test');
const assert = require('node:assert');

const location = require('./location');

// The OwnTracks recorder query window. Two silent bugs lived in the one line
// this replaces, and neither threw: a slash-separated date the API rejects as
// plain text, and a UTC date that names the wrong day through BST.

test('the recorder window is dash-separated, not slashes', () => {
  // Slashes are the recorder's storage-path convention. As a QUERY they return
  // "impossible date/time ranges" as plain text, which JSON.parse turns into an
  // exception and the catch turns into an empty day. Verified against the live
  // recorder: dashes return {"data":[...]}, slashes never have.
  const { from, to } = location._todayRange(new Date('2026-08-26T12:00:00'));
  assert.equal(from, '2026-08-26T00:00:00');
  assert.equal(to, '2026-08-26T23:59:59');
  assert.ok(!from.includes('/'), 'a slash here silently empties the whole day');
});

test('the date is LOCAL, never toISOString', () => {
  // 00:30 local is still YESTERDAY in UTC anywhere east of Greenwich, so under
  // BST the old toISOString() code asked the recorder for the wrong day for the
  // first hour of every summer morning. Constructed with local components so the
  // intent is unambiguous rather than depending on how a string is parsed.
  const earlyBst = new Date(2026, 7, 26, 0, 30, 0); // 26 Aug, 00:30 local
  assert.equal(location._todayRange(earlyBst).from.slice(0, 10), '2026-08-26');

  // Only assert the divergence where the runner's clock actually diverges —
  // on a UTC box local and UTC agree and there is nothing to catch, and a test
  // that pretends otherwise fails on the machine rather than on the code.
  if (earlyBst.toISOString().slice(0, 10) !== '2026-08-26') {
    assert.notEqual(location._todayRange(earlyBst).from.slice(0, 10), earlyBst.toISOString().slice(0, 10));
  }
});

test('months and days are zero-padded', () => {
  const { from } = location._todayRange(new Date('2026-01-05T09:00:00'));
  assert.equal(from, '2026-01-05T00:00:00');
});

test('no trailing Z — the recorder reads naive times in its own timezone', () => {
  const { from, to } = location._todayRange(new Date('2026-08-26T12:00:00'));
  assert.ok(!from.endsWith('Z') && !to.endsWith('Z'));
});
