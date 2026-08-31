'use strict';

/**
 * Semantic index coverage — the index must be honest about what it does NOT
 * hold.
 *
 * ⚠ THE BUG. `listVaultFiles()` walked to **depth 4** while retrieval walked to
 * 12. A note in `Meetings/2026/08/deep/` was findable by keyword and could
 * never be indexed for semantic search — permanently, silently, and invisibly,
 * because a hybrid search always returns something. And `semanticAvailable`
 * only ever meant "the query embedded", so a vault indexed to half its depth
 * answered every search looking complete.
 *
 * Two claims are now kept apart everywhere: the PROVIDER answering, and the
 * INDEX holding your vault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-coverage-'));
process.env.OBSIDIAN_VAULT_PATH = tmp;
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const embeddings = require('./embeddings');
const retrieval = require('./retrieval');

function write(rel, body) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
  return full;
}

const SHALLOW = 'Projects/shallow.md';
// ⚠ Six levels down — comfortably past the retired depth-4 inventory cap.
const DEEP = 'Meetings/2026/08/deep/deeper/deepest/buried.md';

/**
 * Put a row in the index for a path.
 *
 * ⚠ The vector is `computeSimpleVector` of the note's own text, not a constant.
 * With no VOYAGE_API_KEY the QUERY is embedded the same way (128 dims), and
 * cosineSimilarity returns 0 whenever the dimensions differ — so a 1024-dim
 * fixture would score 0 against every query and this suite would "prove" the
 * deep note is unreachable for entirely the wrong reason.
 */
function index(rel, { hash = 'h1', modified = null, chunks = 1 } = {}) {
  const full = path.join(tmp, rel);
  const mtime = modified || fs.statSync(full).mtime.toISOString();
  const text = fs.readFileSync(full, 'utf-8');
  // ⚠ The ARRAY, not a JSON string: `db.saveEmbedding` stringifies internally,
  // so pre-encoding it stores a string of a string. It parses back to a
  // 444-character STRING whose `.length` is not 128, cosineSimilarity returns
  // 0 on the length mismatch, and the fixture silently proves nothing.
  const vec = embeddings.computeSimpleVector(text);
  for (let i = 0; i < chunks; i++) db.saveEmbedding(rel, hash, vec, text.slice(0, 300), mtime, i);
}

test.before(async () => {
  await db.init();
  write(SHALLOW, 'A note about the succession plan, near the top of the vault.');
  write(DEEP, 'Succession planning detail, buried six levels down where the index could not see it.');
});

test.beforeEach(() => {
  for (const row of db.getEmbeddingIndexSummary()) db.deleteEmbedding(row.relative_path);
  db.setState('embeddings_coverage', '');
  db.setState('embeddings_failed', '');
  db.setState('embeddings_truncated', '');
});

// ── The inventory reaches what retrieval reaches ─────────────────────────────

test('a note deeper than four directories is in the embedding inventory', () => {
  const { files, traversal } = embeddings.inventoryVaultFiles();
  const paths = files.map(f => f.relativePath);
  assert.ok(paths.includes(DEEP), 'the deep note must be eligible for indexing');
  assert.ok(paths.includes(SHALLOW));
  assert.equal(traversal.truncated, false, 'and the walk that found it was complete');
});

test('the inventory and retrieval share one traversal policy', () => {
  const vaultWalk = require('./vault-walk');
  assert.equal(retrieval.MAX_DEPTH, vaultWalk.MAX_DEPTH);
  assert.equal(retrieval.MAX_FILES_SCANNED, vaultWalk.MAX_FILES_SCANNED);
  // The bug was a second, shallower copy of this number living in embeddings.
  assert.ok(vaultWalk.MAX_DEPTH > 4, 'depth 4 is what made deep notes unindexable');
});

test('an indexed deep note is returned by semantic search', async () => {
  index(DEEP);
  index(SHALLOW);
  const detail = await embeddings.semanticSearchDetailed('succession', 10);
  assert.ok(detail.results, 'the index answered');
  assert.ok(detail.results.some(r => r.path === DEEP), 'the deep note is reachable by semantic search');
});

// ── Coverage measures what is missing ────────────────────────────────────────

test('a deep eligible note missing from the index makes coverage incomplete', () => {
  index(SHALLOW);            // the deep one is deliberately left out
  const cov = embeddings.refreshCoverage();
  assert.equal(cov.known, true);
  assert.equal(cov.complete, false);
  assert.equal(cov.eligible, 2);
  assert.equal(cov.indexed, 1);
  assert.equal(cov.unindexed, 1);
  assert.deepEqual(cov.unindexedSample, [DEEP]);
  assert.match(cov.reasons.join(' '), /not in the semantic index/);
});

test('...and it propagates all the way to searchWithHealth', async () => {
  index(SHALLOW);
  embeddings.refreshCoverage();
  const { health } = await retrieval.searchWithHealth('succession', { maxResults: 5 });

  assert.equal(health.semanticCoverageComplete, false);
  assert.equal(health.semanticCoverageKnown, true);
  assert.equal(health.semanticEligibleCount, 2);
  assert.equal(health.semanticIndexedCount, 1);
  assert.equal(health.semanticUnindexedCount, 1);
  assert.deepEqual(health.semanticUnindexedPaths, [DEEP]);

  // ⚠ The provider is perfectly healthy here. That must not read as complete.
  assert.equal(health.semanticAvailable, true);
  const honesty = retrieval.describeIncompleteness(health);
  assert.equal(honesty.incomplete, true);
  assert.match(honesty.note, /does not cover the whole vault/);
  assert.match(honesty.note, /not confirmation that nothing exists/);
});

test('a fully indexed vault is complete, and says nothing', async () => {
  index(SHALLOW);
  index(DEEP);
  const cov = embeddings.refreshCoverage();
  assert.equal(cov.complete, true);
  assert.deepEqual(cov.reasons, []);
  assert.equal(cov.unindexed, 0);

  const { health } = await retrieval.searchWithHealth('succession', { maxResults: 5 });
  assert.equal(health.semanticCoverageComplete, true);
  assert.equal(health.truncated, false);
  // ⚠ No warning on a healthy search, or the warning is one nobody reads.
  assert.equal(retrieval.describeIncompleteness(health).incomplete, false);
  assert.equal(retrieval.describeIncompleteness(health).note, null);
});

test('a stale note — indexed, but changed since — is a coverage gap', () => {
  index(SHALLOW, { modified: '2000-01-01T00:00:00.000Z' });
  index(DEEP);
  const cov = embeddings.refreshCoverage();
  assert.equal(cov.complete, false);
  assert.equal(cov.stale, 1);
  assert.deepEqual(cov.staleSample, [SHALLOW]);
  assert.match(cov.reasons.join(' '), /changed since they were embedded/);
});

test('a truncated note is counted apart from an unindexed one', () => {
  index(SHALLOW);
  index(DEEP);
  db.setState('embeddings_truncated', JSON.stringify({ [DEEP]: { totalChunks: 151, indexed: 60, at: 'now' } }));
  const cov = embeddings.refreshCoverage();
  // We hold PART of it. That is not the same fact as holding none of it, and
  // it does not make the index short of a note.
  assert.equal(cov.truncated, 1);
  assert.equal(cov.unindexed, 0);
  assert.equal(cov.complete, true);
});

// ── A failed run records exactly what it left behind ────────────────────────

test('a failed embedding run records the affected files and makes search incomplete', async () => {
  index(SHALLOW);
  index(DEEP);
  // Both notes are in the index and current — coverage is clean...
  assert.equal(embeddings.refreshCoverage().complete, true);

  // ...until a run fails on one of them. Its OLD rows deliberately survive, so
  // nothing about the result set would otherwise reveal the failure.
  embeddings._noteFailed(DEEP, 'Voyage 429 — out of quota');
  const cov = embeddings.refreshCoverage();

  assert.equal(cov.complete, false);
  assert.equal(cov.failed, 1);
  assert.equal(cov.failedSample[0].relativePath, DEEP);
  assert.match(cov.failedSample[0].reason, /quota/);
  assert.match(cov.reasons.join(' '), /could not be embedded/);

  const { health } = await retrieval.searchWithHealth('succession', { maxResults: 5 });
  assert.equal(health.semanticFailedCount, 1);
  assert.equal(retrieval.describeIncompleteness(health).incomplete, true);
});

test('a later success clears the file from the failed ledger', () => {
  embeddings._noteFailed(DEEP, 'transient');
  assert.equal(embeddings.failedFiles().length, 1);
  embeddings._clearFailed(DEEP);
  assert.deepEqual(embeddings.failedFiles(), []);
});

// ── Unmeasured is its own state, never "complete" ───────────────────────────

test('never-measured coverage reports unknown, and is not passed off as complete', async () => {
  index(SHALLOW);
  index(DEEP);
  db.setState('embeddings_coverage', '');   // as on a brand-new install

  const cov = embeddings.getCoverage();
  assert.equal(cov.known, false);
  // ⚠ null, NOT true. The whole reason this is three-valued.
  assert.equal(cov.complete, null);

  const { health } = await retrieval.searchWithHealth('succession', { maxResults: 5 });
  assert.equal(health.semanticCoverageKnown, false);
  assert.equal(health.semanticCoverageComplete, null);
  assert.match(health.semanticCoverageReasons.join(' '), /has not been measured/);
});

// ── Scope narrows what counts as a gap, without widening the scope ──────────

test('a gap outside the scope does not condemn a scoped search', () => {
  const report = {
    known: true, complete: false, reasons: ['1 eligible note(s) are not in the semantic index'],
    eligible: 2, indexed: 1, unindexed: 1, unindexedSample: ['Projects/shallow.md'],
    stale: 0, staleSample: [], failed: 0, failedSample: [],
    truncated: 0, excluded: 0, inaccessible: 0, walkTruncated: false, walkReasons: [],
  };
  const scoped = embeddings.coverageForScope(report, { kind: 'folder', value: 'Meetings' });
  assert.equal(scoped.complete, true, 'Meetings/ is fully indexed; the gap is in Projects/');

  const inScope = embeddings.coverageForScope(report, { kind: 'folder', value: 'Projects' });
  assert.equal(inScope.complete, false);
});

test('a partial WALK is never scoped away — we do not know what is in any folder', () => {
  const report = {
    known: true, complete: false, reasons: [], eligible: 1, indexed: 1, unindexed: 0,
    unindexedSample: [], stale: 0, staleSample: [], failed: 0, failedSample: [],
    truncated: 0, excluded: 0, inaccessible: 2,
    walkTruncated: true, walkReasons: ['some files or folders could not be read'],
  };
  const scoped = embeddings.coverageForScope(report, { kind: 'folder', value: 'Meetings' });
  assert.equal(scoped.complete, false);
  assert.match(scoped.reasons.join(' '), /could not be read/);
});

test('coverage is durable across a restart — it is read, not recomputed, on the search path', () => {
  index(SHALLOW);
  const written = embeddings.refreshCoverage();
  assert.equal(written.known, true);
  // A fresh read does no walking and must return the same measurement.
  const readBack = embeddings.getCoverage();
  assert.equal(readBack.known, true);
  assert.equal(readBack.eligible, written.eligible);
  assert.equal(readBack.unindexed, written.unindexed);
  assert.equal(typeof readBack.ageMs, 'number');
});

// ── Unreadable is recorded, not skipped ─────────────────────────────────────

test('an unreadable folder is a coverage gap, not a smaller vault', () => {
  const vaultWalk = require('./vault-walk');
  const realReaddir = fs.readdirSync;
  try {
    fs.readdirSync = (dir, opts) => {
      if (String(dir).includes('Meetings')) throw new Error('EACCES: permission denied');
      return realReaddir(dir, opts);
    };
    const res = vaultWalk.walk(tmp, { visit: () => {} });
    assert.equal(res.truncated, true, 'an unreadable folder makes the walk partial');
    assert.ok(res.inaccessibleCount >= 1);
    assert.match(res.reasons.join(' '), /could not be read/);
  } finally {
    fs.readdirSync = realReaddir;
  }
});
