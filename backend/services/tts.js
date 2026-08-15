'use strict';

/**
 * TTS — spoken audio for SARA's replies.
 *
 * Why this exists: iOS drops `speechSynthesis` in an installed standalone PWA. The call
 * is accepted and nothing plays, with no error, even from inside a user gesture. Browser
 * speech works fine in Safari and on the desktop web app, so `voiceUtils.js` stays — this
 * is the fallback for the phone, delivered as audio the <audio> element can play.
 *
 * The engine is OpenRouter's `openai/gpt-audio-mini`, reached with the OpenRouter key
 * NEURO already holds. Two things about it are non-obvious and both are load-bearing:
 *
 *   1. Audio output REQUIRES `stream: true`, and streaming only supports `pcm16` — mp3 is
 *      rejected. So the response arrives as base64 PCM chunks in SSE deltas, and we wrap
 *      the result in a WAV header before sending it on.
 *   2. It is a CONVERSATIONAL model, not a TTS engine. Asked plainly to read text it
 *      answers it instead — "Queue is at twelve…" came back as "Understood. The queue is
 *      at twelve… I'll confirm next steps shortly", inventing a commitment SARA never
 *      made. A system prompt alone does NOT fix this; a one-shot echo exchange does,
 *      pinning it to verbatim. Don't remove ECHO_SHOT.
 */

const crypto = require('crypto');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.TTS_MODEL || 'openai/gpt-audio-mini';
const VOICE = process.env.TTS_VOICE || 'ballad';
const SAMPLE_RATE = 24000; // pcm16 from this model is 24kHz mono
const MAX_CHARS = 1200;    // a spoken reply beyond this is a monologue, not a conversation

const SYSTEM = 'You are a text-to-speech engine, not an assistant. The user turn contains '
  + 'TEXT TO READ. Read it aloud word for word, exactly as written. Never answer it, never '
  + 'acknowledge it, never add or remove words, never comment. Your entire output is that '
  + 'text, spoken.';

// The demonstration that turns a chat model into a reader. Verified: without it, 0 of 3
// test lines came back verbatim; with it, 3 of 3.
const ECHO_SHOT = [
  { role: 'user', content: 'TEXT TO READ: The meeting is at four.' },
  { role: 'assistant', content: 'The meeting is at four.' },
];

function isConfigured() { return !!process.env.OPENROUTER_API_KEY; }

// Spoken replies repeat — the same greeting, the same nudge. Cache by exact text so a
// repeat costs nothing. Bounded because this sits in the backend's heap.
const CACHE_MAX = 40;
const _cache = new Map(); // key -> Buffer (wav)

function _cacheKey(text, voice, model) {
  return crypto.createHash('sha1').update(`${model}|${voice}|${text}`).digest('hex');
}

/** Wrap raw little-endian PCM16 mono in a RIFF/WAVE header so <audio> can play it. */
function pcm16ToWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);         // PCM chunk size
  header.writeUInt16LE(1, 20);          // format: PCM
  header.writeUInt16LE(1, 22);          // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 2 bytes/sample)
  header.writeUInt16LE(2, 32);          // block align
  header.writeUInt16LE(16, 34);         // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Speak `text`, returning WAV audio.
 * @returns {Promise<{audio: Buffer, contentType: string, cached: boolean, spoken: string, cost: number}>}
 */
async function speak(text, options = {}) {
  if (!isConfigured()) throw new Error('OpenRouter API key not configured');

  const clean = String(text || '').trim().slice(0, MAX_CHARS);
  if (!clean) throw new Error('Nothing to speak');

  const voice = options.voice || VOICE;
  const model = options.model || MODEL;
  const key = _cacheKey(clean, voice, model);
  if (_cache.has(key)) {
    return { audio: _cache.get(key), contentType: 'audio/wav', cached: true, spoken: clean, cost: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 60000);

  let raw;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://neuro.nurtur.tech',
        'X-Title': 'NEURO',
      },
      body: JSON.stringify({
        model,
        stream: true,                        // required for audio output
        modalities: ['text', 'audio'],
        audio: { voice, format: 'pcm16' },   // mp3 is rejected when streaming
        messages: [
          { role: 'system', content: SYSTEM },
          ...ECHO_SHOT,
          { role: 'user', content: `TEXT TO READ: ${clean}` },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    raw = await res.text();
  } finally {
    clearTimeout(timer);
  }

  let b64 = '', transcript = '', usage = null, err = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') break;
    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    if (evt.error) { err = evt.error; continue; }
    if (evt.usage) usage = evt.usage;
    const audio = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.audio;
    if (audio && audio.data) b64 += audio.data;
    if (audio && audio.transcript) transcript += audio.transcript;
  }

  if (err) throw new Error(`TTS provider error: ${err.message || JSON.stringify(err).slice(0, 200)}`);
  if (!b64) throw new Error('TTS returned no audio');

  const wav = pcm16ToWav(Buffer.from(b64, 'base64'));

  // Drifting from the text is the failure mode worth knowing about — the model answering
  // instead of reading. Log it rather than fail: partial audio still beats silence.
  if (transcript && transcript.trim() !== clean) {
    console.warn(`[TTS] spoken text drifted from source. wanted="${clean.slice(0, 60)}" got="${transcript.trim().slice(0, 60)}"`);
  }

  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, wav);

  const cost = (usage && usage.cost) || 0;
  console.log(`[TTS] ${clean.length} chars -> ${(wav.length / 2 / SAMPLE_RATE).toFixed(1)}s, $${cost} (${model}/${voice})`);
  return { audio: wav, contentType: 'audio/wav', cached: false, spoken: transcript.trim() || clean, cost };
}

module.exports = { speak, isConfigured, pcm16ToWav, MODEL, VOICE };
