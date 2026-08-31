'use strict';

/**
 * Brain Health lives in NEURO, not SARA (31 Aug 2026).
 *
 * NEURO is the brain and the NEURO app is Nick's DIRECT access to it; SARA is
 * the layer that comes to him. Vault maintenance is neither ambient nor
 * something SARA should raise — it is a deliberate desk job with reports to
 * read and writes to weigh. On the phone it was a `brain` tab where the reports
 * were unreadable and a button that rewrites forty notes looked exactly like
 * one that previews them.
 *
 * ⚠ Removing a SARA tab is never only a deletion: a tab id missing from
 * `SARA_LITE_TABS` routes its notifications to Focus IN SILENCE. The kind
 * `brain` is deliberately kept (the desktop still routes it to Imports); only
 * its SARA destination is gone, so it now falls through to the Surface like
 * everything else with no dedicated tab.
 *
 * Source scans, because the alternative is booting three frontends. Each has a
 * positive control so a pass cannot come from a moved file or a typo'd path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');

// ── It is gone from SARA ────────────────────────────────────────────────────

test('the SARA tab registry no longer mounts a brain screen', () => {
  const tabs = read('sara', 'shared-ui', 'tabs.jsx');
  // Positive control: the registry still exists and still has real tabs.
  assert.match(tabs, /id: 'capture'/, 'positive control — the registry is intact');
  assert.ok(!tabs.includes('BrainManagement'), 'the component is no longer imported');
  assert.ok(!/id: 'brain'/.test(tabs), 'the brain tab is gone');
});

test('the SARA component files are gone, and nothing still imports them', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'sara/app/src/views/BrainManagement.jsx')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'sara/app/src/views/BrainManagement.css')), false);
});

// ── Routing survived the removal ────────────────────────────────────────────

/**
 * `SARA_LITE_TABS` is module-private, so it is read from SOURCE — the same way
 * `action-surfaces.test.js` reads the tab registry. Asserting on the exported
 * behaviour alone would miss a stale id sitting in the set.
 */
function saraLiteTabIds() {
  const src = read('shared', 'action-surfaces.cjs');
  const m = src.match(/const SARA_LITE_TABS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'positive control — the tab set must still be findable in source');
  return m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('brain is no longer a SARA tab id', () => {
  const ids = saraLiteTabIds();
  assert.ok(!ids.includes('brain'), `brain must be gone, saw: ${ids.join(', ')}`);
  // Positive control: the set is still populated with real tabs.
  assert.ok(ids.includes('capture'));
  assert.ok(ids.includes('surface'));
});

test('a vault-hygiene notification still resolves — to the Surface, not silently to Focus', () => {
  const surfaces = require('../../shared/action-surfaces.cjs');
  // ⚠ The KIND is unchanged. Only its SARA destination moved.
  assert.equal(surfaces.resolveActionKind({ type: 'vault_hygiene' }), 'brain');
  const tab = surfaces.resolveSaraLiteTab({ type: 'vault_hygiene' });
  assert.equal(tab, 'surface', 'no dedicated tab means SARA, where she is');
  // ⚠ The whole risk of removing a tab: an id with no home falls back to Focus
  // in silence, and nothing anywhere errors.
  assert.notEqual(tab, 'focus');
  assert.ok(saraLiteTabIds().includes(tab), 'and it must be a tab that actually exists');
});

test('the desktop destination for a brain notification is unchanged', () => {
  const surfaces = require('../../shared/action-surfaces.cjs');
  assert.deepEqual(surfaces.resolveNueroNavigation({ type: 'vault_hygiene' }), { view: 'imports', context: {} });
});

// ── It arrived in NEURO ─────────────────────────────────────────────────────

test('NEURO mounts the panel and lists it in the sidebar', () => {
  const app = read('frontend', 'src', 'App.jsx');
  assert.match(app, /case 'brain-health'/, 'the view is routable');
  assert.match(app, /BrainHealthPanel/, 'the component is imported');

  const sidebar = read('frontend', 'src', 'components', 'Sidebar.jsx');
  // ⚠ Routable-but-unreachable is the same hole one step later — the lesson
  // TodoPanel and DecisionsPanel both taught.
  assert.match(sidebar, /id: 'brain-health'/, 'and it is reachable from the sidebar');
});

test('every job names what it changes and what it will not do', () => {
  const panel = read('frontend', 'src', 'components', 'BrainHealthPanel.jsx');
  // Positive control: the options list is really there.
  assert.match(panel, /key: 'lint'/, 'positive control — the jobs are defined here');

  // The descriptive contract: each option carries all four fields. A job with
  // no `wont` is one that looks safe by omission.
  const keys = [...panel.matchAll(/key: '([a-z]+)'/g)].map(m => m[1]);
  assert.ok(keys.length >= 7, `expected the full job list, saw ${keys.length}`);
  for (const field of ['what:', 'changes:', 'wont:', 'effect:']) {
    const count = panel.split(field).length - 1;
    assert.ok(count >= keys.length, `every job must carry ${field} (${count} for ${keys.length} jobs)`);
  }
});

test('anything that writes to the vault is two-step and separately marked', () => {
  const panel = read('frontend', 'src', 'components', 'BrainHealthPanel.jsx');
  // ⚠ The SARA screen had one grey Run button for previews and for writes
  // alike. A write must declare itself and must confirm.
  assert.match(panel, /effect: 'write'/);
  assert.match(panel, /confirm: true/);
  assert.match(panel, /requires: 'plan'/, 'apply is gated on its own preview');
  assert.match(panel, /requires: 'reconcile'/, 'repull is gated on its own preview');
});

test('the panel never claims a clean vault when the scan failed', () => {
  const panel = read('frontend', 'src', 'components', 'BrainHealthPanel.jsx');
  // The house rule, on the one screen whose whole job is counts.
  assert.match(panel, /missing, not zero/);
});
