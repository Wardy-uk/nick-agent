'use strict';

/**
 * The retrieval completeness contract.
 *
 * ⚠ The rule under test is the one NEURO applies everywhere else and had never
 * applied to search: **an incomplete answer is never proof that nothing
 * exists.** A depth cap, a file-scan cap, an unreadable vault and a dead
 * embeddings index all return the same short list, and only one of them is
 * evidence about the vault. So completeness is a fact about the SEARCH,
 * reported from what the walk did — never inferred from the result count.
 *
 * Run against a real temp vault, with the embeddings layer stubbed so the
 * semantic arm can be made to degrade, or to hand back out-of-scope paths, on
 * purpose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-completeness-'));
process.env.OBSIDIAN_VAULT_PATH = tmp;

const embeddings = require('./embeddings');
const retrieval = require('./retrieval');

function write(rel, body) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

const realDetailed = embeddings.semanticSearchDetailed;
const realSemantic = embeddings.semanticSearch;

/** Stub the semantic arm as "unavailable" — the honest degrade to keyword. */
function stubSemanticDown() {
  embeddings.semanticSearchDetailed = async () => ({
    results: null, available: false, why: 'stubbed down', recall: 'none', examined: 0, boundedRecall: false,
  });
}
/** Stub it as available and silent, so only traversal is under test. */
function stubSemanticQuiet() {
  embeddings.semanticSearchDetailed = async () => ({
    results: [], available: true, why: null, recall: 'exact', examined: 0, boundedRecall: false,
  });
}
test.afterEach(() => {
  embeddings.semanticSearchDetailed = realDetailed;
  embeddings.semanticSearch = realSemantic;
});

test.before(() => {
  write('Meetings/2026/08/standup.md', 'The succession plan was discussed today.');
  write('Meetings/2026/08/deep/deeper/deepest/buried.md', 'Succession planning notes buried five levels down.');
  write('Projects/other.md', 'Succession planning for the wider business.');
});

// ── The caps are reported, not swallowed ─────────────────────────────────────

test('a depth cap returns results AND says the answer is partial', async () => {
  stubSemanticQuiet();
  // The real walk, at a depth that genuinely cuts the vault in half. The
  // shallow note is found; the buried one is not — and the difference is
  // REPORTED rather than left to look like an absence.
  const { results, health } = await retrieval.searchWithHealth('succession', { maxResults: 10, maxDepth: 1 });

  assert.ok(results.length > 0, 'a depth-capped search still answers');
  assert.ok(!results.some(r => r.path.includes('deepest')), 'the buried note was out of reach');
  assert.equal(health.truncated, true);
  assert.equal(health.keywordComplete, false);
  assert.match(health.truncationReasons.join(' '), /deeper than 1 levels were not searched/);
  // ⚠ And the honest sentence, not a count.
  assert.match(retrieval.describeIncompleteness(health).note, /not confirmation that nothing exists/);
});

test('the file-scan cap marks the whole answer truncated, with a reason', async () => {
  stubSemanticQuiet();
  const { health } = await retrieval.searchWithHealth('succession', { maxResults: 10, maxFiles: 1 });
  assert.equal(health.truncated, true);
  assert.equal(health.keywordComplete, false);
  assert.match(health.truncationReasons.join(' '), /scan capped at 1 files/);
  assert.ok(health.filesScanned <= 1);
});

test('a capped TEMPORAL walk is reported too, not just the keyword one', async () => {
  stubSemanticQuiet();
  const { health } = await retrieval.searchWithHealth('succession', {
    maxResults: 10,
    maxDepth: 1,
    from: new Date(Date.now() - 86400000),
    to: new Date(Date.now() + 86400000),
  });
  assert.equal(health.temporalComplete, false);
  assert.match(health.truncationReasons.join(' '), /temporal: /);
});

test('a complete search says so — no reasons, nothing to hedge', async () => {
  stubSemanticQuiet();
  const { health } = await retrieval.searchWithHealth('succession', { maxResults: 5 });
  assert.equal(health.truncated, false);
  assert.deepEqual(health.truncationReasons, []);
  assert.equal(health.keywordComplete, true);
  // Temporal was NOT asked for, which is a different fact from "it ran and was
  // complete". Null keeps them apart.
  assert.equal(health.temporalComplete, null);
});

test('asking for a date range makes temporalComplete a boolean, not null', async () => {
  stubSemanticQuiet();
  const { health } = await retrieval.searchWithHealth('succession', {
    maxResults: 5,
    from: new Date(Date.now() - 86400000),
    to: new Date(Date.now() + 86400000),
  });
  assert.equal(health.temporalComplete, true);
  assert.equal(health.truncated, false);
});

test('the note found five levels down proves depth 4 is gone', async () => {
  stubSemanticQuiet();
  const { results } = await retrieval.searchWithHealth('succession planning buried', { maxResults: 10 });
  assert.ok(results.some(r => r.path === 'Meetings/2026/08/deep/deeper/deepest/buried.md'));
});

// ── A missing vault is INCOMPLETE, never a healthy empty one ─────────────────

test('a missing vault path is reported incomplete, not as an empty vault', () => {
  // walkVault answers this directly and is the single place every filesystem
  // arm goes through, so it is where the guarantee lives.
  const originalExists = fs.existsSync;
  try {
    fs.existsSync = (p) => (p === tmp ? false : originalExists(p));
    const traversal = retrieval.walkVault(null, () => {});
    assert.equal(traversal.truncated, true);
    assert.match(traversal.why, /not readable/);
    assert.equal(traversal.scanned, 0);
  } finally {
    fs.existsSync = originalExists;
  }
});

test('noTraversal is always truncated — "we could not look" is incompleteness', () => {
  const t = retrieval.noTraversal('vault path is not configured');
  assert.equal(t.truncated, true);
  assert.equal(t.scanned, 0);
  assert.equal(t.why, 'vault path is not configured');
});

test('a query with no usable keyword term does not pass as a complete search', async () => {
  const { traversal, results } = await retrieval.keywordSearchDetailed('ab', {});
  assert.deepEqual(results, []);
  assert.equal(traversal.truncated, true);
  assert.match(traversal.why, /3 characters/);
});

// ── Completeness is never inferred from the count ────────────────────────────

test('zero results from a complete search is NOT flagged incomplete', async () => {
  stubSemanticQuiet();
  const { results, health } = await retrieval.searchWithHealth('zzzznothingmatchesthis', { maxResults: 5 });
  assert.deepEqual(results, []);
  // Nothing matched. That IS evidence — and saying otherwise would make the
  // warning meaningless everywhere it matters.
  assert.equal(health.truncated, false);
  assert.equal(retrieval.describeIncompleteness(health).incomplete, false);
});

test('a full result set from a degraded search IS flagged incomplete', async () => {
  stubSemanticDown();
  const { results, health } = await retrieval.searchWithHealth('succession', { maxResults: 5 });
  assert.ok(results.length > 0, 'keyword still answered');
  assert.equal(health.semanticAvailable, false);
  const honesty = retrieval.describeIncompleteness(health);
  assert.equal(honesty.incomplete, true);
  assert.match(honesty.note, /not confirmation that nothing exists/);
});

test('describeIncompleteness treats traversal truncation exactly like a dead index', () => {
  const fromIndex = retrieval.describeIncompleteness({ semanticAvailable: false, truncated: false, truncationReasons: [] });
  const fromWalk = retrieval.describeIncompleteness({ semanticAvailable: true, truncated: true, truncationReasons: ['keyword: directories deeper than 12 levels were not searched'] });
  assert.equal(fromIndex.incomplete, true);
  assert.equal(fromWalk.incomplete, true);
  // Same promise, differently caused.
  assert.match(fromWalk.note, /not confirmation that nothing exists/);
  assert.match(fromIndex.note, /not confirmation that nothing exists/);
});

// ── Scoped semantic recall ───────────────────────────────────────────────────

test('a folder scope narrows the index BEFORE ranking, so a low-ranked in-scope note still surfaces', async () => {
  // The old shape: fetch the global top N, then filter. Simulated here by a
  // stub that would only ever hand back out-of-scope notes if the pathFilter
  // were ignored — the in-scope note ranks last.
  const corpus = [];
  for (let i = 0; i < 300; i++) corpus.push({ path: `Projects/noise-${i}.md`, name: `noise-${i}`, score: 0.9 - i * 0.001, excerpts: ['noise'] });
  corpus.push({ path: 'Meetings/2026/08/standup.md', name: 'standup', score: 0.11, excerpts: ['the succession plan'] });

  embeddings.semanticSearchDetailed = async (query, maxResults, opts = {}) => {
    const pool = opts.pathFilter ? corpus.filter(r => opts.pathFilter(r.path)) : corpus;
    return { results: pool.slice(0, maxResults), available: true, why: null, recall: 'exact', examined: pool.length, boundedRecall: false };
  };

  const { results, health } = await retrieval.searchWithHealth('succession', { maxResults: 5, scope: 'folder:Meetings' });
  assert.ok(results.some(r => r.path === 'Meetings/2026/08/standup.md'),
    'the in-scope note ranked 301st globally and must still be found');
  assert.ok(results.every(r => r.path.startsWith('Meetings/')), 'nothing out of scope leaked');
  assert.equal(health.semanticRecall, 'exact');
  assert.equal(health.truncated, false);
});

test('a bounded person-scope pass reports its recall limit rather than looking empty', async () => {
  embeddings.semanticSearchDetailed = async () => ({
    results: [], available: true, why: null, recall: 'bounded', examined: 500, boundedRecall: true,
  });
  const { health } = await retrieval.searchWithHealth('succession', { maxResults: 5, scope: 'person:Naomi Wentworth' });
  assert.equal(health.semanticBoundedRecall, true);
  assert.equal(health.truncated, true);
  assert.match(health.truncationReasons.join(' '), /stopped after examining/);
  // ⚠ And the scope was NOT widened to compensate.
  assert.equal(health.scope.kind, 'person');
});

test('an unrecognised scope admits nothing from the index — it never widens', async () => {
  let sawFilter = null;
  embeddings.semanticSearchDetailed = async (q, n, opts = {}) => {
    sawFilter = opts.pathFilter;
    return { results: [], available: true, why: null, recall: 'exact', examined: 0, boundedRecall: false };
  };
  const { results } = await retrieval.searchWithHealth('succession', { maxResults: 5, scope: 'wibble:Meetings' });
  assert.deepEqual(results, []);
  assert.equal(typeof sawFilter, 'function');
  assert.equal(sawFilter('anything/at/all.md'), false);
});
