// SARA capture bridge — the one thing that must never lie.
//
// A capture is Nick catching a thought before it disappears. If SARA says "Saved" and
// nothing reached NEURO, the thought is gone AND he believes it is safe — which is
// strictly worse than an error, because he will not write it down again. So every
// failure path here is pinned, and the assertion in each is the same: `saved` is false.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const neuroCapture = require('../src/integrations/neuroCapture');
const { createRouter } = require('../src/routes/capture');

const CONFIGURED = { NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_PIN: '1234' };

/** A stand-in for the NEURO backend with a scripted answer. */
function fakeNeuro(answers) {
  const calls = [];
  const queue = Array.isArray(answers) ? [...answers] : [answers];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      const next = queue.shift();
      if (typeof next === 'function') return next();
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

// --- forwarding ------------------------------------------------------------

test('a note reaches NEURO\'s canonical capture route, with SARA\'s credential', async () => {
  const neuro = fakeNeuro({ status: 200, body: { success: true, filename: '2026-08-30-note.md', verified: true } });
  const r = await neuroCapture.forward('note', { title: 'Handover', content: '  Ask Adele about the export  ' }, {
    env: CONFIGURED,
    fetchImpl: neuro.fetchImpl,
  });

  assert.equal(r.ok, true);
  assert.equal(r.saved, true);
  assert.equal(r.status, 200);
  assert.equal(neuro.calls.length, 1);
  assert.equal(neuro.calls[0].url, 'http://neuro.test:3001/api/capture/note');
  assert.equal(neuro.calls[0].options.method, 'POST');
  assert.equal(neuro.calls[0].options.headers['x-neuro-pin'], '1234');
  // The text is trimmed but otherwise untouched — SARA is transport, not an editor.
  assert.deepEqual(neuro.calls[0].body, { content: 'Ask Adele about the export', title: 'Handover' });
});

test('a todo reaches the task route, carrying its detail and its provenance', async () => {
  const neuro = fakeNeuro({ status: 200, body: { success: true, taskId: 91, created: true } });
  const r = await neuroCapture.forward(
    'todo',
    { text: 'Book the risk assessment sign-off', priority: 1, moscow: 'must', due: '2026-09-02' },
    { env: CONFIGURED, fetchImpl: neuro.fetchImpl }
  );

  assert.equal(r.saved, true);
  assert.equal(neuro.calls[0].url, 'http://neuro.test:3001/api/capture/todo');
  assert.deepEqual(neuro.calls[0].body, {
    text: 'Book the risk assessment sign-off',
    priority: 1,
    moscow: 'must',
    due: '2026-09-02',
    // NEURO can see where this came from. `source` is a real column on tasks.
    source: 'sara-capture',
  });
  assert.equal(r.upstream.body.taskId, 91);
});

test('an API token is preferred over the PIN — SARA is a machine client', async () => {
  const neuro = fakeNeuro({ status: 200, body: { success: true } });
  await neuroCapture.forward('note', { content: 'x' }, {
    env: { ...CONFIGURED, NEURO_API_TOKEN: 'machine-token' },
    fetchImpl: neuro.fetchImpl,
  });
  assert.equal(neuro.calls[0].options.headers['x-neuro-api-token'], 'machine-token');
  assert.equal(neuro.calls[0].options.headers['x-neuro-pin'], undefined);
});

// --- refusals: none of these may ever report a save ------------------------

test('an unconfigured NEURO refuses BEFORE the network, and never claims a save', async () => {
  let called = false;
  const r = await neuroCapture.forward('note', { content: 'Important thought' }, {
    env: {},
    fetchImpl: async () => { called = true; },
  });

  assert.equal(r.ok, false);
  assert.equal(r.saved, false);
  assert.equal(r.reason, 'not-configured');
  assert.equal(r.status, 503);
  assert.match(r.detail, /NEURO_BASE_URL/);
  assert.equal(called, false, 'an unconfigured bridge must not fire a blind request');
});

test('an unreachable NEURO is reported as unreachable, not as a save', async () => {
  const r = await neuroCapture.forward('note', { content: 'Important thought' }, {
    env: CONFIGURED,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });

  assert.equal(r.saved, false);
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.status, 504);
  assert.match(r.detail, /ECONNREFUSED/);
});

test('a timeout is its own reason — "slow" is not "refused"', async () => {
  const r = await neuroCapture.forward('note', { content: 'x' }, {
    env: CONFIGURED,
    fetchImpl: async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    },
  });

  assert.equal(r.saved, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.status, 504);
});

test('a rejected credential says so, so the fix is obvious', async () => {
  const r = await neuroCapture.forward('note', { content: 'x' }, {
    env: CONFIGURED,
    fetchImpl: fakeNeuro({ status: 401, body: { error: 'Unauthorized' } }).fetchImpl,
  });

  assert.equal(r.saved, false);
  assert.equal(r.reason, 'unauthorized');
  assert.match(r.detail, /NEURO_API_TOKEN|NEURO_PIN/);
});

test('NEURO refusing the content is passed through with its own status', async () => {
  const r = await neuroCapture.forward('todo', { text: 'x' }, {
    env: CONFIGURED,
    fetchImpl: fakeNeuro({ status: 400, body: { error: 'text is required' } }).fetchImpl,
  });

  assert.equal(r.saved, false);
  assert.equal(r.reason, 'rejected');
  assert.equal(r.status, 400);
  assert.equal(r.detail, 'text is required');
});

test('a NEURO 500 is an upstream error, and the capture is not saved', async () => {
  const r = await neuroCapture.forward('note', { content: 'x' }, {
    env: CONFIGURED,
    fetchImpl: fakeNeuro({ status: 500, body: { error: 'File write verification failed' } }).fetchImpl,
  });

  assert.equal(r.saved, false);
  assert.equal(r.reason, 'upstream-error');
  assert.equal(r.status, 502);
  assert.match(r.detail, /verification failed/);
});

// ⚠ The subtle one, and the reason `saved` is not simply `res.ok`. NEURO's capture
// routes answer `{ success: true }`. A 200 carrying anything else — a proxy's HTML
// error page rendered as JSON, a half-written handler, a login redirect — is NOT an
// acknowledgement, and treating it as one is exactly how a lost capture comes to be
// reported as a saved one.
test('a 200 that does not ACKNOWLEDGE is not a save', async () => {
  const r = await neuroCapture.forward('note', { content: 'x' }, {
    env: CONFIGURED,
    fetchImpl: fakeNeuro({ status: 200, body: { message: 'ok' } }).fetchImpl,
  });

  assert.equal(r.ok, false);
  assert.equal(r.saved, false);
  assert.equal(r.reason, 'upstream-error');
  assert.match(r.detail, /without acknowledging/);
});

test('empty content is refused locally rather than sent for NEURO to reject', async () => {
  let called = false;
  const r = await neuroCapture.forward('note', { content: '   ' }, {
    env: CONFIGURED,
    fetchImpl: async () => { called = true; },
  });
  assert.equal(r.reason, 'invalid');
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test('the bridge is a named door, not an open proxy into the brain', async () => {
  let called = false;
  const r = await neuroCapture.forward('photo', { content: 'x' }, {
    env: CONFIGURED,
    fetchImpl: async () => { called = true; },
  });
  assert.equal(r.reason, 'unsupported-kind');
  assert.equal(called, false, 'an unsupported kind must never reach NEURO');
});

// --- HTTP wiring -----------------------------------------------------------
//
// A green unit suite says nothing about routing. These drive a real express app over
// a real socket, because the original bug WAS a routing bug: the frontend had always
// POSTed to /api/capture/note and nothing was ever mounted there.

async function withServer(routerOptions, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/capture', createRouter(routerOptions));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /api/capture/note is MOUNTED and answers ok on a successful forward', async () => {
  const neuro = fakeNeuro({ status: 200, body: { success: true, filename: 'n.md' } });
  await withServer({ env: CONFIGURED, fetchImpl: neuro.fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/capture/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'A thought' }),
    });
    assert.equal(res.status, 200, 'this route 404d for the whole life of the kiosk');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.saved, true);
    assert.equal(body.error, null);
  });
});

test('POST /api/capture/todo is MOUNTED and answers ok on a successful forward', async () => {
  const neuro = fakeNeuro({ status: 200, body: { success: true, taskId: 7, created: true } });
  await withServer({ env: CONFIGURED, fetchImpl: neuro.fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/capture/todo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Chase the sign-off' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved, true);
    assert.equal(body.data.taskId, 7);
  });
});

test('over HTTP, an unavailable NEURO answers 503 with saved:false and a readable reason', async () => {
  await withServer({ env: {}, fetchImpl: async () => { throw new Error('should not be called'); } }, async (base) => {
    const res = await fetch(`${base}/api/capture/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'A thought' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.saved, false);
    // The UI prints `error`. It has to be a sentence, not a code.
    assert.match(body.error, /NEURO_BASE_URL/);
  });
});

test('over HTTP, a NEURO outage answers 504 and never a 200', async () => {
  await withServer({ env: CONFIGURED, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }, async (base) => {
    const res = await fetch(`${base}/api/capture/todo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A task' }),
    });
    assert.equal(res.status, 504);
    const body = await res.json();
    assert.equal(body.saved, false);
    assert.match(body.error, /Could not reach NEURO/);
  });
});

// --- auth/settings agreement -----------------------------------------------
//
// ⚠ `/api/neuro-auth` answers the SAME question as the capture bridge — "can SARA
// talk to NEURO?" — and used to answer it differently, keying `configured` on the PIN
// alone. A SARA authenticated with NEURO_API_TOKEN therefore reported itself
// unconfigured and asked for a PIN it did not need, while capture worked fine. Three
// surfaces disagreeing about one fact is the drift this pass removes.

const neuroAuthRouter = require('../src/routes/neuroAuth');
const neuroConfig = require('../src/integrations/neuroConfig');

async function withAuthServer(env, fn) {
  const saved = { ...process.env };
  // The route reads process.env (it is a live status surface, not a pure function).
  for (const k of ['NEURO_BASE_URL', 'NEURO_PIN', 'NEURO_API_TOKEN']) delete process.env[k];
  Object.assign(process.env, env);
  neuroConfig.clearPin();

  const app = express();
  app.use(express.json());
  app.use('/api/neuro-auth', neuroAuthRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const k of ['NEURO_BASE_URL', 'NEURO_PIN', 'NEURO_API_TOKEN']) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('an API token alone reports NEURO as CONFIGURED — no PIN prompt', async () => {
  await withAuthServer({ NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_API_TOKEN: 'machine-token' }, async (base) => {
    const body = await (await fetch(`${base}/api/neuro-auth`)).json();
    assert.equal(body.configured, true, 'a machine token IS a credential');
    assert.equal(body.available, true);
    assert.equal(body.credentialKind, 'api-token');
    assert.equal(body.source, 'api-token');
    assert.deepEqual(body.problems, []);
    // whether, never what
    assert.ok(!JSON.stringify(body).includes('machine-token'));
  });
});

test('auth status and the capture bridge cannot disagree about readiness', async () => {
  const env = { NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_API_TOKEN: 'tok' };
  await withAuthServer(env, async (base) => {
    const body = await (await fetch(`${base}/api/neuro-auth`)).json();
    const capture = await neuroCapture.forward('note', { content: 'x' }, {
      env,
      fetchImpl: fakeNeuro({ status: 200, body: { success: true } }).fetchImpl,
    });
    assert.equal(body.available, true);
    assert.equal(capture.saved, true, 'if capture works, auth status must not say unconfigured');
  });
});

test('a missing base URL is reported by auth status too, by name', async () => {
  await withAuthServer({ NEURO_PIN: '1234' }, async (base) => {
    const body = await (await fetch(`${base}/api/neuro-auth`)).json();
    // The credential is set but SARA still does not know where NEURO is. Those are
    // two separate facts and the settings screen has to be able to show which is
    // missing — "enter a PIN" is the wrong instruction when the PIN is already there.
    assert.equal(body.configured, true, 'the PIN is set');
    assert.equal(body.baseUrlConfigured, false);
    assert.equal(body.available, false, 'a credential with no destination is not usable');
    assert.match(body.detail, /NEURO_BASE_URL/);
  });
});
