const express = require('express');
const router = express.Router();

const neuroChat = require('../integrations/neuroChat');

async function requestJson(path, options = {}) {
  const availability = neuroChat.getAvailability();
  if (!availability.available) {
    return { ok: false, status: 503, error: availability.detail || 'NEURO bridge not configured' };
  }

  const res = await fetch(neuroChat.buildUrl(availability.config.baseUrl, path), {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      'content-type': 'application/json',
      'x-neuro-pin': availability.config.pin,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(5000),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: payload.error || payload.detail || `HTTP ${res.status}`,
    };
  }

  return { ok: true, status: res.status, payload };
}

router.get('/escalations', async (_req, res) => {
  try {
    const result = await requestJson('/api/jira/escalations');
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json(result.payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

router.get('/escalations/unseen', async (_req, res) => {
  try {
    const result = await requestJson('/api/jira/escalations/unseen');
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json(result.payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

router.post('/escalations/seen', async (_req, res) => {
  try {
    const result = await requestJson('/api/jira/escalations/seen', { method: 'POST', body: {} });
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json(result.payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

module.exports = router;
