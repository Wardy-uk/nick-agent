const express = require('express');
const router = express.Router();

const neuroChat = require('../integrations/neuroChat');

async function getJson(path) {
  const availability = neuroChat.getAvailability();
  if (!availability.available) {
    return { ok: false, status: 503, error: availability.detail || 'NEURO bridge not configured' };
  }

  const res = await fetch(neuroChat.buildUrl(availability.config.baseUrl, path), {
    headers: {
      Accept: 'application/json',
      'x-neuro-pin': availability.config.pin,
    },
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

router.get('/', async (_req, res) => {
  try {
    const result = await getJson('/api/focus');
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json(result.payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

module.exports = router;
