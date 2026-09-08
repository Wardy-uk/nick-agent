'use strict';

/**
 * Where a suggested task came from, in words a human can act on.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * A `capture_todo` candidate carries a `sourcePath`, and for the two producers
 * that fill the queue it means two entirely different things: a vault path for
 * `action-candidates`, and `email:<Graph message id>` for `email-actions`. The
 * review card rendered that field RAW, so an email-sourced suggestion showed
 * 150 characters of base64 message id under the words "Spotted, waiting on
 * you" — which identifies the email to Graph and to nobody else. Nick cannot
 * find that email, so he cannot check the claim, so the only safe thing to do
 * with the card is dismiss it. A review queue whose provenance is unreadable is
 * a review queue that stops being read.
 *
 * ⚠ The payload has always carried what was needed — `payload.email` holds the
 * sender, the subject and the received date, and has since the extractor
 * shipped. Nothing was missing; the screen was rendering the wrong field.
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 *
 * 1. **PURE.** No DB, no vault, no clock. It reads the stored payload and
 *    nothing else, so it pins without a database and cannot become slow on a
 *    path that renders a list.
 *
 * 2. **ONE describer, two surfaces.** TodoPanel's review queue and
 *    `action-presenter`'s approval card describe the same row; two copies is
 *    how they come to name different senders for one suggestion.
 *
 * 3. **An opaque id is NEVER shown as provenance.** Where the sender was not
 *    recorded, this says so — "an email, sender not recorded" is a fact Nick
 *    can act on (check it in the Actions queue, or dismiss it knowingly); a
 *    base64 blob is not. The raw value still travels as `ref` for the one
 *    consumer that legitimately needs it (matching a row back to its source),
 *    but it is never the label.
 */

// ⚠ ONE vocabulary. `describeNote` and `describeEmail` moved to
// `shared/task-provenance.cjs` when task cards started describing their own
// origin: a suggestion and the task it becomes are the same fact at two moments,
// and two copies of these words is exactly how the review queue and the task
// card come to name different senders for one commitment. This module keeps its
// own API — what a *candidate payload* looks like is its business — and borrows
// the phrasing rather than restating it.
const { describeNote, describeEmail } = require('../../shared/task-provenance.cjs');

/** Trim to something, or null. Never the empty string, which renders as a gap. */
function str(v) {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s || null;
}

/**
 * Describe the provenance of a `capture_todo` payload.
 *
 * Returns null when there is nothing recorded — deliberately, so a caller
 * renders NOTHING rather than a row asserting a source it does not have.
 */
function describeCandidateSource(payload = {}) {
  const p = payload || {};
  const sourcePath = str(p.sourcePath);

  // The producer says what it is; the path shape is only a fallback for rows
  // written before `extractedFrom` existed.
  const isEmail = p.extractedFrom === 'email' || (sourcePath && sourcePath.startsWith('email:'));
  if (isEmail) return describeEmail(p.email, sourcePath);

  if (sourcePath) return describeNote(sourcePath, p.sourceLine || null);
  return null;
}

module.exports = { describeCandidateSource };
