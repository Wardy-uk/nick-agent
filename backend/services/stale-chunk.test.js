'use strict';

/**
 * "Your tab is old" must never be reported as "this screen is broken".
 *
 * The predicate lives in `frontend/src/staleChunk.js` as a PURE function — the
 * `pi-health.assess()` / `vaultHealth` split — so the wordings pin without a
 * DOM. The frontend is ESM and this suite is CommonJS, hence the dynamic
 * import; a source scan follows, because a perfect predicate the boundary does
 * not consult is exactly the shape of a fix that never shipped.
 *
 * ⚠ The case that motivated it: **"Unable to preload CSS for
 * /assets/WeeklyRiskPanel-D2M3dRAP.css"** (7 Sep 2026). Vite fetches a lazy
 * view's stylesheet BEFORE importing its JS, so on a tab left open across a
 * deploy the CSS is what 404s first and none of the module-script wordings are
 * ever reached. Weekly Risk therefore rendered the GENERIC branch — "Try this
 * screen again", which re-runs the same import against the same dead URL for
 * ever — instead of the one action that works.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend', 'src');
const MODULE_URL = pathToFileURL(path.join(FRONTEND, 'staleChunk.js')).href;

let isStaleChunkError;

test.before(async () => {
  ({ isStaleChunkError } = await import(MODULE_URL));
});

// ── The wordings, each one a real engine's ────────────────────────────────────

test('the live Weekly Risk failure is recognised as a stale tab, not a crash', () => {
  // Verbatim from the screen, 7 Sep 2026.
  assert.equal(
    isStaleChunkError(new Error('Unable to preload CSS for /assets/WeeklyRiskPanel-D2M3dRAP.css')),
    true
  );
});

test('every browser wording for a dead chunk is covered', () => {
  const wordings = [
    'Failed to fetch dynamically imported module: https://x/assets/A-1.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    "Failed to load module script: expected a JavaScript module script but the server responded with a MIME type of \"text/html\"",
    'Unable to preload CSS for /assets/B-2.css',
  ];
  for (const message of wordings) {
    assert.equal(isStaleChunkError(new Error(message)), true, message);
  }
  assert.equal(isStaleChunkError({ name: 'ChunkLoadError', message: '' }), true);
});

// ── Negatives: a real bug must NOT be excused as an old tab ──────────────────

test("a genuine component crash is not treated as a stale tab", () => {
  // The StateOfPlay outage that put the boundary here in the first place.
  assert.equal(
    isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'staleDays')")),
    false
  );
  assert.equal(isStaleChunkError(new Error('Failed to fetch')), false, 'a dead API call is not a dead chunk');
  assert.equal(isStaleChunkError(new Error('css parse error')), false);
});

test('a missing error is not a stale chunk', () => {
  assert.equal(isStaleChunkError(null), false);
  assert.equal(isStaleChunkError(undefined), false);
  assert.equal(isStaleChunkError({}), false);
});

// ── The boundary actually asks it ────────────────────────────────────────────

test('ErrorBoundary consults the shared predicate and keeps no copy of its own', () => {
  const src = fs.readFileSync(path.join(FRONTEND, 'components', 'ErrorBoundary.jsx'), 'utf8');
  assert.match(src, /from '\.\.\/staleChunk'/, 'positive control: the boundary imports the predicate');
  assert.equal(
    /function isStaleChunkError/.test(src),
    false,
    'a second copy is how the two come to disagree about which failures a reload fixes'
  );
  assert.match(src, /if \(isStaleChunkError\(error\)\)/, 'and it is what decides the reload branch');
});
