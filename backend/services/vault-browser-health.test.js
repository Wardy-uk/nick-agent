'use strict';

/**
 * What the Vault Browser says above its results.
 *
 * The judgement lives in `frontend/src/vaultHealth.js` as a PURE function — the
 * `pi-health.assess()` / `context-state` split — so the states can be asserted
 * without a DOM. The rule it carries is the one this whole area exists for:
 * ⚠ **an incomplete search is never proof that nothing exists**, and a
 * COMPLETE one must not be hedged, or the warning stops being read by week two.
 *
 * The frontend is ESM and this suite is CommonJS, so the module is pulled in
 * with a dynamic import. A source scan follows, because a perfect pure function
 * nothing renders is exactly the shape of a feature that never shipped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend', 'src');
const MODULE_URL = pathToFileURL(path.join(FRONTEND, 'vaultHealth.js')).href;

let assessSearchHealth;
let EMPTY_INCOMPLETE_LINE;

test.before(async () => {
  const mod = await import(MODULE_URL);
  assessSearchHealth = mod.assessSearchHealth;
  EMPTY_INCOMPLETE_LINE = mod.EMPTY_INCOMPLETE_LINE;
});

const COMPLETE = { semanticAvailable: true, truncated: false, truncationReasons: [], incomplete: [] };

// ── The five states ─────────────────────────────────────────────────────────

test('degraded: semantic unavailable is named, and the empty line refuses to claim absence', () => {
  const a = assessSearchHealth({
    health: { ...COMPLETE, semanticAvailable: false },
    results: [],
  });
  assert.equal(a.state, 'incomplete');
  assert.equal(a.banner.tone, 'warn');
  assert.match(a.banner.detail, /Semantic search was unavailable/);
  assert.equal(a.emptyLine, EMPTY_INCOMPLETE_LINE);
  assert.match(a.emptyLine, /not confirmation that the vault contains nothing/);
});

test('truncated: a capped walk is reported with its reason', () => {
  const a = assessSearchHealth({
    health: { ...COMPLETE, truncated: true, truncationReasons: ['keyword: scan capped at 5000 files'] },
    results: [{ path: 'a.md' }],
  });
  assert.equal(a.state, 'incomplete');
  assert.match(a.banner.detail, /Part of the vault was not searched/);
  assert.match(a.banner.detail, /scan capped at 5000 files/);
});

test('partial index: notes the index holds only part of are counted, singular and plural', () => {
  const one = assessSearchHealth({ health: { ...COMPLETE, incomplete: ['Meetings/long.md'] }, results: [] });
  assert.equal(one.state, 'incomplete');
  assert.match(one.banner.detail, /1 note below is only partly indexed/);

  const two = assessSearchHealth({ health: { ...COMPLETE, incomplete: ['a.md', 'b.md'] }, results: [] });
  assert.match(two.banner.detail, /2 notes below are only partly indexed/);
});

test('empty + incomplete: the exact contracted sentence, verbatim', () => {
  const a = assessSearchHealth({ health: { ...COMPLETE, truncated: true, truncationReasons: ['keyword: vault path is not readable'] }, results: [] });
  assert.equal(
    a.emptyLine,
    'No matches found in the available search results. This is not confirmation that the vault contains nothing.',
  );
});

test('request failure: never an authoritative empty result', () => {
  const a = assessSearchHealth({ error: 'Search failed (HTTP 503)', results: null });
  assert.equal(a.state, 'error');
  assert.equal(a.banner.tone, 'error');
  assert.match(a.banner.detail, /Nothing below is a statement about the vault/);
  // ⚠ And it must not read as "no matches" — the search did not run.
  assert.doesNotMatch(a.emptyLine, /^No matches found/);
  assert.match(a.emptyLine, /not an empty vault/);
});

// ── And silence when there is nothing to say ────────────────────────────────

test('a complete search is NOT hedged — no banner, plain empty line', () => {
  const a = assessSearchHealth({ health: COMPLETE, results: [] });
  assert.equal(a.state, 'ok');
  assert.equal(a.banner, null);
  assert.equal(a.emptyLine, 'No matches');
});

test('an unread health block (no search yet) says nothing alarming', () => {
  const a = assessSearchHealth({});
  assert.equal(a.state, 'ok');
  assert.equal(a.banner, null);
});

test('scope is surfaced, so a short list inside a folder is not read as a short vault', () => {
  const a = assessSearchHealth({ health: COMPLETE, results: [], scope: 'Meetings' });
  assert.equal(a.scopeLabel, 'in Meetings/');
  assert.equal(assessSearchHealth({ health: COMPLETE, results: [] }).scopeLabel, null);
});

// ── The component actually renders it ───────────────────────────────────────

test('VaultBrowser stores health, renders the banner, and never renders "Lnull:"', () => {
  const src = fs.readFileSync(path.join(FRONTEND, 'components', 'VaultBrowser.jsx'), 'utf-8');

  // Positive control: the search still exists at all.
  assert.ok(src.includes('/api/vault/search?query='), 'positive control — the search call is still there');

  assert.ok(src.includes("import { assessSearchHealth } from '../vaultHealth'"), 'the judgement is imported, not re-derived');
  assert.ok(src.includes('setSearchHealth(data.health'), 'health is stored alongside the results');
  assert.ok(src.includes('setSearchError('), 'a failed request has its own state');
  assert.ok(src.includes('searchAssessment.banner'), 'the banner is rendered');
  assert.ok(src.includes('searchAssessment.emptyLine'), 'the empty state comes from the assessment');
  assert.ok(src.includes('vault-result-partial'), 'a partly-indexed note is marked on its row');

  // ⚠ `line` is null by design upstream, so the old `L{m.line}:` rendered
  // "Lnull:" on every single result.
  assert.ok(!src.includes('L{m.line}'), 'the raw Lnull render is gone');
  assert.ok(src.includes('m.line != null'), 'a null line renders as nothing at all');
});

test('the CSS the banner needs exists', () => {
  const css = fs.readFileSync(path.join(FRONTEND, 'components', 'VaultBrowser.css'), 'utf-8');
  for (const cls of ['.vault-health', '.vault-health-error', '.vault-health-title', '.vault-health-detail', '.vault-result-partial', '.vault-results-scope']) {
    assert.ok(css.includes(cls), `${cls} must be styled`);
  }
});
