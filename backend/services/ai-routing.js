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
    anthropicEnabled: process.env.ANTHROPIC_ENABLED !== 'false',
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

/**
 * Latency-sensitive tasks — Nick is sitting there waiting for the reply.
 * These go to OpenRouter first: the Pi's local models are fine for background
 * work but too slow to hold a conversation with.
 *
 * Everything NOT in this set is treated as light or scheduled work and runs on
 * local Ollama first, only reaching for cloud if the local model fails. That is
 * the policy: Ollama for the cheap and the scheduled, OpenRouter for the fast.
 */
const LATENCY_SENSITIVE_TASKS = new Set([
  'chat_stream',
  'chat_sync',
  'standup_interactive',
  'eod_interactive',
  'standup_questions',
  'eod_questions',
  'email_draft',
  'email_summary',
  'briefing_synthesis',
]);

// Kept as an alias — _isOpenRouterAllowed and older callers still reference it.
const CLOUD_PREFERRED_TASKS = LATENCY_SENSITIVE_TASKS;

/**
 * Provider order for a task.
 *
 * Anthropic and OpenAI are deliberately NOT the default any more. They stay in
 * the list so an explicitly configured key still gets used as a backstop, but
 * they sit behind OpenRouter — the Anthropic key ran out of credit on 14 Aug
 * and, being tier 1 at the time, took chat and the standup down with it.
 */
function _providerOrder(taskType) {
  if (LATENCY_SENSITIVE_TASKS.has(taskType)) {
    return ['openrouter', 'anthropic', 'openai', 'ollama'];
  }
  return ['ollama', 'openrouter', 'anthropic', 'openai'];
}

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

// Where background work goes when the Pi 4 worker cannot take it.
//
// Not a blanket "send it to the cloud": the worker runs qwen2.5:1.5b, the same
// model Pi 5's Ollama would use, so local fallback is quality-EQUAL to the
// worker and free. Cloud is an upgrade over anything these tasks have ever had,
// which is only worth paying for where the output is prose Nick reads.
//   · email_triage, transcript_processing → cloud. 1.5B is genuinely poor at
//     both, and a bad summary wastes his attention rather than a byte of disk.
//   · import_classification → local. A routing decision; a wrong answer costs
//     one misfiled note.
//   · journal_prompts → local. Once a day, and a clumsier prompt is not worth
//     a token.
const CLOUD_ON_WORKER_FALLBACK = new Set([
  'email_triage',
  'transcript_processing',
]);

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
// Health telemetry
// ═══════════════════════════════════════════════════════
// Config tells you what SHOULD happen; this records what DID. The failure that
// matters here is silent: when a cloud provider dies, nobody sees an error —
// the answer just quietly comes from a 1.5B local model instead. Provider mix
// is what exposes that, so keep the last N outcomes in memory (no DB writes;
// this is on the hot path of every AI call).

const HEALTH_MAX = 200;
const _outcomes = [];              // { t, taskType, provider, ok, ms, fallback, errorClass }
const _providerErrors = new Map();  // provider -> { count, message, errorClass, at }
const _providerSuccess = new Map(); // provider -> timestamp of last success

// The worker reports itself as pi4-<engine> on success but errors are recorded
// against 'pi4Worker', so without this the two never line up and a recovered
// worker keeps wearing its old failure badge.
function _normaliseProvider(name) {
  return String(name || '').startsWith('pi4-') ? 'pi4Worker' : name;
}

// Different classes need different fixes — a 401 is a key problem, a 429 is a
// budget problem, ECONNREFUSED is a box problem. One "failed" count hides that.
function _classifyError(message) {
  const m = String(message || '').toLowerCase();
  if (/\b401\b|\b403\b|unauthor|invalid api key|invalid_api_key|forbidden/.test(m)) return 'auth';
  if (/\b429\b|rate.?limit|quota|too many requests|insufficient.?credit/.test(m)) return 'rate_limit';
  if (/timeout|timed out|aborted|abort/.test(m)) return 'timeout';
  if (/econnrefused|enotfound|ehostunreach|fetch failed|network|socket hang up/.test(m)) return 'unreachable';
  if (/\b5\d\d\b|internal server error|overloaded/.test(m)) return 'upstream';
  return 'other';
}

function _recordOutcome(o) {
  _outcomes.push({ t: Date.now(), ...o });
  while (_outcomes.length > HEALTH_MAX) _outcomes.shift();
  if (o.ok && o.provider && o.provider !== 'none') {
    _providerSuccess.set(_normaliseProvider(o.provider), Date.now());
  }
}

function _recordProviderError(provider, message) {
  const errorClass = _classifyError(message);
  const prev = _providerErrors.get(provider);
  _providerErrors.set(provider, {
    count: (prev?.count || 0) + 1,
    message: String(message || '').substring(0, 160),
    errorClass,
    at: new Date().toISOString(),
  });
  return errorClass;
}

function _pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function getHealth() {
  const calls = _outcomes.length;
  const byProvider = {};
  const byTask = {};

  for (const o of _outcomes) {
    const p = (byProvider[o.provider] ||= { calls: 0, ok: 0, failed: 0, ms: [] });
    p.calls++;
    o.ok ? p.ok++ : p.failed++;
    // providerMs is the serving provider's own time. o.ms is end-to-end and
    // includes any failed attempts before it — charging a 60s dead-worker
    // timeout to OpenRouter made a fast provider look broken.
    const attemptMs = o.providerMs != null ? o.providerMs : o.ms;
    if (o.ok && attemptMs != null) p.ms.push(attemptMs);

    const t = (byTask[o.taskType] ||= { calls: 0, providers: {} });
    t.calls++;
    t.providers[o.provider] = (t.providers[o.provider] || 0) + 1;
  }

  for (const p of Object.values(byProvider)) {
    const sorted = p.ms.sort((a, b) => a - b);
    p.p50 = _pct(sorted, 50);
    p.p95 = _pct(sorted, 95);
    p.share = calls ? Math.round((p.calls / calls) * 100) : 0;
    delete p.ms;
  }

  const failures = _outcomes.filter(o => !o.ok).length;
  const fallbacks = _outcomes.filter(o => o.fallback).length;

  return {
    windowSize: HEALTH_MAX,
    calls,
    since: calls ? new Date(_outcomes[0].t).toISOString() : null,
    failures,
    failureRate: calls ? Math.round((failures / calls) * 100) : 0,
    // The headline number: how often the intended provider did NOT serve it.
    fallbacks,
    fallbackRate: calls ? Math.round((fallbacks / calls) * 100) : 0,
    byProvider,
    byTask,
    // An error older than that provider's last success is history, not a fault.
    // Reporting it forever made a recovered Pi 4 worker look permanently broken,
    // which is exactly the false signal that teaches you to ignore the panel.
    errors: Object.fromEntries(
      [..._providerErrors.entries()].filter(([provider, err]) => {
        const lastOk = _providerSuccess.get(provider);
        return !lastOk || Date.parse(err.at) > lastOk;
      })
    ),
    recent: _outcomes.slice(-12).reverse().map(o => ({
      at: new Date(o.t).toISOString(),
      taskType: o.taskType,
      provider: o.provider,
      ok: o.ok,
      ms: o.ms,
      providerMs: o.providerMs ?? null,
      fallback: o.fallback,
      errorClass: o.errorClass || null,
    })),
  };
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
// Thin timing/telemetry wrapper. The routing logic lives in _runTaskInner
// untouched — instrumenting from the outside keeps this out of the way of
// anyone editing the routing rules themselves.
async function runTask(taskType, payload, options = {}) {
  const started = Date.now();
  try {
    const result = await _runTaskInner(taskType, payload, options);
    const provider = result?.provider || 'none';

    // A deliberate switch-off is not a fault. Recording "AI mode is off" or a
    // disabled worker as a failure would put a 100% failure rate on the panel
    // for a setting the user chose — noise that trains you to ignore it.
    if (provider === 'none' && /mode is off|not enabled/i.test(result?.reason || '')) {
      return result;
    }

    _recordOutcome({
      taskType,
      provider,
      // provider 'none' here means every tier declined or failed — not a
      // success, even though nothing threw.
      ok: provider !== 'none' && Boolean(result?.text),
      // ms = what the caller actually waited; providerMs = what the serving
      // provider itself took. They differ whenever something failed first.
      ms: Date.now() - started,
      providerMs: result?.providerMs ?? null,
      fallback: Boolean(result?.fallback),
      errorClass: provider === 'none' ? _classifyError(result?.reason) : null,
    });
    return result;
  } catch (e) {
    _recordOutcome({
      taskType,
      provider: 'none',
      ok: false,
      ms: Date.now() - started,
      fallback: true,
      errorClass: _recordProviderError('routing', e.message),
    });
    throw e;
  }
}

async function _runTaskInner(taskType, payload, options = {}) {
  _resetIfNewDay();
  const { forceLocal = false, forceCloud = false } = options;

  if (_cfg().aiMode === 'off') {
    return { text: '', provider: 'none', fallback: false, reason: 'AI mode is off' };
  }

  // ── Background tasks → Pi 4 worker, then fail over ──
  // These used to dead-end here: if the worker was unreachable the task returned
  // provider 'none' and the work was simply dropped. The Pi 4 has been offline
  // for months at a time without anyone noticing (it was down from 27 June to
  // 14 Aug), and every email triage and transcript in that window silently did
  // nothing. Now a dead worker falls through to the rest of the stack instead.
  let workerFellBack = false;
  if (BACKGROUND_TASKS.has(taskType) && !forceLocal) {
    if (!pi4Worker.isEnabled()) {
      console.log(`[AIRouting] ${taskType}: Pi 4 worker not enabled, using cloud`);
      workerFellBack = true;
    } else if (pi4Worker.shouldSkip()) {
      // Already known to be failing — go straight to the fallback rather than
      // spending another 60s proving it again.
      workerFellBack = true;
    } else {
      try {
        const workerResult = await pi4Worker.runTask(taskType, payload);
        if (workerResult.ok && workerResult.result) {
          console.log(`[AIRouting] ${taskType}: Pi 4 worker (${workerResult.duration}ms)`);
          return { text: workerResult.result, provider: workerResult.provider, fallback: false, providerMs: workerResult.duration };
        }
        console.warn(`[AIRouting] Pi 4 worker failed for ${taskType}: ${workerResult.error}`);
        // Recorded so the panel shows evidence of the worker being down, rather
        // than only the absence of successes.
        _recordProviderError('pi4Worker', workerResult.error || 'worker returned no result');
      } catch (e) {
        console.warn(`[AIRouting] Pi 4 worker unreachable for ${taskType}: ${e.message}`);
        _recordProviderError('pi4Worker', e.message);
      }
      workerFellBack = true;
    }
  }

  const cloudOk = !forceLocal && _isCloudAllowed(taskType);
  // Background work that has lost its worker is re-routed per task (see
  // CLOUD_ON_WORKER_FALLBACK). Either way every tier stays in the list, so if
  // the preferred one is over budget or unreachable the work still gets done
  // rather than dropped — that dead-end is what this whole path exists to fix.
  // Note the cloud-tier fallback deliberately ends WITHOUT ollama.
  //
  // Pi 5's Ollama is the interactive box: it serves chat and Focus, one request
  // at a time behind a semaphore. Letting a triage payload land there blocked
  // chat for up to two minutes AND still failed 32 times out of 76 — it paid
  // the full cost of the attempt and mostly wasted it. Skipping is cheaper and
  // self-healing: untriaged mail is still a candidate on the next pass.
  //
  // This reinstates a dead end, which is only acceptable because the silence
  // that made the original one dangerous is fixed — the skip is recorded as
  // provider "none", shown on the AI panel, and alerted on by the watchdog.
  const order = workerFellBack
    ? (CLOUD_ON_WORKER_FALLBACK.has(taskType)
        ? ['openrouter', 'anthropic', 'openai']
        : ['ollama', 'openrouter', 'anthropic', 'openai'])
    : _providerOrder(taskType);
  // Whichever provider the policy puts first is the intended one; anything after
  // it is a fallback, and the caller is told so via `fallback`.
  // Starting at 1 when the worker died means whatever serves it is correctly
  // reported as a fallback — the intended provider was the worker.
  let attempted = workerFellBack ? 1 : 0;

  for (const provider of order) {
    // Reset per attempt: what we want to know is how long the provider that
    // ANSWERED took, not how long the whole waterfall took.
    const attemptStart = Date.now();
    try {
      if (provider === 'ollama') {
        if (forceCloud) continue;
        const model = TASK_MODELS[taskType] || HEAVY_MODEL;
        const text = await _queueOllamaRequest(_getTaskPriority(taskType), () =>
          _runOllama(taskType, { ...payload, model }, options)
        );
        attempted++;
        if (text && text.trim().length > 0) {
          console.log(`[AIRouting] ${taskType}: ollama (${model})${attempted > 1 ? ' [fallback]' : ''}`);
          return { text, provider: 'ollama', fallback: attempted > 1, model , providerMs: Date.now() - attemptStart };
        }
        continue;
      }

      if (provider === 'openrouter') {
        if (forceLocal || !_isOpenRouterAllowed(taskType)) continue;
        attempted++;
        const result = await _runOpenRouter(taskType, payload, options);
        if (result.text && result.text.trim().length > 0) {
          _recordOpenRouterUsage(result.usage);
          console.log(`[AIRouting] ${taskType}: openrouter${attempted > 1 ? ' [fallback]' : ''}`);
          return { text: result.text, provider: 'openrouter', fallback: attempted > 1 , providerMs: Date.now() - attemptStart };
        }
        continue;
      }

      if (provider === 'anthropic') {
        if (!cloudOk || !_cfg().anthropicEnabled || !anthropicProvider.isConfigured()) continue;
        attempted++;
        const result = await _runAnthropic(taskType, payload, options);
        if (result.text && result.text.trim().length > 0) {
          _recordOpenRouterUsage(result.usage);
          console.log(`[AIRouting] ${taskType}: anthropic${attempted > 1 ? ' [fallback]' : ''}`);
          return { text: result.text, provider: 'anthropic', fallback: attempted > 1 , providerMs: Date.now() - attemptStart };
        }
        continue;
      }

      if (provider === 'openai') {
        if (!cloudOk || !openaiProvider.isConfigured()) continue;
        attempted++;
        const result = await _runOpenAI(taskType, payload, options);
        if (result.text && result.text.trim().length > 0) {
          _recordOpenRouterUsage(result.usage);
          console.log(`[AIRouting] ${taskType}: openai${attempted > 1 ? ' [fallback]' : ''}`);
          return { text: result.text, provider: 'openai', fallback: attempted > 1 , providerMs: Date.now() - attemptStart };
        }
      }
    } catch (err) {
      console.warn(`[AIRouting] ${provider} failed for ${taskType}: ${err.message}`);
      _usage.lastFallbackReason = `${provider}: ${err.message.substring(0, 100)}`;
      _recordProviderError(provider, err.message);
    }
  }

  return { text: '', provider: 'none', fallback: true, reason: 'All providers failed or disabled' };
}

/**
 * Streaming chat — same 4-tier priority as runTask.
 * Anthropic → OpenAI → OpenRouter → Ollama
 */
// Streaming chat is the highest-volume path and the one Nick actually watches,
// so it needs the same telemetry as runTask — instrumented the same way, from
// the outside, leaving the routing body alone.
async function runStreamingChat(systemPrompt, messages, res, options = {}) {
  const started = Date.now();
  const taskType = options.taskType || 'chat_stream';
  try {
    const result = await _runStreamingChatInner(systemPrompt, messages, res, options);
    const provider = result?.provider || 'none';
    _recordOutcome({
      taskType,
      provider,
      ok: provider !== 'none' && Boolean(result?.text),
      ms: Date.now() - started,
      fallback: Boolean(result?.fallback),
      errorClass: provider === 'none' ? 'other' : null,
    });
    return result;
  } catch (e) {
    _recordOutcome({
      taskType,
      provider: 'none',
      ok: false,
      ms: Date.now() - started,
      fallback: true,
      errorClass: _recordProviderError('routing', e.message),
    });
    throw e;
  }
}

async function _runStreamingChatInner(systemPrompt, messages, res, options = {}) {
  _resetIfNewDay();
  const taskType = options.taskType || 'chat_stream';
  const forceCloud = options.forceCloud || false;
  const model = TASK_MODELS[taskType] || HEAVY_MODEL;
  const cloudOk = _isCloudAllowed(taskType);

  // Same policy as runTask: OpenRouter leads for anything Nick is waiting on,
  // Ollama leads for the rest, Anthropic/OpenAI are backstops.
  let attempted = 0;
  for (const provider of _providerOrder(taskType)) {
    if (res.writableEnded) break;
    try {
      if (provider === 'openrouter') {
        if (!_isOpenRouterAllowed(taskType)) continue;
        attempted++;
        const result = await openrouterProvider.streamChat(systemPrompt, messages, res, options);
        if (result.fullText) {
          _recordOpenRouterUsage(result.usage);
          return { text: result.fullText, provider: 'openrouter', fallback: attempted > 1 };
        }
        continue;
      }
      if (provider === 'anthropic') {
        if (!cloudOk || !_cfg().anthropicEnabled || !anthropicProvider.isConfigured()) continue;
        attempted++;
        const result = await anthropicProvider.streamChat(systemPrompt, messages, res, options);
        if (result.fullText) {
          _recordOpenRouterUsage(result.usage);
          return { text: result.fullText, provider: 'anthropic', fallback: attempted > 1 };
        }
        continue;
      }
      if (provider === 'openai') {
        if (!cloudOk || !openaiProvider.isConfigured()) continue;
        attempted++;
        const result = await openaiProvider.streamChat(systemPrompt, messages, res, options);
        if (result.fullText) {
          _recordOpenRouterUsage(result.usage);
          return { text: result.fullText, provider: 'openai', fallback: attempted > 1 };
        }
        continue;
      }
      if (provider === 'ollama') {
        if (forceCloud) continue;
        attempted++;
        const text = await ollamaProvider.streamChat(systemPrompt, messages, res, { ...options, model });
        if (text && text.trim().length > 0) {
          return { text, provider: 'ollama', fallback: attempted > 1 };
        }
      }
    } catch (err) {
      console.warn(`[AIRouting] ${provider} stream failed: ${err.message}`);
      _recordProviderError(provider, err.message);
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

/**
 * The provider to use for a tool-calling turn, or null if none can.
 *
 * Tool use needs a provider with a function-calling API — Ollama has none, so a
 * tools turn either gets a cloud provider or degrades to plain conversation.
 * Follows the same preference order as everything else: OpenRouter first.
 *
 * Returns `{ name, provider }` so callers can log which one answered.
 */
function getToolProvider(taskType = 'chat_sync') {
  if (!_isCloudAllowed(taskType)) return null;

  if (_isOpenRouterAllowed(taskType) && typeof openrouterProvider.chatWithTools === 'function') {
    return { name: 'openrouter', provider: openrouterProvider };
  }
  if (_cfg().anthropicEnabled && anthropicProvider.isConfigured()) {
    return { name: 'anthropic', provider: anthropicProvider };
  }
  return null;
}

function getStatus() {
  _resetIfNewDay();
  return {
    mode: _cfg().aiMode,
    priority: ['anthropic', 'openai', 'openrouter', 'ollama'],
    anthropic: {
      enabled: _cfg().anthropicEnabled,
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
    // What actually happened, as opposed to what is configured above.
    health: getHealth(),
    taskModels: TASK_MODELS,
    cloudPreferredTasks: [...CLOUD_PREFERRED_TASKS],
    backgroundTasks: [...BACKGROUND_TASKS],
  };
}

async function checkOllama() {
  return ollamaProvider.isAvailable();
}

module.exports = {
  runTask,
  runStreamingChat,
  getStatus,
  getHealth,
  checkOllama,
  getAIMode: () => _cfg().aiMode,
  // Exposed so chat tool-use can ask the same question the routing tiers ask,
  // rather than re-deriving it from getStatus() and missing the budget caps —
  // one tool-using turn can be several API calls.
  isCloudAllowed: _isCloudAllowed,
  getToolProvider,
  _providerOrder,
  LATENCY_SENSITIVE_TASKS,
  // Tool-using chat calls the Anthropic provider directly (the loop has to see
  // each response before it can run anything), so it has to report its own usage
  // or the daily budget silently under-counts every turn that used tools.
  recordUsage: _recordOpenRouterUsage,
  // Same reason, for health: a turn that bypasses the routing tiers would
  // otherwise be invisible to the provider mix — and tool-using chat is the
  // path Nick uses most.
  recordOutcome: _recordOutcome,
};
