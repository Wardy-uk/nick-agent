// The kiosk's door onto NEURO — and, mostly, what it REFUSES.
//
// ⚠ WHY THIS EXISTS. Nick, 31 Aug 2026: "make the Pi version of SARA the same
// as the phone app." The phone's views each talk straight to NEURO with a PIN
// in localStorage; the kiosk cannot, because it is an unauthenticated
// always-on touchscreen on a desk and `server.js` binds 0.0.0.0. So the
// credential stays in `sara/backend` and the same views reach NEURO through
// this route.
//
// That makes the ALLOWLIST the entire safety model, which makes the refusals
// the thing worth testing. Real HTTP throughout: a green service suite says
// nothing about routing, and this route's whole behaviour IS routing.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const proxy = require('../src/routes/neuroProxy');
const { createRouter, isAllowed } = proxy;

const CONFIGURED = { NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_API_TOKEN: 'tok' };

function serve(options) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(options));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        server,
        call: async (p, init) => {
          const res = await fetch(base + p, init);
          const text = await res.text();
          let body; try { body = JSON.parse(text); } catch { body = text; }
          return { status: res.status, body };
        },
      });
    });
  });
}

// A stand-in NEURO that records what it was asked and always answers 200.
function recorder(answer = { ok: true }) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init?.method || 'GET', headers: init?.headers || {}, body: init?.body });
    return {
      status: 200, ok: true,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(answer),
    };
  };
  return { seen, fetchImpl };
}

test('positive control — an allowed door reaches NEURO, with SARA\u2019s credential', async () => {
  const { seen, fetchImpl } = recorder({ tasks: [] });
  const { server, call } = await serve({ fetchImpl, env: CONFIGURED });
  const res = await call('/api/todos/focus');
  server.close();

  // Without this the refusal tests below all pass on a route that forwards
  // NOTHING, which proves only that the server is broken.
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { tasks: [] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://neuro.test:3001/api/todos/focus');
  // The credential is attached HERE. The kiosk browser holds none, which is the
  // whole reason this route exists.
  assert.ok(JSON.stringify(seen[0].headers).includes('tok'), 'NEURO was asked without a credential');
});

test('⚠ nothing that LEAVES THE BUILDING is reachable', async () => {
  // `/api/actions/:id/approve` sends email as Nick, books meetings with real
  // attendees and pushes chases to direct reports. It is deliberately absent
  // from DOORS even though a screen could plausibly want it — the same
  // "leaves the building" test `action-presenter` and `bulk-reject` apply.
  const { seen, fetchImpl } = recorder();
  const { server, call } = await serve({ fetchImpl, env: CONFIGURED });
  const res = await call('/api/actions/12/approve', { method: 'POST' });
  server.close();

  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'not-a-door');
  // Refused LOCALLY, before the network — `neuroCapture`'s rule. A refusal that
  // still made the call would be no refusal at all.
  assert.equal(seen.length, 0, 'the refused call still reached NEURO');
});

test('⚠ nothing that manages an ACCOUNT or a CREDENTIAL is reachable', async () => {
  const { seen, fetchImpl } = recorder();
  const { server, call } = await serve({ fetchImpl, env: CONFIGURED });
  for (const path of ['/api/capture-links', '/api/microsoft/auth', '/api/notion-sync/token', '/api/settings']) {
    const res = await call(path);
    assert.equal(res.status, 403, `${path} was proxied`);
  }
  server.close();
  assert.equal(seen.length, 0);
});

test('⚠ matching is on the WHOLE first segment, never a prefix', () => {
  // `capture` is a door. `capture-links` — VESTA accounts and their PINs — is
  // not, and a `startsWith` test would have opened it for free.
  assert.equal(isAllowed('/capture'), true);
  assert.equal(isAllowed('/capture/todo'), true);
  assert.equal(isAllowed('/capture-links'), false);
  assert.equal(isAllowed('/capture-links/nick/pin'), false);
  // Same shape one route along.
  assert.equal(isAllowed('/push/subscribe'), true);
  assert.equal(isAllowed('/push-anything'), false);
});

test('⚠ traversal is refused outright, not normalised', () => {
  // A `..` that resolves back inside an allowed segment is still someone
  // trying, and this is the one place where reading it charitably is expensive.
  assert.equal(isAllowed('/todos/../capture-links'), false);
  assert.equal(isAllowed('/../capture-links'), false);
  assert.equal(isAllowed('/todos' + String.fromCharCode(92) + '..'), false);
  assert.equal(isAllowed('todos'), false, 'a path not starting at the root is not a path we understand');
});

test('an unconfigured bridge refuses BEFORE the network', async () => {
  const { seen, fetchImpl } = recorder();
  const { server, call } = await serve({ fetchImpl, env: {} });
  const res = await call('/api/todos/focus');
  server.close();

  // "We were never told where NEURO is" needs a different fix from "NEURO is
  // down", and firing blind blurs the two.
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, 'not-configured');
  assert.equal(seen.length, 0);
});

test('⚠ the upstream STATUS survives — a refusal is not rewritten as a success', async () => {
  const fetchImpl = async () => ({
    status: 401, ok: false,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: 'bad pin' }),
  });
  const { server, call } = await serve({ fetchImpl, env: CONFIGURED });
  const res = await call('/api/todos/focus');
  server.close();

  // A screen has to be able to tell a 401 from a 500 from a 200 carrying
  // `{ok:false}`. Flattening them here is how it loses that, and how a card
  // comes to look acted-on when nothing happened.
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'bad pin' });
});

test('an unreachable NEURO is named, not swallowed', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const { server, call } = await serve({ fetchImpl, env: CONFIGURED });
  const res = await call('/api/todos/focus');
  server.close();
  assert.equal(res.status, 504);
  assert.equal(res.body.reason, 'unreachable');
});
