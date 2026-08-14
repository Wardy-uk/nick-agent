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
  for (const task of ['focus_enhancement', 'drilldown_framing', 'knowledge_consolidation', 'action_suggestion']) {
    const order = routing._providerOrder(task);
    assert.equal(order[0], 'ollama', `${task} should lead with Ollama`);
  }
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
// been offline since June, so every email triage in that window did nothing.
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
  // Fail Ollama loudly so a silent local success cannot mask OpenRouter never being tried
  ollama.generate = async () => { throw new Error('ollama should not be reached first'); };

  Object.assign(process.env, {
    AI_MODE: 'hybrid',
    OPENROUTER_ENABLED: 'true',
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_ALLOWED_TASKS: 'all',
  });

  try {
    const result = await routing.runTask('email_triage', { prompt: 'x' });
    assert.equal(result.provider, 'openrouter', 'should reach OpenRouter rather than returning none');
    assert.equal(result.text, 'triaged');
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
