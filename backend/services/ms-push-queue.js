'use strict';

/**
 * Completions Microsoft would not take, held until it will.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `POST /api/todos/complete-ms` flips the vault mirror first (instant feedback,
 * the same order as `wip-ms`), then pushes to Graph. When Graph refused it fell
 * back to the Power Automate webhook, and when that was unset or failed it
 * returned `{ok: true, pushed: 'none'}` with a warning string — and that was the
 * end of it. Nothing retried.
 *
 * ⚠ And the completion did not merely fail to reach Microsoft: it UNDID itself.
 * `Tasks/Microsoft Tasks.md` is regenerated wholesale from Graph every 30
 * minutes on weekdays, so a task Nick ticked reappeared as open inside half an
 * hour, with no warning still on screen and nothing anywhere recording that he
 * had already dealt with it. The single most demoralising possible shape: work
 * done, silently reverted, and offered back as if it had never happened.
 *
 * Graph auth expiring is not a rare event here — the device code flow needs
 * re-running periodically and `getAccessToken()` returns null for the whole
 * window in between. That is precisely when this matters.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 * 1. NOTHING IS EVER SILENTLY DROPPED. An item that exhausts its attempts
 *    becomes `failed` with its last reason, stays on the queue and is reported.
 *    Deleting it would recreate the original bug with extra steps.
 *
 * 2. ALMOST NOTHING IS TERMINAL. The obvious classification — retry `auth`,
 *    give up on `not_found` — is wrong here, and the reason is in
 *    `setPlannerPercent`: it returns `not_found` when it cannot read the task's
 *    etag, and `graphFetch` returns null on a 401. So during an auth outage a
 *    perfectly real Planner task reports `not_found`. Only `no_task_id` is
 *    genuinely terminal, because there is nothing to retry. Everything else is
 *    bounded by attempts and age instead, which fails towards trying again.
 *
 * 3. THE MIRROR MUST NOT OFFER THE TASK BACK while a completion is pending.
 *    `syncMicrosoftTasks` asks `pendingIds()` and skips those lines. This is the
 *    load-bearing half — without it the retry works and Nick still sees the task
 *    reappear, ticks it again, and queues a second copy of the same completion.
 *    Suppression ends the moment the item leaves `pending`, so a permanently
 *    failed push gives the task BACK rather than hiding it for ever. Hiding work
 *    on a bad guess is the failure that would end the feature.
 *
 * 4. IDEMPOTENT BY msId. Ticking the same task twice is one queue entry, and a
 *    retry against a task Microsoft has already completed is a no-op there.
 *
 * State lives in `agent_state` (KV), following standup-session, focus-session
 * and one_two_one_moves: the volume is failed pushes only, and a schema
 * migration on the live DB is a bigger risk than the query convenience is worth.
 * It MUST be persisted — the backend restarts several times a day on deploys,
 * and an in-memory queue would lose exactly the completions it exists to hold.
 */

const db = require('../db/database');

const STATE_KEY = 'ms_push_queue';

/** Bounded so a task Microsoft will never accept cannot retry for ever. */
const MAX_ATTEMPTS = 12;
const MAX_AGE_DAYS = 7;
/** A cap on the stored blob. Far above any real backlog — a backstop, not a policy. */
const MAX_ITEMS = 200;

/**
 * The only reason worth giving up on immediately: there is no task to push to.
 * See rule 2 — `not_found` is deliberately NOT in here.
 */
const TERMINAL_REASONS = new Set(['no_task_id']);

/** What each reason means, in words Nick can act on. */
const REASON_TEXT = {
  auth: 'Microsoft sign-in expired',
  scope: 'Tasks permission not granted',
  list_not_found: 'Could not find the task in any To Do list',
  not_found: 'Microsoft did not return the task',
  no_task_id: 'No Microsoft id on the task',
};

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt blob must not take the completion path down with it. An empty
    // queue is wrong, but it is wrong in the direction that keeps ticking a task
    // working — and it says so.
    console.warn('[MSQueue] State unreadable — starting from empty');
    return [];
  }
}

function _save(items) {
  db.setState(STATE_KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
}

/**
 * Hold a completion Microsoft would not take.
 *
 * Returns the queue entry, or null if this was not something to hold.
 */
function enqueue({ msId, source = null, listId = null, text = null, reason = null, at = new Date() }) {
  if (!msId) return null;
  if (TERMINAL_REASONS.has(reason)) return null;

  const items = _load();
  const existing = items.find(i => i.msId === msId && i.status === 'pending');
  if (existing) {
    // Ticked twice, or re-queued by a retry. One task, one entry — and the newer
    // reason is the useful one.
    existing.lastReason = reason || existing.lastReason;
    existing.lastAt = at.toISOString();
    if (text) existing.text = text;
    _save(items);
    return existing;
  }

  const entry = {
    msId,
    source: source || null,
    listId: listId || null,
    text: text || null,
    status: 'pending',
    attempts: 0,
    firstAt: at.toISOString(),
    lastAt: at.toISOString(),
    lastReason: reason || null,
  };
  items.push(entry);
  _save(items);
  console.log(`[MSQueue] Holding completion for ${msId} — ${REASON_TEXT[reason] || reason || 'push failed'}`);
  return entry;
}

/**
 * Whether an item has run out of road. Pure — takes the item and a clock.
 *
 * Age AND attempts, because they fail differently: a queue drained every ten
 * minutes exhausts its attempts in two hours, which is shorter than a weekend
 * of expired auth, while an item that errors before it can even attempt would
 * otherwise sit pending for ever.
 */
function isExhausted(item, now = new Date()) {
  if (!item) return false;
  if (item.attempts >= MAX_ATTEMPTS) return true;
  const first = new Date(item.firstAt);
  if (Number.isNaN(first.getTime())) return false;
  return (now - first) / 86400000 >= MAX_AGE_DAYS;
}

/**
 * The Microsoft ids with a completion still in flight.
 *
 * `syncMicrosoftTasks` reads this to keep a ticked task out of the regenerated
 * mirror. Only `pending` — a failed item deliberately comes back, because the
 * push is not going to happen and Nick needs to see the task again.
 *
 * Returns a Set, and never throws: this sits on the vault sync path, and an
 * unreadable queue must degrade to "suppress nothing" rather than take the
 * whole Microsoft Tasks file down with it.
 */
function pendingIds() {
  try {
    return new Set(_load().filter(i => i.status === 'pending').map(i => i.msId));
  } catch {
    return new Set();
  }
}

/**
 * Try every held completion again.
 *
 * Sequential, not parallel: these are Graph writes against a shared board and
 * there is nobody waiting on the result. One failure must not abandon the rest
 * — `one-to-one-booking.bookAll()`'s rule, for the same reason.
 */
async function drain({ now = new Date(), microsoft = require('./microsoft') } = {}) {
  const items = _load();
  const pending = items.filter(i => i.status === 'pending');
  if (!pending.length) return { attempted: 0, completed: 0, stillPending: 0, failed: 0 };

  let completed = 0;
  let failed = 0;

  for (const item of pending) {
    item.attempts++;
    item.lastAt = now.toISOString();
    try {
      const result = await microsoft.completeMicrosoftTask(item.msId, item.source, item.listId);
      if (result && result.completed) {
        item.status = 'done';
        item.doneAt = now.toISOString();
        item.lastReason = null;
        completed++;
        console.log(`[MSQueue] Completed ${item.msId} on retry ${item.attempts}`);
        continue;
      }
      item.lastReason = result?.reason || 'unknown';
    } catch (e) {
      item.lastReason = e.message;
    }

    if (isExhausted(item, now)) {
      item.status = 'failed';
      failed++;
      // Loud. A completion that will not land is a task Nick believes is closed
      // and is about to be handed back to him — he has to be told, not left to
      // notice it reappear.
      console.error(
        `[MSQueue] GIVING UP on ${item.msId} after ${item.attempts} attempts — ` +
        `${REASON_TEXT[item.lastReason] || item.lastReason}. The task will reappear in the mirror.`
      );
    }
  }

  // Done entries are kept briefly so a retry is inspectable, then aged out.
  // They are not suppressed and not reported, so they cost nothing but memory.
  const keep = items.filter(i => {
    if (i.status !== 'done') return true;
    return (now - new Date(i.doneAt || i.lastAt)) / 86400000 < 2;
  });
  _save(keep);

  return {
    attempted: pending.length,
    completed,
    failed,
    stillPending: keep.filter(i => i.status === 'pending').length,
  };
}

/** What is held, for the route and for state-of-play. Read-only. */
function status(now = new Date()) {
  const items = _load();
  const pending = items.filter(i => i.status === 'pending');
  const failed = items.filter(i => i.status === 'failed');
  const describe = i => ({
    msId: i.msId,
    text: i.text,
    source: i.source,
    attempts: i.attempts,
    firstAt: i.firstAt,
    ageHours: Math.round((now - new Date(i.firstAt)) / 3600000),
    reason: i.lastReason,
    reasonText: REASON_TEXT[i.lastReason] || i.lastReason || null,
  });
  return {
    pending: pending.map(describe),
    failed: failed.map(describe),
    pendingCount: pending.length,
    failedCount: failed.length,
  };
}

/**
 * Drop an entry by hand — the way back when a task was completed or deleted in
 * Microsoft directly and the held push is chasing something that is gone.
 *
 * `plaud-admin-blocks`'s `forget` rule: an automated retry must have a manual
 * way out, or it argues with Nick indefinitely.
 */
function forget(msId) {
  const items = _load();
  const next = items.filter(i => i.msId !== msId);
  if (next.length === items.length) return false;
  _save(next);
  return true;
}

module.exports = {
  enqueue,
  drain,
  status,
  forget,
  pendingIds,
  // exported for tests — pure, no DB, no clock
  isExhausted,
  MAX_ATTEMPTS,
  MAX_AGE_DAYS,
  TERMINAL_REASONS,
  STATE_KEY,
};
