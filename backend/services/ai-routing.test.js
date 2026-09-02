'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The routing policy, pinned. Nick's rule (14 Aug 2026): Ollama for the light and
// scheduled, OpenRouter where he is sitting there waiting. Anthropic and OpenAI
// are backstops, never the default — the Anthropic key ran out of credit while it
// was tier 1 and took chat and the standup down with it.

const routing = require('./ai-routing');

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('anything Nick waits on goes to OpenRouter first, never a local model', () => {
  for (const task of ['chat_sync', 'chat_stream', 'standup_interactive', 'eod_interactive']) {
    const order = routing._providerOrder(task);
    assert.equal(order[0], 'openrouter', `${task} should lead with OpenRouter`);
    assert.equal(order.at(-1), 'ollama', `${task} should keep Ollama as the last resort`);
  }
});

test('light and scheduled work runs locally first', () => {
  // drilldown_framing was in this list until 2 Sep 2026 and is deliberately not
  // any more — see the next test. Nothing else moved.
  for (const task of ['focus_enhancement', 'knowledge_consolidation', 'action_suggestion']) {
    const order = routing._providerOrder(task);
    assert.equal(order[0], 'ollama', `${task} should lead with Ollama`);
  }
});

/**
 * The exception, and why it is one.
 *
 * "Light and scheduled runs locally" splits on whether anyone is waiting, and
 * drilldown_framing looked light — one short sentence, 84 input tokens. But it
 * is awaited inside `GET /api/todos/focus` and raced against a 5s deadline in
 * routes/todos.js, so Nick holds the request while it runs. The local model
 * measures ~5 tok/s on this Pi and was given 4s, which it could never meet: 20
 * of 29 calls burned four of the five seconds failing and were then served by
 * OpenRouter anyway.
 *
 * Pinned so this cannot be quietly "tidied" back into the local list by someone
 * reading only the task's size.
 */
test('drilldown_framing is cloud-first because a request is waiting on it', () => {
  const order = routing._providerOrder('drilldown_framing');
  assert.equal(order[0], 'openrouter', 'a user-facing 5s budget cannot afford a doomed local attempt');
  assert.equal(order.at(-1), 'ollama', 'still reachable as a last resort');
});

test('Anthropic and OpenAI are backstops, never the default', () => {
  for (const task of ['chat_sync', 'focus_enhancement']) {
    const order = routing._providerOrder(task);
    assert.notEqual(order[0], 'anthropic');
    assert.notEqual(order[0], 'openai');
    assert.ok(order.includes('anthropic'), 'still reachable when explicitly configured');
  }
});

test('tool calls prefer OpenRouter when it has a key', () => {
  withEnv({ AI_MODE: 'hybrid', OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'test-key' }, () => {
    const picked = routing.getToolProvider('chat_sync');
    assert.equal(picked?.name, 'openrouter');
    assert.equal(typeof picked.provider.chatWithTools, 'function');
  });
});

test('tool calls fall back to Anthropic only when OpenRouter has no key', () => {
  withEnv({
    AI_MODE: 'hybrid',
    OPENROUTER_ENABLED: 'true',
    OPENROUTER_API_KEY: undefined,
    ANTHROPIC_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'test-key',
  }, () => {
    assert.equal(routing.getToolProvider('chat_sync')?.name, 'anthropic');
  });
});

test('no cloud provider means no tools — chat degrades rather than pretending', () => {
  withEnv({
    AI_MODE: 'hybrid',
    OPENROUTER_ENABLED: 'true',
    OPENROUTER_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  }, () => {
    assert.equal(routing.getToolProvider('chat_sync'), null);
  });
});

test('ollama-only mode disables tools entirely — Ollama has no function calling', () => {
  withEnv({ AI_MODE: 'ollama-only', OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'test-key' }, () => {
    assert.equal(routing.getToolProvider('chat_sync'), null);
  });
});

test('both tool providers expose the same contract, so callers stay provider-agnostic', () => {
  const anthropic = require('./providers/anthropic-provider');
  const openrouter = require('./providers/openrouter-provider');
  assert.equal(typeof anthropic.chatWithTools, 'function');
  assert.equal(typeof openrouter.chatWithTools, 'function');
  // (systemPrompt, messages, tools, runTool, options)
  assert.equal(anthropic.chatWithTools.length, openrouter.chatWithTools.length);
});

// Background tasks used to dead-end at the Pi 4 worker: if it was unreachable the
// task returned provider 'none' and the work was dropped, silently. The Pi 4 has
// been offline for months at a time unnoticed (27 June to 14 Aug), so every
// email triage in that window did nothing.
//
// Note: withEnv() above is synchronous — its finally block restores the env before
// an awaited body ever reads it — so this sets the env itself.
test('a dead Pi 4 worker fails background work over to OpenRouter, not into the bin', async () => {
  const pi4 = require('./pi4-worker-client');
  const openrouter = require('./providers/openrouter-provider');
  const ollama = require('./providers/ollama-provider');

  const saved = {
    run: pi4.runTask, enabled: pi4.isEnabled,
    configured: openrouter.isConfigured, generate: openrouter.generate,
    ollamaGen: ollama.generate,
    env: { ...process.env },
  };

  pi4.isEnabled = () => true;
  pi4.runTask = async () => { throw new Error('fetch failed'); };
  openrouter.isConfigured = () => true;
  // payload carries { prompt }, so the routing layer calls generate(), not chat()
  openrouter.generate = async () => ({ text: 'triaged', usage: { total_tokens: 10 } });
  // Ollama must SUCCEED here. Making it throw would let this test pass even if
  // the OpenRouter-first override were deleted: the order would fall back to
  // _providerOrder (Ollama-first for background tasks), Ollama would throw, and
  // OpenRouter would serve it anyway. A working Ollama is the only way to prove
  // the override is what puts OpenRouter first.
  ollama.generate = async () => 'served by ollama';

  Object.assign(process.env, {
    AI_MODE: 'hybrid',
    OPENROUTER_ENABLED: 'true',
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_ALLOWED_TASKS: 'all',
  });

  try {
    const result = await routing.runTask('email_triage', { prompt: 'x' });
    assert.equal(result.provider, 'openrouter', 'should reach OpenRouter rather than returning none');
    assert.equal(result.text, 'triaged', 'must be OpenRouter output, not the local model');
    assert.equal(result.fallback, true, 'the worker was the intended provider, so this is a fallback');
  } finally {
    pi4.runTask = saved.run;
    pi4.isEnabled = saved.enabled;
    openrouter.isConfigured = saved.configured;
    openrouter.generate = saved.generate;
    ollama.generate = saved.ollamaGen;
    for (const k of ['AI_MODE','OPENROUTER_ENABLED','OPENROUTER_API_KEY','OPENROUTER_ALLOWED_TASKS']) {
      if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k];
    }
  }
});

// The other half of the split. Worth pinning separately: a single test proving
// "fallback reaches the cloud" would happily stay green if someone made every
// background task cloud-first, which is the thing this policy deliberately does
// not do.
test('background work that is not prose falls back to LOCAL, not the cloud', async () => {
  const pi4 = require('./pi4-worker-client');
  const openrouter = require('./providers/openrouter-provider');
  const ollama = require('./providers/ollama-provider');

  const saved = {
    run: pi4.runTask, enabled: pi4.isEnabled,
    configured: openrouter.isConfigured, generate: openrouter.generate,
    ollamaGen: ollama.generate,
    env: { ...process.env },
  };

  pi4.isEnabled = () => true;
  pi4.runTask = async () => { throw new Error('fetch failed'); };
  // OpenRouter is fully available — the point is that it is NOT chosen.
  openrouter.isConfigured = () => true;
  openrouter.generate = async () => ({ text: 'served by openrouter', usage: { total_tokens: 10 } });
  ollama.generate = async () => 'classified locally';

  Object.assign(process.env, {
    AI_MODE: 'hybrid',
    OPENROUTER_ENABLED: 'true',
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_ALLOWED_TASKS: 'all',
  });

  try {
    const result = await routing.runTask('import_classification', { prompt: 'x' });
    assert.equal(result.provider, 'ollama', 'a routing decision does not need cloud quality');
    assert.equal(result.text, 'classified locally');
  } finally {
    pi4.runTask = saved.run;
    pi4.isEnabled = saved.enabled;
    openrouter.isConfigured = saved.configured;
    openrouter.generate = saved.generate;
    ollama.generate = saved.ollamaGen;
    for (const k of ['AI_MODE', 'OPENROUTER_ENABLED', 'OPENROUTER_API_KEY', 'OPENROUTER_ALLOWED_TASKS']) {
      if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k];
    }
  }
});

// Pi 5's Ollama is the interactive box. Measured on 15 Aug: triage landing there
// ran p50 48s / p95 119s and still failed 32 of 76 calls, while blocking chat
// behind the single-request semaphore. Skipping is strictly better, and safe now
// that the skip is recorded and alerted rather than silent.
test('heavy background work skips rather than grinding the interactive Ollama', async () => {
  const pi4 = require('./pi4-worker-client');
  const openrouter = require('./providers/openrouter-provider');
  const ollama = require('./providers/ollama-provider');

  const saved = {
    run: pi4.runTask, enabled: pi4.isEnabled, skip: pi4.shouldSkip,
    configured: openrouter.isConfigured, generate: openrouter.generate,
    ollamaGen: ollama.generate,
    env: { ...process.env },
  };

  pi4.isEnabled = () => true;
  pi4.shouldSkip = () => false;
  pi4.runTask = async () => { throw new Error('fetch failed'); };
  // Cloud unavailable, local WORKING — the local model must still not be used.
  openrouter.isConfigured = () => false;
  let ollamaCalled = false;
  ollama.generate = async () => { ollamaCalled = true; return 'local answer'; };

  Object.assign(process.env, { AI_MODE: 'hybrid', OPENROUTER_ENABLED: 'false' });

  try {
    const result = await routing.runTask('email_triage', { prompt: 'x' });
    assert.equal(ollamaCalled, false, 'must not fall through to the interactive box');
    assert.equal(result.provider, 'none', 'skipping is the intended outcome');
  } finally {
    pi4.runTask = saved.run;
    pi4.isEnabled = saved.enabled;
    pi4.shouldSkip = saved.skip;
    openrouter.isConfigured = saved.configured;
    openrouter.generate = saved.generate;
    ollama.generate = saved.ollamaGen;
    for (const k of ['AI_MODE', 'OPENROUTER_ENABLED']) {
      if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k];
    }
  }
});

// ── What `fallback` means ─────────────────────────────────────────────────────
// The flag drives the AI card's headline number, so it has to mean "the provider
// that SHOULD have served this didn't". Measured on the Pi 17 Aug: 14 calls, 10
// flagged fallback, 0 failures — a standing 71% on the card with nothing wrong.
// Nine of the ten were background tasks whose intended provider was a worker
// retired on 15 Aug, and the tenth real one was flagged clean. Both directions
// are pinned below, because fixing either alone still leaves the number lying.

test('a worker switched off on purpose is not a fallback', async () => {
  const pi4 = require('./pi4-worker-client');
  const openrouter = require('./providers/openrouter-provider');

  const saved = {
    enabled: pi4.isEnabled,
    configured: openrouter.isConfigured, generate: openrouter.generate,
    env: { ...process.env },
  };

  // The live state since 15 Aug: PI4_WORKER_ENABLED=false, worker retired.
  pi4.isEnabled = () => false;
  openrouter.isConfigured = () => true;
  openrouter.generate = async () => ({ text: 'triaged', usage: { total_tokens: 10 } });

  Object.assign(process.env, {
    AI_MODE: 'hybrid',
    OPENROUTER_ENABLED: 'true',
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_ALLOWED_TASKS: 'all',
  });

  try {
    const result = await routing.runTask('email_triage', { prompt: 'x' });
    assert.equal(result.provider, 'openrouter', 'still routes past the dead worker');
    assert.equal(result.fallback, false,
      'a disabled tier is a setting, not a missed attempt — counting it puts a permanent fault on the AI card');
  } finally {
    pi4.isEnabled = saved.enabled;
    openrouter.isConfigured = saved.configured;
    openrouter.generate = saved.generate;
    for (const k of ['AI_MODE','OPENROUTER_ENABLED','OPENROUTER_API_KEY','OPENROUTER_ALLOWED_TASKS']) {
      if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k];
    }
  }
});

test('a local attempt that THREW still counts as an attempt', async () => {
  const openrouter = require('./providers/openrouter-provider');
  const ollama = require('./providers/ollama-provider');

  const saved = {
    configured: openrouter.isConfigured, generate: openrouter.generate,
    ollamaGen: ollama.generate,
    env: { ...process.env },
  };

  // The 07:16 Focus call: Ollama burned its timeout and aborted, OpenRouter
  // served the same answer in 1.9s. Counting Ollama only on success reported
  // that as a clean first-choice hit.
  ollama.generate = async () => { throw new Error('This operation was aborted'); };
  openrouter.isConfigured = () => true;
  openrouter.generate = async () => ({ text: 'enhanced', usage: { total_tokens: 10 } });

  Object.assign(process.env, {
    AI_MODE: 'hybrid',
    OPENROUTER_ENABLED: 'true',
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_ALLOWED_TASKS: 'all',
  });

  try {
    const result = await routing.runTask('focus_enhancement', { prompt: 'x' });
    assert.equal(result.provider, 'openrouter', 'the rescue still has to happen');
    assert.equal(result.fallback, true,
      'Ollama was tried and failed — the one case the flag exists for');
  } finally {
    openrouter.isConfigured = saved.configured;
    openrouter.generate = saved.generate;
    ollama.generate = saved.ollamaGen;
    for (const k of ['AI_MODE','OPENROUTER_ENABLED','OPENROUTER_API_KEY','OPENROUTER_ALLOWED_TASKS']) {
      if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k];
    }
  }
});
