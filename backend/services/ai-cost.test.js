'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cost = require('./ai-cost');

// The whole point of the module: an unpriced call must never look like a free
// one. NOVA's equivalent returns 0 for an unknown model with no log and no
// flag, so anything outside its price map silently records as free and
// vanishes from every rollup.
test('an unpriced model costs NULL, never zero', () => {
  const r = cost.resolveCost({ prompt_tokens: 900, completion_tokens: 100 }, 'some/model-nobody-priced', 'openrouter');
  assert.equal(r.costUsd, null);
  assert.equal(r.source, 'unknown');
});

test('a known model with no tokens reported is also unknown, not free', () => {
  // This is exactly what a dropped usage block looks like, and it is how
  // streaming chat came to cost nothing at all.
  const r = cost.resolveCost({ prompt_tokens: 0, completion_tokens: 0 }, 'anthropic/claude-haiku-4.5', 'openrouter');
  assert.equal(r.costUsd, null);
  assert.equal(r.source, 'unknown');
});

test('the vendor’s own cost beats our table', () => {
  // Deliberately a figure our table would never produce, so the assertion can
  // only pass if the vendor number was preferred.
  const r = cost.resolveCost(
    { prompt_tokens: 1000, completion_tokens: 1000, cost: 0.4242 },
    'anthropic/claude-haiku-4.5',
    'openrouter',
  );
  assert.equal(r.costUsd, 0.4242);
  assert.equal(r.source, 'vendor');
});

test('a free vendor cost of 0 is honoured rather than falling through', () => {
  // 0 is falsy — a truthiness check here would silently re-price a genuinely
  // free call from the table.
  const r = cost.resolveCost({ prompt_tokens: 10, completion_tokens: 10, cost: 0 }, 'anthropic/claude-haiku-4.5', 'openrouter');
  assert.equal(r.costUsd, 0);
  assert.equal(r.source, 'vendor');
});

test('input and output are priced differently, because they are', () => {
  // haiku-4.5: $1/M in, $5/M out. Same token count each way must NOT be
  // symmetrical — the old counter stored only a total, which is why cost could
  // not be derived from it at all.
  const inHeavy = cost.resolveCost({ prompt_tokens: 1e6, completion_tokens: 0 }, 'anthropic/claude-haiku-4.5', 'openrouter');
  const outHeavy = cost.resolveCost({ prompt_tokens: 0, completion_tokens: 1e6 }, 'anthropic/claude-haiku-4.5', 'openrouter');
  assert.equal(inHeavy.costUsd, 1);
  assert.equal(outHeavy.costUsd, 5);
  assert.equal(inHeavy.source, 'estimated');
});

test('local providers are free, which is a different claim from unpriced', () => {
  const r = cost.resolveCost({ prompt_tokens: 5000, completion_tokens: 500 }, 'qwen2.5:1.5b', 'ollama');
  assert.equal(r.costUsd, 0);
  assert.equal(r.source, 'free');
});

test('a summary reports what it could not price rather than absorbing it', () => {
  const s = cost.summarise([
    { prompt_tokens: 100, completion_tokens: 10, cost_usd: 0.5, cost_source: 'vendor' },
    { prompt_tokens: 200, completion_tokens: 20, cost_usd: 0.25, cost_source: 'estimated' },
    { prompt_tokens: 300, completion_tokens: 30, cost_usd: null, cost_source: 'unknown' },
  ]);
  assert.equal(s.calls, 3);
  assert.equal(s.costUsd, 0.75, 'the null is not counted as 0 in the total');
  assert.equal(s.unpricedCalls, 1, 'and it is not hidden either');
  assert.equal(s.totalTokens, 660);
  assert.equal(s.vendorPricedShare, 33);
});

test('unpriced models are named so a missing price is findable', () => {
  const rows = [
    { model: 'anthropic/claude-haiku-4.5', cost_usd: 0.1 },
    { model: 'mystery/model-a', cost_usd: null },
    { model: 'mystery/model-a', cost_usd: null },
    { model: 'mystery/model-b', cost_usd: null },
  ];
  assert.deepEqual(cost.unpricedModels(rows), [
    { model: 'mystery/model-a', calls: 2 },
    { model: 'mystery/model-b', calls: 1 },
  ]);
});

// NOVA holds a twin of this table (`MODEL_PRICING` in llm-service.ts). Separate
// repos, so it cannot be shared as code — this pins the overlap so a change on
// one side is a visible decision rather than silent drift.
test('the prices NOVA also holds still agree with NOVA', () => {
  assert.deepEqual(cost.PRICES_PER_MTOK['anthropic/claude-haiku-4.5'], { input: 1, output: 5 });
  assert.deepEqual(cost.PRICES_PER_MTOK['claude-haiku-4-5-20251001'], { input: 1, output: 5 });
  assert.deepEqual(cost.PRICES_PER_MTOK['anthropic/claude-sonnet-5'], { input: 2, output: 10 });
  assert.deepEqual(cost.PRICES_PER_MTOK['gpt-4.1-mini'], { input: 0.4, output: 1.6 });
});

test('everything is USD and says so', () => {
  // NOVA renders unconverted USD with a "£" sign. Naming the currency is what
  // stops that happening here.
  assert.equal(cost.CURRENCY, 'USD');
});
