'use strict';

// One phrase for where Nick is. Pure, so it pins without a house or an HA.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { describe: where } = require('./whereabouts');

const inRoom = (r) => ({ known: true, room: r, subject: 'watch' });
const noRoom = (why) => ({ known: false, room: null, why });

test('a known room wins, and reads like a place', () => {
  const w = where(inRoom('living-room'), 'home');
  assert.equal(w.label, 'Living Room');
  assert.equal(w.kind, 'room');
  assert.equal(w.subject, 'watch', 'it measured the watch and says so');
});

test('the office zone becomes "At Work"', () => {
  const w = where(noRoom('not heard'), 'office');
  assert.equal(w.label, 'At Work');
  assert.equal(w.kind, 'zone');
});

test('a zone nobody mapped still renders, title-cased', () => {
  // So adding a zone in HA needs no code change here.
  assert.equal(where(noRoom('x'), 'gym').label, 'At Gym');
});

// ⚠ The load-bearing refusal. zone.home is a 100m circle centred 90m from where
// Nick sits, so he lives on its edge and jitter reports not_home while he is at
// home. Rendering anything from it would tell his family he had gone out.
test('home and not_home are NOT places, and render nothing', () => {
  for (const z of ['home', 'not_home', 'unknown', 'unavailable', '', null, undefined]) {
    const w = where(noRoom('not heard'), z);
    assert.equal(w.known, false, `${z} must not become a label`);
    assert.equal(w.label, null);
  }
});

test('a room beats a zone, because it is the finer answer', () => {
  const w = where(inRoom('kitchen'), 'office');
  assert.equal(w.label, 'Kitchen');
});

test('knowing nothing keeps the room reader\'s own reason', () => {
  const w = where(noRoom('no rooms have been calibrated'), null);
  assert.equal(w.known, false);
  assert.match(w.why, /calibrated/);
});

test('case and padding on a zone name do not matter', () => {
  assert.equal(where(noRoom('x'), '  Office ').label, 'At Work');
});
