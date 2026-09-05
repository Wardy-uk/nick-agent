'use strict';

/**
 * mobile-sync — the append-only, idempotent outbox NEURO accepts from a phone.
 *
 * The contract, in one paragraph: the DEVICE owns the identity of an intent
 * (`operationId`, generated locally, before anything reaches the network); NEURO
 * owns the canonical record that intent produces. Re-sending an operation is
 * always safe and never creates a second record. Nothing here mutates an
 * existing canonical record except through semantics NEURO already had.
 *
 * ⚠ THE CONFLICT RULE (documented, and deliberately small):
 *   1. New captures are APPEND-ONLY and idempotent. There is nothing to conflict
 *      with — the record does not exist until the operation lands.
 *   2. Existing canonical records remain SERVER-OWNED. The one mutation in this
 *      phase (`todo.complete`) is idempotent by nature and carries no content.
 *   3. Where a mutation cannot be applied cleanly, the local intent is PRESERVED
 *      and reported as needing attention. Server data is never overwritten and
 *      the device's copy is never discarded. There is no merge, and no
 *      resolution UI — a conflict is a thing Nick is told about, not a dialog.
 *
 * ⚠ Idempotency rests on this module being SYNCHRONOUS from the ledger read to
 * the ledger write. better-sqlite3 is synchronous and this is one Node process,
 * so that read-modify-write genuinely cannot interleave — it is a real mutex
 * here, and would NOT be safe across processes (`plaud-admin-blocks`' rule).
 * Do not make `applyOperation` async.
 *
 * ⚠ Nothing here logs capture text, a PIN or a token. Operation ids and kinds
 * only.
 */

const db = require('../db/database');

const CONTRACT_VERSION = 'neuro.mobile/1';

/** Operation kinds NEURO will accept. A closed set: an unknown kind is REFUSED
 *  locally rather than passed through to something that might understand it —
 *  the `neuroCapture` bridge's "named door, not an open proxy" rule. */
const KINDS = {
  CAPTURE_NOTE: 'capture.note',
  CAPTURE_TODO: 'capture.todo',
  TODO_COMPLETE: 'todo.complete',
  // Acting on a nudge is SARA's whole loop — she comes to him, and the answer
  // has to survive being given on a watch in a lift. Added 5 Sep 2026 for the
  // native apps; the PWA calls the routes directly and does not use the outbox.
  NUDGE_COMPLETE: 'nudge.complete',
  NUDGE_SNOOZE: 'nudge.snooze',
};
const KNOWN_KINDS = new Set(Object.values(KINDS));

const MAX_OPERATIONS_PER_REQUEST = 100;
const MAX_TEXT_LENGTH = 20000;

// ── Pure validation ──────────────────────────────────────────────────────────

function isNonEmptyString(v, max = 200) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

/**
 * Validate one operation envelope. PURE — no DB, no clock, no I/O, so the shape
 * of the contract pins without a database (the `pi-health.assess()` split).
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`. The reason is returned to
 * the device verbatim, because a rejection the client cannot explain to Nick is
 * a capture that silently stops retrying with no visible cause.
 */
function validateOperation(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    return { ok: false, reason: 'operation must be an object' };
  }
  if (!isNonEmptyString(op.operationId, 200)) {
    return { ok: false, reason: 'operationId is required' };
  }
  if (!isNonEmptyString(op.kind, 100)) {
    return { ok: false, reason: 'kind is required' };
  }
  if (!KNOWN_KINDS.has(op.kind)) {
    return { ok: false, reason: `unsupported kind "${op.kind}"` };
  }
  if (op.createdAt !== undefined && op.createdAt !== null) {
    if (typeof op.createdAt !== 'string' || Number.isNaN(Date.parse(op.createdAt))) {
      return { ok: false, reason: 'createdAt must be an ISO timestamp' };
    }
  }
  const payload = op.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload must be an object' };
  }

  if (op.kind === KINDS.CAPTURE_NOTE) {
    const content = typeof payload.content === 'string' ? payload.content.trim() : '';
    if (!content) return { ok: false, reason: 'payload.content is required' };
    if (payload.content.length > MAX_TEXT_LENGTH) {
      return { ok: false, reason: `payload.content exceeds ${MAX_TEXT_LENGTH} characters` };
    }
    if (payload.title !== undefined && payload.title !== null && typeof payload.title !== 'string') {
      return { ok: false, reason: 'payload.title must be a string' };
    }
    return { ok: true };
  }

  if (op.kind === KINDS.CAPTURE_TODO) {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) return { ok: false, reason: 'payload.text is required' };
    if (payload.text.length > 2000) {
      return { ok: false, reason: 'payload.text exceeds 2000 characters' };
    }
    return { ok: true };
  }

  if (op.kind === KINDS.TODO_COMPLETE) {
    // ⚠ Only a NEURO-owned task id is accepted. The other two owners a mobile
    // tick can have (a Microsoft mirror, a vault checkbox line) are reachable
    // from `completeTask.js` online, but their semantics are NOT unambiguous
    // offline: a `filePath`+`lineNumber` recorded hours ago can name a different
    // row by the time it replays, which is exactly the bug logged on 27 Aug when
    // a hand-typed line number moved another task's progress. So the outbox
    // carries the one owner whose identity survives the delay.
    const taskId = Number(payload.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return { ok: false, reason: 'payload.taskId (a NEURO task id) is required' };
    }
    return { ok: true };
  }

  if (op.kind === KINDS.NUDGE_COMPLETE) {
    const nudgeId = Number(payload.nudgeId);
    if (!Number.isInteger(nudgeId) || nudgeId <= 0) {
      return { ok: false, reason: 'payload.nudgeId is required' };
    }
    return { ok: true };
  }

  if (op.kind === KINDS.NUDGE_SNOOZE) {
    // ⚠ Snooze is per-TYPE, not per-nudge — `snoozeNudge` writes `snooze_<type>`
    // — so the type is what the device must send, and it is checked against the
    // known list rather than passed through. An unrecognised type would write a
    // junk state key that mutes nothing and never expires, and nothing would
    // ever read it to notice.
    const nudges = require('./nudges');
    if (!isNonEmptyString(payload.type, 100) || !nudges.NUDGE_TYPES.includes(payload.type)) {
      return { ok: false, reason: `payload.type must be one of ${nudges.NUDGE_TYPES.join(', ')}` };
    }
    if (payload.minutes !== undefined) {
      const m = Number(payload.minutes);
      if (!Number.isFinite(m) || m <= 0) return { ok: false, reason: 'payload.minutes must be positive' };
    }
    return { ok: true };
  }

  return { ok: false, reason: `unsupported kind "${op.kind}"` };
}

function validateDeviceId(deviceId) {
  return isNonEmptyString(deviceId, 200);
}

// ── Ledger ───────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function readLedger(deviceId, operationId) {
  return db.get(
    'SELECT * FROM mobile_sync_operations WHERE device_id = ? AND operation_id = ?',
    [deviceId, operationId]
  );
}

function receiptFromRow(row, status) {
  return {
    operationId: row.operation_id,
    status: status || row.status,
    canonicalId: row.canonical_id || null,
    kind: row.kind,
    receivedAt: row.received_at,
    settledAt: row.settled_at || null,
    detail: row.detail || null,
  };
}

// ── Appliers ─────────────────────────────────────────────────────────────────
// Each returns `{ canonicalId, detail }`, or throws. All SYNCHRONOUS.

function applyCaptureNote(payload) {
  const captureStore = require('./capture-store');
  const { filePath, filename, written } = captureStore.writeNote({
    title: payload.title ? String(payload.title).trim() : undefined,
    content: payload.content,
    source: 'neuro-mobile',
  });
  const relative = captureStore.relativePath(filePath);

  // Side effects that must never fail the operation: the capture has landed,
  // and reporting failure after the fact would make Nick capture it twice.
  try { require('./activity').trackCapture('note'); } catch {}
  try { require('./vault-hooks').onVaultWrite(filePath, 'mobile-capture-note'); } catch {}

  return {
    canonicalId: `capture:${relative}`,
    detail: JSON.stringify({ filename, bytes: written.length }),
  };
}

function applyCaptureTodo(payload) {
  const taskStore = require('./task-store');
  const captureStore = require('./capture-store');

  // Obsidian first, same order and same reasoning as `POST /api/capture/todo`:
  // the words go to the vault before the row exists, so a crash between the two
  // loses the projection and never the thought.
  //
  // ⚠ Exactly-once is the LEDGER's job, not this function's. `applyOperation`
  // is synchronous from the ledger read to the ledger write, so a replayed
  // operation never reaches here — which is what stops a drained offline queue
  // appending the same line twice.
  //
  // A vault miss does not fail the operation. The device is replaying a capture
  // it may no longer hold; refusing it because the vault is unreachable would
  // put the queue into a retry loop over the one thing that must not be lost.
  let vault = { written: false, why: 'not attempted' };
  let vaultRecord = null;
  const captureId = `${Date.now().toString(36)}-${String(payload.text || '').length.toString(36)}`;
  try {
    vaultRecord = captureStore.appendTaskCapture({
      text: payload.text,
      source: 'neuro-mobile',
      captureId,
    });
    vault = { written: true, path: vaultRecord.relativePath };
  } catch (e) {
    console.warn('[MobileSync] Todo vault record failed:', e.message);
    vault = { written: false, why: e.message };
  }

  const { id, created } = taskStore.createTask({
    text: payload.text,
    priority: payload.priority || undefined,
    moscow: payload.moscow || undefined,
    due_date: payload.due || null,
    domain: payload.domain || undefined,
    source: 'neuro-mobile',
    origin_path: vaultRecord ? vaultRecord.relativePath : null,
  });
  if (vaultRecord) captureStore.stampTaskCaptureId(vaultRecord.relativePath, captureId, id);
  try { require('./activity').trackCapture('todo'); } catch {}
  if (vaultRecord) {
    try { require('./vault-hooks').onVaultWrite(vaultRecord.filePath, 'mobile-capture-todo'); } catch {}
  }

  // `created:false` means the text folded into an existing task — task-store's
  // dedupe. That is a SUCCESS, not a duplicate operation: a different intent
  // reached an existing record. The distinction is carried in `detail` so the
  // device can say "already on your list" rather than claiming a new task.
  return {
    canonicalId: `task:${id}`,
    detail: JSON.stringify({ created: !!created, vault }),
  };
}

function applyTodoComplete(payload) {
  const taskStore = require('./task-store');
  const taskId = Number(payload.taskId);
  const existing = taskStore.getTask(taskId);
  if (!existing) {
    // A canonical record that is not there is not a failure to retry — it is a
    // conflict: the device holds an intent about something the server does not
    // have. Local intent is preserved (the device keeps the item, visibly
    // needing attention); nothing on the server is touched or invented.
    const err = new Error('task not found on the server');
    err.conflict = true;
    throw err;
  }
  if (existing.status === 'done') {
    // Already done, by any route. Idempotent by nature — report the canonical
    // record rather than writing over a completion that already stands.
    return { canonicalId: `task:${taskId}`, detail: JSON.stringify({ alreadyDone: true }) };
  }

  const updated = taskStore.updateTask(taskId, { status: 'done' });
  // ⚠ `held` is task-blocks' outcome-note hold: the tick was a real statement
  // and is NOT thrown away, but the task stays in-progress until the write-up
  // lands. The device must be able to say so rather than show a completion that
  // silently did not happen.
  // `updated.held` is an OBJECT ({blockId, notePath, reason, …}), not a boolean —
  // read `.reason` off it, or the device shows "held" with nothing to explain it.
  const held = updated && updated.held ? updated.held : null;
  return {
    canonicalId: `task:${taskId}`,
    detail: JSON.stringify({
      held: !!held,
      heldReason: held ? (held.reason || 'awaiting write-up') : null,
      status: updated ? updated.status : null,
    }),
  };
}

/**
 * Dismiss a nudge.
 *
 * ⚠ A nudge that is no longer active is NOT a conflict, which is the opposite
 * call from `applyTodoComplete` and worth stating. Nudges auto-clear: a stale
 * one is swept by `clearStaleNudges`, and completing the underlying thing
 * clears it too. So a dismissal arriving for a nudge that has already gone is
 * the SYSTEM WORKING, not a device holding an intent about something the server
 * has never heard of. Reported as applied, with `alreadyGone` so the phone can
 * tell the difference rather than showing a failure for a tick that was fine.
 */
function applyNudgeComplete(payload) {
  const nudgeId = Number(payload.nudgeId);
  const active = db.getActiveNudges();
  const nudge = active.find((n) => n.id === nudgeId);

  if (!nudge) {
    return { canonicalId: `nudge:${nudgeId}`, detail: JSON.stringify({ alreadyGone: true }) };
  }

  db.completeNudge(nudgeId);
  // Same side effect the route has, so a dismissal from the watch and one from
  // the browser are the same event as far as the activity log is concerned.
  try { require('./activity').trackNudgeDismiss(nudge.type); } catch {}
  return {
    canonicalId: `nudge:${nudgeId}`,
    detail: JSON.stringify({ alreadyGone: false, type: nudge.type }),
  };
}

/**
 * Snooze a nudge type.
 *
 * ⚠ THE SNOOZE IS MEASURED FROM WHEN NICK TAPPED IT, NOT FROM WHEN IT LANDED.
 * This is the one operation in the outbox whose meaning is time-relative, and
 * replaying it naively is actively harmful: "snooze for 30 minutes" tapped at
 * 09:00 and delivered at 13:00 would mute the nudge until 13:30 — three and a
 * half hours of silence he never asked for, from an intent that expired long
 * ago. `snoozeNudge()` computes `Date.now() + minutes`, so it cannot be used
 * directly here.
 *
 * A snooze whose window has already passed is therefore SPENT: nothing is
 * written and the receipt says so. Idempotency comes free — the ledger stops a
 * replay before it reaches this function, and an expired one is a no-op anyway.
 */
function applyNudgeSnooze(payload, op) {
  const nudges = require('./nudges');
  const type = payload.type;
  const requested = Number(payload.minutes);
  const minutes = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.round(requested), 24 * 60)
    : 30;

  // The tap time the device recorded. Falling back to now when it is missing is
  // the only safe default: without it there is no way to tell a fresh tap from
  // a stale one, and treating an unknown as expired would silently drop a
  // snooze he just asked for.
  const tappedAtMs = op && op.createdAt ? Date.parse(op.createdAt) : NaN;
  const basisMs = Number.isFinite(tappedAtMs) ? tappedAtMs : Date.now();
  const untilMs = basisMs + minutes * 60 * 1000;

  if (untilMs <= Date.now()) {
    return {
      canonicalId: `snooze:${type}`,
      detail: JSON.stringify({ spent: true, minutes, reason: 'the snooze window had already passed' }),
    };
  }

  // Written directly rather than through snoozeNudge(), which measures from now
  // — see the warning above. The state key must match what getSnoozeState()
  // reads, so this stays in step with `nudges.js`.
  db.setState(`snooze_${type}`, String(untilMs));
  try { require('./activity').trackNudgeSnooze(type); } catch {}
  return {
    canonicalId: `snooze:${type}`,
    detail: JSON.stringify({
      spent: false,
      minutes,
      until: new Date(untilMs).toISOString(),
      // Named so a phone that queued for hours can explain a shortened snooze
      // rather than appearing to have ignored the request.
      measuredFrom: Number.isFinite(tappedAtMs) ? 'tap' : 'arrival',
    }),
  };
}

const APPLIERS = {
  [KINDS.CAPTURE_NOTE]: applyCaptureNote,
  [KINDS.CAPTURE_TODO]: applyCaptureTodo,
  [KINDS.TODO_COMPLETE]: applyTodoComplete,
  [KINDS.NUDGE_COMPLETE]: applyNudgeComplete,
  [KINDS.NUDGE_SNOOZE]: applyNudgeSnooze,
};

// ── The one entry point ──────────────────────────────────────────────────────

/**
 * Apply one operation, idempotently. SYNCHRONOUS — see the module note.
 *
 * @returns a receipt: { operationId, status, canonicalId, kind, receivedAt, detail }
 *   status is one of:
 *     applied         — the canonical record exists (first time)
 *     duplicate       — already applied; `canonicalId` is the SAME record
 *     rejected        — refused; a replay will be refused identically
 *     failed          — nothing was written; the device SHOULD retry
 *     needs-attention — interrupted mid-apply, or a conflict. Never replayed
 *                       automatically; the device keeps its copy.
 */
function applyOperation(deviceId, op, clientSchema) {
  const check = validateOperation(op);
  if (!check.ok) {
    return {
      operationId: op && typeof op.operationId === 'string' ? op.operationId : null,
      status: 'rejected',
      canonicalId: null,
      kind: op && op.kind ? String(op.kind).slice(0, 100) : null,
      receivedAt: nowIso(),
      detail: check.reason,
    };
  }

  const existing = readLedger(deviceId, op.operationId);
  if (existing) {
    if (existing.status === 'applied') return receiptFromRow(existing, 'duplicate');
    if (existing.status === 'rejected') return receiptFromRow(existing, 'rejected');
    if (existing.status === 'pending') {
      // Only reachable if the process died between the ledger write and the
      // apply. We cannot know whether the note landed, and re-applying would
      // duplicate it, so we refuse to guess and say so.
      return receiptFromRow(existing, 'needs-attention');
    }
    if (existing.status === 'needs-attention') return receiptFromRow(existing, 'needs-attention');
    // status === 'failed' — nothing was written, so replaying is correct.
  }

  const receivedAt = existing ? existing.received_at : nowIso();
  if (!existing) {
    db.run(
      `INSERT INTO mobile_sync_operations
         (device_id, operation_id, kind, client_schema, created_at, received_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [deviceId, op.operationId, op.kind, clientSchema || null, op.createdAt || null, receivedAt]
    );
  } else {
    db.run(
      `UPDATE mobile_sync_operations SET status = 'pending', detail = NULL
       WHERE device_id = ? AND operation_id = ?`,
      [deviceId, op.operationId]
    );
  }

  try {
    // The whole operation is passed alongside the payload because `nudge.snooze`
    // needs `createdAt` — when Nick TAPPED it, not when it arrived. Appliers
    // that do not care simply ignore the second argument.
    const { canonicalId, detail } = APPLIERS[op.kind](op.payload, op);
    db.run(
      `UPDATE mobile_sync_operations
         SET status = 'applied', canonical_id = ?, detail = ?, settled_at = ?
       WHERE device_id = ? AND operation_id = ?`,
      [canonicalId, detail || null, nowIso(), deviceId, op.operationId]
    );
    console.log(`[MobileSync] applied ${op.kind} ${op.operationId} → ${canonicalId}`);
    return {
      operationId: op.operationId,
      status: 'applied',
      canonicalId,
      kind: op.kind,
      receivedAt,
      settledAt: nowIso(),
      detail: detail || null,
    };
  } catch (e) {
    const conflict = e && e.conflict === true;
    const status = conflict ? 'needs-attention' : 'failed';
    db.run(
      `UPDATE mobile_sync_operations SET status = ?, detail = ?, settled_at = ?
       WHERE device_id = ? AND operation_id = ?`,
      [status, e.message, nowIso(), deviceId, op.operationId]
    );
    // The operation id and kind are safe to log; the payload is not.
    console.error(`[MobileSync] ${status} ${op.kind} ${op.operationId}: ${e.message}`);
    return {
      operationId: op.operationId,
      status,
      canonicalId: null,
      kind: op.kind,
      receivedAt,
      settledAt: nowIso(),
      detail: e.message,
    };
  }
}

/**
 * Apply a batch. Sequential and FAULT-ISOLATED — one bad operation must not
 * abandon the rest of a queue that has been waiting for signal (`bookAll()`'s
 * rule). Every operation gets a receipt, in the order it arrived.
 */
function applyBatch({ deviceId, operations, clientSchema } = {}) {
  if (!validateDeviceId(deviceId)) {
    return { ok: false, error: 'deviceId is required' };
  }
  if (!Array.isArray(operations)) {
    return { ok: false, error: 'operations must be an array' };
  }
  if (operations.length > MAX_OPERATIONS_PER_REQUEST) {
    return { ok: false, error: `at most ${MAX_OPERATIONS_PER_REQUEST} operations per request` };
  }

  const receipts = operations.map((op) => applyOperation(deviceId, op, clientSchema));
  const counts = receipts.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  return {
    ok: true,
    contract: CONTRACT_VERSION,
    acceptedAt: nowIso(),
    receipts,
    counts,
  };
}

/**
 * Diagnostics — what the outbox has seen. No payloads, no secrets: ids, kinds,
 * statuses and timestamps only, so this is safe to read from a phone.
 */
function diagnostics({ deviceId = null, limit = 50 } = {}) {
  const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = deviceId
    ? db.all(
      `SELECT device_id, operation_id, kind, status, canonical_id, received_at, settled_at
         FROM mobile_sync_operations WHERE device_id = ?
        ORDER BY id DESC LIMIT ?`,
      [deviceId, bounded]
    )
    : db.all(
      `SELECT device_id, operation_id, kind, status, canonical_id, received_at, settled_at
         FROM mobile_sync_operations ORDER BY id DESC LIMIT ?`,
      [bounded]
    );

  const byStatus = db.all(
    'SELECT status, COUNT(*) AS n FROM mobile_sync_operations GROUP BY status'
  ).reduce((acc, r) => { acc[r.status] = r.n; return acc; }, {});

  return {
    contract: CONTRACT_VERSION,
    supportedKinds: Array.from(KNOWN_KINDS),
    byStatus,
    recent: rows.map((r) => ({
      deviceId: r.device_id,
      operationId: r.operation_id,
      kind: r.kind,
      status: r.status,
      canonicalId: r.canonical_id,
      receivedAt: r.received_at,
      settledAt: r.settled_at,
    })),
  };
}

module.exports = {
  CONTRACT_VERSION,
  KINDS,
  KNOWN_KINDS,
  MAX_OPERATIONS_PER_REQUEST,
  applyBatch,
  applyOperation,
  diagnostics,
  // exported for tests — pure, no DB, no clock
  validateOperation,
  validateDeviceId,
};
