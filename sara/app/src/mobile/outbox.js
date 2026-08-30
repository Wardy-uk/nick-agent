// The mobile outbox — the ONE path a capture takes on this device.
//
// Everything a Neuro Mobile capture does goes through here, online or off. That
// is the point: before Phase 2 the online path posted straight to
// /api/capture/* and the offline path did not exist, so "it worked when I had
// signal" and "it saved" were the same code and the same words. Now there is one
// path with FIVE honest states, and the words differ.
//
//   queued          — on this device, NOT in NEURO. Says so, in those words.
//   sending         — in flight.
//   confirmed       — NEURO acknowledged it and named the canonical record.
//   failed          — the attempt did not land. Retryable. Text intact.
//   needs-attention — NEURO refused it, or could not apply it. Never retried on
//                     a loop; the text is intact and Nick decides.
//
// ⚠ Replay is FOREGROUND-ONLY. iOS PWAs have no guaranteed background sync —
// the Background Sync API is not implemented in Safari, and a service worker
// there is not kept alive to drain a queue. Pretending otherwise would mean a
// capture Nick believes is on its way while the phone is in his pocket. So the
// triggers are: app launch, returning to the foreground, coming back online,
// after a successful capture, and an explicit "retry now".

import { apiFetch } from '../api.js';
import {
  OP_STATUS,
  getDeviceId,
  listOperations,
  putOperation,
  deleteOperation,
  putReceipt,
  randomId,
} from './localStore.js';

export const CLIENT_SCHEMA = 'neuro.mobile.client/1';
const SYNC_PATH = '/api/mobile/v1/sync/operations';

// How many consecutive failures before an operation stops being retried
// automatically. It is NOT discarded — it moves to needs-attention with its text
// intact, and Nick gets an explicit retry. A queue that retries forever on a
// permanently broken item is a queue that never drains and never says so.
const MAX_ATTEMPTS = 8;

/**
 * What ONE operation's receipt actually means, phrased once.
 *
 * ⚠ A caller must NEVER read a per-operation outcome off flush()'s aggregate
 * counts. `flush()` drains the WHOLE queue, so `confirmed >= 1` can easily be an
 * older capture landing while the thing the user just did was rejected — which
 * is how a screen comes to say "Done" over a completion NEURO refused. Match the
 * receipt by operationId and ask this.
 *
 * `held` is its own outcome and not a success: `task-blocks` holds a completion
 * until the outcome note is written, so the tick was recorded and the task is
 * NOT done. Rendering that as "Done" is the silent half-failure shape.
 *
 * @param {object|null|undefined} receipt  the server receipt for ONE operation
 * @returns {{state: string, done: boolean, message: string}}
 *   state is one of: confirmed | held | refused | pending
 */
export function outcomeFor(receipt) {
  if (!receipt) {
    // No receipt means it never got an answer — it is still on the device.
    return { state: 'pending', done: false, message: 'Queued on this device — not in NEURO yet.' };
  }

  if (receipt.status === 'applied' || receipt.status === 'duplicate') {
    let detail = null;
    try { detail = receipt.detail ? JSON.parse(receipt.detail) : null; } catch { detail = null; }
    if (detail && detail.held) {
      return {
        state: 'held',
        done: false,
        message: `Ticked, but NEURO is holding it — ${detail.heldReason || 'awaiting the write-up'}.`,
      };
    }
    return { state: 'confirmed', done: true, message: 'Saved to NEURO.' };
  }

  if (receipt.status === 'rejected' || receipt.status === 'needs-attention') {
    return {
      state: 'refused',
      done: false,
      message: `NOT saved — ${receipt.detail || 'NEURO could not apply it'}.`,
    };
  }

  return { state: 'pending', done: false, message: 'Queued on this device — not in NEURO yet.' };
}

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notify() {
  let ops = [];
  try { ops = await listOperations(); } catch {}
  for (const fn of listeners) {
    try { fn(ops); } catch {}
  }
}

/**
 * Queue an operation. Returns the stored record.
 *
 * ⚠ THROWS if local persistence fails. The caller MUST NOT clear its draft on a
 * throw: if the write did not land, the words in the box are the only copy left,
 * and clearing them is how a capture is lost by the thing built to save it.
 */
export async function enqueue(kind, payload) {
  const op = {
    operationId: randomId(),
    kind,
    payload,
    createdAt: new Date().toISOString(),
    status: OP_STATUS.QUEUED,
    attempts: 0,
    lastError: null,
    canonicalId: null,
    detail: null,
  };
  await putOperation(op);
  notify();
  return op;
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

let flushing = false;

/**
 * Send everything that is waiting. Safe to call at any time and from several
 * triggers at once — a second call while one is in flight is a no-op rather than
 * a second delivery of the same operations.
 *
 * ⚠ The counts are an aggregate over the WHOLE queue and must never be used to
 * decide what happened to ONE operation — `receipts[operationId]` is for that,
 * read through `outcomeFor()`. A caller that reads `confirmed >= 1` after
 * queueing a completion will say "Done" whenever any older capture happened to
 * land in the same flush.
 *
 * @returns {{ ran: boolean, reason?: string, sent?: number, confirmed?: number,
 *             failed?: number, needsAttention?: number,
 *             receipts: Record<string, object> }}
 */
export async function flush({ force = false } = {}) {
  // Every return below carries `receipts`, empty or not, so a caller can index
  // it without guarding — an undefined map read as `receipts[id]` would throw in
  // exactly the branch where the app is offline and least able to report it.
  if (flushing) return { ran: false, reason: 'already-running', receipts: {} };
  if (!force && !isOnline()) return { ran: false, reason: 'offline', receipts: {} };

  flushing = true;
  try {
    const all = await listOperations();
    const pending = all.filter(
      (o) => (o.status === OP_STATUS.QUEUED || o.status === OP_STATUS.FAILED || o.status === OP_STATUS.SENDING)
        && (o.attempts || 0) < MAX_ATTEMPTS
    );
    if (!pending.length) return { ran: true, sent: 0, confirmed: 0, failed: 0, needsAttention: 0, receipts: {} };

    for (const op of pending) {
      await putOperation({ ...op, status: OP_STATUS.SENDING });
    }
    notify();

    const deviceId = await getDeviceId();
    let response;
    try {
      response = await apiFetch(SYNC_PATH, {
        method: 'POST',
        body: JSON.stringify({
          deviceId,
          clientSchema: CLIENT_SCHEMA,
          operations: pending.map((o) => ({
            operationId: o.operationId,
            kind: o.kind,
            createdAt: o.createdAt,
            payload: o.payload,
          })),
        }),
      });
    } catch (e) {
      // The batch never reached NEURO. Nothing is confirmed and nothing is
      // discarded — every operation goes back to failed with its text intact.
      for (const op of pending) {
        await putOperation({
          ...op,
          status: OP_STATUS.FAILED,
          attempts: (op.attempts || 0) + 1,
          lastError: e.message,
        });
      }
      notify();
      // No receipts: NEURO never answered, so there is nothing to report per
      // operation. `outcomeFor(undefined)` is 'pending', which is the truth.
      return { ran: true, sent: pending.length, confirmed: 0, failed: pending.length, needsAttention: 0, error: e.message, receipts: {} };
    }

    const receipts = new Map((response.receipts || []).map((r) => [r.operationId, r]));
    // Keyed by operationId and handed back, so a caller can ask what happened to
    // the one thing it queued rather than reading the aggregate counts.
    const byId = {};
    for (const [id, r] of receipts) byId[id] = r;
    let confirmed = 0;
    let failed = 0;
    let needsAttention = 0;

    for (const op of pending) {
      const receipt = receipts.get(op.operationId);
      if (!receipt) {
        // A missing receipt is NOT a success. The server may or may not have
        // applied it; treat it as failed so it is retried, which is safe because
        // the operation id makes a replay idempotent.
        await putOperation({
          ...op,
          status: OP_STATUS.FAILED,
          attempts: (op.attempts || 0) + 1,
          lastError: 'no receipt returned for this operation',
        });
        failed += 1;
        continue;
      }

      try { await putReceipt(receipt); } catch {}

      if (receipt.status === 'applied' || receipt.status === 'duplicate') {
        // Confirmed. The canonical record exists and is named. The operation is
        // dropped from the outbox — the receipt is what survives, so the device
        // never becomes a second store of things NEURO already owns.
        await deleteOperation(op.operationId);
        confirmed += 1;
      } else if (receipt.status === 'rejected' || receipt.status === 'needs-attention') {
        // NEURO refused it, or cannot apply it. Retrying changes nothing, so the
        // operation is KEPT with its text intact and surfaced for a decision.
        await putOperation({
          ...op,
          status: OP_STATUS.NEEDS_ATTENTION,
          attempts: (op.attempts || 0) + 1,
          lastError: receipt.detail || receipt.status,
          canonicalId: receipt.canonicalId || null,
        });
        needsAttention += 1;
      } else {
        const attempts = (op.attempts || 0) + 1;
        await putOperation({
          ...op,
          status: attempts >= MAX_ATTEMPTS ? OP_STATUS.NEEDS_ATTENTION : OP_STATUS.FAILED,
          attempts,
          lastError: receipt.detail || 'the server could not apply it',
        });
        if (attempts >= MAX_ATTEMPTS) needsAttention += 1; else failed += 1;
      }
    }

    notify();
    return { ran: true, sent: pending.length, confirmed, failed, needsAttention, receipts: byId };
  } finally {
    flushing = false;
  }
}

/** Put a needs-attention or exhausted operation back in the queue, by hand. */
export async function retry(operationId) {
  const ops = await listOperations();
  const op = ops.find((o) => o.operationId === operationId);
  if (!op) return { ok: false, error: 'not found on this device' };
  await putOperation({ ...op, status: OP_STATUS.QUEUED, attempts: 0, lastError: null });
  notify();
  return flush({ force: true });
}

/**
 * Discard one operation. The ONLY way anything leaves the outbox unconfirmed,
 * and it is always the user's explicit act — nothing here drops a capture on
 * its own.
 */
export async function discard(operationId) {
  await deleteOperation(operationId);
  notify();
  return { ok: true };
}

export async function pending() {
  const ops = await listOperations();
  return ops.filter((o) => o.status !== OP_STATUS.CONFIRMED);
}

/**
 * Wire the foreground triggers. Returns a teardown function.
 * Deliberately no Background Sync registration — see the header.
 */
export function startAutoFlush() {
  const run = () => { flush().catch(() => {}); };

  run();
  const onOnline = () => run();
  const onVisible = () => { if (document.visibilityState === 'visible') run(); };

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  // A slow, unconditional heartbeat so a queue cannot sit forever in an app
  // that is open but idle. Cheap: it returns immediately when nothing is
  // pending, and does not fire at all while offline.
  const timer = setInterval(run, 60000);

  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
  };
}
