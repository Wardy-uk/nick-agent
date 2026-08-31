'use strict';

/**
 * What a call actually cost.
 *
 * The rule here is the one the rest of NEURO already follows: prefer the number
 * the vendor reports, estimate only when it is absent, and ALWAYS say which.
 * A cost table maintained by hand goes stale silently — prices change and
 * nothing tells you — so it is the fallback, never the first answer.
 *
 * Three outcomes, and the third is the one that matters:
 *   · `vendor`    — OpenRouter returned the real charged cost. Authoritative.
 *   · `estimated` — priced from the table below. Directionally right, dated.
 *   · `unknown`   — an unpriced model, or tokens we never learned. Cost is
 *                   **null, never 0**. A zero here reads as "this was free",
 *                   which is the one thing it definitely was not.
 */

// USD per MILLION tokens. Last checked 26 Aug 2026 — an estimate with a date
// on it, not a price list.
//
// ⚠ NOVA has a TWIN of this table: `MODEL_PRICING` in
// `daypilot/src/server/services/llm-service.ts`. Separate repos on separate
// machines, so it cannot be shared as code — the values below are deliberately
// copied from it so the two agree today, and they are the thing to check when
// either is touched. A price is a fact about the world; a disagreement between
// them is one of them being wrong, not a naming difference.
const PRICES_PER_MTOK = {
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  // VESTA's fridge photo. NOVA has no twin of this row — it does no vision —
  // so it is not part of the parity check above.
  'claude-opus-5': { input: 5, output: 25 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
};
const PRICES_CHECKED = '2026-08-26';

// Everything here is USD, because that is what the vendors charge and what
// OpenRouter reports. NOVA stores USD and renders it with a "£" sign and no
// conversion, which makes every figure on its Costs tab ~27% wrong; the only
// FX rate in that repo is a hardcoded 0.79 in one briefing query. NEURO says
// USD and means it — a pound figure needs an exchange-rate source, and
// inventing one is how that bug happened.
const CURRENCY = 'USD';

// Anything served by the Pi is genuinely free at the point of use, and saying
// so is not the same claim as "we could not price it".
const FREE_PROVIDERS = new Set(['ollama', 'pi4worker']);

function normaliseModel(model) {
  return String(model || '').trim().toLowerCase();
}

function priceFor(model) {
  return PRICES_PER_MTOK[normaliseModel(model)] || null;
}

/**
 * @param {object} usage  { prompt_tokens, completion_tokens, total_tokens, cost }
 * @param {string} model
 * @param {string} provider
 * @returns {{ costUsd: number|null, source: 'vendor'|'estimated'|'free'|'unknown' }}
 */
function resolveCost(usage, model, provider) {
  if (FREE_PROVIDERS.has(String(provider || '').toLowerCase())) {
    return { costUsd: 0, source: 'free' };
  }

  // OpenRouter returns the real charged cost when asked for it. Nothing we can
  // compute beats being told.
  const vendor = Number(usage?.cost);
  if (Number.isFinite(vendor) && vendor >= 0) {
    return { costUsd: vendor, source: 'vendor' };
  }

  const price = priceFor(model);
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;

  // No price, or no idea how many tokens moved. Either way we cannot say.
  // Note a call with a known model but zero tokens is ALSO unknown, not free:
  // that is what a dropped usage block looks like, and it is exactly how
  // streaming chat came to cost nothing at all.
  if (!price || (prompt === 0 && completion === 0)) {
    return { costUsd: null, source: 'unknown' };
  }

  return {
    costUsd: (prompt * price.input + completion * price.output) / 1e6,
    source: 'estimated',
  };
}

/**
 * Sum a set of ledger rows without pretending the unpriced ones were free.
 * `unpricedCalls` is the honesty half: a total is only the whole story when
 * that number is 0, and the panel says so.
 */
function summarise(rows) {
  let costUsd = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let unpricedCalls = 0;
  let vendorPriced = 0;

  for (const r of rows) {
    promptTokens += r.prompt_tokens || 0;
    completionTokens += r.completion_tokens || 0;
    if (r.cost_usd == null) unpricedCalls++;
    else costUsd += r.cost_usd;
    if (r.cost_source === 'vendor') vendorPriced++;
  }

  return {
    calls: rows.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    unpricedCalls,
    // What share of the money figure came from the vendor rather than our
    // table — a summary that is mostly estimate should read as one.
    vendorPricedShare: rows.length ? Math.round((vendorPriced / rows.length) * 100) : null,
  };
}

/**
 * Models seen in the ledger that have no price. NOVA's equivalent function
 * returns 0 for an unknown model with no log and no flag, so anything not in
 * its map silently records as free and vanishes from every rollup — it already
 * bites there (`claude-sonnet-4-20250514` appears in its UI but not its price
 * map). Surfacing the list is what stops that being invisible here.
 */
function unpricedModels(rows) {
  const seen = new Map();
  for (const r of rows) {
    if (r.cost_usd != null || !r.model) continue;
    seen.set(r.model, (seen.get(r.model) || 0) + 1);
  }
  return [...seen.entries()]
    .map(([model, calls]) => ({ model, calls }))
    .sort((a, b) => b.calls - a.calls);
}

module.exports = {
  resolveCost,
  priceFor,
  summarise,
  unpricedModels,
  PRICES_PER_MTOK,
  PRICES_CHECKED,
  CURRENCY,
};
