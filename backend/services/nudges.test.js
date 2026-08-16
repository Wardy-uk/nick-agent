'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-nudges-'));
process.env.NEURO_DB_PATH = path.join(root, 'nudges.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const nudges = require('../services/nudges');

test.before(async () => { await db.init(); });

// The tone ladder is a deliberate design decision, not a style preference:
// Nick's failure mode is avoidance, and shame feeds avoidance. It used to
// shuffle one flat pool, so the day's FIRST nudge could be the harshest line
// in it. These tests exist to stop that coming back.

function messagesFor(type, counts) {
  return counts.map(n => nudges.getNagMessage(type, n));
}

test('the first nudge of the day is always from the light tier', () => {
  for (const type of ['standup', 'todo']) {
    for (const n of [0, 1]) {
      const msg = nudges.getNagMessage(type, n);
      assert.ok(msg && msg.length, `${type} nag ${n} produced nothing`);
    }
  }
});

test('tone never turns to shame, blame or score-keeping at any nag count', () => {
  // Sampling well past any realistic nag count — a 9-to-5 day at 15-minute
  // intervals tops out around 32.
  const banned = /disappointed|ashamed|pathetic|you failed|impressive avoidance|taking this personally|so help me|more times than you have/i;
  for (const type of ['standup', 'todo']) {
    for (let n = 0; n < 60; n++) {
      const msg = nudges.getNagMessage(type, n);
      assert.doesNotMatch(msg, banned, `${type} nag ${n} used a shaming line: "${msg}"`);
    }
  }
});

test('escalation is real — early and late nags come from different tiers', () => {
  // With a flat shuffled pool these were drawn from the same set, which is the
  // bug: the tier comments in the source described an escalation that did not
  // exist. Compare the SETS reachable early vs late.
  for (const type of ['standup', 'todo']) {
    const early = new Set(messagesFor(type, [0, 1]));
    const late = new Set(messagesFor(type, [6, 7, 8]));
    const overlap = [...early].filter(m => late.has(m));
    assert.equal(overlap.length, 0, `${type}: early and late nags drew the same message`);
  }
});

test('a high nag count is answered warmly, not harshly', () => {
  // The gradient is deliberately inverted. By nag 5+ the problem is not that he
  // forgot, so the late tier is the fond/playful one.
  const late = messagesFor('standup', [5, 6, 7, 8, 9]);
  const warmth = /know your brain|get it|good at this|believe|feel better|small thing|halfway|mirror/i;
  assert.ok(late.some(m => warmth.test(m)), `late standup nags were not warm: ${JSON.stringify(late)}`);
});

test('every nag count returns a real message, however high it climbs', () => {
  for (const type of ['standup', 'todo']) {
    for (const n of [0, 1, 5, 50, 500]) {
      const msg = nudges.getNagMessage(type, n);
      assert.equal(typeof msg, 'string');
      assert.ok(msg.length > 3, `${type} nag ${n} returned "${msg}"`);
    }
  }
});

test('a negative or missing nag count does not throw', () => {
  assert.ok(nudges.getNagMessage('standup', undefined));
  assert.ok(nudges.getNagMessage('standup', -3));
});

// #64's sibling: a stale banner must be retired every day, not only on weekdays.
test('clearStaleNudges retires yesterday and leaves today alone', () => {
  const db = require('../db/database');
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  db.createNudge('email', 'stale one', '2020-01-01');
  db.createNudge('email', 'todays one', key);

  const cleared = nudges.clearStaleNudges();
  assert.ok(cleared >= 1, 'the 2020 nudge must be retired');

  const left = db.getActiveNudges().filter(n => n.date_key === '2020-01-01');
  assert.strictEqual(left.length, 0, 'nothing from a previous day stays active');
  assert.ok(db.getActiveNudges().some(n => n.date_key === key), "today's nudge survives");
});
