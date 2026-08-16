# Next session — #30, then the rest of the ranked queue

Continuing NEURO. Read `.claude/memory/handoff.md` (the **2026-08-17** entry is
newest, at the top), then `mistakes.md`, then `patterns.md`.

## Before touching anything

`git status`, and `git diff <file>` on **every file before you stage it**. Nick
runs 2–3 Claude sessions on this repo at once. A second session has been holding
the same ~14 files uncommitted for two days: `CLAUDE.md`, `routes/{capture,
imports,journal,standup}.js`, `services/{ai-provider,briefing,claude,
decision-engine,imports,nudges,scheduler,standup-session}.js`,
`prompt-parity.test.js`, `sara/app/src/views/{Focus,Tasks}.jsx`, plus
`services/sara-voice.js`. Explicit staging protects against unrelated *files*,
not unrelated *hunks*. "The file had been modified on disk since you last read
it" is a collision signal, not line-ending noise.

**Check whether their work has landed first.** If it has:
1. **`CLAUDE.md` is OWED for two sessions' work now** — #26/#40/#41/#42 *and*
   #119/#21/#38/#114/#59/#52/#107b. Write it, and diff it first.
2. Finish the #52 leftover: the 90-day-plan readers in `claude.js` and
   `standup-session.js` are now unreachable (working-memory no longer populates
   it) and should come out.

If it has NOT landed, route around them as this session did — a new router file
rather than editing theirs, and cut shared behaviour at the source.

## State — verified at the end of 17 Aug, not assumed

Local and Pi both at `163f760`, `main` in sync with origin. Pi suite **457/457**,
backend online, `unstable_restarts` 0. **Local 462 vs Pi 457 is the other
session's uncommitted `prompt-parity.test.js`, not a regression** — the same
5-test gap existed the day before (Pi 430 / local 435). Confirm it is still the
explanation rather than assuming.

Shipped: `8ff4e51` #119(+#21) · `de69070` #38 · `7008955` #114 · `b921d06` #59 ·
`163f760` #52/#107b.

### Two things to check FIRST

1. **Apple Health HRV has STILL not arrived.** 277,437 samples, 13 metrics, all
   activity — no `hrv`, no `heartRate`, no sleep, and most metrics have now
   reached Aug 2026. This no longer reads as "the backfill hasn't got there";
   it reads as **the FreeReps app not being configured to send vitals
   categories**. Check the app before writing any code. It gates #42's card,
   #43 and #44. If vitals do land, check units are `ms` and whether
   `/api/health/stress` leaves `calibrating` — the backfill brings history, so
   **#43 may close itself with no code**.
2. **#59 is built but dark until Nick creates a Backblaze key.**
   `backend/scripts/backup-offsite-SETUP.md` is the whole remaining job. Until
   then `watchdog` reports `offsite:unconfigured` at level `info`. **That is the
   designed state — do not "fix" it**, and do not treat it as a failure.

`escalation_alert_wide_seeded` may still be unset — `checkEscalationAlerts` is
`*/5 8-18 * * 1-5`, weekdays only. **Unset is NORMAL.**

## The task

**#30 — moving or cancelling a 1-2-1 in Outlook doesn't come back.**

`next-1-2-1-due` is stamped when NEURO books and nothing reconciles it after.
Move Heidi's 1-2-1 in Outlook, or cancel it, and the vault still says the old
date — so the Team card silently describes a meeting that isn't there. The
detector already solves the mirror image for `last-1-2-1` (read the notes, don't
trust the field); this is that lesson unapplied to the forward-looking date.

Cheap version from the row: on the nightly sweep, look for a
`1-2-1 — Nick / X` event near the stored date and correct it.

**Measure before building.** Specifically:
- How many of the 12 stored `1-2-1-booked` / `next-1-2-1-due` dates actually
  disagree with the calendar right now? If the answer is zero, this is
  speculative and should be ranked accordingly.
- `one-to-one-booking.findOneToOne` already matches an existing meeting by
  attendee email then subject — **reuse it, do not write a second matcher.**
- ⚠ `services/scheduler.js` is one of the other session's files. `syncPeopleNotes`
  already runs in the 10pm block, so hang the reconcile off `one-to-one-detect`
  and touch no scheduler.
- Remember the field split (16 Aug): `1-2-1-booked` is when the meeting IS,
  `next-1-2-1-due` is when one is OWED. `last-1-2-1` moves **only** when a note
  proves the meeting happened. A reconcile that moves `last-1-2-1` is wrong.

Then, in order: **#50** (`/api/todos/moscow` legacy path — small), **#36**
(people-gap review UI), **#31** (stale `Areas/1-2-1 Tracker.md`), then the NOVA
trio (#115/#117/#118) once #116 unblocks them.

## The rule this repo keeps relearning

**Every ticket premise has been wrong.** This session made it nine in a row:
#5 was already done (5 pending, not 929), #107's churn had already stopped by
itself, #106 was narrower than written, #21 understated itself (the "dead" file
was being executed against the live vault on every test run), and **#38 was
backwards** — its aliases would have re-created the ambiguity it claimed to fix,
and building it as written was a regression, not a feature.

**Measure before building. State what you measured. If the ticket is wrong, say
so and correct the tracker row.**

Three more that keep biting:
- **A green suite says nothing about routing.** Call any new route against the
  running server before calling it done.
- **A feature is not available until it is reachable from the UI.** A new view
  needs its Sidebar entry in the same commit.
- **An "already fixed" claim is a hypothesis too.** Cross-check every "Ready"
  row against `git log` and against the live DB before ranking it as outstanding.

## Deploy sequence

`git pull --ff-only` → `cd frontend && npm run build` → `cd ../backend && npm test`
→ `pm2 restart neuro-backend --update-env`.

- **Node 22.22.2 must be on PATH for any pm2 command** (Node 20 segfaults
  better-sqlite3): `export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH`.
- DB at `/mnt/data/nuero/backend/db/agent.db` — open `{readonly:true}` while the
  backend runs.
- `sara/app` deploys to Netlify (`sara-nickward`, base `sara/app`) on push to main.
  Verify against the LIVE bundle and check `VITE_BUILD_LABEL`.
- ⚠ **Before exempting any route from auth on the Pi, run `tailscale serve status`
  first.** pi5 serves `https://pi5.tailecb90f.ts.net` → `127.0.0.1:3001` with
  **Funnel ON** (public internet), and Tailscale proxies both tailnet and public
  traffic from `127.0.0.1`.
- ⚠ **`npm test` no longer touches the real vault** (#119) — keep it that way.
  Smoke scripts are `backend/scripts/smoke-*.js` and refuse to run without an
  explicit `OBSIDIAN_VAULT_PATH`; `no-live-vault-in-tests.test.js` pins it.
