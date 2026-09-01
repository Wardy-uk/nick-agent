'use strict';

/**
 * The in-place approval routes actually resolve, and the send stays one path.
 *
 * A green service suite says nothing about routing: Express matches in
 * REGISTRATION order, and a literal path registered after a sibling
 * parameterised one is read as that parameter instead — which is how
 * `/triage/feedback` came to be parsed as an email id (#70).
 *
 * The second test is the one that matters most. Approving from the weekly risk
 * panel must remain the SAME gate the Actions queue uses — the same queued
 * action, the same approve route, the same executor. If this router ever grows
 * a route that sends, there are two ways for a report to reach the manager
 * assessing Nick's PIP, only one of which is gated, and that is precisely the
 * shape the two-gate rule exists to prevent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wrroute-')), 'a.db');

const router = require('./weekly-risk');

const layersFor = (url, method) => router.stack
  .filter(l => l.route && l.regexp.test(url) && l.route.methods[method]);

test('GET /send-status is reachable and is the first match', () => {
  const hits = layersFor('/send-status', 'get');
  assert.ok(hits.length > 0, 'no GET layer matches /send-status');
  assert.equal(hits[0].route.path, '/send-status');
});

test('POST /reopen is reachable and is the first match', () => {
  const hits = layersFor('/reopen', 'post');
  assert.ok(hits.length > 0, 'no POST layer matches /reopen');
  assert.equal(hits[0].route.path, '/reopen');
});

test('the new routes did not shadow the ones already here', () => {
  for (const [url, method, expected] of [
    ['/', 'get', '/'],
    ['/markdown', 'get', '/markdown'],
    ['/manual', 'get', '/manual'],
    ['/manual', 'post', '/manual'],
    ['/publish', 'post', '/publish'],
    ['/queue-send', 'post', '/queue-send'],
    ['/test-send', 'post', '/test-send'],
    ['/log', 'get', '/log'],
  ]) {
    const hits = layersFor(url, method);
    assert.ok(hits.length > 0, `no ${method.toUpperCase()} layer matches ${url}`);
    assert.equal(hits[0].route.path, expected, `${method.toUpperCase()} ${url} is being handled by ${hits[0].route.path}`);
  }
});

test('this router still has NO route that sends — approval goes through /api/actions', () => {
  const source = fs.readFileSync(path.join(__dirname, 'weekly-risk.js'), 'utf8');
  // Positive control: the file really is the one being scanned.
  assert.ok(source.includes("router.post('/queue-send'"), 'wrong file, or the scan is broken');
  // queue-send creates the card; test-send mails Nick at a hardcoded address.
  // Nothing else here may reach the outbound path.
  assert.ok(!/sendMail\(/.test(source), 'this router must never send mail directly — the approval gate lives in /api/actions');
  assert.ok(!/executeAction\(/.test(source), 'executing an action from here would skip the queue the gate depends on');
});

test('a send is recorded by the EXECUTOR, not by whichever screen approved it', () => {
  // The panel and the Actions queue both approve through the same executor, so
  // the freeze has to be recorded there. A hook in the route would be a hook
  // the other screen walks straight past — the task-store hold's lesson.
  const engine = fs.readFileSync(path.join(__dirname, '..', 'services', 'suggestion-engine.js'), 'utf8');
  const start = engine.indexOf("case 'send_weekly_risk_report'");
  assert.ok(start > 0, 'the send executor is gone — this scan proves nothing');
  const body = engine.slice(start, start + 3000);
  assert.match(body, /markSent\(/, 'the executor must record the send, or the week never freezes');

  const routes = fs.readFileSync(path.join(__dirname, 'weekly-risk.js'), 'utf8');
  assert.ok(!/markSent\(/.test(routes), 'recording the send in the route means the Actions queue never freezes the week');
});
