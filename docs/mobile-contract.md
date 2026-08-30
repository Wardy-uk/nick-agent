# The Neuro Mobile contract (Phase 2)

**Status:** built 30 Aug 2026. Versioned in the path (`/api/mobile/v1/…`).
**Owner:** NEURO. The device is a bounded local replica and an outbox, never a
second brain.

---

## Why the version is in the path

The phone caches responses on disk and replays operations across app upgrades. A
client running an old bundle must keep talking to the endpoint it was written
against, rather than silently receiving a newer shape it will mis-parse. The
payload also carries its own `schema` string, so a cached snapshot sitting in
IndexedDB can be identified without knowing which URL fetched it.

## Auth

The app-level PIN / `X-NEURO-API-TOKEN` middleware in `server.js`. Nothing under
`/api/mobile` is exempted, and a test pins that it stays out of the exemption
list. No endpoint here logs capture text, a PIN or a token.

---

## `GET /api/mobile/v1/nick-now`

The compact mobile working set. Three rules run through the whole payload:

1. **Every item carries a stable canonical `id`, a `source` and an `updatedAt`.**
   A cached item with no provenance cannot be labelled honestly a day later.
2. **A section that could not be READ is `{known:false, why}` — never an empty
   list.** "I couldn't look" and "there is nothing" are different facts.
3. **Nothing is a bulk dump.** Retrieval is *pointers* — title, path, updated —
   never private source content.

```jsonc
{
  "schema": "neuro.mobile.nick-now/1",
  "contract": "neuro.mobile/1",
  "generatedAt": "2026-08-30T09:14:02.113Z",

  "context": { "activity": "steady", "confidence": {...}, "duty": {...} },

  "focus":     { "known": true, "session": null, "item": {...}, "nextStep": "…" },
  "agenda":    { "known": true, "scope": "today", "items": [...], "next": {...} },
  "followUps": { "known": true, "total": 4, "quiet": false, "dropped": 1, "items": [...] },
  "tasks":     { "known": true, "total": 148, "items": [...] },
  "captures":  { "known": true, "items": [...] },
  "people":    { "known": true, "items": [...] },
  "retrieval": { "known": true, "note": "pointers only — request the body from NEURO when online", "items": [...] },

  "weeklyTarget": {...},
  "readiness":    {...},

  "poolAvailable": true,
  "sources": [ { "id": "agenda", "state": "live", "why": null }, … ],
  "gaps":    [ { "input": "presence", "why": "no presence entity reported" } ]
}
```

### Canonical id forms

| Prefix | Example | Notes |
|---|---|---|
| `task:` | `task:412` | A NEURO-owned task row. |
| `capture:` | `capture:Imports/2026-08-30-…md` | Vault-relative path. ⚠ The filename is unique to the SECOND; `capture-store.writeNote` writes with the `wx` flag (O_CREAT\|O_EXCL, atomic) and suffixes `-2`, `-3` on EEXIST, so two captures inside one tick get two files. Before that, the second silently overwrote the first and BOTH were acknowledged `applied` against the same id. |
| `attention:` | `attention:todo-overdue-top` | A decision-engine card. |
| `event:derived:` | `event:derived:2026-08-30T14:00:00:1-2-1 Hope` | ⚠ Derived from start + subject, because `agendaFor` carries no Graph id. Deterministic and stable across refreshes; **not** a Graph id and must never be used to PATCH. |
| `person:` | `person:Hope Goodall` | Full name only. |

### Bounds

`tasks` 12 · `followUps` 5 · `agenda` 6 · `captures` 8 · `people` 4 ·
`retrieval` 8. `tasks.total` reports the real figure so no count on screen is
the capped one.

### The states a client must keep apart

| State | Means | Must NOT be rendered as |
|---|---|---|
| `sources[x].state = "live"` | read just now | — |
| `known: false` on a section | NEURO could not read it | an empty section |
| `poolAvailable: false` | the decision pool was unreachable | "nothing pending" |
| `followUps.quiet: true` | in a meeting / off duty | broken |
| `items: []` with `known: true` | genuinely nothing | — |
| no cached snapshot on device | never fetched here | "your day is clear" |
| `minutesAway: null` | no answer | `0m` — `Number(null)` is `0` |

---

## `POST /api/mobile/v1/sync/operations`

The append-only, idempotent outbox.

```jsonc
// request
{
  "deviceId": "mob-2f0c…",              // generated on-device, stable per install
  "clientSchema": "neuro.mobile.client/1",
  "operations": [
    {
      "operationId": "9e1c…",            // generated ON-DEVICE, before the network
      "kind": "capture.note",
      "createdAt": "2026-08-30T08:58:11.000Z",
      "payload": { "title": "Optional", "content": "The thought" }
    }
  ]
}

// response — 200, one receipt per operationId, in the order sent
{
  "ok": true,
  "contract": "neuro.mobile/1",
  "acceptedAt": "2026-08-30T09:14:02.113Z",
  "receipts": [
    { "operationId": "9e1c…", "status": "applied", "canonicalId": "capture:Imports/…md",
      "kind": "capture.note", "receivedAt": "…", "settledAt": "…", "detail": "{\"bytes\":142}" }
  ],
  "counts": { "applied": 1 }
}
```

### Supported kinds (a CLOSED set)

| Kind | Payload | Canonical record |
|---|---|---|
| `capture.note` | `{ content, title? }` | a note in `Imports/` |
| `capture.todo` | `{ text, priority?, moscow?, due?, domain? }` | a row in `tasks` |
| `todo.complete` | `{ taskId }` | that task, set done |

An unknown kind is **refused locally**, never passed through — the `neuroCapture`
bridge's "a named door, not an open proxy" rule.

⚠ `todo.complete` accepts a **NEURO task id only**. The other two owners a mobile
tick can have (a Microsoft mirror, a vault `filePath`+`lineNumber`) work online
through `completeTask.js` but are *not* unambiguous offline: a line number
recorded hours ago can name a different row by the time it replays. That is the
27 Aug bug where a hand-typed line number moved another task's progress.

### Receipt statuses

| Status | Means | Client should |
|---|---|---|
| `applied` | the canonical record now exists | drop from the outbox, show confirmed |
| `duplicate` | already applied; `canonicalId` is the SAME record | drop from the outbox, show confirmed |
| `rejected` | refused; a replay is refused identically | **stop retrying**, surface with the text intact |
| `failed` | nothing was written | retry — safe by construction |
| `needs-attention` | a conflict, or interrupted mid-apply | **never auto-retry**; keep the text, ask the user |

A batch containing rejections still answers **200**. A non-2xx would make the
client discard receipts it needs in order to stop retrying.

⚠ **A receipt is per operation, and so is the outcome.** `flush()` drains the
whole queue, so its aggregate counts (`confirmed`, `failed`, `needsAttention`)
describe the round trip and **never** any one operation — reading
`confirmed >= 1` after queueing a completion says "Done" whenever any older
capture happened to land in the same flush. `flush()` returns
`receipts[operationId]`; `outcomeFor(receipt)` turns one into
`{state, done, message}` with four states — `confirmed` / `held` / `refused` /
`pending`. **`held` is not `done`**: `task-blocks` holds a completion until the
outcome note is written, so the tick was recorded and the task is still open. A
source test pins that no view reads the aggregate counts.

### Idempotency, and why it holds

The ledger is `mobile_sync_operations`, `UNIQUE(device_id, operation_id)`. The
device owns the identity of an *intent*; NEURO owns the *record* it produces.

⚠ The applier is **synchronous** from the ledger read to the ledger write.
better-sqlite3 is synchronous and this is one Node process, so that
read-modify-write genuinely cannot interleave — a real mutex, and **only valid
in-process** (`plaud-admin-blocks`' rule). Do not make `applyOperation` async.

A `pending` row can only survive a crash *mid-apply*. It is never replayed: the
note may or may not have landed, and re-applying would duplicate it. It is
reported `needs-attention` and the device keeps its copy.

⚠ **No capture text is stored in the ledger.** The payload lives in the vault or
the tasks table, which are its canonical homes. A copy in a ledger is a second
store, and mobile stores nothing NEURO owns.

---

## The conflict rule

Deliberately small, and documented because a client has to be written against it:

1. **New captures are append-only and idempotent.** There is nothing to conflict
   with — the record does not exist until the operation lands.
2. **Existing canonical records remain server-owned.** The one mutation in this
   phase (`todo.complete`) is idempotent by nature and carries no content.
3. **Where a mutation cannot be applied cleanly, local intent is PRESERVED and
   reported as needing attention.** Server data is never overwritten and the
   device's copy is never discarded.

There is no merge, and no conflict-resolution UI. A conflict is a thing Nick is
*told about*, not a dialog he has to arbitrate.

Two knock-ons worth knowing:

- `todo.complete` against a task NEURO does not have → `needs-attention`. It does
  not invent the task and it does not silently succeed.
- `todo.complete` against a task held by `task-blocks`' outcome-note rule stays
  `applied`, with `detail.held = true` and a reason. The tick was a real
  statement; the completion waits for the write-up. The device must **say so**
  rather than show a completion that did not happen.

---

## `GET /api/mobile/v1/readiness`

Reports what was **observed**, not a configured boolean (#65 — "configured" was
never the same claim as "works"). Names of things, states, counts. No secrets.

## `GET /api/mobile/v1/sync/diagnostics`

Operation ids, kinds, statuses and timestamps for recent operations, plus a
`byStatus` roll-up. Optional `?deviceId=`. Pinned by a test that asserts capture
text never appears in it.

---

## The device side

`sara/app/src/mobile/localStore.js` · `outbox.js` · `useNickNow.js`

### What the local store is, accurately

An ordinary **IndexedDB** database (`neuro-mobile`, schema v1) in the installed
PWA's browser profile. **It is not encrypted.** iOS may evict it if the app goes
unused or storage runs low. Anyone with the unlocked phone can read it.

**No secrets live there.** The PIN stays in `localStorage`, written by `api.js`,
and a test pins that the store module never touches it.

Stores: `kv` (snapshot cache, device id, settings), `operations` (the outbox),
`receipts`.

⚠ **Migration rule:** an upgrade may create stores and indexes and may rewrite
the cache, but it must **never delete or clear `operations`** — that store holds
captures that have not reached NEURO, so an upgrade that discards them destroys
the only copy of something Nick typed. Pinned two ways: a real fake-IndexedDB
test that puts an unsent capture in a v1 database and reopens it through the
module, and a source assertion that the upgrade body contains no
`deleteObjectStore` or `.clear(`.

### Retention and caching limits

| What | Kept | Cleared by |
|---|---|---|
| Snapshot | the single latest successful fetch | "Clear cached data", or overwritten |
| Operations | until confirmed, discarded, or force-cleared | confirmation, explicit discard |
| Receipts | last 30 shown; all kept until cleared | "Clear cached data" |

"Clear cached data" **refuses** while anything is unsent, and says how many.
"Clear everything, including unsent" is the deliberate override and reports what
it destroyed.

### iOS PWA capability statement

- **Supported:** cached UI (service worker precache), IndexedDB, the outbox
  surviving a reload, a cold start and an app upgrade.
- **NOT guaranteed:** any background work. Safari does not implement Background
  Sync, and a PWA service worker is not kept alive to drain a queue. **Replay is
  foreground-only** — app launch, returning to the foreground, coming back
  online, after a capture, or an explicit "Send now".
- **Also not possible:** iOS cannot read the Obsidian vault filesystem or a local
  Notion workspace. NEURO ingests and indexes those; the PWA syncs only the
  derived working set above.
- Storage may be evicted by the OS. The outbox is durable against app restarts,
  **not** against a user clearing site data or iOS reclaiming storage.

---

## Backup and recovery of canonical data

Mobile holds nothing that needs backing up — every confirmed operation is in
NEURO. NEURO's own canonical data is covered by the existing arrangement:

- **Local:** `backend/scripts/backup-data.sh`, 28 rotated copies of `agent.db`
  under `/mnt/data/backups/nuero-db`.
- **Off-site:** nightly root cron 02:20, rclone `crypt` → Backblaze B2
  `pi5-neuro-offsite`, filenames and directory names encrypted, watchdog
  monitored. Ships the half that cannot be regenerated (vault, Home Assistant,
  one current `agent.db`, syncthing config). Setup and the two outstanding items
  are in `backend/scripts/backup-offsite-SETUP.md`.
- `mobile_sync_operations` lives in `agent.db` and is therefore covered by both.
  Losing it would not lose data — it would only mean a replayed operation could
  create a second record, which is why it must not be excluded from the backup.

---

## Tests

| File | Covers |
|---|---|
| `backend/services/mobile-sync.test.js` | validation, idempotency, replay, conflict rule, batch isolation, no-secrets-in-diagnostics, same-second filename collisions (21) |
| `backend/services/mobile-snapshot.test.js` | the three payload rules, section states, null-not-zero (16) |
| `backend/routes/mobile.test.js` | real HTTP: routing, replay over the wire, 200-with-rejections, auth exemption (8) |
| `backend/services/mobile-store.test.js` | the device store against fake-indexeddb: persistence across reopen, migration invariant, clear refusal (14) |
| `backend/services/mobile-outbox-e2e.test.js` | the real outbox against real HTTP: offline capture → reload → exactly once, per-operation receipts, held vs done, and a source pin against reading the aggregate (14) |
