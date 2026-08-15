'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { chunkText, MAX_CHUNKS_PER_FILE, isConfigured } = require('./embeddings');

test('a long note produces more than one chunk', () => {
  // The bug this pins: prepareFile computed every chunk and returned chunks[0].
  // 3,216 rows in the DB, every one chunk_index 0 — so everything decided in
  // the back half of a meeting was unreachable by search, and it was invisible
  // because search always returns SOMETHING.
  const paragraph = 'x'.repeat(400);
  const body = Array.from({ length: 12 }, (_, i) => `${paragraph} ${i}`).join('\n\n');
  const chunks = chunkText(body);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
});

test('the back half of a note is chunked, not discarded', () => {
  const filler = Array.from({ length: 8 }, (_, i) => `Opening exchange paragraph ${i}. ${'y'.repeat(300)}`).join('\n\n');
  const body = `${filler}\n\nDECISION: Stephen moves to the new rota from September.`;
  const chunks = chunkText(body);
  assert.ok(chunks.length > 1);
  assert.ok(
    chunks.some(c => c.includes('DECISION: Stephen moves')),
    'the decision at the end of the note must appear in some chunk'
  );
  assert.ok(
    !chunks[0].includes('DECISION: Stephen moves'),
    'and it must NOT be in chunk 0 — otherwise this test would pass under the old bug'
  );
});

test('short notes still make exactly one chunk', () => {
  assert.equal(chunkText('A single short paragraph about the standup.').length, 1);
});

test('trivial fragments are dropped rather than embedded', () => {
  assert.equal(chunkText('ok').length, 0);
});

test('there is a stated bound on chunks per file', () => {
  // A three-hour transcript should be indexed, not allowed to own the index.
  assert.ok(MAX_CHUNKS_PER_FILE > 1 && MAX_CHUNKS_PER_FILE <= 50);
});

test('embedding readiness is gated on the key embeddings actually use', () => {
  // This read ANTHROPIC_API_KEY while the calls authenticate with Voyage. Both
  // are set on the Pi, so it worked — and would have silently stopped live
  // re-indexing the day the out-of-credit Anthropic key was removed.
  const anthropic = process.env.ANTHROPIC_API_KEY;
  const voyage = process.env.VOYAGE_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-whatever';
    delete process.env.VOYAGE_API_KEY;
    assert.equal(isConfigured(), false, 'an Anthropic key does not configure embeddings');

    process.env.VOYAGE_API_KEY = 'pa-whatever';
    assert.equal(isConfigured(), true);
  } finally {
    if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = anthropic;
    if (voyage === undefined) delete process.env.VOYAGE_API_KEY; else process.env.VOYAGE_API_KEY = voyage;
  }
});
