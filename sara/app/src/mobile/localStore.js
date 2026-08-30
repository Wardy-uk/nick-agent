// Neuro Mobile local store — device-local PWA storage (IndexedDB).
//
// ⚠ WHAT THIS IS, ACCURATELY: an ordinary IndexedDB database in the browser
// profile of this installed PWA. It is NOT encrypted. iOS may evict it if the
// app is unused for long enough or storage runs low. Anyone with the unlocked
// phone can read it through the browser's own tooling. Describe it that way to
// the user; a claim of encryption we do not implement is worse than the plain
// truth, because it invites him to put things here he otherwise would not.
//
// ⚠ NO SECRETS LIVE HERE. The PIN and any API token stay where they already
// are (localStorage, written by `api.js`) — moving them into a store the
// snapshot cache also lives in would put a credential next to bulk data that
// gets exported, cleared and migrated by this file.
//
// Raw IndexedDB rather than a wrapper library: the migration path is the part
// of this that must never go wrong, and an explicit `onupgradeneeded` that can
// be read top to bottom is worth more here than a smaller call site.

const DB_NAME = 'neuro-mobile';

// ⚠ Bump this ONLY alongside a matching branch in `upgrade()` below. The rule
// that must survive every future bump: an upgrade may CREATE stores and indexes
// and may rewrite the cache, but it must NEVER delete or clear `operations`.
// That store holds captures that have not reached NEURO yet — an app upgrade
// that discards them destroys the one remaining copy of something Nick typed,
// which is precisely what capture exists to prevent.
export const SCHEMA_VERSION = 1;

export const STORE = {
  KV: 'kv',
  OPERATIONS: 'operations',
  RECEIPTS: 'receipts',
};

export const KEY = {
  SNAPSHOT: 'snapshot',
  DEVICE_ID: 'deviceId',
  SETTINGS: 'settings',
  LAST_SYNC: 'lastSync',
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion, request.transaction);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A version change requested by ANOTHER tab must not leave this one
      // holding a blocked connection forever.
      db.onversionchange = () => { try { db.close(); } catch {} dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab'));
  }).catch((e) => {
    // Do not memoise a failure — a private window, a full disk or a transient
    // error must not permanently disable local storage for the session.
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function upgrade(db, oldVersion) {
  // v0 → v1: initial shape.
  if (oldVersion < 1) {
    if (!db.objectStoreNames.contains(STORE.KV)) {
      db.createObjectStore(STORE.KV, { keyPath: 'key' });
    }
    if (!db.objectStoreNames.contains(STORE.OPERATIONS)) {
      const ops = db.createObjectStore(STORE.OPERATIONS, { keyPath: 'operationId' });
      ops.createIndex('status', 'status', { unique: false });
      ops.createIndex('createdAt', 'createdAt', { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE.RECEIPTS)) {
      db.createObjectStore(STORE.RECEIPTS, { keyPath: 'operationId' });
    }
  }
  // Future versions append a branch here. They must not touch STORE.OPERATIONS
  // beyond adding indexes — see the note on SCHEMA_VERSION.
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

// ── Availability ─────────────────────────────────────────────────────────────

/**
 * Whether local persistence actually works, verified by a real round trip.
 * "IndexedDB is defined" is not the same claim as "a write lands" — a private
 * window defines it and then throws on the first transaction.
 */
export async function checkAvailable() {
  try {
    const db = await openDb();
    const t = tx(db, [STORE.KV], 'readwrite');
    await promisify(t.objectStore(STORE.KV).put({ key: '__probe', value: 1, at: Date.now() }));
    await promisify(t.objectStore(STORE.KV).delete('__probe'));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Key/value ────────────────────────────────────────────────────────────────

export async function kvGet(key) {
  const db = await openDb();
  const row = await promisify(tx(db, [STORE.KV], 'readonly').objectStore(STORE.KV).get(key));
  return row ? row.value : null;
}

export async function kvSet(key, value) {
  const db = await openDb();
  await promisify(
    tx(db, [STORE.KV], 'readwrite').objectStore(STORE.KV).put({ key, value, at: Date.now() })
  );
  return true;
}

// ── Device identity ──────────────────────────────────────────────────────────

/**
 * A stable, random per-install id. It identifies the DEVICE for idempotency and
 * nothing else — it is not a credential, carries no personal data, and NEURO
 * uses it only to scope operation ids.
 */
export async function getDeviceId() {
  const existing = await kvGet(KEY.DEVICE_ID);
  if (existing) return existing;
  const id = `mob-${randomId()}`;
  await kvSet(KEY.DEVICE_ID, id);
  return id;
}

export function randomId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {}
  // Last resort. Collision risk is the reason this is last, not first: two
  // operations sharing an id would make one of them invisible.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── Snapshot cache ───────────────────────────────────────────────────────────

/**
 * Cache the last SUCCESSFUL snapshot, with the time it was fetched. The stored
 * `fetchedAt` is what lets the UI say "as of 11:42" honestly — the payload's own
 * `generatedAt` is the server's clock and answers a slightly different question.
 */
export async function saveSnapshot(payload) {
  return kvSet(KEY.SNAPSHOT, { fetchedAt: new Date().toISOString(), payload });
}

export async function readSnapshot() {
  const row = await kvGet(KEY.SNAPSHOT);
  if (!row || !row.payload) return null;
  return row;
}

// ── Operations (the outbox) ──────────────────────────────────────────────────

export const OP_STATUS = {
  QUEUED: 'queued',
  SENDING: 'sending',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  NEEDS_ATTENTION: 'needs-attention',
};

export async function putOperation(op) {
  const db = await openDb();
  await promisify(tx(db, [STORE.OPERATIONS], 'readwrite').objectStore(STORE.OPERATIONS).put(op));
  return op;
}

export async function listOperations() {
  const db = await openDb();
  const rows = await promisify(
    tx(db, [STORE.OPERATIONS], 'readonly').objectStore(STORE.OPERATIONS).getAll()
  );
  return (rows || []).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function deleteOperation(operationId) {
  const db = await openDb();
  await promisify(
    tx(db, [STORE.OPERATIONS], 'readwrite').objectStore(STORE.OPERATIONS).delete(operationId)
  );
}

export async function putReceipt(receipt) {
  const db = await openDb();
  await promisify(tx(db, [STORE.RECEIPTS], 'readwrite').objectStore(STORE.RECEIPTS).put(receipt));
}

export async function listReceipts(limit = 30) {
  const db = await openDb();
  const rows = await promisify(
    tx(db, [STORE.RECEIPTS], 'readonly').objectStore(STORE.RECEIPTS).getAll()
  );
  return (rows || [])
    .sort((a, b) => String(b.settledAt || b.receivedAt || '').localeCompare(String(a.settledAt || a.receivedAt || '')))
    .slice(0, limit);
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

/**
 * What is on this device, so the user can see it rather than take it on trust.
 */
export async function describeStorage() {
  const out = {
    schemaVersion: SCHEMA_VERSION,
    available: false,
    encrypted: false, // stated explicitly — see the header note
    snapshotFetchedAt: null,
    operations: { queued: 0, failed: 0, needsAttention: 0, total: 0 },
    receipts: 0,
    estimate: null,
  };
  const probe = await checkAvailable();
  out.available = probe.ok;
  if (!probe.ok) { out.error = probe.error; return out; }

  const snap = await readSnapshot();
  out.snapshotFetchedAt = snap ? snap.fetchedAt : null;

  const ops = await listOperations();
  out.operations.total = ops.length;
  out.operations.queued = ops.filter((o) => o.status === OP_STATUS.QUEUED || o.status === OP_STATUS.SENDING).length;
  out.operations.failed = ops.filter((o) => o.status === OP_STATUS.FAILED).length;
  out.operations.needsAttention = ops.filter((o) => o.status === OP_STATUS.NEEDS_ATTENTION).length;
  out.receipts = (await listReceipts(500)).length;

  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      out.estimate = { usage: est.usage ?? null, quota: est.quota ?? null };
    }
  } catch {}

  return out;
}

/**
 * Clear local data.
 *
 * ⚠ REFUSES by default while anything is still waiting to reach NEURO. Clearing
 * then would delete the only copy of a capture that has not been written
 * anywhere else — the exact loss this whole layer exists to prevent. `force`
 * makes it possible, and the caller is expected to have said out loud what is
 * about to be lost.
 *
 * The cache and the receipts are always safe to drop: both are derived from
 * NEURO and rebuild on the next successful fetch.
 */
export async function clearLocalData({ force = false } = {}) {
  const db = await openDb();
  const ops = await listOperations();
  const unsent = ops.filter((o) => o.status !== OP_STATUS.CONFIRMED);
  if (unsent.length && !force) {
    return { ok: false, refused: 'unsent-operations', unsent: unsent.length };
  }

  const stores = force ? [STORE.KV, STORE.RECEIPTS, STORE.OPERATIONS] : [STORE.KV, STORE.RECEIPTS];
  const t = tx(db, stores, 'readwrite');
  for (const name of stores) {
    // The device id lives in KV and is deliberately cleared with it: a fresh
    // install identity after a wipe is correct, and NEURO scopes operation ids
    // per device, so nothing is orphaned by it.
    await promisify(t.objectStore(name).clear());
  }
  return { ok: true, clearedOperations: force ? ops.length : 0 };
}
