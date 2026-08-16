'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const embeddings = require('./embeddings');
const {
  isRealEmbedding, _storedIsReal, computeSimpleVector,
  VOYAGE_DIMENSIONS, FALLBACK_DIMENSIONS, getEmbeddingHealth,
} = embeddings;

// #56 — embeddings were the last AI path that could fail silently. Voyage
// bypasses ai-routing entirely: no budget, no telemetry, nothing on the AI
// panel. On failure the code fell back to computeSimpleVector() — a local hash —
// and WROTE THAT INTO THE INDEX alongside real vectors, stamped with the real
// content hash.
//
// That is worse than "search degrades to keyword matching", which is how the
// ticket described it. Measured on the live index: 74 rows across 32 files,
// including one meeting transcript's entire 16 chunks and another's 13. The
// oldest dated from 18 June and could never have healed on its own.

test('the two vector sizes are different, which is the whole bug', () => {
  // cosineSimilarity() returns 0 the moment the lengths differ, so a fallback
  // vector in a real index is not a worse match — it is unreachable, while
  // still occupying the row that says the file is indexed.
  assert.equal(VOYAGE_DIMENSIONS, 1024);
  assert.equal(FALLBACK_DIMENSIONS, 128);
  assert.equal(computeSimpleVector('some note text').length, FALLBACK_DIMENSIONS);
});

test('only a full-length vector counts as real', () => {
  assert.equal(isRealEmbedding(new Array(1024).fill(0.1)), true);
  assert.equal(isRealEmbedding(new Array(128).fill(0.1)), false);
  assert.equal(isRealEmbedding(new Array(1023).fill(0.1)), false, 'a truncated response is not usable');
  assert.equal(isRealEmbedding(null), false);
  assert.equal(isRealEmbedding('not an array'), false);
});

test('a stored fallback row is detected as unreachable', () => {
  const previousKey = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = 'test-key';
  try {
    assert.equal(_storedIsReal({ embedding: JSON.stringify(new Array(1024).fill(0.1)) }), true);
    assert.equal(_storedIsReal({ embedding: JSON.stringify(new Array(128).fill(0.1)) }), false);
    assert.equal(_storedIsReal({ embedding: 'not json' }), false);
    assert.equal(_storedIsReal({}), false);
    assert.equal(_storedIsReal(null), false);
  } finally {
    if (previousKey === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = previousKey;
  }
});

test('with no key configured the hash index is self-consistent, so nothing is re-embedded', () => {
  // The mixture is what breaks. With no key at all, documents AND queries are
  // hashed the same way and match each other — weak, but coherent. Treating
  // those rows as damaged would put the whole vault into a rebuild loop it
  // could never satisfy, because every re-embed would produce the same 128 dims.
  const previousKey = process.env.VOYAGE_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  try {
    assert.equal(_storedIsReal({ embedding: JSON.stringify(new Array(128).fill(0.1)) }), true);
  } finally {
    if (previousKey !== undefined) process.env.VOYAGE_API_KEY = previousKey;
  }
});

test('"not probed yet" is a distinct state from "working"', () => {
  // The honesty pattern from #65's getBridgeHealth. A path nobody has called is
  // not a healthy one, and reporting it as green is how a dead bridge looked
  // exactly like an empty mailbox for a week.
  const previousKey = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = 'test-key';
  try {
    const h = getEmbeddingHealth();
    assert.ok(['unprobed', 'ok', 'degraded'].includes(h.status));
    assert.equal(h.configured, true);
    // A fresh module has made no calls, so it must not claim to be working.
    if (h.calls === 0) assert.equal(h.status, 'unprobed');
  } finally {
    if (previousKey === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = previousKey;
  }
});

test('no key at all reports as not-configured, not as broken', () => {
  const previousKey = process.env.VOYAGE_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  try {
    const h = getEmbeddingHealth();
    assert.equal(h.status, 'not-configured');
    assert.equal(h.configured, false);
  } finally {
    if (previousKey !== undefined) process.env.VOYAGE_API_KEY = previousKey;
  }
});
