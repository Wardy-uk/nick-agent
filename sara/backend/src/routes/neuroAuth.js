const express = require('express');
const router = express.Router();

const neuroSnapshot = require('../integrations/neuroSnapshot');
const neuroChat = require('../integrations/neuroChat');
const neuroConfig = require('../integrations/neuroConfig');

async function checkPin(baseUrl, pin) {
  const res = await fetch(neuroChat.buildUrl(baseUrl, '/api/auth/check'), {
    headers: pin ? { 'x-neuro-pin': pin } : {},
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ⚠ This answers the SAME question as the capture bridge and the snapshot poller —
// "can SARA talk to NEURO?" — so it must answer it from the SAME place. It used to
// key `configured` on the PIN alone (`Boolean(neuroConfig.getPin())`), which meant a
// SARA authenticated with NEURO_API_TOKEN reported itself UNCONFIGURED and asked for
// a PIN it did not need, while capture and the snapshot were working perfectly. Three
// surfaces disagreeing about one fact is the drift this whole pass exists to remove,
// so readiness() is the single source and nothing here re-derives it.
router.get('/', (_req, res) => {
  const readiness = neuroConfig.readiness();
  res.json({
    available: readiness.ready,
    // A credential is a credential: the machine token counts, and is preferred.
    configured: readiness.credentialConfigured,
    credentialKind: readiness.credentialKind,
    source:
      readiness.credentialKind === 'api-token' ? 'api-token' : readiness.pinSource,
    baseUrlConfigured: readiness.baseUrlConfigured,
    // Non-sensitive throughout — whether, never what.
    problems: readiness.problems,
    detail: readiness.problems.join(' ') || null,
  });
});

router.post('/', async (req, res) => {
  const pin = String(req.body?.pin || '').trim();
  if (!pin) return res.status(400).json({ ok: false, error: 'pin is required' });

  const availability = neuroChat.getAvailability({ ...process.env, NEURO_PIN: pin });
  if (!availability.config.baseUrl) {
    return res.status(400).json({ ok: false, error: 'NEURO_BASE_URL is not configured' });
  }

  try {
    const check = await checkPin(availability.config.baseUrl, pin);
    if (check.required && !check.authenticated) {
      return res.status(401).json({ ok: false, error: 'PIN rejected by NEURO' });
    }

    neuroConfig.setPin(pin);
    await neuroSnapshot.refresh().catch(() => {});
    return res.json({ ok: true, source: 'session' });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

router.delete('/', async (_req, res) => {
  neuroConfig.clearPin();
  await neuroSnapshot.refresh().catch(() => {});
  res.json({ ok: true, source: 'none' });
});

module.exports = router;
