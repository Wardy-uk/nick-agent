# Next session — check the health data first, then #30

Continuing NEURO. Read `.claude/memory/handoff.md` (the **2026-08-17** entry is
newest, at the top), then `mistakes.md`, then `patterns.md`.

## Before touching anything

`git status`, and `git diff <file>` on **every file before you stage it**. Nick
runs 2–3 Claude sessions on this repo at once. A second session has held the same
~14 files uncommitted for two days: `CLAUDE.md`, `routes/{capture,imports,journal,
standup}.js`, `services/{ai-provider,briefing,claude,decision-engine,imports,
nudges,scheduler,standup-session}.js`, `prompt-parity.test.js`,
`sara/app/src/views/{Focus,Tasks}.jsx`, plus `services/sara-voice.js`. Explicit
staging protects against unrelated *files*, not unrelated *hunks*. "The file had
been modified on disk since you last read it" is a collision signal, not
line-ending noise.

**If their work has landed:**
1. **`CLAUDE.md` is OWED for three sessions now** — #26/#40/#41/#42, then
   #119/#21/#38/#114/#59/#52/#107b. Write it, and diff it first.
2. Finish the #52 leftover: the 90-day-plan readers in `claude.js` and
   `standup-session.js` are unreachable now that `working-memory` no longer
   populates it, and should come out.

If it has NOT landed, route around them as the last session did — a new router
file rather than editing theirs, and cut shared behaviour at the source.

## State — verified 16 Aug, not assumed

Local and Pi at `2db33e0`, `main` in sync with origin. Pi suite **457/457**,
backend online, `unstable_restarts` 0. **Local 462 vs Pi 457 is the other
session's uncommitted `prompt-parity.test.js`, not a regression** — confirm that
is still the explanation rather than assuming it.

Shipped: `8ff4e51` #119(+#21) · `de69070` #38 · `7008955` #114 · `b921d06`+`2db33e0`
#59 · `163f760` #52/#107b.

---

# 1. THE HEALTH DATA — the sync has finished. Check what actually landed.

**This is the first job.** The 24-month Apple Health backfill completed on the
evening of 16 Aug. Inserts confirmed stopped (count stable across 20s). Measured
at completion — these are facts, not expectations:

| | Before (16 Aug afternoon) | After (sync complete) |
|---|---|---|
| Samples | 277,437 | **1,048,465** |
| Distinct metrics | 13 | **66** |
| DB size | 235 MB | **447 MB** |

**Everything #40/#41/#42/#43 were waiting on is now present:**

- `heartRate` **479,296** samples · `hrv` **42,564** · `respiratoryRate` 35,121 ·
  `blood_oxygen_saturation` 21,163 · sleep stages core/rem/deep/awake · all
  current to 16:32 on 16 Aug.
- **HRV units are fine.** 42,564 samples, none ≤ 0, only 23 below 5ms, mean
  23.3ms, max 175 — plausible ms values, and the parser's unit rule held.
- **`/api/health/stress` LEFT `calibrating` on arrival**: `status:"ok"`,
  score **19 ("Very low")**, hrv 35.9, `baselineDays: 15`. So **#43 closed itself
  with no code**, exactly as the parked row predicted — the backfill brought the
  history with it, so a calibrating placeholder was never served to Nick.
  Tracker updated; #41 confirmed live.

### What to actually check, in this order

**a. The sleep rollup — a real finding, captured as #122.**
Every night carries BOTH a staged breakdown from the Watch (core/deep/rem, many
samples) AND a single whole-night `sleep_asleep_unspecified_hours` sample from a
second source. 14 Aug: core 6.23 + deep 0.62 + rem 0.53 = **7.38h staged**,
beside ONE unspecified sample of **8.92h**. `GET /api/health/sleep` returns only
`awake` + `asleep_unspecified` in `stages` and takes `asleepHours` from the
unspecified value — **so the staged breakdown never reaches the card built for
it**, and 16 Aug reads 10.42h asleep.
Two things to settle: prefer the staged source when it exists, and make sure
nothing ever sums both (that double-counts a night to ~2x). **The ingest is
fine** — this is a read-time rollup choice, the same shape as the wake-night rule
already applied at read time. Do not "fix" the parser.

**b. Look at the card, do not just call the endpoint.** Sidebar → **Insights**,
top of the panel. #42's rule is that the card must never look more certain than
the service: `efficiency: null` and `inBedHours: 0` are BY DESIGN (no "In Bed"
data — never a confident 100%), and `currentHr: null` is by design too (the HR
term only counts if under 60 min old). None of those are bugs. Check the card
renders the real score sensibly now that it has one.

**c. Is a score of 19 believable?** It is the first real reading. `baselineMs: 17`
against a current 35.9 gives `deviation: 1.74`, i.e. HRV well above baseline →
low stress. Sanity-check it against a day Nick remembers before trusting the
curve; retuning should fail `stress-score.test.js`.

**d. Two knock-ons nobody has costed yet.**
- The DB nearly doubled (235 → 447 MB). `backup-data.sh` keeps **28** rotated
  copies, so `/mnt/data/backups/nuero-db` heads for **~12.5 GB** and grows with
  every sync. Locally survivable (422 GB free) but worth a decision.
- The off-site payload grows with it: ~2.05 GB → ~2.26 GB against B2's **10 GB**
  free tier. Fine now; the trend is the thing to watch, and the lifecycle rule
  is what stops versions compounding it.

**e. Does anything else read this data?** 66 metrics is a lot of new surface and
almost nothing consumes it. Resist building for it — #43 just demonstrated that
waiting can be the right answer.

---

# 2. Then the build: #30 — Outlook moves don't come back

`next-1-2-1-due` is stamped when NEURO books and nothing reconciles it after.
Move Heidi's 1-2-1 in Outlook, or cancel it, and the vault still says the old
date — the Team card silently describes a meeting that isn't there. The detector
already solves the mirror image for `last-1-2-1` (read the notes, don't trust the
field); this is that lesson unapplied to the forward-looking date.

Cheap version from the row: on the nightly sweep, look for a `1-2-1 — Nick / X`
event near the stored date and correct it.

**Measure before building:**
- How many of the stored `1-2-1-booked` / `next-1-2-1-due` dates actually
  disagree with the calendar right now? If the answer is zero, this is
  speculative and should be ranked accordingly — say so rather than building it.
- `one-to-one-booking.findOneToOne` already matches an existing meeting by
  attendee email then subject. **Reuse it; do not write a second matcher.**
- ⚠ `services/scheduler.js` is one of the other session's files. `syncPeopleNotes`
  already runs in the 10pm block, so hang the reconcile off `one-to-one-detect`
  and touch no scheduler.
- Remember the field split (16 Aug): `1-2-1-booked` is when the meeting IS,
  `next-1-2-1-due` is when one is OWED, and **`last-1-2-1` moves only when a note
  proves the meeting happened**. A reconcile that moves `last-1-2-1` is wrong.

Then, in order: **#50** (`/api/todos/moscow` legacy path — small), **#36**
(people-gap review UI), **#31** (stale `Areas/1-2-1 Tracker.md`), **#39** (the
Naomi Winkworth rename — note #38 already resolves it in DATA via the alias, so
this is now only the file rename and its wikilinks), then the NOVA trio
(#115/#117/#118) once #116 unblocks them.

---

## Still on Nick, not code

- **#116** NOVA msgraph re-auth — 2 min, unblocks #115/#117/#118. Best ratio on
  the board.
- **#2** Teams consent · **#99** the 287 · **#106** approve the pending
  `draft_reply` (action 15814 — no OUTBOUND executor has ever run).
- **#59 aftercare**: store the crypt password + salt off the Pi, and regenerate
  the B2 master key (it was pasted into a chat; the Pi now uses a bucket-scoped
  key, so regenerating breaks nothing). Both in
  `backend/scripts/backup-offsite-SETUP.md`.

`escalation_alert_wide_seeded` may still be unset — `checkEscalationAlerts` is
`*/5 8-18 * * 1-5`, weekdays only. **Unset is NORMAL, do not "fix" it.**

## The rule this repo keeps relearning

**Every ticket premise has been wrong**, and the last session made it nine in a
row: #5 was already done (5 pending, not 929), #107's churn had stopped by
itself, #106 was narrower than written, #21 understated itself (the "dead" file
was being EXECUTED against the live vault on every test run), and **#38 was
backwards** — its aliases would have re-created the ambiguity it claimed to fix,
so building it as written was a regression, not a feature.

**Measure before building. State what you measured. If the ticket is wrong, say
so and correct the tracker row.**

Four more that keep biting:
- **A green suite says nothing about routing.** Call any new route against the
  running server before calling it done.
- **A feature is not available until it is reachable from the UI.**
- **A verification that can pass or fail by absence is not a verification** — the
  #59 restore check named a vault file that does not exist and read as a failed
  restore when nothing was wrong.
- **"Already fixed" is a hypothesis too.** Cross-check every "Ready" row against
  `git log` AND the live DB before ranking it as outstanding.

## Deploy sequence

`git pull --ff-only` → `cd frontend && npm run build` → `cd ../backend && npm test`
→ `pm2 restart neuro-backend --update-env`.

- **Node 22.22.2 must be on PATH for any pm2 command** (Node 20 segfaults
  better-sqlite3): `export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH`.
- DB at `/mnt/data/nuero/backend/db/agent.db` — open `{readonly:true}` while the
  backend runs. It is **447 MB** now; prefer aggregate queries over `SELECT *`.
- `sara/app` deploys to Netlify (`sara-nickward`, base `sara/app`) on push to
  main. Verify against the LIVE bundle and check `VITE_BUILD_LABEL`.
- ⚠ **Before exempting any route from auth on the Pi, run `tailscale serve status`
  first.** pi5 serves `https://pi5.tailecb90f.ts.net` → `127.0.0.1:3001` with
  **Funnel ON**, and Tailscale proxies both tailnet and public traffic from
  `127.0.0.1`.
- ⚠ **`npm test` no longer touches the real vault** (#119) — keep it that way.
  Smoke scripts are `backend/scripts/smoke-*.js`, they refuse to run without an
  explicit `OBSIDIAN_VAULT_PATH`, and `no-live-vault-in-tests.test.js` pins it.
- ⚠ The vault is **Syncthing-replicated both ways**. The tracker was edited on
  Windows and captured-to on the Pi in the same session; that worked, but check
  a change has landed before editing the same file from the other side.
