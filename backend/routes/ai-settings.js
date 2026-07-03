'use strict';

/**
 * AI Settings API — view and update AI configuration at runtime.
 *
 * GET  /api/ai/settings  — current AI config + status
 * POST /api/ai/settings  — update runtime AI settings
 *
 * Some settings (API keys) require server restart.
 * Others (mode, limits) can be changed at runtime via agent_state.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const aiRouting = require('../services/ai-routing');

// Settings that can be changed at runtime (stored in agent_state)
const RUNTIME_SETTINGS = {
  ai_mode: { key: 'ai_mode', env: 'AI_MODE', default: 'ollama-only', options: ['off', 'ollama-only', 'hybrid', 'critical-only'] },
  anthropic_enabled: { key: 'anthropic_enabled', env: 'ANTHROPIC_ENABLED', default: 'true', type: 'boolean' },
  openrouter_enabled: { key: 'openrouter_enabled', env: 'OPENROUTER_ENABLED', default: 'false', type: 'boolean' },
  openrouter_api_key: { key: 'openrouter_api_key', env: 'OPENROUTER_API_KEY', default: '', type: 'secret' },
  openrouter_model: { key: 'openrouter_model', env: 'OPENROUTER_MODEL', default: 'google/gemini-2.5-flash' },
  openrouter_daily_call_limit: { key: 'openrouter_daily_call_limit', env: 'OPENROUTER_DAILY_CALL_LIMIT', default: '100', type: 'number' },
  openrouter_daily_token_limit: { key: 'openrouter_daily_token_limit', env: 'OPENROUTER_DAILY_TOKEN_LIMIT', default: '100000', type: 'number' },
  openrouter_max_escalations_per_hour: { key: 'openrouter_max_escalations_per_hour', env: 'OPENROUTER_MAX_ESCALATIONS_PER_HOUR', default: '20', type: 'number' },
  sara_mode: { key: 'sara_mode', env: 'SARA_MODE', default: 'suggest', options: ['suggest', 'off'] },
  pi4_worker_enabled: { key: 'pi4_worker_enabled', env: 'PI4_WORKER_ENABLED', default: 'false', type: 'boolean' },
  pi4_worker_url: { key: 'pi4_worker_url', env: 'PI4_WORKER_URL', default: 'http://100.69.158.50:3002' },
};

function _getSettingValue(setting) {
  const stored = db.getState(`ai_setting_${setting.key}`);
  if (stored !== null && stored !== undefined) return stored;
  return process.env[setting.env] || setting.default;
}

const pi4Worker = require('../services/pi4-worker-client');

// Bootstrap: sync DB-stored settings into process.env so values
// set via admin panel survive PM2 restarts. Runs once on first request
// (DB isn't ready at require time).
let _bootstrapped = false;
function _bootstrapFromDb() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {
    for (const def of Object.values(RUNTIME_SETTINGS)) {
      const stored = db.getState(`ai_setting_${def.key}`);
      if (stored !== null && stored !== undefined && stored !== '') {
        process.env[def.env] = stored;
      }
    }
    console.log('[AI Settings] Bootstrapped from DB');
  } catch (e) {
    _bootstrapped = false;
    console.warn('[AI Settings] Bootstrap deferred:', e.message);
  }
}

// GET /api/ai/settings
router.get('/', async (req, res) => {
  _bootstrapFromDb();
  const settings = {};
  for (const [key, def] of Object.entries(RUNTIME_SETTINGS)) {
    const value = _getSettingValue(def);
    settings[key] = {
      value: def.type === 'secret' ? (value ? '••••••' + value.slice(-4) : '') : value,
      hasValue: !!value,
      options: def.options || null,
      type: def.type || 'string',
      requiresRestart: def.type === 'secret',
    };
  }

  // Add live status (with fresh Pi 4 health check)
  const status = aiRouting.getStatus();
  const pi4Healthy = pi4Worker.isEnabled() ? await pi4Worker.isHealthy() : null;

  res.json({
    settings,
    status: {
      mode: status.mode,
      ollamaModel: status.ollama?.model,
      ollamaLightModel: status.ollama?.lightweightModel,
      ollamaQueueDepth: status.ollama?.queueDepth,
      ollamaInUse: status.ollama?.inUse,
      openrouterModel: status.openrouter?.model,
      openrouterCallsToday: status.openrouter?.callsToday,
      openrouterTokensToday: status.openrouter?.tokensToday,
      openrouterThrottled: status.openrouter?.throttled,
      openrouterLastFallback: status.openrouter?.lastFallbackReason,
      pi4Enabled: pi4Worker.isEnabled(),
      pi4Healthy,
      cloudPreferredTasks: status.cloudPreferredTasks,
      backgroundTasks: status.backgroundTasks,
      taskModels: status.taskModels,
    },
  });
});

// POST /api/ai/settings
router.post('/', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Expected object with setting key/value pairs' });
  }

  const applied = {};
  const errors = {};

  for (const [key, value] of Object.entries(updates)) {
    const def = RUNTIME_SETTINGS[key];
    if (!def) {
      errors[key] = 'Unknown setting';
      continue;
    }

    if (def.options && !def.options.includes(value)) {
      errors[key] = `Must be one of: ${def.options.join(', ')}`;
      continue;
    }

    db.setState(`ai_setting_${def.key}`, String(value));

    if (def.type !== 'secret') {
      process.env[def.env] = String(value);
    } else if (value && value !== '••••••') {
      process.env[def.env] = String(value);
    }

    applied[key] = def.type === 'secret' ? '(updated)' : value;
  }

  console.log('[AI Settings] Updated:', Object.keys(applied).join(', '));

  res.json({ ok: true, applied, errors: Object.keys(errors).length > 0 ? errors : undefined });
});

router.bootstrap = _bootstrapFromDb;
module.exports = router;
