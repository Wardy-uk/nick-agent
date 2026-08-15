'use strict';

/**
 * TTS routes — spoken audio for clients that can't use browser speech synthesis.
 * Sits behind the usual /api PIN middleware.
 */

const express = require('express');
const router = express.Router();
const tts = require('../services/tts');

// GET /api/tts/status — can the client rely on this before switching to it?
router.get('/status', (req, res) => {
  res.json({ available: tts.isConfigured(), model: tts.MODEL, voice: tts.VOICE });
});

// POST /api/tts/speak { text, voice? } -> audio/wav
router.post('/speak', async (req, res) => {
  const { text, voice, model } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
  if (!tts.isConfigured()) return res.status(503).json({ error: 'TTS not configured' });

  try {
    const { audio, contentType, cached } = await tts.speak(text, { voice, model });
    res.set('Content-Type', contentType);
    res.set('Content-Length', String(audio.length));
    res.set('Cache-Control', 'no-store');
    res.set('X-TTS-Cached', cached ? '1' : '0');
    res.send(audio);
  } catch (err) {
    console.error('[TTS] speak failed:', err.message);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
