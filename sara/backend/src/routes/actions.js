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

// The LEGACY suppression path, kept for one job only: a card the kiosk cannot
// resolve to a canonical attention record. `saraState` tries the record first
// and says out loud when it has fallen back here, because the engine's
// suppression is a TIMER and cannot express "seen it" or "this is finished".
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

// ⚠ `POST /focus/done` USED TO LIVE HERE and proxied `/api/focus/action-done`.
//
// That route calls `nextActionEngine.logOutcome()` AND `engine.dismiss()`, so
// the kiosk's "Done" button recorded work as a completed outcome and hid the
// card — and it never closed the underlying task, so the work stayed open with
// its only reminder suppressed. It is the same bug the desktop carried, one
// surface along, and it is gone rather than fixed in place: completion belongs
// to the attention lifecycle, which knows what a card is about and can say
// whether a task was actually closed.
//
// The replacement is `POST /api/attention/records/:id/act` with
// `action: 'complete'` — see `src/routes/attention.js`.

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
