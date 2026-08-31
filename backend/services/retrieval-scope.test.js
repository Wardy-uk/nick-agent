'use strict';

/**
 * Retrieval scope, ranking and honest degradation.
 *
 * ── The three bugs ──────────────────────────────────────────────────────────
 * 1. `scope` was applied inside `keywordSearch` ONLY. Semantic results were
 *    never checked against it and carry the HIGHEST fusion weight, so asking
 *    for `folder:Meetings` reliably returned notes from outside Meetings,
 *    ranked above the ones inside it.
 * 2. The keyword walk stopped once it had collected `maxResults * 2` files, in
 *    FILESYSTEM ORDER. The answer was "the first N the directory listing
 *    happened to yield", not "the best N", so a strong match late in the walk
 *    could not outrank a weak one early in it.
 * 3. The walk was capped at depth 4, silently removing whole subtrees while
 *    they went on looking perfectly searchable.
 *
 * Run against a real temp vault, with `embeddings.semanticSearch` stubbed so
 * the semantic arm can be made to return out-of-scope paths on purpose — which
 * is the only way to prove the gate holds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-retrieval-'));
process.env.OBSIDIAN_VAULT_PATH = tmp;

const embeddings = require('./embeddings');
const retrieval = require('./retrieval');

function write(rel, body) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

const realSemantic = embeddings.semanticSearch;
const realDetailed = embeddings.semanticSearchDetailed;

/**
 * Stub the semantic arm.
 *
 * `fn` keeps the old array-or-null contract, which is what these tests are
 * written against. Retrieval calls `semanticSearchDetailed` now (that is what
 * lets a `folder:` scope narrow the index BEFORE ranking), so BOTH are replaced
 * and the array is wrapped — otherwise a stub here would be quietly ignored and
 * every scope test would be exercising the real index.
 *
 * ⚠ The stub deliberately does NOT honour `pathFilter`. That is the point: the
 * gate has to hold over a source that hands back out-of-scope paths, which is
 * the only way to prove it is a guarantee rather than a convention.
 */
function stubSemantic(fn) {
  embeddings.semanticSearch = fn;
  embeddings.semanticSearchDetailed = async (...args) => {
    const results = await fn(...args);
    return results === null
      ? { results: null, available: false, why: 'stubbed unavailable', recall: 'none', examined: 0, boundedRecall: false }
      : { results, available: true, why: null, recall: 'exact', examined: results.length, boundedRecall: false };
  };
}
test.after(() => {
  embeddings.semanticSearch = realSemantic;
  embeddings.semanticSearchDetailed = realDetailed;
});

test.before(() => {
  write('Meetings/2026/08/standup.md', 'The succession plan was discussed with Naomi Wentworth today.');
  write('Meetings/2026/08/one-to-one.md', 'Succession planning, and the risk assessment. Naomi Wentworth owns it.');
  // Deliberately DEEP: five levels down, past the old depth-4 cap.
  write('Meetings/2026/08/deep/deeper/deepest/buried.md', 'Succession planning notes buried five levels down.');
  write('Projects/other.md', 'Succession planning for the wider business, nothing to do with meetings.');
  write('People/Naomi Wentworth.md', 'Her People note. Nothing about succession here.');
  // ⚠ The body must not contain the bare first name anywhere, or the fixture
  // proves nothing: the point is that "Liam" inside "William" is not a match.
  write('Projects/william.md', 'A note about William Hartley and succession planning.');
});

// ── Pure rules ───────────────────────────────────────────────────────────────

test('folder scope is segment-aware — "Meetings" is not "Meetings archive"', () => {
  assert.equal(retrieval.pathInFolder('Meetings/2026/08/a.md', 'Meetings'), true);
  assert.equal(retrieval.pathInFolder('Meetings archive/a.md', 'Meetings'), false);
  // And the reverse containment the old code allowed is gone: asking for
  // Meetings/2026 must not be answered with Meetings/2025.
  assert.equal(retrieval.pathInFolder('Meetings/2025/a.md', 'Meetings/2026'), false);
});

test('an unrecognised scope admits nothing — it fails closed', () => {
  const parsed = retrieval.parseScope('projekt:Meetings');
  assert.equal(parsed.kind, 'unknown');
  assert.equal(retrieval.inScope({ path: 'anything.md' }, parsed, new Map()), false);
});

test('person matching is whole-word on the full name', () => {
  const cache = new Map();
  assert.equal(retrieval.noteMentionsPerson('Meetings/2026/08/standup.md', 'Naomi Wentworth', cache), true);
  // "Liam" inside "William" is the bug `entities.js` already learned.
  assert.equal(retrieval.noteMentionsPerson('Projects/william.md', 'Liam', cache), false);
  // The person's own note qualifies by filename even though the body says
  // nothing about them by name.
  assert.equal(retrieval.noteMentionsPerson('People/Naomi Wentworth.md', 'Naomi Wentworth', cache), true);
});

// ── Scope enforcement across sources ─────────────────────────────────────────

test('a SEMANTIC result outside the requested folder is never returned', async () => {
  // The semantic arm is made to return exactly the wrong thing, at the top of
  // its list, where the 1.2 fusion weight would previously have put it first.
  stubSemantic(async () => ([
    { path: 'Projects/other.md', name: 'other', excerpts: ['Succession planning for the wider business'], score: 0.99 },
    { path: 'Meetings/2026/08/standup.md', name: 'standup', excerpts: ['The succession plan'], score: 0.4 },
  ]));

  const { results, health } = await retrieval.searchWithHealth('succession planning', {
    scope: 'folder:Meetings', maxResults: 10,
  });

  assert.ok(results.length > 0, 'the in-scope notes should still be found');
  for (const r of results) {
    assert.ok(r.path.startsWith('Meetings/'), `out-of-scope result leaked: ${r.path}`);
  }
  assert.equal(health.scope.kind, 'folder');
});

test('a SEMANTIC result that does not concern the person is never returned', async () => {
  stubSemantic(async () => ([
    { path: 'Projects/other.md', name: 'other', excerpts: ['nothing about her'], score: 0.99 },
    { path: 'Meetings/2026/08/one-to-one.md', name: 'one-to-one', excerpts: ['Naomi Wentworth owns it'], score: 0.5 },
  ]));

  const { results } = await retrieval.searchWithHealth('succession', {
    scope: 'person:Naomi Wentworth', maxResults: 10,
  });

  assert.ok(results.length > 0);
  for (const r of results) {
    assert.ok(
      retrieval.noteMentionsPerson(r.path, 'Naomi Wentworth', new Map()),
      `result outside the person scope: ${r.path}`
    );
  }
});

// ── Ranking and depth ────────────────────────────────────────────────────────

test('a deep but permitted path is searched', async () => {
  const results = await retrieval.keywordSearch('succession planning notes', { maxResults: 20 });
  assert.ok(
    results.some((r) => r.path === 'Meetings/2026/08/deep/deeper/deepest/buried.md'),
    'a note five levels down must be reachable — the old depth cap was 4'
  );
});

test('keyword ranking sees the whole permitted set, not the first N in walk order', async () => {
  // Twenty weak matches, then one strong one. Under the old early stop the walk
  // filled up on whatever came first and the strong match could not be ranked
  // at all.
  for (let i = 0; i < 20; i += 1) {
    write(`Bulk/aaa-${String(i).padStart(2, '0')}.md`, 'quarterly reporting only');
  }
  write('Bulk/zzz-strong.md', 'quarterly reporting cadence dashboards — quarterly reporting cadence dashboards');

  const results = await retrieval.keywordSearch('quarterly reporting cadence dashboards', { maxResults: 3 });
  assert.ok(results.length > 0);
  assert.equal(results[0].path, 'Bulk/zzz-strong.md', 'the best match must win regardless of walk order');
});

// ── Honest degradation ───────────────────────────────────────────────────────

test('unavailable embeddings degrade to keyword, and SAY so — never an empty vault', async () => {
  // `null` is the embeddings service's honest "I could not answer".
  stubSemantic(async () => null);

  const { results, health } = await retrieval.searchWithHealth('succession planning', { maxResults: 5 });

  assert.equal(health.semanticAvailable, false);
  assert.match(health.semanticWhy, /unavailable/);
  // The vault is plainly not empty, and the answer must not look as if it were.
  assert.ok(results.length > 0, 'keyword must still answer when semantic cannot');
  assert.ok(health.keywordCount > 0);
});

test('a semantic failure is not silently the same as no matches', async () => {
  stubSemantic(async () => []);
  const empty = await retrieval.searchWithHealth('succession planning', { maxResults: 5 });
  assert.equal(empty.health.semanticAvailable, true, 'an empty result set is an answer');

  stubSemantic(async () => { throw new Error('voyage is down'); });
  const broken = await retrieval.searchWithHealth('succession planning', { maxResults: 5 });
  assert.equal(broken.health.semanticAvailable, false);
  assert.match(broken.health.semanticWhy, /voyage is down/);
});

test('an over-limit note is reported as partly indexed, not silently complete', async () => {
  stubSemantic(async () => ([
    { path: 'Meetings/2026/08/one-to-one.md', name: 'one-to-one', excerpts: ['Naomi Wentworth owns it'], score: 0.9 },
  ]));
  const realTruncated = embeddings.truncatedFiles;
  embeddings.truncatedFiles = () => ['Meetings/2026/08/one-to-one.md'];
  try {
    const { results, health } = await retrieval.searchWithHealth('succession planning', { maxResults: 5 });
    const flagged = results.find((r) => r.path === 'Meetings/2026/08/one-to-one.md');
    assert.ok(flagged, 'the note should still be returned — partly indexed is not unindexed');
    assert.equal(flagged.indexIncomplete, true);
    assert.ok(health.incomplete.includes('Meetings/2026/08/one-to-one.md'));

    // And a note the index holds in full carries no such flag, so the marker
    // means something.
    const other = results.find((r) => r.path !== 'Meetings/2026/08/one-to-one.md');
    if (other) assert.equal(other.indexIncomplete, undefined);
  } finally {
    embeddings.truncatedFiles = realTruncated;
  }
});

test('search() keeps its long-standing array shape', async () => {
  stubSemantic(async () => []);
  const results = await retrieval.search('succession planning', { maxResults: 3 });
  assert.ok(Array.isArray(results), 'every existing caller expects an array');
});
