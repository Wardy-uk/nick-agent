# Handoff — 30 Aug 2026: Phase 2, the Neuro Mobile contract

**Commits:** `c0e66a3` (the build), `bf6d341` (CLAUDE.md), `c46e70b` (the two
review fixes), `2c1ff11` (mistakes log). **Not pushed** — you said commits, not
pushes. Not deployed to the Pi either.
**Tests:** backend 1406 pass / 0 fail (73 new). sara/backend 82 pass / 0 fail.
Both frontends build.

## Review round 1 — both findings fixed (`c46e70b`)

**P0, and it was worse than a mobile bug.** `capture-store.writeNote` named
files from a SECOND-precision timestamp, so two notes written in one tick got
the same path and the second silently overwrote the first — with the ledger
acknowledging BOTH as `applied` against the same canonical id. Reachable from
the web route all along; the outbox made it ordinary, because a drained queue
replays several notes into the same tick. Fixed with the `wx` flag
(O_CREAT|O_EXCL, atomic) plus a bounded `-2`/`-3` suffix retry — not
`existsSync`-then-write, which is a race with a gap in the middle. Only EEXIST
retries; a permissions error surfaces as itself.

**P1.** `Now.tick` read `flush().confirmed`, an aggregate over the whole queue,
to describe ONE completion — so any older capture landing in the same round trip
printed "Done" over a rejected or HELD completion. `Capture.submit` had the
milder version. `flush()` now returns `receipts` keyed by operationId (every
early return included, so callers can index without guarding) and
`outcomeFor(receipt)` gives `{state, done, message}` — confirmed / held /
refused / pending. **`held` is not `done`** and says why.

Both guards were proved by reintroducing the bug and watching them fail: three
collision tests, and a source pin that stops either view drifting back to the
aggregate counts.
**Full contract doc:** `docs/mobile-contract.md`.

## What was built

| Gate | State |
|---|---|
| 1 — Contract | done: `/api/mobile/v1/{nick-now, sync/operations, readiness, sync/diagnostics}` |
| 2 — Offline core | done: IndexedDB store + outbox + snapshot cache, driven end to end |
| 3 — Mobile surface | done: Capture / Now / Review as primary modes |
| 4 — Hardening | done: contract, idempotency, migration and routing tests; docs |

## The decisions worth arguing with

**1. `Now` is the root, and the SARA Surface moved to "More".** The brief says
three primary modes; CLAUDE.md says the Surface is load-bearing and deliberate.
Both are honoured: the Surface is **not retired**, is still what notification
routing lands on, and is one tap away. But the app now opens on `Now`. If you
want the Surface back as the root, it is one line in `App.jsx` (`useState(() =>
… || 'now')`).

**2. `todo.complete` accepts a NEURO task id only.** SARA's `completeTask.js`
knows three owners (`task_id` → `ms_id` → `filePath`+`lineNumber`). Only the
first has an identity that survives sitting in a queue for four hours — a line
number recorded this morning can name a different row by the time it replays,
which is exactly the 27 Aug bug with a delay bolted on. Microsoft and vault ticks
still work **online**, through the existing routes. Tasks the phone cannot tick
offline are marked `completableOffline:false` and the button is disabled with a
reason, rather than queuing something that will fail later.

**3. Feature capture stays online-only.** `feature-tracker` appends a row to a
vault markdown file with no idempotency key, so a replay writes it twice.
Queueing it would have been the easy thing and the wrong one. Capture says so in
words when there is no signal, and keeps the text.

**4. `fake-indexeddb` is a new backend devDependency.** The alternative was
source assertions over the migration path, and the migration path is the one
piece of client code whose failure destroys the only copy of something you typed.
It buys a real test: put an unsent capture in a v1 database, reopen it through
the module, assert it is still there.

**5. One commit, not several.** The contract, the client and the IA are one
change — a half-landed version of it has a phone talking to endpoints that do
not exist. `git show c0e66a3 --stat` is the review surface.

## What I did NOT do

- **No new database.** `mobile_sync_operations` is a table in `agent.db`,
  additive via `schema.sql`. No migration to run beyond a restart.
- **No push, no proactive workflows, no background agent.** Explicit non-goals.
- **No arbitrary two-way sync**, no conflict UI, no legacy dashboard rewrite.
- **The Phase 1 SARA capture bridge is untouched.**

## ⚠ Concurrency note — read before you deploy

Another session has uncommitted work in this tree (notion-sync: `backend/routes/
notion-sync.js`, `backend/services/notion-sync/`, the frontend panel,
`.env.example`, `scheduler.js`, `frontend/src/{App.jsx,components/Sidebar.jsx}`).

Their `app.use('/api/notion-sync', …)` line in `server.js` sits in the same hunk
as mine. **I staged only my three lines** (`git apply --cached` with a hand-cut
patch), so `HEAD:backend/server.js` mounts `/api/mobile` and **not**
`/api/notion-sync` — committing theirs would have made the app crash on boot for
anyone pulling, because the route file is untracked.

**Consequence for the deploy:** the Pi will get `/api/mobile` and will not get
`/api/notion-sync` until that session commits its own work. That is correct, but
it means the deployed `server.js` will differ from this working tree.

## Residual risks

1. **iOS background sync does not exist.** Replay is foreground-only — launch,
   returning to the app, coming back online, after a capture, "Send now". A
   capture made offline sits on the phone until the app is opened with signal.
   This is a Safari limitation, not a shortcut; it is stated in the UI and in the
   doc. A native app is the only thing that changes it, and that is a non-goal.
2. **iOS can evict IndexedDB.** The outbox is durable against app restarts and
   upgrades, **not** against the OS reclaiming storage or the user clearing site
   data. Nothing warns before eviction, because nothing can.
3. **Not tested on the actual phone.** Everything here is proven under node and
   in a build; the last time a util was called "proven" without naming the
   device, three deploys went into chasing it (15 Aug). Worth doing on the phone:
   the Freshness banner in aeroplane mode, the queue surviving a swipe-away, and
   whether the four-button primary row reads well at 390px.
4. **`event:derived:` ids are content-derived.** A meeting renamed in Outlook
   gets a new id. Nothing depends on that today (they are display-only), but a
   future feature that stores one will be surprised.
5. **The v1→v2 store migration is not driven by a test**, because there is no v2
   yet — only a source assertion that the upgrade body contains no
   `deleteObjectStore` or `.clear(`. When you write a v2 branch, drive it for
   real in `mobile-store.test.js`.
6. **`capture.note` idempotency depends on the ledger, not on content.** Two
   genuinely different captures with identical text create two notes, correctly.
   But a `pending` row left by a crash mid-write is reported `needs-attention`
   and the user decides — there is no way to know whether the file landed.

## Deploy notes (unchanged, and they still bite)

- `export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH` before any pm2
  command.
- Never pipe a deploy step to `head`/`tail`; confirm with `git log --oneline -1`
  **on the Pi**.
- Scratch scripts go in `/tmp` on the Pi, never the repo tree.
- `sara/app` ships via Netlify on push to main (`sara-nickward` →
  sara.nickward.co.uk). The backend must be deployed **first**, or the phone
  fetches `/api/mobile/v1/nick-now` from a server that does not serve it — the
  Freshness banner will say "I couldn't ask", which is honest but pointless.

## Next, if you want it

- Wire `Now`'s task tick to the Microsoft/vault owners **when online** (the
  outbox path is already there for NEURO tasks; the other two just need the
  existing routes called directly with an "online only" label).
- A `sara/widget` read of `/api/mobile/v1/nick-now` instead of `/api/attention`,
  so the fourth renderer also gets the sourced/timestamped payload.
- The parked "one interface — the chat" direction is untouched and still parked.
