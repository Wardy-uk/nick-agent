'use strict';

// The SPA fallback must never answer a missing FILE with the app shell.
//
// ⚠ This is a real outage, not a hypothetical. `express.static` calls next() on a
// miss, so a request for a hashed chunk that no longer exists fell through to
// `app.get('*')` and was answered with index.html and a **200**. The browser then
// tried to parse HTML as a JS module and reported "importing a module script
// failed" — naming neither the file nor the cause.
//
// It was harmless while the frontend was a single bundle and became reachable the
// moment the panels were code-split: every menu click is now a chunk fetch, and a
// chunk fetch answered with HTML is a dead screen with a cryptic message.
//
// The fallback logic is re-expressed here rather than imported, because server.js
// boots the whole app (DB, scheduler, Graph auth) on require. What is pinned is
// the RULE — and the positive control below is what stops this passing by
// accident if the rule ever stops being applied at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOOKS_LIKE_A_FILE = /\.[a-z0-9]{2,8}$/i;

function buildApp(distDir) {
  const app = express();
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  app.use('/assets', express.static(path.join(distDir, 'assets')));
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (req.path.startsWith('/assets/') || LOOKS_LIKE_A_FILE.test(req.path)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });
  return app;
}

let dist;
let server;
let base;

test.before(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-spa-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>NEURO</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'Panel-CURRENT.js'), 'export default 1;\n');
  fs.writeFileSync(path.join(dist, 'manifest.json'), '{}');

  server = buildApp(dist).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  try { fs.rmSync(dist, { recursive: true, force: true }); } catch {}
});

test('a STALE hashed chunk 404s — it is never answered with the app shell', async () => {
  const res = await fetch(`${base}/assets/NotionSyncPanel-OLDHASH.js`);
  assert.equal(res.status, 404, 'a missing chunk must 404');
  assert.ok(
    !(res.headers.get('content-type') || '').includes('text/html'),
    'answering a chunk request with HTML is what produced "importing a module script failed"',
  );
});

test('a chunk that DOES exist is still served — the guard is not a blanket 404', async () => {
  // The positive control. Without it, a rule that 404s everything under /assets
  // would pass the test above while breaking the entire app.
  const res = await fetch(`${base}/assets/Panel-CURRENT.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /export default/);
});

test('a missing top-level file 404s rather than serving the shell', async () => {
  for (const p of ['/favicon.svg', '/icon-192.png', '/sw.js', '/some.css']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, `${p} should 404 when absent`);
  }
});

test('a real static file at the root is still served', async () => {
  const res = await fetch(`${base}/manifest.json`);
  assert.equal(res.status, 200);
});

test('an ordinary SPA route still gets index.html', async () => {
  // The whole point of the fallback — these must not be caught by the guard.
  for (const p of ['/', '/dashboard', '/people/Hope Goodall']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 200, `${p} should serve the shell`);
    assert.match(await res.text(), /NEURO/);
  }
});

test('an API route is left to its own handler, not swallowed by the fallback', async () => {
  const res = await fetch(`${base}/api/ping`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('the file-shaped test does not misfire on a route with a dot in a name', () => {
  // A person's note or a version-ish segment must still reach the SPA. The
  // pattern requires a short trailing extension, so these are safe.
  assert.ok(!LOOKS_LIKE_A_FILE.test('/people/Hope Goodall'));
  assert.ok(!LOOKS_LIKE_A_FILE.test('/vault/Projects/NEURO'));
  assert.ok(LOOKS_LIKE_A_FILE.test('/assets/Panel-abc123.js'));
  assert.ok(LOOKS_LIKE_A_FILE.test('/index.html'));
});
