'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { assessWorker } = require('../../shared/worker-health.cjs');

// The bug these pin: every one of these states used to collapse into either
// "unverified" or "unreachable", because both surfaces derived the verdict from
// lastHealthy alone — and lastHealthy deliberately stays null through a timeout.

test('a disabled worker is not a fault', () => {
  const v = assessWorker({ enabled: false });
  assert.strictEqual(v.level, 'ok');
  assert.strictEqual(v.up, null);
});

test('missing status is treated as disabled, not as a failure', () => {
  assert.strictEqual(assessWorker(undefined).level, 'ok');
});

test('enabled but never asked reads as unverified, not healthy', () => {
  const v = assessWorker({ enabled: true, url: 'http://pi4:3002', lastHealthy: null });
  assert.strictEqual(v.state, 'unknown');
  assert.strictEqual(v.level, 'warn');
  assert.strictEqual(v.up, null);
});

test('timing out is reported as too slow, NOT as unreachable', () => {
  // The live case on 15 Aug: /health answers in 0.2s, real triage blows the 60s
  // timeout. Calling this "unreachable" sends Nick to check a box that is fine.
  const v = assessWorker({
    enabled: true, url: 'http://pi4:3002', timeout: 60000,
    lastHealthy: null, consecutiveFailures: 2, skipAfter: 3, skipping: false,
    lastFailure: { timedOut: true, message: 'This operation was aborted' },
  });
  assert.strictEqual(v.state, 'slow');
  assert.strictEqual(v.level, 'warn');
  assert.match(v.title, /not finishing tasks inside 60s/);
  assert.doesNotMatch(v.title, /unreachable/);
  // It must say the work is still getting done, or the panel reads as an outage.
  assert.match(v.detail, /falling back/);
});

test('a connection failure is reported as failing, not as slow', () => {
  const v = assessWorker({
    enabled: true, url: 'http://pi4:3002',
    lastHealthy: null, consecutiveFailures: 1,
    lastFailure: { timedOut: false, message: 'fetch failed' },
  });
  assert.strictEqual(v.state, 'failing');
  assert.strictEqual(v.short, 'Pi 4 worker failing');
});

test('cooldown is critical and says when it lifts', () => {
  const until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const v = assessWorker({
    enabled: true, url: 'http://pi4:3002', timeout: 60000,
    lastHealthy: null, consecutiveFailures: 3, skipAfter: 3,
    skipping: true, skipUntil: until,
    lastFailure: { timedOut: true, message: 'This operation was aborted' },
  });
  assert.strictEqual(v.state, 'cooldown');
  assert.strictEqual(v.level, 'critical');
  assert.match(v.detail, /routed elsewhere until/);
});

test('an unreachable worker still says unreachable', () => {
  const v = assessWorker({
    enabled: true, url: 'http://pi4:3002',
    lastHealthy: false, lastFailure: { timedOut: false, message: 'ECONNREFUSED' },
  });
  assert.strictEqual(v.state, 'unreachable');
  assert.strictEqual(v.level, 'critical');
  assert.strictEqual(v.up, false);
});

test('a working worker is green and silent', () => {
  const v = assessWorker({ enabled: true, url: 'http://pi4:3002', lastHealthy: true, consecutiveFailures: 0 });
  assert.strictEqual(v.level, 'ok');
  assert.strictEqual(v.up, true);
});

test('skipAfter comes from the client, not a hardcoded 3', () => {
  const v = assessWorker({
    enabled: true, url: 'http://pi4:3002', lastHealthy: null,
    consecutiveFailures: 1, skipAfter: 5, lastFailure: { timedOut: true },
  });
  assert.match(v.detail, /skipped at 5/);
});
