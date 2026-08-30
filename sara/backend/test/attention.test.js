// SARA's read of NEURO's attention feed — a passthrough that must never invent.
//
// The failure paths ARE the feature. A blank feed and an unreadable one are
// different facts, and only one of them is good news; every path below asserts
// that the difference survives to the screen.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createRouter } = require('../src/routes/attention');

const CONFIGURED = { NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_API_TOKEN: 'tok' };

const GOOD = {
  generatedAt: '2026-09-01T10:00:00.000Z',
  primary: { kind: 'item', title: 'Write the risk assessment', say: "It's 2 days over." },
  poolAvailable: true,
};

function serve(options) {
  const app = express();
  app.use('/api/attention', createRouter(options));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        server,
        get: async (p = '/api/attention') => {
          const res = await fetch(base + p);
          return { status: res.status, body: await res.json() };
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

test('a good read is passed through VERBATIM', async () => {
  const h = await serve({ env: CONFIGURED, fetchImpl: reply(GOOD) });
  const { status, body } = await h.get();
  h.server.close();
  assert.equal(status, 200);
  assert.equal(body.available, true);
  // The wording is NEURO's. Re-phrasing here is how four surfaces come to say
  // the same fact four ways.
  assert.equal(body.primary.title, 'Write the risk assessment');
  assert.equal(body.primary.say, "It's 2 days over.");
});

test('an unconfigured SARA refuses BEFORE the network', async () => {
  let called = false;
  const h = await serve({
    env: {},
    fetchImpl: async () => { called = true; return new Response('{}'); },
  });
  const { body } = await h.get();
  h.server.close();
  assert.equal(body.available, false);
  // "We were never told where NEURO is" needs a different fix from "NEURO is
  // down", and firing blind blurs the two.
  assert.equal(body.reason, 'not-configured');
  assert.equal(called, false, 'it must not reach for the network at all');
});

test('a 200 carrying the wrong shape is NOT an answer', async () => {
  // A proxy error page or a login redirect arrives as a perfectly good 200.
  // Treating that as data is how a broken feed renders as a calm day.
  const h = await serve({ env: CONFIGURED, fetchImpl: reply({ error: 'nope' }) });
  const { body } = await h.get();
  h.server.close();
  assert.equal(body.available, false);
  assert.equal(body.reason, 'unexpected-shape');
});

test('every upstream failure is NAMED, never a silent empty feed', async () => {
  const cases = [
    [reply({}, 401), 'unauthorized'],
    [reply({}, 500), 'upstream-error'],
    [async () => { throw new Error('ECONNREFUSED'); }, 'unreachable'],
    [async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 'timeout'],
  ];
  for (const [fetchImpl, reason] of cases) {
    const h = await serve({ env: CONFIGURED, fetchImpl });
    const { status, body } = await h.get();
    h.server.close();
    // 200 with available:false is deliberate — a non-2xx makes a fetch wrapper
    // throw into a generic branch that cannot tell these apart.
    assert.equal(status, 200, reason);
    assert.equal(body.available, false, reason);
    assert.equal(body.reason, reason);
  }
});

test('a pinned view is forwarded; anything else is dropped, not invented', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return new Response(JSON.stringify(GOOD)); };

  let h = await serve({ env: CONFIGURED, fetchImpl });
  await h.get('/api/attention?view=personal');
  h.server.close();
  assert.match(seen[0], /\?view=personal$/);

  h = await serve({ env: CONFIGURED, fetchImpl });
  await h.get('/api/attention?view=nonsense');
  h.server.close();
  // A proxy passes parameters on; it does not make them up.
  assert.ok(!seen[1].includes('view='), 'an unrecognised view must not be forwarded');
});
