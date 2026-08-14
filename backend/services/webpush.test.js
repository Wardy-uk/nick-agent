'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-push-'));
process.env.NEURO_DB_PATH = path.join(root, 'push.db');
process.env.PUSH_QUIET_HOURS = 'off'; // tested explicitly below
process.env.PUSH_HOURLY_CAP = '3';

const db = require('../db/database');
const webpush = require('./webpush');

test.before(async () => { await db.init(); });

test.beforeEach(() => { db.setState('push_governor', '{}'); });

test('the hourly cap holds back ordinary notifications', () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(webpush._governor(`Nudge ${i}`, 'body', { type: 'todo' }).allowed, true);
  }
  const blocked = webpush._governor('Nudge 4', 'body', { type: 'todo' });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /hourly cap/);
});

test('critical alerts ignore the cap — an escalation is never rate-limited away', () => {
  for (let i = 0; i < 5; i++) webpush._governor(`Nudge ${i}`, 'body', { type: 'todo' });
  const critical = webpush._governor('New escalation', 'NT-123: something broke', { type: 'escalation_alert' });
  assert.equal(critical.allowed, true);
});

test('the same notification twice inside the window only fires once', () => {
  const first = webpush._governor('New escalation', 'NT-123: broke', { type: 'escalation_alert' });
  const second = webpush._governor('New escalation', 'NT-123: broke', { type: 'escalation_alert' });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.match(second.reason, /duplicate/);
});

test('quiet hours silence ordinary notifications but not critical ones', () => {
  // 22:00-07:00 with the clock forced into the small hours.
  process.env.PUSH_QUIET_HOURS = '22:00-07:00';
  const RealDate = Date;
  const at = (hour) => class extends RealDate {
    constructor(...args) {
      if (args.length) return new RealDate(...args);
      super(2026, 7, 14, hour, 30, 0);
    }
  };

  try {
    global.Date = at(3);
    assert.equal(webpush._isQuietNow(), true);
    assert.equal(webpush._governor('Todo nag', 'body', { type: 'todo' }).allowed, false);
    assert.equal(webpush._governor('Meeting', 'starts in 10', { type: 'meeting_alert' }).allowed, true);

    global.Date = at(14);
    assert.equal(webpush._isQuietNow(), false);
    assert.equal(webpush._governor('Todo nag', 'body', { type: 'todo' }).allowed, true);
  } finally {
    global.Date = RealDate;
    process.env.PUSH_QUIET_HOURS = 'off';
  }
});

test('governor state survives a restart — the budget is not reset by a redeploy', () => {
  for (let i = 0; i < 3; i++) webpush._governor(`Nudge ${i}`, 'body', { type: 'todo' });

  // Simulate a restart: drop the module cache and reload against the same DB.
  delete require.cache[require.resolve('./webpush')];
  const reloaded = require('./webpush');

  const afterRestart = reloaded._governor('Nudge 4', 'body', { type: 'todo' });
  assert.equal(afterRestart.allowed, false, 'a restart must not hand back a fresh quota');
});
