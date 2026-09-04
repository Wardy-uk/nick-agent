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

const path = require('path');

/** Trim to something, or null. Never the empty string, which renders as a gap. */
function str(v) {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s || null;
}

/**
 * A vault path as a person would name it: the note, and the folder it is in.
 *
 * The full path is kept as `detail` — it is what you need to go and open the
 * thing — but the LABEL is the note name, because `Meetings/2026/08/2026-08-25
 * – Hope 1-2-1.md` on a card is mostly year and month.
 */
function describeNote(sourcePath, sourceLine) {
  const rel = String(sourcePath);
  const name = path.basename(rel, '.md');
  const folder = path.dirname(rel).split(/[\/]/).filter((s) => s && s !== '.')[0] || null;
  return {
    kind: 'note',
    label: name,
    // "from your meeting notes" is already said once at the top of the queue;
    // what the row adds is WHICH note, and roughly what kind of thing it is.
    context: folder ? `${folder} note` : 'Vault note',
    detail: sourceLine ? `${rel}:${sourceLine}` : rel,
    ref: rel,
  };
}

/**
 * An email as a person would name it: who sent it, and what it was called.
 *
 * ⚠ Subject and sender are read from `payload.email`, never sliced out of the
 * `sourcePath` — that field holds the Graph id and holds nothing else.
 */
function describeEmail(email, sourcePath) {
  const from = str(email?.from) || str(email?.fromEmail);
  const subject = str(email?.subject);

  if (!from && !subject) {
    // Recorded honestly rather than falling back to the id. "Sender not
    // recorded" tells Nick the row cannot be checked from here; the id tells
    // him nothing at all and looks like a bug.
    return {
      kind: 'email',
      label: 'An email — sender not recorded',
      context: 'Email',
      detail: null,
      ref: str(sourcePath),
    };
  }

  return {
    kind: 'email',
    label: from ? `Email from ${from}` : 'Email',
    context: 'Email',
    // The subject is the thing he searches Outlook for, so it is the detail.
    detail: subject ? `${String.fromCharCode(8220)}${subject}${String.fromCharCode(8221)}` : null,
    ref: str(sourcePath),
  };
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
