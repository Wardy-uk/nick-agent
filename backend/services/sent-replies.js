'use strict';

/**
 * Replies Nick has sent from triage (#69).
 *
 * A sent reply used to leave NO trace inside NEURO. The send path called
 * `dismissEmail(emailId, 'replied')` and that was the entire record — the only
 * evidence it had happened lived in Outlook's Sent Items. So "I answered that
 * on Tuesday" was not answerable from NEURO at all, and outbound mail was the
 * newest write path in the system and the least observable.
 *
 * This is deliberately the ONE-ROW version, chosen over feeding the body to the
 * meeting-note extraction. It records what happened and nothing more: no AI
 * call, no commitment parsing, nothing to tune. That richer version now has
 * something to be built ON, which it did not before — the same order #88/#89
 * followed, where real durations were recorded and deliberately not consumed
 * until there was a body of them to calibrate against.
 *
 * The one judgement here is `recipientsSource`. On a plain reply / replyAll,
 * **Graph** decides who the message goes to, not NEURO — the route only knows
 * the addressees for certain when the composer passed an explicit `to`. So the
 * list is stored with its provenance rather than as fact: `explicit` is what
 * was actually addressed, `inferred` is NEURO's reading of the thread, and
 * `unknown` is neither. Following #65, a record that cannot tell those apart is
 * worse than one that admits the gap — an inferred recipient list presented as
 * fact is exactly how "who did I copy?" gets answered wrongly.
 */

const db = require('../db/database');

const SOURCES = new Set(['explicit', 'inferred', 'unknown']);

function _serialiseRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) return null;
  const clean = recipients
    .map(r => (typeof r === 'string'
      ? { name: null, email: r }
      : { name: r?.name || null, email: r?.email || null }))
    .filter(r => r.email);
  return clean.length ? JSON.stringify(clean) : null;
}

function _parseRecipients(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Record a sent reply. Never throws — a bookkeeping failure must not turn a
 * mail that HAS ALREADY LEFT into an error the user reads as "not sent".
 */
function record({
  emailId, subject, fromName, fromEmail,
  recipients, recipientsSource, replyAll, body, sentAt,
} = {}) {
  try {
    if (!emailId || !String(body || '').trim()) return null;
    const source = SOURCES.has(recipientsSource) ? recipientsSource : 'unknown';
    db.run(
      `INSERT INTO sent_replies
         (email_id, subject, from_name, from_email, recipients, recipients_source, reply_all, body, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(emailId),
        subject || null,
        fromName || null,
        fromEmail || null,
        _serialiseRecipients(recipients),
        source,
        replyAll ? 1 : 0,
        String(body),
        sentAt || new Date().toISOString(),
      ]
    );
    return true;
  } catch (e) {
    console.error('[SentReplies] Failed to record reply:', e.message);
    return null;
  }
}

function _shape(row) {
  return {
    id: row.id,
    emailId: row.email_id,
    subject: row.subject,
    from: row.from_name || row.from_email || null,
    fromEmail: row.from_email,
    recipients: _parseRecipients(row.recipients),
    // Surfaced, not hidden: the UI has to be able to say "these are the people
    // NEURO believes were on the thread", not present a guess as the record.
    recipientsSource: row.recipients_source || 'unknown',
    replyAll: Boolean(row.reply_all),
    body: row.body,
    sentAt: row.sent_at,
  };
}

/**
 * Recent replies, newest first. `limit` is a real bound with a total beside it —
 * `getPendingSaraActions`'s silent default of 10 reported a queue of 930 as 10,
 * so no count returned here is allowed to be the capped one.
 */
function list({ limit = 50, offset = 0 } = {}) {
  // Nonsense input falls back to the DEFAULT, not to the nearest legal value —
  // clamping limit=-5 to 1 answers with one row and looks like the truth.
  const n = parseInt(limit, 10);
  const cap = Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
  const off = parseInt(offset, 10);
  const skip = Number.isFinite(off) && off > 0 ? off : 0;
  const rows = db.all(
    'SELECT * FROM sent_replies ORDER BY sent_at DESC, id DESC LIMIT ? OFFSET ?',
    [cap, skip]
  ) || [];
  return {
    replies: rows.map(_shape),
    total: count(),
    limit: cap,
    offset: skip,
  };
}

function count() {
  const row = db.get('SELECT COUNT(*) AS n FROM sent_replies');
  return row ? row.n : 0;
}

/** Every reply sent on one email — a thread can be answered more than once. */
function forEmail(emailId) {
  if (!emailId) return [];
  const rows = db.all(
    'SELECT * FROM sent_replies WHERE email_id = ? ORDER BY sent_at DESC, id DESC',
    [String(emailId)]
  ) || [];
  return rows.map(_shape);
}

module.exports = { record, list, count, forEmail, _internals: { _serialiseRecipients, _parseRecipients, _shape } };
