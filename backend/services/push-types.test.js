'use strict';

/**
 * Every notification type production SENDS must be a decision, not an accident.
 *
 * `meeting_prep` sat outside ALWAYS_DELIVER for the whole life of the governor.
 * briefing.js sends `meeting_alert` (listed); meeting-prep.js sends
 * `meeting_prep` (not listed) — so the "Meeting in 25 min" alert carrying the
 * prep notes was suppressible, and the live pm2 log shows the hourly cap
 * swallowing seven real 1-2-1 reminders. webpush.test.js was green throughout
 * because it asserted the bypass using `meeting_alert`, a string that code path
 * never sends. A test over an invented name proves nothing about the real one.
 *
 * So this reads the SOURCE, the way action-presenter.test.js parses
 * executeAction's case labels: adding a sendToAll with a new type fails here
 * until someone classifies it, rather than surfacing months later as a nudge
 * that quietly never arrives.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ALWAYS_DELIVER } = require('./webpush');

/**
 * Types that are deliberately suppressible: routine nagging, digests and
 * scheduled reports. Being here means "we thought about it and the governor
 * should be free to drop this one", which is a different statement from
 * "nobody has looked".
 */
const SUPPRESSIBLE = new Set([
  'standup', 'todo', 'eod', 'journal', '121', 'brief',
  'escalation',        // the count-based nudge; escalation_alert is the loud path
  'email',
  'nudge_cleared',
  'weekly_review', 'knowledge_reflection', 'vault_hygiene', 'sweep_complete',
  'plaud', 'plan_milestone', 'teams_mention', 'day_plan',
  // The ambient layer — water, sitting, exercise, a health trend. SUPPRESSIBLE
  // by definition: it is the most interruptible thing SARA says, and the whole
  // design rests on it respecting quiet hours, the dedupe and the hourly cap.
  // Anything here that ever needs to bypass those has stopped being ambient.
  'ambient',
]);

const ROOTS = ['services', 'routes'];

function sourceFiles() {
  const out = [];
  for (const rootName of ROOTS) {
    const root = path.join(__dirname, '..', rootName);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
      if (rootName === 'services' && name === 'webpush.js') continue; // defines it
      out.push(path.join(root, name));
    }
  }
  return out;
}

/** Every `type:` passed to a sendToAll call, as [{file, type}]. */
function sentTypes() {
  const found = [];
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    let i = src.indexOf('sendToAll(');
    while (i !== -1) {
      // The type sits in the third argument, within a few lines of the call.
      const window = src.slice(i, i + 500);
      const m = window.match(/type:\s*'([a-z0-9_]+)'/i);
      if (m) found.push({ file: path.basename(file), type: m[1] });
      i = src.indexOf('sendToAll(', i + 1);
    }
  }
  return found;
}

test('the scan actually finds sendToAll call sites', () => {
  // Positive control. Without this, a broken regex finds nothing and every
  // assertion below passes by absence — the exact failure this file exists to
  // stop happening somewhere else.
  const found = sentTypes();
  assert.ok(found.length >= 15, `expected to find many sendToAll types, found ${found.length}`);
  assert.ok(
    found.some(f => f.type === 'meeting_prep'),
    'expected to find meeting_prep — the type this test was written for'
  );
});

test('every type production sends is classified', () => {
  const unclassified = sentTypes().filter(
    f => !ALWAYS_DELIVER.has(f.type) && !SUPPRESSIBLE.has(f.type)
  );
  assert.deepEqual(
    unclassified, [],
    'These types are sent but are in neither ALWAYS_DELIVER nor SUPPRESSIBLE. ' +
    'Decide which: an unlisted type is silently suppressible.\n' +
    unclassified.map(u => `  ${u.file}: '${u.type}'`).join('\n')
  );
});

test('a meeting about to start is never suppressible', () => {
  // The governing rule for ALWAYS_DELIVER is "on fire, about to start, or the
  // system is broken". A meeting reminder is the "about to start" case, and it
  // is worthless late.
  for (const type of ['meeting_prep', 'meeting_alert']) {
    assert.ok(ALWAYS_DELIVER.has(type), `${type} must bypass the governor`);
  }
});

test('every ALWAYS_DELIVER entry is actually sent by something', () => {
  // The other direction: a bypass listed for a string nothing sends is dead
  // config that reads as coverage. `test` is exempt — it is the manual probe.
  const sent = new Set(sentTypes().map(f => f.type));
  const orphans = [...ALWAYS_DELIVER].filter(t => t !== 'test' && !sent.has(t));
  assert.deepEqual(
    orphans, [],
    `ALWAYS_DELIVER lists types nothing sends: ${orphans.join(', ')}`
  );
});
