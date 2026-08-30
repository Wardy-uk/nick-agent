// The kiosk's write half — acting on a canonical attention record.
//
// ⚠ WHY THIS EXISTS. The kiosk's "Done" button POSTed
// `/api/actions/focus/done`, which proxied NEURO's `/api/focus/action-done` — a
// route that logs a COMPLETED OUTCOME and dismisses the item without ever
// closing the underlying task. So the button recorded work as finished, hid the
// card, and left the work open with its only reminder suppressed. Its "Defer"
// POSTed `/dismiss`, so "not now" and "not mine" were one gesture.
//
// Both are the desktop bug one surface along. They are replaced by a
// PASSTHROUGH onto the attention lifecycle, and what is under test is that it
// stays a passthrough: the action is forwarded verbatim and NEURO decides what
// it means.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { createRouter } = require('../src/routes/attention');

const CONFIGURED = { NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_API_TOKEN: 'tok' };

function serve(options) {
  const app = express();
  app.use(express.json());
  app.use('/api/attention', createRouter(options));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        server,
        get: async (p) => {
          const res = await fetch(base + p);
          return { status: res.status, body: await res.json() };
        },
        post: async (p, body) => {
          const res = await fetch(base + p, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          });
          return { status: res.status, body: await res.json().catch(() => ({})) };
        },
      });
    });
  });
}

function reply(body, status = 200) {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('an action is forwarded VERBATIM — the proxy decides nothing', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, record: { state: 'deferred' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  const h = await serve({ env: CONFIGURED, fetchImpl });
  const { status } = await h.post('/api/attention/records/att_abc/act', {
    action: 'defer', minutes: 120, reason: 'not-now',
  });
  h.server.close();

  assert.equal(status, 200);
  assert.equal(seen[0].method, 'POST');
  assert.match(seen[0].url, /\/api\/attention\/records\/att_abc\/act$/);
  // No mapping, no substitution. `focus/done` came to mean something nobody
  // asked for precisely because a proxy translated one action into another.
  assert.equal(seen[0].body.action, 'defer');
  assert.equal(seen[0].body.reason, 'not-now');
  assert.equal(seen[0].body.minutes, 120);
});

test('the body is BOUNDED to the contract fields', async () => {
  let sent = null;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const h = await serve({ env: CONFIGURED, fetchImpl });
  await h.post('/api/attention/records/att_abc/act', {
    action: 'dismiss',
    // A proxy that passes an arbitrary body through is one that will one day
    // carry a field NEURO trusts and the kiosk should not set.
    resolution: 'completed',
    operational: true,
  });
  h.server.close();
  // `JSON.stringify` drops the undefined ones, so what survives is the action
  // alone — and, crucially, NOTHING the caller added.
  assert.deepEqual(Object.keys(sent).sort(), ['action']);
  assert.equal(sent.resolution, undefined);
  assert.equal(sent.operational, undefined);
});

test('the completion outcome rides back untouched', async () => {
  // "Done, and I closed the task" and "Done, there was no task to close" are
  // different outcomes and the screen has to be able to say which.
  const h = await serve({
    env: CONFIGURED,
    fetchImpl: reply({ ok: true, taskCompleted: false, taskWhy: 'no matching task in the store' }),
  });
  const { body } = await h.post('/api/attention/records/att_abc/act', { action: 'complete' });
  h.server.close();
  assert.equal(body.taskCompleted, false);
  assert.equal(body.taskWhy, 'no matching task in the store');
});

test('a WRITE reports a refusal as a refusal — never a 200', async () => {
  // The feed is polled, so a non-2xx there lands in a generic "something broke"
  // branch; a write is a deliberate button press, and a refusal rendered as
  // success is a card that looks acted-on when nothing happened.
  const cases = [
    [reply({ error: 'record is resolved and cannot be changed' }, 400), 400],
    [reply({}, 401), 401],
    [reply({}, 500), 500],
  ];
  for (const [fetchImpl, expected] of cases) {
    const h = await serve({ env: CONFIGURED, fetchImpl });
    const { status, body } = await h.post('/api/attention/records/att_abc/act', { action: 'complete' });
    h.server.close();
    assert.equal(status, expected);
    assert.equal(body.ok, false);
    assert.ok(body.error, 'a refusal must name itself');
  }
});

test('an unconfigured SARA refuses a write BEFORE the network', async () => {
  let called = false;
  const h = await serve({ env: {}, fetchImpl: async () => { called = true; return new Response('{}'); } });
  const { status, body } = await h.post('/api/attention/records/att_abc/act', { action: 'complete' });
  h.server.close();
  assert.equal(status, 503);
  assert.equal(body.reason, 'not-configured');
  assert.equal(called, false);
});

test('an unreachable NEURO is a 504 with a reason, not a silent success', async () => {
  const h = await serve({ env: CONFIGURED, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const { status, body } = await h.post('/api/attention/records/att_abc/act', { action: 'complete' });
  h.server.close();
  assert.equal(status, 504);
  assert.equal(body.reason, 'unreachable');
});

test('/records is a literal and is matched BEFORE /records/:id/act', async () => {
  // Express matches in registration order, and a literal declared after a
  // parameterised sibling is read as its parameter — the bug that made
  // `/api/email/triage/feedback` answer "Email not found" for a fortnight.
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ records: [{ recordId: 'att_1', engineId: 'todo-overdue-top' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const h = await serve({ env: CONFIGURED, fetchImpl });
  const { status, body } = await h.get('/api/attention/records');
  h.server.close();
  assert.equal(status, 200);
  assert.equal(body.available, true);
  assert.match(seen[0], /\/api\/attention\/records$/);
  // `engineId` is the whole point of this route: the legacy Focus screen holds
  // a decision-engine item id and nothing else.
  assert.equal(body.records[0].engineId, 'todo-overdue-top');
});

test('/records applies the same shape check as the feed', async () => {
  const h = await serve({ env: CONFIGURED, fetchImpl: reply({ error: 'nope' }) });
  const { body } = await h.get('/api/attention/records');
  h.server.close();
  assert.equal(body.available, false);
  assert.equal(body.reason, 'unexpected-shape');
});

test('nothing in sara/backend proxies /api/focus/action-done any more', () => {
  const routes = path.join(__dirname, '..', 'src', 'routes');
  for (const file of fs.readdirSync(routes)) {
    const source = fs.readFileSync(path.join(routes, file), 'utf-8')
      // Comments explain WHY the route is gone; a rule that fails on its own
      // explanation pressures the next person to delete the explanation.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(
      !source.includes('action-done'),
      `${file} still proxies /api/focus/action-done — it logs a completed outcome for work that has not been done`
    );
  }
});
