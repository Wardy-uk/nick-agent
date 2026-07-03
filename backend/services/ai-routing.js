'use strict';

/**
 * AI Routing Policy — Phase 6: 4-tier cloud + local stack.
 *
 * Priority order for all tasks:
 *   1. Anthropic (Claude API direct)   — ANTHROPIC_API_KEY
 *   2. OpenAI (ChatGPT)                — OPENAI_API_KEY
 *   3. OpenRouter (multi-model cloud)  — OPENROUTER_API_KEY
 *   4. Ollama (local Pi 5)             — always available
 *
 * Background tasks (Pi 4 worker): email_triage, import_classification,
 *   journal_prompts, transcript_processing — bypass the stack entirely.
 */

const anthropicProvider = require('./providers/anthropic-provider');
const openaiProvider = require('./providers/openai-provider');
const ollamaProvider = require('./providers/ollama-provider');
const openrouterProvider = require('./providers/openrouter-provider');
const pi4Worker = require('./pi4-worker-client');

// ── Config (read live so admin panel changes take effect without restart) ──
function _cfg() {
  return {
    aiMode: process.env.AI_MODE || 'ollama-only',
    enabled: process.env.OPENROUTER_ENABLED === 'true',
    dailyCallLimit: parseInt(process.env.OPENROUTER_DAILY_CALL_LIMIT) || 100,
    dailyTokenLimit: parseInt(process.env.OPENROUTER_DAILY_TOKEN_LIMIT) || 100000,
    maxEscalationsPerHour: parseInt(process.env.OPENROUTER_MAX_ESCALATIONS_PER_HOUR) || 20,
    allowedTasks: (process.env.OPENROUTER_ALLOWED_TASKS || 'all').split(',').map(s => s.trim()).filter(Boolean),
    criticalTypes: (process.env.OPENROUTER_CRITICAL_ONLY_TYPES || 'escalation_reasoning,sla_ambiguity,cross_context_synthesis,transcript_processing').split(',').map(s => s.trim()).filter(Boolean),
  };
}


// ── Model-per-task routing ──
const LIGHTWEIGHT_MODEL = 'qwen2.5:1.5b';
const HEAVY_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

// Tasks that should go to OpenRouter when available (heavy/interactive)
const CLOUD_PREFERRED_TASKS = new Set([
  'chat_stream',
  'chat_sync',
  'standup_interactive',
  'eod_interactive',
]);

// Local model selection for tasks that stay on Pi
const TASK_MODELS = {
  focus_enhancement: LIGHTWEIGHT_MODEL,
  drilldown_framing: LIGHTWEIGHT_MODEL,
  action_suggestion: LIGHTWEIGHT_MODEL,
  knowledge_consolidation: 'qwen2.5:1.5b',
  chat_stream: 'qwen2.5:1.5b',
  chat_sync: 'qwen2.5:1.5b',
  standup_interactive: 'gemma3:4b',
  eod_interactive: 'gemma3:4b',
};

// ── Background tasks → Pi 4 worker ──
const BACKGROUND_TASKS = new Set([
  'email_triage',
  'import_classification',
  'journal_prompts',
  'transcript_processing',
]);

// ── Priority queue (simple semaphore) ──
let _ollamaInUse = false;
const _highQueue = [];
const _lowQueue = [];

async function _queueOllamaRequest(priority, fn) {
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, fn };
    if (priority === 'high') {
      _highQueue.push(entry);
    } else {
      _lowQueue.push(entry);
    }
    _processQueue();
  });
}

async function _processQueue() {
  if (_ollamaInUse) return;

  const entry = _highQueue.shift() || _lowQueue.shift();
  if (!entry) return;

  _ollamaInUse = true;
  try {
    const result = await entry.fn();
    entry.resolve(result);
  } catch (e) {
    entry.reject(e);
  } finally {
    _ollamaInUse = false;
    setImmediate(_processQueue);
  }
}

function _getTaskPriority(taskType) {
  if (taskType === 'focus_enhancement' || taskType === 'chat_stream' ||
      taskType === 'drilldown_framing' || taskType === 'standup_interactive' ||
      taskType === 'eod_interactive') {
    return 'high';
  }
  return 'low';
}


// ── Usage tracking ──
let _usage = { date: _todayStr(), calls: 0, tokens: 0, hourlyEscalations: new Map(), lastFallbackReason: null };

function _todayStr() { return new Date().toISOString().split('T')[0]; }
function _resetIfNewDay() {
  const today = _todayStr();
  if (_usage.date !== today) {
    _usage = { date: today, calls: 0, tokens: 0, hourlyEscalations: new Map(), lastFallbackReason: null };
  }
}
function _currentHourKey() { return new Date().getHours().toString(); }

// Is cloud AI allowed at all (mode + budget guard)?
function _isCloudAllowed(taskType) {
  _resetIfNewDay();
  const c = _cfg();
  if (c.aiMode === 'off' || c.aiMode === 'ollama-only') return false;
  if (c.aiMode === 'critical-only' && !c.criticalTypes.includes(taskType)) return false;
  if (c.aiMode === 'hybrid' && c.allowedTasks[0] !== 'all' && !c.allowedTasks.includes(taskType)) return false;
  if (_usage.calls >= c.dailyCallLimit) { _usage.lastFallbackReason = 'Daily call limit'; return false; }
  if (_usage.tokens >= c.dailyTokenLimit) { _usage.lastFallbackReason = 'Daily token limit'; return false; }
  const hk = _currentHourKey();
  if ((_usage.hourlyEscalations.get(hk) || 0) >= c.maxEscalationsPerHour) { _usage.lastFallbackReason = 'Hourly limit'; return false; }
  return true;
}

// Kept for OpenRouter-specific checks (requires OPENROUTER_ENABLED flag)
function _isOpenRouterAllowed(taskType) {
  if (!_isCloudAllowed(taskType)) return false;
  const c = _cfg();
  return c.enabled && openrouterProvider.isConfigured();
}

function _recordOpenRouterUsage(usage) {
  _resetIfNewDay();
  _usage.calls++;
  _usage.tokens += usage?.total_tokens || 0;
  const hk = _currentHourKey();
  _usage.hourlyEscalations.set(hk, (_usage.hourlyEscalations.get(hk) || 0) + 1);
}


// ═══════════════════════════════════════════════════════
// Main API
// ═══════════════════════════════════════════════════════

/**
 * Run an AI task through the routing policy.
 *
 * Routing order:
 *   1. Background tasks   → Pi 4 worker (bypasses stack)
 *   2. Anthropic          → if ANTHROPIC_API_KEY set + cloud allowed
 *   3. OpenAI (ChatGPT)   → if OPENAI_API_KEY set + cloud allowed
 *   4. OpenRouter         → if OPENROUTER_API_KEY + OPENROUTER_ENABLED + cloud allowed
 *   5. Ollama             → local Pi 5 fallback (always)
 */
async function runTask(taskType, payload, options = {}) {
  _resetIfNewDay();
  const { forceLocal = false, forceCloud = false } = options;

  if (_cfg().aiMode === 'off') {
    return { text: '', provider: 'none', fallback: false, reason: 'AI mode is off' };
  }

  // ── Background tasks → Pi 4 worker ──
  if (BACKGROUND_TASKS.has(taskType) && !forceLocal) {
    if (!pi4Worker.isEnabled()) {
      console.log(`[AIRouting] ${taskType}: skipped (Pi 4 worker not enabled)`);
      return { text: '', provider: 'none', fallback: true, reason: 'Pi 4 worker not enabled' };
    }
    try {
      const workerResult = await pi4Worker.runTask(taskType, payload);
      if (workerResult.ok && workerResult.result) {
        console.log(`[AIRouting] ${taskType}: Pi 4 worker (${workerResult.duration}ms)`);
        return { text: workerResult.result, provider: workerResult.provider, fallback: false };
      }
      console.warn(`[AIRouting] Pi 4 worker failed for ${taskType}: ${workerResult.error}`);
    } catch (e) {
      console.warn(`[AIRouting] Pi 4 worker unreachable for ${taskType}: ${e.message}`);
    }
    return { text: '', provider: 'none', fallback: true, reason: 'Pi 4 worker unavailable' };
  }

  const cloudOk = !forceLocal && _isCloudAllowed(taskType);

  // ── Tier 1: Anthropic ──
  if (cloudOk && anthropicProvider.isConfigured()) {
    try {
      const result = await _runAnthropic(taskType, payload, options);
      if (result.text && result.text.trim().length > 0) {
        _recordOpenRouterUsage(result.usage);
        console.log(`[AIRouting] ${taskType}: anthropic`);
        return { text: result.text, provider: 'anthropic', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] Anthropic failed for ${taskType}: ${err.message}`);
      _usage.lastFallbackReason = `Anthropic: ${err.message.substring(0, 100)}`;
    }
  }

  // ── Tier 2: OpenAI ──
  if (cloudOk && openaiProvider.isConfigured()) {
    try {
      const result = await _runOpenAI(taskType, payload, options);
      if (result.text && result.text.trim().length > 0) {
        _recordOpenRouterUsage(result.usage);
        console.log(`[AIRouting] ${taskType}: openai`);
        return { text: result.text, provider: 'openai', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenAI failed for ${taskType}: ${err.message}`);
      _usage.lastFallbackReason = `OpenAI: ${err.message.substring(0, 100)}`;
    }
  }

  // ── Tier 3: OpenRouter ──
  if (!forceLocal && _isOpenRouterAllowed(taskType)) {
    try {
      const result = await _runOpenRouter(taskType, payload, options);
      if (result.text && result.text.trim().length > 0) {
        _recordOpenRouterUsage(result.usage);
        console.log(`[AIRouting] ${taskType}: openrouter`);
        return { text: result.text, provider: 'openrouter', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenRouter failed for ${taskType}: ${err.message}`);
      _usage.lastFallbackReason = `OpenRouter: ${err.message.substring(0, 100)}`;
    }
  }

  // ── Tier 4: Ollama (local, always last resort) ──
  if (!forceCloud) {
    const model = TASK_MODELS[taskType] || HEAVY_MODEL;
    const priority = _getTaskPriority(taskType);
    try {
      const text = await _queueOllamaRequest(priority, () =>
        _runOllama(taskType, { ...payload, model }, options)
      );
      if (text && text.trim().length > 0) {
        console.log(`[AIRouting] ${taskType}: ollama (${model})`);
        return { text, provider: 'ollama', fallback: true, model };
      }
    } catch (err) {
      console.warn(`[AIRouting] Ollama failed for ${taskType}: ${err.message}`);
    }
  }

  return { text: '', provider: 'none', fallback: true, reason: 'All providers failed or disabled' };
}

/**
 * Streaming chat — same 4-tier priority as runTask.
 * Anthropic → OpenAI → OpenRouter → Ollama
 */
async function runStreamingChat(systemPrompt, messages, res, options = {}) {
  _resetIfNewDay();
  const taskType = options.taskType || 'chat_stream';
  const forceCloud = options.forceCloud || false;
  const model = TASK_MODELS[taskType] || HEAVY_MODEL;
  const cloudOk = _isCloudAllowed(taskType);

  // Tier 1: Anthropic
  if (cloudOk && anthropicProvider.isConfigured()) {
    try {
      const result = await anthropicProvider.streamChat(systemPrompt, messages, res, options);
      if (result.fullText) {
        _recordOpenRouterUsage(result.usage);
        return { text: result.fullText, provider: 'anthropic', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] Anthropic stream failed: ${err.message}`);
    }
  }

  // Tier 2: OpenAI
  if (cloudOk && openaiProvider.isConfigured() && !res.writableEnded) {
    try {
      const result = await openaiProvider.streamChat(systemPrompt, messages, res, options);
      if (result.fullText) {
        _recordOpenRouterUsage(result.usage);
        return { text: result.fullText, provider: 'openai', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenAI stream failed: ${err.message}`);
    }
  }

  // Tier 3: OpenRouter
  if (_isOpenRouterAllowed(taskType) && !res.writableEnded) {
    try {
      const result = await openrouterProvider.streamChat(systemPrompt, messages, res, options);
      if (result.fullText) {
        _recordOpenRouterUsage(result.usage);
        return { text: result.fullText, provider: 'openrouter', fallback: false };
      }
    } catch (err) {
      console.warn(`[AIRouting] OpenRouter stream failed: ${err.message}`);
    }
  }

  // Tier 4: Ollama
  if (!forceCloud) {
    try {
      const text = await ollamaProvider.streamChat(systemPrompt, messages, res, { ...options, model });
      if (text && text.trim().length > 0) {
        return { text, provider: 'ollama', fallback: true };
      }
    } catch (err) {
      console.warn(`[AIRouting] Ollama stream failed: ${err.message}`);
    }
  }

  _writeFallbackNotice('*[AI unavailable — try again later]*\n');
  return { text: '', provider: 'none', fallback: true };
}


// ── Internal runners ──

async function _runAnthropic(taskType, payload, options) {
  if (payload.messages) {
    return anthropicProvider.chat(payload.systemPrompt || '', payload.messages, {
      maxTokens: payload.maxTokens,
      timeout: options.timeout,
    });
  }
  return anthropicProvider.generate(payload.prompt || '', {
    maxTokens: payload.maxTokens,
    timeout: options.timeout,
  });
}

async function _runOpenAI(taskType, payload, options) {
  if (payload.messages) {
    return openaiProvider.chat(payload.systemPrompt || '', payload.messages, {
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      timeout: options.timeout,
    });
  }
  return openaiProvider.generate(payload.prompt || '', {
    temperature: payload.temperature,
    maxTokens: payload.maxTokens,
    timeout: options.timeout,
  });
}

async function _runOllama(taskType, payload, options) {
  if (payload.messages) {
    return ollamaProvider.chat(payload.systemPrompt || '', payload.messages, {
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      contextWindow: payload.contextWindow,
      timeout: options.timeout,
    });
  }
  return ollamaProvider.generate(payload.prompt || '', {
    model: payload.model,
    temperature: payload.temperature,
    maxTokens: payload.maxTokens,
    contextWindow: payload.contextWindow,
    timeout: options.timeout,
  });
}

async function _runOpenRouter(taskType, payload, options) {
  if (payload.messages) {
    return openrouterProvider.chat(payload.systemPrompt || '', payload.messages, {
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      contextWindow: payload.contextWindow,
      timeout: options.timeout,
    });
  }
  return openrouterProvider.generate(payload.prompt || '', {
    temperature: payload.temperature,
    maxTokens: payload.maxTokens,
    contextWindow: payload.contextWindow,
    timeout: options.timeout,
  });
}


// ═══════════════════════════════════════════════════════
// Status
// ═══════════════════════════════════════════════════════

function getStatus() {
  _resetIfNewDay();
  return {
    mode: _cfg().aiMode,
    priority: ['anthropic', 'openai', 'openrouter', 'ollama'],
    anthropic: {
      configured: anthropicProvider.isConfigured(),
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    },
    openai: {
      configured: openaiProvider.isConfigured(),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    },
    openrouter: {
      enabled: _cfg().enabled,
      configured: openrouterProvider.isConfigured(),
      model: process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5',
      callsToday: _usage.calls,
      tokensToday: _usage.tokens,
      dailyCallLimit: _cfg().dailyCallLimit,
      dailyTokenLimit: _cfg().dailyTokenLimit,
      throttled: _usage.calls >= _cfg().dailyCallLimit || _usage.tokens >= _cfg().dailyTokenLimit,
      lastFallbackReason: _usage.lastFallbackReason,
    },
    ollama: {
      url: ollamaProvider.getUrl(),
      model: ollamaProvider.getModel(),
      lightweightModel: LIGHTWEIGHT_MODEL,
      queueDepth: _highQueue.length + _lowQueue.length,
      inUse: _ollamaInUse,
    },
    pi4Worker: pi4Worker.getStatus(),
    taskModels: TASK_MODELS,
    cloudPreferredTasks: [...CLOUD_PREFERRED_TASKS],
    backgroundTasks: [...BACKGROUND_TASKS],
  };
}

async function checkOllama() {
  return ollamaProvider.isAvailable();
}

module.exports = { runTask, runStreamingChat, getStatus, checkOllama, getAIMode: () => _cfg().aiMode };
