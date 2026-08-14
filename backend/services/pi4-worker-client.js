'use strict';

/**
 * Pi 4 Worker Client — sends background AI tasks to the Pi 4 worker.
 *
 * Simple HTTP client. Fails safely if worker is unavailable.
 * Used by ai-routing.js for background task types.
 */

const PI4_ENABLED = process.env.PI4_WORKER_ENABLED === 'true';
const PI4_URL = process.env.PI4_WORKER_URL || 'http://100.69.158.50:3002';
const PI4_SECRET = process.env.PI4_WORKER_SECRET || '';
const PI4_TIMEOUT = parseInt(process.env.PI4_WORKER_TIMEOUT_MS) || 60000;

// Health cache — don't check health on every call
let _healthCache = { ok: null, at: 0 };
const HEALTH_CACHE_TTL = 60000; // 1 minute

function isEnabled() {
  return PI4_ENABLED;
}

/**
 * Check if the worker is reachable.
 */
async function isHealthy() {
  if (!PI4_ENABLED) return false;

  const now = Date.now();
  if (_healthCache.ok !== null && (now - _healthCache.at) < HEALTH_CACHE_TTL) {
    return _healthCache.ok;
  }

  try {
    const r = await fetch(`${PI4_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const ok = r.ok;
    _healthCache = { ok, at: now };
    return ok;
  } catch {
    _healthCache = { ok: false, at: now };
    return false;
  }
}

/**
 * Run a task on the Pi 4 worker.
 *
 * @param {string} task - Task type (email_triage, import_classification, etc.)
 * @param {object} payload - { prompt, messages, systemPrompt, model, maxTokens, temperature }
 * @returns {{ ok: boolean, result: string, provider: string, model: string, duration: number }}
 */
async function runTask(task, payload) {
  if (!PI4_ENABLED) {
    return { ok: false, error: 'Worker disabled' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PI4_TIMEOUT);

  try {
    const r = await fetch(`${PI4_URL}/run-task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PI4_SECRET ? { 'X-Worker-Secret': PI4_SECRET } : {}),
      },
      body: JSON.stringify({ task, payload }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Worker HTTP ${r.status}: ${body.substring(0, 100)}`);
    }

    const data = await r.json();
    // A completed task is stronger evidence of health than any probe, so record
    // it. Without this, lastHealthy stayed null forever — isHealthy() is only
    // called by /api/ai/settings, so a worker doing real work all day still
    // reported "status unknown" on the health panel.
    _healthCache = { ok: true, at: Date.now() };
    return {
      ok: data.ok,
      result: data.result || '',
      provider: `pi4-${data.provider || 'ollama'}`,
      model: data.model || '?',
      duration: data.duration || 0,
    };
  } catch (e) {
    // A timeout means the worker was too SLOW for this task, not that it is
    // unreachable: /health answers in 0.12s while a 32-email triage through
    // qwen2.5:1.5b on a Pi 4 runs past 60s. Conflating the two put "Pi 4 worker
    // unreachable" on the panel while the worker was demonstrably up and
    // answering. Health here means reachability — let the timeout govern
    // routing, and leave reachability to say what is actually true.
    const timedOut = /abort|timeout/i.test(e.message || '');
    if (!timedOut) _healthCache = { ok: false, at: Date.now() };
    return { ok: false, error: e.message, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function getStatus() {
  return {
    enabled: PI4_ENABLED,
    url: PI4_URL,
    timeout: PI4_TIMEOUT,
    lastHealthy: _healthCache.ok,
    healthCheckedAt: _healthCache.at ? new Date(_healthCache.at).toISOString() : null,
  };
}

module.exports = { isEnabled, isHealthy, runTask, getStatus };
