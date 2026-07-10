const express = require('express');
const router = express.Router();

const neuroChat = require('../integrations/neuroChat');

async function postJson(path, body) {
  const availability = neuroChat.getAvailability();
  if (!availability.available) {
    return { ok: false, status: 503, error: availability.detail || 'NEURO bridge not configured' };
  }

  const res = await fetch(neuroChat.buildUrl(availability.config.baseUrl, path), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-neuro-pin': availability.config.pin,
    },
    body: JSON.stringify(body || {}),
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
    const result = await getJson('/api/actions');
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json(result.payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

router.post('/focus/dismiss', async (req, res) => {
  const itemId = String(req.body?.itemId || '').trim();
  if (!itemId) return res.status(400).json({ ok: false, error: 'itemId is required' });

  try {
    const result = await postJson('/api/focus/dismiss', {
      itemId,
      itemType: req.body?.itemType || null,
    });
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

router.post('/focus/done', async (req, res) => {
  const detail = String(req.body?.detail || '').trim();
  if (!detail) return res.status(400).json({ ok: false, error: 'detail is required' });

  try {
    const result = await postJson('/api/focus/action-done', {
      actionType: req.body?.actionType || 'manual',
      detail,
      itemId: req.body?.itemId || null,
      itemType: req.body?.itemType || null,
    });
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const result = await postJson(`/api/actions/${req.params.id}/approve`);
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json(result.payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const result = await postJson(`/api/actions/${req.params.id}/reject`);
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json(result.payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

module.exports = router;
