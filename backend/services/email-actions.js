'use strict';

/**
 * The obligation inside an email, lifted out of it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `email-triage` has worked for months: it fetches 14 days of mail, classifies
 * it into lanes and stores the result. Not one of its exports creates a task or
 * a candidate, and the file contains no reference to `task-store`, `createTask`
 * or `action-candidates` — the chain stops at classification. So an email
 * reading *"Nick, can you get me the headcount numbers by Friday"* became an
 * ACTION-lane card in InboxPanel and nothing more. The lane says THIS EMAIL
 * NEEDS ATTENTION; nothing anywhere said THIS IS A THING YOU AGREED TO DO.
 * Measured live 3 Sep 2026: urgent 16, reply 11, action-lane 27, oldest
 * unanswered 20 Aug, and not one of them had ever become a task.
 *
 * This is the other half of the queue `action-candidates` fills from meeting
 * notes. It emits the SAME `capture_todo` shape into the SAME table, so the
 * existing queue, the cross-note fold, the dedupe and the approval path all
 * take it unchanged.
 *
 * ── Four rules, and the first one is the whole safety model ──────────────────
 *
 * 1. **REVIEW-ONLY. Nothing here ever promotes.** `autoPromote` is a hardcoded
 *    false and there is no path to `task-store` in this file — a test asserts
 *    both. An email is somebody ELSE'S wording about what Nick owes, read from
 *    a short preview, and a false task minted from a marketing mail is exactly
 *    what makes a review queue stop being read. Confidence is capped well below
 *    `AUTO_PROMOTE_CONFIDENCE`, so it cannot drift over the line later either.
 *
 * 2. **Two lanes only** — `urgent` and `reply`. FYI, DELEGATE and IGNORE are
 *    the lanes triage has already judged as not Nick's to act on, and running
 *    the extractor over them would spend money re-litigating a decision that
 *    has already been made, on much the largest bucket (166 FYI against 27
 *    action).
 *
 * 3. **An answer is bought ONCE.** An email's text never changes, so neither
 *    does what can be extracted from it. The ledger records BOTH outcomes — "an
 *    obligation, here it is" and "nothing owed in this one" — because without
 *    the second, every quiet email is re-bought every 30 minutes for fourteen
 *    days. ⚠ A FAILED batch records NOTHING and is retried: the whole point of
 *    `aiClassified` one file over is that "the model never saw it" and "the
 *    model read it and said nothing" must not be the same record.
 *
 * 4. **It never invents a due date.** The model is asked for the obligation in
 *    plain words, not for a date; a Friday inferred from "by Friday" is a guess
 *    about WHICH Friday, and a wrong date on a task is worse than no date.
 *    Whatever the email said about timing stays in the reason line, where a
 *    human reads it.
 */

const db = require('../db/database');
const actionCandidates = require('./action-candidates');
const todoIntelligence = require('./todo-intelligence');

/** Kill switch. On by default — it creates review rows and can write nothing else. */
const ENABLED = process.env.EMAIL_ACTIONS_ENABLED !== 'false';

/** The lanes where Nick is the one who has to do something. */
const LANES = new Set(['urgent', 'reply']);

const LEDGER_KEY = 'email_actions_seen';

/**
 * A ceiling on the confidence anything from here can carry.
 *
 * `action-candidates` runs 0.82–0.97 because a `- [ ]` in a meeting note is a
 * commitment somebody typed as one. This is a model reading a preview of
 * somebody else's email, which is strictly weaker evidence, and the queue sorts
 * on confidence — so an email guess must never outrank a written checkbox.
 * Kept below `AUTO_PROMOTE_CONFIDENCE` by a margin, and pinned.
 */
const CONFIDENCE = 0.62;

/** Model calls are batched; a batch is small so one bad answer costs little. */
const BATCH = 10;

/**
 * How many emails one run will pay to read.
 *
 * The first run after this lands faces the whole 14-day backlog. That is a
 * one-off, but it is a one-off that should not arrive as a single unbounded
 * bill, and the remainder is picked up by the next run half an hour later.
 */
const MAX_PER_RUN = Number(process.env.EMAIL_ACTIONS_MAX_PER_RUN || 40);

/** Below this an "obligation" is a fragment; above it, an essay. */
const MIN_TEXT = 8;
const MAX_TEXT = 220;

/**
 * The candidate's provenance.
 *
 * ⚠ Deliberately NOT a vault path, and namespaced so it cannot be mistaken for
 * one. Everything downstream that reads `sourcePath` — the review state, the
 * per-source dedupe, `rememberReviewedAction` — is key-value and path-agnostic,
 * but a bare `Inbox/whatever.md` would read as a note that does not exist.
 */
function sourcePathFor(id) {
  return `email:${String(id)}`;
}

function readLedger() {
  try {
    const raw = db.getState(LEDGER_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(ledger) {
  try {
    db.setState(LEDGER_KEY, JSON.stringify(ledger));
  } catch (e) {
    console.warn('[EmailActions] Could not persist the seen-ledger:', e.message);
  }
}

/**
 * Forget emails triage no longer holds.
 *
 * Bounded on the same principle as the triage store itself: an append-only
 * ledger with no retention is the next pile. Triage is the authority on what
 * exists, so anything it has dropped has nothing left to be re-bought for.
 */
function pruneLedger(ledger, liveIds) {
  const next = {};
  for (const [id, v] of Object.entries(ledger || {})) if (liveIds.has(id)) next[id] = v;
  return next;
}

/**
 * The prompt.
 *
 * Two things it is told and one it is not. It is told to answer `null` when
 * there is no obligation — most email is not an ask, and a model that must
 * produce something produces something. It is told the obligation must be
 * NICK'S: an email describing what somebody else is going to do is information,
 * not a task. It is NOT asked for a date (rule 4).
 */
function buildPrompt(batch) {
  const list = batch.map((e, i) => [
    `[${i}]`,
    `From: ${e.from || '(unknown)'} <${e.fromEmail || ''}>`,
    `Subject: ${e.subject || '(no subject)'}`,
    `Preview: ${String(e.preview || '').slice(0, 400) || '(no preview)'}`,
  ].join('\n')).join('\n\n');

  return `You are reading Nick Ward's email. Nick is Head of Technical Support at Nurtur.

For each email, decide whether it asks NICK to DO something specific.

Rules:
- If somebody is asking Nick for something, or Nick has agreed to something, write it as a short action starting with a verb, in plain words, under 15 words.
- If the email is information, a notification, an automated report, marketing, or describes what SOMEBODY ELSE will do, answer null. Most email is null. Answering null is the correct and expected answer.
- Do not invent a deadline or a date. Do not restate the subject line as the action.

Respond with ONLY a JSON array, one entry per email:
[{"index": 0, "action": "Send Chris the headcount numbers"}, {"index": 1, "action": null}]

The ${batch.length} emails:

${list}`;
}

/** Parse the model's answer into `index -> action text, or null for nothing owed`. */
function parseAnswer(text, batchSize) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  const match = clean.match(/\[[\s\S]*\]/);
  // No closing bracket is a TRUNCATED answer, not an empty one — the shape that
  // has cost this repo whole email-triage runs before.
  if (!match) throw new Error(`unparseable answer (${clean.length} chars)`);
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) throw new Error('answer was not an array');

  const out = new Map();
  for (const row of parsed) {
    if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= batchSize) continue;
    const raw = row.action;
    if (raw === null || raw === undefined || raw === '' || /^(null|none|n\/a|no action)$/i.test(String(raw).trim())) {
      out.set(row.index, null);
      continue;
    }
    out.set(row.index, String(raw).replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** Reject a "task" that is really a fragment, or an essay. */
function usable(text) {
  const t = String(text || '').trim();
  return t.length >= MIN_TEXT && t.length <= MAX_TEXT;
}

/**
 * Build the candidate. The same shape `action-candidates` emits, field for
 * field — that is what lets the existing queue, fold and approval path take it
 * with no change of their own.
 */
function buildCandidate(email, text) {
  const sourcePath = sourcePathFor(email.id);
  const who = email.from || email.fromEmail || 'an email';
  return {
    type: 'capture_todo',
    text,
    confidence: CONFIDENCE,
    reason: `Asked of you by ${who} — "${String(email.subject || '').slice(0, 60)}"`,
    sourcePath,
    focusItemId: actionCandidates.buildFocusItemId(sourcePath, text),
    semanticSignature: actionCandidates.buildSemanticSignature(text),
    // Hardcoded, never computed. See rule 1.
    autoPromote: false,
    payload: {
      text,
      sourcePath,
      semanticSignature: actionCandidates.buildSemanticSignature(text),
      extractedFrom: 'email',
      origin: 'email-candidate',
      // ⚠ Carried so promotion does not stamp `meeting-promotion` on something
      // that never came from a meeting. Provenance nobody can trust is worse
      // than none — and `inferOrigin` reads exactly this field.
      source: 'email-promotion',
      email: {
        id: email.id,
        from: email.from || null,
        fromEmail: email.fromEmail || null,
        subject: email.subject || null,
        received: email.received || null,
        lane: email.lane || null,
      },
      metadata: todoIntelligence.triageTodo({ text, sourcePath, dueDate: null }),
    },
  };
}

/** Already queued for this email. */
function alreadyRaised(candidate) {
  const existing = db.getSaraActionsBySource(candidate.sourcePath, 'capture_todo');
  return existing.some((a) => a.focus_item_id === candidate.focusItemId
    || a.payload?.semanticSignature === candidate.semanticSignature);
}

/**
 * Extract obligations from the triage list and queue them for review.
 *
 * Takes the entries rather than reading them back, so the caller passes what it
 * has just stored and there is no window in which the two disagree.
 */
async function extractFromTriage(entries = [], { limit = MAX_PER_RUN } = {}) {
  if (!ENABLED) return { ok: true, skipped: 'disabled', created: 0, considered: 0 };

  const live = (entries || []).filter((e) => e && e.id);
  const ledger = pruneLedger(readLedger(), new Set(live.map((e) => String(e.id))));

  const eligible = live.filter((e) => LANES.has(e.lane) && !e.dismissed);
  const unread = eligible.filter((e) => !ledger[String(e.id)]);
  const batchable = unread.slice(0, limit);

  const result = {
    ok: true,
    considered: eligible.length,
    asked: batchable.length,
    deferred: unread.length - batchable.length,
    created: 0,
    withObligation: 0,
    failedBatches: 0,
    unanswered: 0,
  };

  if (!batchable.length) {
    writeLedger(ledger);
    return result;
  }

  const aiRouting = require('./ai-routing');

  for (let offset = 0; offset < batchable.length; offset += BATCH) {
    const batch = batchable.slice(offset, offset + BATCH);
    let answers;
    try {
      const res = await aiRouting.runTask('email_summary', {
        prompt: buildPrompt(batch),
        maxTokens: 700,
        temperature: 0.1,
      });
      // No text is not "no obligations". It is no answer, and it must retry.
      if (!res?.text) throw new Error(`no text from ${res?.provider || 'any provider'}`);
      answers = parseAnswer(res.text, batch.length);
    } catch (e) {
      result.failedBatches += 1;
      console.warn(`[EmailActions] batch ${offset}-${offset + batch.length - 1} failed: ${e.message}`);
      // ⚠ Nothing is written to the ledger for a failed batch, so these emails
      // are asked about again next run rather than silently reading as quiet.
      continue;
    }

    batch.forEach((email, i) => {
      const key = String(email.id);
      if (!answers.has(i)) {
        // The model answered the batch but skipped this row. Same rule as a
        // failed batch: unmarked, retried.
        result.unanswered += 1;
        return;
      }
      const text = answers.get(i);
      if (!text || !usable(text)) {
        // A real answer: nothing owed here. Recorded so it is never re-bought.
        ledger[key] = { at: new Date().toISOString(), obligation: false };
        return;
      }

      const candidate = buildCandidate(email, text);
      ledger[key] = { at: new Date().toISOString(), obligation: true, text };
      result.withObligation += 1;

      try {
        if (alreadyRaised(candidate)) return;
        // A candidate Nick has already rejected, or already turned into a task,
        // must not come back. Same review state the vault path writes.
        const handled = actionCandidates.reviewStatusFor(candidate.sourcePath, candidate.semanticSignature);
        if (handled === 'rejected' || handled === 'executed' || handled === 'ignored') return;

        db.createSaraAction(
          candidate.type,
          candidate.payload,
          candidate.confidence,
          candidate.reason,
          candidate.focusItemId,
        );
        result.created += 1;
      } catch (e) {
        console.warn(`[EmailActions] could not queue "${text.slice(0, 50)}": ${e.message}`);
      }
    });
  }

  writeLedger(ledger);

  if (result.created || result.failedBatches) {
    console.log(`[EmailActions] ${result.asked} emails read, ${result.withObligation} carried an ask, `
      + `${result.created} queued for review`
      + (result.failedBatches ? `, ${result.failedBatches} batch(es) failed and will be retried` : '')
      + (result.deferred ? `, ${result.deferred} left for the next run` : ''));
  }
  return result;
}

module.exports = {
  extractFromTriage,
  // Pure, and exported for the tests: the rules are the product.
  buildPrompt,
  parseAnswer,
  buildCandidate,
  usable,
  sourcePathFor,
  pruneLedger,
  LANES,
  CONFIDENCE,
  ENABLED,
};
