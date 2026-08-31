'use strict';

/**
 * Which room in the house Nick is in.
 *
 * The BLE room sensors push to the SARA backend (:3005 on this same Pi), which
 * holds the fingerprint profiles and does the classification. NEURO reads that
 * the way it reads Home Assistant: as a SENSOR FEED, not as a second opinion.
 *
 * ⚠ That distinction is the one `sara/backend/src/state/inference.js` was
 * retired for. SARA keeps its TRANSPORT half; what it must never do is decide
 * things about Nick's day. A room reading is a measurement — the same kind of
 * fact as "the phone says he is home" — and NEURO remains the only place that
 * reasons about what it MEANS. Nothing here ranks, gates or suggests.
 *
 * ⚠ NEVER ASSERTS A ROOM IT WAS NOT TOLD. The classifier already refuses three
 * ways (uncalibrated, no match, too close to call) and every one of those
 * arrives here as `known: false` with the reason intact. An unreachable SARA is
 * the fourth. A confident wrong room is far worse than no room: this is meant
 * to feed automation, and "he is in the bedroom" turns lights on above someone.
 *
 * ⚠ IT TRACKS THE WATCH, NOT NICK. Proven live on 31 Aug 2026: he showered
 * while the watch sat on a bedroom surface and it reported `bedroom` with full
 * confidence for eight minutes. The reading is honest about what it measured —
 * `subject: 'watch'` — so nothing downstream can quietly promote it to a claim
 * about where the man is.
 *
 * CommonJS — NEURO backend convention.
 */

const SARA_URL = (process.env.SARA_BASE_URL || 'http://localhost:3005').replace(/\/$/, '');
// Short: this sits on the /api/attention path, which several surfaces poll.
const TIMEOUT_MS = Number(process.env.ROOM_PRESENCE_TIMEOUT_MS) || 1500;
// The sensors report every ~3s and the classification is instant, so a cached
// answer a few seconds old is as good as a fresh one and costs nothing.
const CACHE_MS = 5000;

let _cache = { at: 0, value: null };

function isConfigured() {
  return !!SARA_URL;
}

/**
 * `{ known, room, confidence, margin, why, subject, at }`.
 *
 * `known` is true ONLY for a confident room. `unsure` is deliberately not
 * good enough: a coin toss between two rooms is not a location, and the
 * caller that wants the detail can read `confidence` and `why`.
 */
async function read(now = new Date()) {
  if (!isConfigured()) {
    return { known: false, room: null, why: 'SARA base URL not configured' };
  }
  if (_cache.value && now.getTime() - _cache.at < CACHE_MS) return _cache.value;

  let out;
  try {
    const res = await fetch(`${SARA_URL}/api/presence/room`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    // ⚠ A 200 carrying the wrong shape is not an answer — the rule the SARA
    // capture bridge learned the hard way. A proxy error page parses as JSON
    // perfectly well and has no `confidence` in it.
    if (!d || typeof d.confidence !== 'string') {
      out = { known: false, room: null, why: 'SARA answered with an unexpected shape' };
    } else if (d.confidence === 'sure' && d.room) {
      out = {
        known: true,
        room: d.room,
        confidence: d.confidence,
        margin: typeof d.margin === 'number' ? d.margin : null,
        why: null,
        subject: 'watch',
        at: d.checkedAt || now.toISOString(),
      };
    } else {
      // unsure / none — carry the classifier's own words rather than inventing
      // a summary of them.
      out = {
        known: false,
        room: null,
        confidence: d.confidence,
        why: d.why || 'not confident which room',
        subject: 'watch',
        at: d.checkedAt || now.toISOString(),
      };
    }
  } catch (e) {
    out = {
      known: false,
      room: null,
      why: e.name === 'TimeoutError'
        ? 'SARA did not answer in time'
        : `could not reach SARA: ${e.message}`,
    };
  }

  _cache = { at: now.getTime(), value: out };
  return out;
}

/** The cached read with no network call, for sync callers. Null if never read. */
function cached() {
  return _cache.value;
}

function _reset() {
  _cache = { at: 0, value: null };
}

module.exports = { read, cached, isConfigured, _reset, SARA_URL };
