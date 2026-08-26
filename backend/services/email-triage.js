'use strict';

const db = require('../db/database');
const { evaluateEmail } = require('./email-priority');

// CLAUDE_MODEL removed in Phase 3 — AI routing handles provider selection
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_TRIAGE_MODEL || 'qwen2.5:3b';
const TRIAGE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function classifyWithOllama(emailList) {
  const prompt = `You are classifying emails for Nick Ward, Head of Technical Support.
Classify each email into exactly one category:
- ACTION: Requires Nick to do something or reply
- FYI: Informational only, no action needed
- DELEGATE: Someone else should handle this
- IGNORE: Automated, spam, or irrelevant

Respond with ONLY a JSON array. No markdown, no explanation.
Format: [{"index": 0, "category": "ACTION", "reason": "brief reason max 8 words"}, ...]

Emails:
${emailList}`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_ctx: 4096, num_predict: 512 }
    }),
    signal: AbortSignal.timeout(30000) // 30s — fail fast to AI routing
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  const text = data.response || '';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in Ollama response');
  return JSON.parse(jsonMatch[0]);
}

// The model sees the mail in batches of this size (26 Aug 2026).
//
// It used to see `emails.slice(0, 20)` and nothing else, while the result was
// mapped over ALL of them — we fetch 40, so on any busy day the back half was
// never shown to the model at all. Worse, an email with no classification fell
// through to `aiCategory = 'FYI'`, which is indistinguishable from the model
// having read it and said FYI. So the newest 20 were triaged and the rest were
// quietly filed as informational, with nothing anywhere saying so.
//
// 20 is kept as the BATCH size rather than raised to 40 in one call: the reply
// budget is 1024 tokens, and 40 items of JSON overruns it — which truncates the
// array, fails the parse and silently drops the whole run to deterministic
// rules. Two batches of 20 each fit, and a batch that fails costs only itself.
const CLASSIFY_BATCH = 20;

async function classifyBatch(batch, offset) {
  const emailList = batch.map((e, i) =>
    `[${i}] From: ${e.from} <${e.fromEmail}>\nSubject: ${e.subject}\nPreview: ${e.preview?.substring(0, 150) || '(no preview)'}`
  ).join('\n\n');

  // Route through AI provider (Pi 4 worker first, then local fallback)
  // DO NOT call Pi 5 Ollama directly — it blocks interactive use
  const aiProvider = require('./ai-provider');
  const result = await aiProvider.triageEmails(
    `You are classifying emails for Nick Ward, Head of Technical Support at Nurtur.
Classify each email into exactly one category: ACTION, FYI, DELEGATE, or IGNORE.
Respond with ONLY a JSON array. Format: [{"index": 0, "category": "ACTION", "reason": "brief reason max 8 words"}, ...]

Classify these ${batch.length} emails:\n\n${emailList}`
  );
  if (!result.text) return [];

  const clean = result.text.replace(/```json|```/g, '').trim();
  const jsonMatch = clean.match(/\[[\s\S]*\]/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '[]');
  console.log(`[EmailTriage] Classified ${batch.length} via ${result.provider}`);
  // Batch-local indices become global ones here, so the caller never has to
  // know the batching happened.
  return parsed
    .filter(c => Number.isInteger(c?.index) && c.index >= 0 && c.index < batch.length)
    .map(c => ({ ...c, index: c.index + offset }));
}

async function classifyEmails(emails) {
  if (!emails || emails.length === 0) return [];

  const classifications = [];
  let failedBatches = 0;

  // Sequential, not parallel: these are cloud calls against a shared daily
  // budget and a rate limit, and triage is a background job with nobody
  // waiting on it.
  for (let offset = 0; offset < emails.length; offset += CLASSIFY_BATCH) {
    const batch = emails.slice(offset, offset + CLASSIFY_BATCH);
    try {
      classifications.push(...await classifyBatch(batch, offset));
    } catch (aiErr) {
      failedBatches++;
      console.error(`[EmailTriage] AI classification failed for emails ${offset}-${offset + batch.length - 1}:`, aiErr.message);
    }
  }

  const answered = new Set(classifications.map(c => c.index));
  const unclassified = emails.length - answered.size;
  if (unclassified > 0) {
    // Loud, because the failure is otherwise invisible: an email the model
    // never saw looks exactly like one it called FYI.
    console.warn(`[EmailTriage] ${unclassified}/${emails.length} emails got no model answer`
      + `${failedBatches ? ` (${failedBatches} batch(es) failed)` : ''} — deterministic rules only`);
  }

  return emails.map((email, i) => {
    const cls = classifications.find(c => c.index === i);
    const deterministic = evaluateEmail(email);
    // No answer means NO ANSWER. Defaulting to 'FYI' and storing it in the same
    // field the model writes made "never looked at" and "judged informational"
    // the same record — so the blend below then treated a non-answer as the
    // model actively disagreeing with the deterministic rules.
    const aiCategory = cls ? String(cls.category || 'FYI').toUpperCase() : null;
    let category = aiCategory || deterministic.category;
    if (deterministic.category === 'IGNORE') category = 'IGNORE';
    else if (deterministic.category === 'FYI' && aiCategory === 'ACTION') category = 'FYI';
    else if (deterministic.category === 'ACTION' && aiCategory === 'IGNORE') category = 'ACTION';
    else if (deterministic.category === 'DELEGATE' && aiCategory !== 'ACTION') category = 'DELEGATE';
    else if (deterministic.forced) category = deterministic.category;

    const lane =
      category === 'IGNORE' ? 'ignore'
        : category === 'DELEGATE' ? 'delegate'
          : deterministic.lane === 'urgent' ? 'urgent'
            : category === 'ACTION' ? 'reply'
              : deterministic.lane || 'fyi';

    return {
      ...email,
      category,
      lane,
      urgency: deterministic.urgency,
      urgent: lane === 'urgent',
      needsReply: lane === 'reply' || lane === 'urgent',
      reason: deterministic.reasons.length
        ? deterministic.reasons.join(' · ')
        : (cls?.reason || ''),
      aiCategory,
      // Null aiCategory already says it, but only to code that remembers to
      // check. This says it plainly to anything reading the record later.
      aiClassified: cls != null,
      triaged: true,
      triagedAt: new Date().toISOString()
    };
  });
}

// What the last run was actually looking at. Not a store of items — the pile
// that caused all this was a store of items. Just "is the input the same mail
// as last time", so a 30-minute cadence does not pay for 21 identical
// classifications a day (26 Aug 2026).
const INPUT_KEY = 'email_triage_input';

// ── Keeping the store from becoming the next pile ───────────────────────────
//
// Measured 26 Aug: 748 entries, 743 of them dismissed, **668 KB** — parsed in
// full on every read, and there are a lot of reads (the nudge, both context
// feeds, the panel polling). Growing ~57 entries a day with nothing pruning.
// Not wrong the way `inbox_items` was wrong, but the same shape of mistake one
// step later: a store nobody empties.
//
// A dismissed entry is kept for exactly two reasons, and neither needs the
// whole email:
//   1. The merge in `runTriage` must not resurrect it while its id can still
//      come back in the 24-hour fetch window. Seven days is a wide margin.
//   2. The #70 feedback score reads urgency/category/dismissReason.
// So dismissed entries are COMPACTED to those fields on write (668 KB → 192 KB
// on today's data, and the id is most of what remains), then pruned by age —
// with their contribution to the feedback score ROLLED UP first, so pruning
// costs history rather than throwing it away. The classifier's only free
// feedback signal must not quietly reset every week.
const DISMISSED_RETAIN_DAYS = 7;
const DISMISSED_FIELDS = ['id', 'dismissed', 'dismissedAt', 'dismissReason', 'urgency', 'category'];
const FEEDBACK_ROLLUP_KEY = 'email_triage_feedback_rollup';

function compact(entry) {
  if (!entry.dismissed) return entry;
  const out = {};
  for (const f of DISMISSED_FIELDS) if (entry[f] !== undefined) out[f] = entry[f];
  return out;
}

function readRollup() {
  try {
    const raw = JSON.parse(db.getState(FEEDBACK_ROLLUP_KEY) || '{}');
    // Every counter must be listed here. This normaliser is also what
    // `foldUnderRanked` reads before incrementing, so a field it forgets is a
    // field that silently resets to 0 on every write — `underRanked` could
    // never have exceeded 1.
    return {
      judged: raw.judged || 0,
      notRelevant: raw.notRelevant || 0,
      underRanked: raw.underRanked || 0,
      byCategory: raw.byCategory || {},
    };
  } catch { return { judged: 0, notRelevant: 0, underRanked: 0, byCategory: {} }; }
}

function isJudged(e) {
  return e.dismissed && e.dismissReason && e.dismissReason !== 'unspecified';
}

// Anything judged that is about to leave the blob — pruned by age, or dropped
// by a deliberate clear — pays its verdict into the rollup on the way out.
// Nick pressing "clear" means he wants a fresh triage, not that he wants the
// classifier to forget he ever corrected it.
function foldIntoRollup(entries) {
  const judged = entries.filter(isJudged);
  if (!judged.length) return;
  const rollup = readRollup();
  for (const e of judged) {
    const key = `${e.urgency || 'none'}/${e.category || 'none'}`;
    rollup.byCategory[key] = rollup.byCategory[key] || { judged: 0, notRelevant: 0 };
    rollup.byCategory[key].judged++;
    rollup.judged++;
    if (e.dismissReason === 'not-relevant') {
      rollup.byCategory[key].notRelevant++;
      rollup.notRelevant++;
    }
  }
  db.setState(FEEDBACK_ROLLUP_KEY, JSON.stringify(rollup));
}

/**
 * The single write path for the triage blob. Compacts dismissed entries, drops
 * ones older than the retention window, and folds anything dropped into the
 * feedback rollup on its way out.
 */
function storeTriage(items, now = Date.now()) {
  const cutoff = now - DISMISSED_RETAIN_DAYS * 86400000;
  const kept = [];
  const expired = [];

  for (const e of items) {
    // A dismissed entry with no timestamp cannot be aged, so it is kept rather
    // than guessed at — it will be stamped the next time it is dismissed.
    const age = e.dismissed && e.dismissedAt ? new Date(e.dismissedAt).getTime() : null;
    if (age != null && age < cutoff) expired.push(e);
    else kept.push(compact(e));
  }

  if (expired.length) {
    foldIntoRollup(expired);
    console.log(`[EmailTriage] Pruned ${expired.length} dismissed entries older than ${DISMISSED_RETAIN_DAYS}d`);
  }

  db.setState('email_triage', JSON.stringify(kept));
  return { kept: kept.length, pruned: expired.length };
}

// The one shape every runTriage branch reports its numbers in: what is still
// on Nick's plate, never what a particular pass happened to look at.
function outstandingCounts() {
  const cat = getTriageByCategory();
  return {
    count: cat.action.length + cat.fyi.length + cat.delegate.length,
    urgent: cat.urgent.length,
    reply: cat.reply.length,
    action: cat.action.length,
    fyi: cat.fyi.length,
    delegate: cat.delegate.length,
    ignore: cat.ignore.length,
  };
}

function inputFingerprint(emails) {
  return require('crypto')
    .createHash('sha1')
    .update(emails.map(e => e.id).sort().join('|'))
    .digest('hex');
}

/**
 * Run a full triage cycle — fetch, classify, store.
 *
 * `force` skips the unchanged-input check. Anything Nick pressed himself, and
 * anything that has just wiped the stored blob, must actually re-run.
 */
async function runTriage({ force = false } = {}) {
  const microsoft = require('./microsoft');
  if (!microsoft.isBridgeConfigured() && !(await microsoft.isAuthenticated())) {
    return { ok: false, reason: 'M365 not connected' };
  }

  try {
    const emails = await microsoft.fetchRecentEmails(24, 40);

    // `null` means we could not READ the mailbox; `[]` means we read it and
    // there was nothing. Those were one branch, and it wiped the stored triage
    // either way — so a Graph outage published an empty inbox, and now that the
    // urgent banner is driven from here it would have cleared that too. An
    // all-clear NEURO never actually established is the exact failure the
    // retired scanner's pile was the other half of. Leave the last known state
    // alone and say why.
    if (emails === null) {
      console.warn('[EmailTriage] Mailbox unreachable — keeping the last known triage rather than publishing an empty one');
      return { ok: false, reason: 'mailbox unreachable', stale: true };
    }

    if (emails.length === 0) {
      storeTriage(getStoredTriage().filter(e => e.dismissed));
      db.setState('email_triage_time', String(Date.now()));
      db.setState(INPUT_KEY, inputFingerprint([]));
      try { require('./nudges').triggerUrgentEmailNudge(); } catch {}
      return { ok: true, classified: 0, ...outstandingCounts() };
    }

    // Same mail as last time → the classification would be identical, so skip
    // the (cloud, paid) model call. Gated on HAVING a stored classification,
    // not on it being non-empty: an inbox Nick has fully actioned is the normal
    // end state of a good day, and treating that as "nothing stored" would pay
    // for a full re-classification every 30 minutes precisely when there is
    // nothing to do. A `/triage/clear` forces instead.
    const fingerprint = inputFingerprint(emails);
    const stored = getStoredTriage();
    if (!force && fingerprint === db.getState(INPUT_KEY) && stored.length > 0) {
      // We DID look — the panel's "last triage" is a statement about when NEURO
      // last checked the inbox, and it checked.
      db.setState('email_triage_time', String(Date.now()));
      console.log(`[EmailTriage] ${emails.length} emails, none new since last run — skipped the model call`);
      return { ok: true, skipped: true, classified: 0, ...outstandingCounts() };
    }

    const classified = await classifyEmails(emails);
    db.setState(INPUT_KEY, fingerprint);

    // Store results
    const existing = getStoredTriage();

    // Merge: keep existing dismissed items, add/update new ones.
    //
    // Nick's verdicts are the things a re-classification must NOT overwrite.
    // That was already true of `dismissed`; it is equally true of a promotion,
    // and at a 30-minute cadence a promotion that did not survive the merge
    // would silently drop back to FYI within the half hour — the button would
    // appear to work and then quietly undo itself.
    const updated = [
      ...existing.filter(e => e.dismissed),
      ...classified.map(e => {
        const prev = existing.find(p => p.id === e.id);
        return applyPromotion({
          ...e,
          dismissed: prev?.dismissed || false,
          dismissedAt: prev?.dismissedAt || null,
          promoted: prev?.promoted || false,
          promotedAt: prev?.promotedAt || null,
        });
      })
    ];

    storeTriage(updated);
    db.setState('email_triage_time', String(Date.now()));

    // Raise/refresh/clear the urgent-email banner off the set just stored.
    // The retired scanner used to own this; the nudge now fires from the same
    // pass that produces the list it describes. Never allowed to fail triage.
    try {
      require('./nudges').triggerUrgentEmailNudge();
    } catch (e) {
      console.warn('[EmailTriage] Failed to sync urgent email nudge:', e.message);
    }

    const urgentCount = classified.filter(e => e.lane === 'urgent').length;
    const replyCount = classified.filter(e => e.lane === 'reply').length;
    console.log(`[EmailTriage] Classified ${classified.length} emails, ${urgentCount} urgent, ${replyCount} need reply`);

    // Meeting invites arrive as email, so triage is the earliest point we know
    // one landed. Sync the calendar here rather than waiting for the next timer
    // — sync reports which events are new and checks those for a missing agenda,
    // so the ask reaches the organiser while they are still thinking about the
    // meeting they just sent. Awaited but never allowed to fail the triage:
    // classifying the inbox is the job, this is a passenger.
    try {
      await require('./calendar-sync').sync({ days: 14 });
    } catch (e) {
      console.warn('[EmailTriage] Calendar sync after triage failed:', e.message);
    }

    // Reported as what is STILL OUTSTANDING, not as what was just classified.
    // Those are different populations — a run over 40 emails Nick has already
    // dealt with is a run with nothing to show for it — and the skip branch
    // could only ever report the outstanding one. Two branches returning the
    // same field names for different things is how the 37 happened.
    // `classified` is kept separately: it says what the run DID.
    return { ok: true, classified: classified.length, ...outstandingCounts() };
  } catch (e) {
    console.error('[EmailTriage] Failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function getStoredTriage() {
  try {
    const raw = db.getState('email_triage');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function getTriageByCategory() {
  const all = getStoredTriage().filter(e => !e.dismissed);
  return {
    urgent: all.filter(e => e.lane === 'urgent'),
    reply: all.filter(e => e.lane === 'reply'),
    action: all.filter(e => e.category === 'ACTION'),
    fyi: all.filter(e => e.category === 'FYI'),
    delegate: all.filter(e => e.category === 'DELEGATE'),
    ignore: all.filter(e => e.category === 'IGNORE'),
    lastRun: db.getState('email_triage_time')
  };
}

// The ONE definition of "someone is waiting on Nick today" (26 Aug 2026).
//
// This used to live in nudges.js, computed against a SECOND, independent scan:
// `inbox-scanner.js` writing the `inbox_items` table. Nothing reconciled the
// two. Dismissing in the panel writes here and never wrote there, no frontend
// ever called the scanner's dismiss route, and the 24-hour purge was reachable
// only from a manual endpoint — so that table was a write-only pile going back
// twelve days, and the push notification counted it. Measured the morning it
// was found: SARA said **37 urgent emails**, the panel showed 3, and all 114
// rows in the table had `dismissed = 0`. Two scanners were also paying the AI
// to classify the same mailbox on two different schedules.
//
// So the scanner is retired and this is the only store. The nudge, the chat
// context and the panel now read one blob through one predicate: the count
// that interrupts Nick and the list he opens cannot describe different mail.
function getUrgentEmails() {
  return getStoredTriage().filter(e => !e.dismissed && e.lane === 'urgent');
}

const URGENCY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Everything triage is still holding, worst first — the chat and SARA context
 * feed. Replaces `inbox-scanner.getFlaggedItems()` and keeps its shape so the
 * consumers did not have to learn a second vocabulary.
 *
 * `lastRun` is null when triage has never run, and is NOT the same claim as an
 * empty list: "we have not looked" must stay distinguishable from "your inbox
 * is clear", which is the whole lesson of the pile this replaces.
 */
function getFlaggedItems() {
  const items = getStoredTriage()
    .filter(e => !e.dismissed && e.lane !== 'ignore')
    .map(e => ({
      emailId: e.id,
      subject: e.subject,
      from: e.from,
      fromEmail: e.fromEmail,
      urgency: e.urgency,
      category: e.category,
      // The blob carries no model-written summary — the deterministic reason
      // and the preview are what we actually have. Stating the preview as a
      // summary would be inventing one.
      summary: (e.preview || '').slice(0, 160),
      reason: e.reason,
      received: e.received,
      isRead: !!e.isRead,
      hasAttachments: !!e.hasAttachments,
    }))
    .sort((a, b) => (URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3));

  const lastRun = db.getState('email_triage_time');
  return {
    items,
    lastScan: lastRun ? new Date(Number(lastRun)).toISOString() : null,
  };
}

// #70 — why it was dismissed, not just that it was.
//
// "Done" and "Not relevant" called the identical endpoint, so the distinction
// was painted on. Every "not relevant" is Nick telling triage its ranking was
// wrong, and that was discarded on the spot — the only feedback this classifier
// will ever get for free. Two buttons that do the same thing quietly teach him
// they mean nothing.
const DISMISS_REASONS = new Set(['done', 'not-relevant', 'replied', 'unspecified']);

function dismissEmail(emailId, reason = 'unspecified') {
  const clean = DISMISS_REASONS.has(reason) ? reason : 'unspecified';
  const all = getStoredTriage();
  const updated = all.map(e =>
    e.id === emailId
      ? { ...e, dismissed: true, dismissedAt: new Date().toISOString(), dismissReason: clean }
      : e
  );
  storeTriage(updated);
  if (clean === 'not-relevant') {
    // Logged loudly on purpose: it is a misclassification report, and until
    // something consumes it the log is the only place it exists.
    const item = all.find(e => e.id === emailId);
    console.log(`[Triage] Misranked — "${(item?.subject || emailId).slice(0, 80)}" `
      + `was ${item?.urgency || '?'}/${item?.category || '?'} and Nick says not relevant`);
  }

  // Clearing the last urgent email should silence the banner on the spot, not
  // at the next triage run. Actioning mail and watching the count stay put is
  // exactly the bug this whole change exists to fix.
  try { require('./nudges').triggerUrgentEmailNudge(); } catch {}
}

// ── "This should have been an action" (26 Aug 2026) ─────────────────────────
//
// The mirror of "Not relevant", and the half that was missing. Triage can be
// wrong in two directions, and only one of them had a button: over-ranking got
// recorded as a misclassification, while under-ranking — the expensive
// direction, since a buried ACTION is work Nick never sees — could only be
// fixed by going and finding the email in Outlook, which teaches him the
// classifier cannot be corrected.
//
// It is NOT a dismissal. "Not relevant" says "take this away"; this says "you
// filed it wrong, keep it in front of me", so the email stays in the list and
// moves to the ACTION group.
//
// Deliberately lands in `reply`, never `urgent`: the urgent lane is what drives
// the push notification, and a correction Nick makes while reading the panel is
// not a reason to interrupt the person already reading it.
function applyPromotion(entry) {
  if (!entry.promoted) return entry;
  return {
    ...entry,
    category: 'ACTION',
    lane: 'reply',
    // Never demote something the rules already rated higher.
    urgency: entry.urgency === 'high' ? 'high' : 'medium',
    urgent: false,
    needsReply: true,
    reason: entry.reason ? `${entry.reason} · promoted by Nick` : 'promoted by Nick',
  };
}

function promoteEmail(emailId) {
  const all = getStoredTriage();
  const item = all.find(e => e.id === emailId);
  // Distinguishable from "promoted it": the caller can say so rather than
  // reporting a success that moved nothing.
  if (!item) return { ok: false, reason: 'not in triage' };
  if (item.dismissed) return { ok: false, reason: 'already dismissed' };

  const promotedAt = new Date().toISOString();
  storeTriage(all.map(e => (
    e.id === emailId ? applyPromotion({ ...e, promoted: true, promotedAt }) : e
  )));

  // Recorded against what triage SAID, not what it now says — the whole point
  // is which verdict was wrong.
  foldUnderRanked(item);
  console.log(`[Triage] Under-ranked — "${(item.subject || emailId).slice(0, 80)}" `
    + `was ${item.urgency || '?'}/${item.category || '?'} and Nick says it needs action`);

  return { ok: true, promoted: true };
}

function foldUnderRanked(item) {
  const rollup = readRollup();
  const key = `${item.urgency || 'none'}/${item.category || 'none'}`;
  rollup.byCategory[key] = rollup.byCategory[key] || { judged: 0, notRelevant: 0 };
  rollup.byCategory[key].judged++;
  rollup.byCategory[key].underRanked = (rollup.byCategory[key].underRanked || 0) + 1;
  rollup.judged++;
  rollup.underRanked = (rollup.underRanked || 0) + 1;
  db.setState(FEEDBACK_ROLLUP_KEY, JSON.stringify(rollup));
}

/**
 * How the classifier is doing, by its own output, against Nick's verdict.
 *
 * Deliberately counts only what he has actually judged: an email still sitting
 * in triage is not evidence either way, and folding it in would make the score
 * improve simply because he has not got to it yet.
 *
 * `judged` counts VERDICTS, not emails — an email promoted and later marked
 * done carries two, because Nick said two separate things about it. Triage can
 * be wrong in both directions and `misrankRate` now covers both: over-ranking
 * (`notRelevant`) and under-ranking (`underRanked`). A score that only ever
 * counted the over-ranked half flattered the classifier for the failure that
 * costs most — mail Nick never sees.
 */
function getDismissFeedback() {
  // Live judgements plus the rollup of the ones pruned out of the blob. Reading
  // only what is still stored would make the classifier's score silently reset
  // every seven days, and always look like a young classifier with a small
  // sample — the opposite of what a feedback score is for.
  const rollup = readRollup();
  const byCategory = {};
  for (const [key, v] of Object.entries(rollup.byCategory)) {
    byCategory[key] = { judged: v.judged, notRelevant: v.notRelevant, underRanked: v.underRanked || 0 };
  }
  let judged = rollup.judged;
  let notRelevant = rollup.notRelevant;
  const underRanked = rollup.underRanked || 0;

  for (const e of getStoredTriage().filter(isJudged)) {
    const key = `${e.urgency || 'none'}/${e.category || 'none'}`;
    byCategory[key] = byCategory[key] || { judged: 0, notRelevant: 0, underRanked: 0 };
    byCategory[key].judged++;
    judged++;
    if (e.dismissReason === 'not-relevant') {
      byCategory[key].notRelevant++;
      notRelevant++;
    }
  }

  return {
    judged,
    notRelevant,
    underRanked,
    // Null rather than 0 when nothing has been judged — an untested classifier
    // is not a perfect one.
    misrankRate: judged ? Math.round(((notRelevant + underRanked) / judged) * 100) : null,
    // Kept separate so a rate that moved can be attributed to a direction:
    // ranking things too high and burying things are different faults with
    // different fixes.
    overRankRate: judged ? Math.round((notRelevant / judged) * 100) : null,
    underRankRate: judged ? Math.round((underRanked / judged) * 100) : null,
    byCategory,
  };
}

function clearDismissed() {
  const all = getStoredTriage();
  foldIntoRollup(all.filter(e => e.dismissed));
  storeTriage(all.filter(e => !e.dismissed));
}

module.exports = {
  runTriage,
  getTriageByCategory,
  getUrgentEmails,
  getFlaggedItems,
  // Read-only accessor. The reply route needs the cached subject/sender to
  // record a sent reply (#69) without paying for a live Graph fetch — and a
  // fetch that can fail must not be on the path of bookkeeping for mail that
  // has already left.
  getStoredTriage,
  dismissEmail,
  promoteEmail,
  getDismissFeedback,
  clearDismissed,
  TRIAGE_CACHE_TTL,
  _internals: { inputFingerprint, storeTriage, DISMISSED_RETAIN_DAYS, CLASSIFY_BATCH },
};
