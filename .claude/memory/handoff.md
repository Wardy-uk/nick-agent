# Session Handoff — 2026-08-16 16:40

## `c89d914` — #65, and **the ticket described a bug that cannot happen**
Deployed and verified live. Suite **347 local / 338 Pi**.

#65 said: "the bridge fallback can't reply — map `toRecipients`/`ccRecipients` in the
bridge branch, ten lines." **That branch cannot run.** NOVA's bridge serves eight routes
and `/mail/{id}` is not one of them, so NEURO's call falls past the bridge router into
NOVA's app auth and answers **401**. Same for `/todo/lists`, `/todo/tasks`,
`/planner/tasks` — all three labelled "Priority 2 — NOVA bridge" and none implemented.
**Checking the other repo before writing the fix is what caught this**; the ten lines
would have shipped as a no-op and the ticket would have closed.

**The real bug was one level down and silent.** A route that DOES exist answers
**HTTP 200 with the failure nested in `data`** — NOVA's msgraph token is expired, so
`/mail` returns `{ok:true, data:{error:"Failed to acquire token…"}}`. `novaBridgeFetch`
returned that as a payload; callers read `.id`, got undefined, returned `null`. **A dead
bridge was indistinguishable from an empty mailbox, and nothing logged a word.**

Now: detected/logged/recorded per path, 401+404 classified `unsupported` (not `error`),
nothing blocks a call so NOVA adding a route self-heals, keys normalised so `/mail/:id`
doesn't mint an entry per message. `getMailAccessStatus()` reports what was **observed**
— `bridgeConfigured` alone was the lie.

**The user-visible half is also not what the ticket said.** Cached triage entries (290 of
them) carry `fromEmail`, so on a Graph outage Reply **works**. What they carry no trace of
is the other participants — `replyAllCc` comes back empty and the composer rendered that
as *nothing at all*. **An unreachable thread looked exactly like a one-to-one email**, and
the difference is who gets left off a reply. Now `replyDefaults.threadKnown`, `live` +
`detail` on the route, and a muted "thread unavailable — add anyone else by hand" chip.

Verified live: `/mail/:id` → `unsupported HTTP 401`; the real `/mail` 200-payload fed
through the deployed classifier → correctly a failure; `getBridgeHealth()` starts `{}`
(**"unprobed" is a real third state** — the bridge is only touched when Graph fails, and
Graph is currently healthy).

### Left for Nick — two minutes, unblocks the only bridge route that exists
NOVA's msgraph MCP needs a re-login: `Failed to acquire token for account
'NickW@nurtur.tech'. The token may have expired. Please re-login with: --login`.
Nothing is broken today (NEURO's own MSAL Graph is healthy and was driven live this
session) — but the fallback is dark until that happens.

### Tracker correction
**#63 is DONE** — Nick confirmed key expiry is already disabled; the tracker still ranked
it P1 #1 "do it today". **#65 is two different items** under one number (bridge reply
fallback, and metrics plotting) — same duplicate-numbering problem as the known #103.

# Session Handoff — 2026-08-16 15:40

## Shipped — all three queued items, deployed and verified live
`205c549` #71 · `edf9de8` #53/#54. Suite **340 local / 331 Pi** (the 9 is the parked
stress-score work). Pi at `edf9de8`, frontend rebuilt, `unstable_restarts` still 0.

## `205c549` — #71, the To-Do list cache survives a restart
`agent_state.ms_todo_list_by_task`. Verified live: driven through the real endpoint,
**9 entries / 2.5KB**, one list; reloaded intact in a fresh process after a restart.

**Calibration worth carrying: the walk was cheaper than the ticket implies.** Nick has
**2 To Do lists**, and one is `Flagged Emails`, which the sync skips — so the cold-start
cost was ~2 Graph calls, not "every list" in any dramatic sense. Still worth fixing (it
was on the critical path of every first completion after a deploy), but if something
later looks like it needs the same treatment, measure the list count first.

Persisting **flips the failure mode** — the in-memory map self-corrected every restart,
a stored one cannot. Two guards, both in the commit: `fetchTodoTasks` **re-keys the whole
list** instead of appending (completed tasks fall out, map stays at "tasks currently
open"; the re-key returns a `changed` flag which gates the DB write, or it would rewrite
the blob per-list per-sync forever), and `completeTodoTask` **forgets and re-walks once on
a 404** so a moved task heals on the next completion rather than the next deploy.

## `edf9de8` — #53/#54, and **#54's framing in the tracker was wrong**
#53: the list rendered only at 2+, so a single escalation had no anchor. Now `>= 1`, with
the summary dropped in that case (the title carries it) and the hover underline moved onto
the key. Verified by building a real single-escalation card through deployed
`decision-engine.evaluate` — title `NT-27530 — ESCALATION…`, one row, **live Jira link**,
badge `Reopened`, 5d.

**#54 said "show priority + assignee, or stop sending them". Neither is right, and the
6 currently-open escalations would have led me to the wrong answer.** Against all **41**
escalations Jira has ever held:
- priority — `Unset` **33**, Normal 5, Major 2, **Critical 1**
- assignee — Nick **23**, unassigned **7**, five other people 11
- status (of the 6 open) — Open 3, Reopened 2, Waiting on Development 1

Every field has a **default that is a fact about the queue, not about the ticket**, plus a
tail worth interrupting for. So: suppress the default, keep the tail. `Unset` / `Open` /
Nick's own name never leave `jira.js`; no assignee becomes **`Unassigned`**, which on an
escalation is the finding rather than an absence. Nulled in the service, not per panel, so
Focus and Briefing cannot drift. Live result — **3 of the 6 render no badges at all**, the
other 3 render exactly one (`Reopened` ×2, `Waiting on Development` ×1).

**If I had sampled only the 6 open, priority reads "always Unset" and assignee "always
Nick", and I would have deleted a field that carries a Critical.** Same species as the
`getPendingSaraActions` limit-10 lesson: the sample the system hands you is not the
population.

## NEXT
Nothing queued from me. Still on Nick, not code:
- **#59** off-site backup — one Backblaze B2 keyID + applicationKey away from buildable,
  and needs a decision on where the restic password lives **off** the Pi.
- **P0s outrank all of it**: #63 (Tailscale key, 28 Sept, home only), #2, #106, #22/#23/#99.

`backend/routes/health.js` + `backend/services/stress-score{,.test}.js` remain parked and
uncommitted — untouched this session, and the 9-test local/Pi gap is exactly them.

# Session Handoff — 2026-08-16 13:15

## Shipped this session (all deployed + verified live)
`df7b49a` #81 · `68e93fc` reschedule · `311c6ec` cadenceState · `eb1f3fd` #64 + weekend nudge
Plus #27/#46 (Master Todo retired, 11 superseded copies archived) — API call + file move.
Suite **329 local / 319 Pi**; the 10 is the parked stress-score work.

## `eb1f3fd` — two alerts that lie
- **#64** — the restart warning fired on TOTAL restarts, so with 2-3 sessions deploying it
  sat on the panel all week saying `restarted 58×` about its own deploys. Measured live:
  **58 restarts, `unstable_restarts` 0**. PM2 already separates them — `unstable_restarts`
  only counts restarts inside `min_uptime`. Now critical on crash-looping, silent for
  deploys. Verified after deploy: count is 59 and the warning is GONE, leaving only the two
  real ones (swap, Pi 4 unreachable).
- **The weekend nudge** — `clearStaleNudges()` split out of `nagCheck` and scheduled daily
  (`5 0 * * *`). nagCheck is weekdays-only, so Saturday's banner survived the rollover and
  Sunday minted a second row for the same fact. **The frequent restarts were the only
  reason it never looked persistent** — a restart clears stale nudges on startup.
- **GOTCHA that cost a test run:** a cron expression in a JSDoc block closes the comment —
  `*/15 ...` contains `*/`. Never put one inside `/** */`.

## NEXT — #71 and #53/#54 were asked for and NOT started
Deliberately not begun: context was long and splitting a build across the boundary is how
half-done work gets committed (it already bit once today — see mistakes.md).
- **#71** — `fetchTodoTasks` caches Microsoft task→list in MEMORY, so the first completion
  after any restart walks EVERY To Do list. With 2-3 sessions deploying daily that is most
  completions. The vault stores a bare `<!--id:...-->` with no list id, which is why the
  cache exists. Persist it (`agent_state` KV, following the other caches).
- **#53** — a SINGLE escalation renders with no link anywhere on the card; the list only
  renders at 2+. So the quietest day is the one you cannot click through.
- **#54** — `getUnseenEscalations()` returns `status`/`priority`/`assignee`, they travel
  through `meta.escalations` into both panels, and nothing renders them. Either show
  priority + assignee on the row or stop sending them.

# Session Handoff — 2026-08-16 12:30

## 1-2-1 work — TWO sessions landed together, deployed and verified
`68e93fc` **reschedule** (this session) + `311c6ec` **cadenceState** (a concurrent
session, committed from its working tree here once Nick said it was done). They are one
feature and had to ship together: HEAD already called `updatePersonNote({booked121})`
while the committed `obsidian.js` had no idea what `booked121` was, so booking would have
silently stamped nothing. **That is why the deploy was held.**

**Reschedule** — `findOneToOne` / `proposeReschedule` / `reschedule`, `microsoft.updateCalendarEvent`,
routes `/api/1to1/{find/:person,propose-reschedule,reschedule,moves/:person}`, "Move" on
the Team card. Finds the meeting that EXISTS (attendee email first, subject fallback)
rather than only NEURO-booked ones. **PATCH, never cancel-and-recreate.** The event is
excluded from its own clash check. A synthesised `graph-…` id is refused up front. Move
history in `agent_state.one_to_one_moves`, shown BEFORE the confirm.
Verified live: `find/Hope Goodall` returned her real 19 Aug 11:00 event, `matchedBy:
attendee`, `addressable: true`.

**cadenceState** — `1-2-1-booked` (in the diary) is now separate from `next-1-2-1-due`
(when the next is OWED). Verified end-to-end on live data: Hope reads **`booked`, 3 days
away** where the old logic gave **94 days overdue**. All five states check out:
`booked` / `unwritten` / `overdue` / `due-soon` / `ok`. `migrate-121-booked.js` had
**already been applied** by that session — 12 People notes carry `1-2-1-booked`, and a
fresh dry run reports `0 migrated, 13 untouched`.

Suite **331 local / 318 Pi** (gap = parked stress-score). Frontend rebuilt on the Pi.

**MISTAKE, logged in `mistakes.md`:** I ran `git add` on `PeopleBoard.jsx` and swept ~45
lines of the other session's unfinished work into `68e93fc`. Explicit staging protects
against unrelated FILES, not unrelated HUNKS in a file you are legitimately editing. Nick
runs 2-3 sessions on this repo — **`git diff <file>` before staging it**, and treat
"modified on disk since you last read it" as a collision signal, not line-ending noise.
It came out fine only because the two halves turned out to be the same feature.

# Session Handoff — 2026-08-16 11:00

**Everything the last two handoffs listed as unverified is now verified.** The 22:00 rollup
fired, the re-index finished, #78 and #34 both confirmed live. #27 and #46 shipped.
No code changed this session — the two items were an API call and a file move.

## Verified (all four clock-dependent checks from the last handoff)
- **Rollup ran.** `scheduler_last_run:nightly-rollup` = 2026-08-15. Watchdog self-resolved
  its "has never run" alerts for both `nightly-rollup` and `embeddings-rebuild`.
- **#78 held.** Consecutive log lines: `scanned 205, created 463` (first-ever pass over
  unseen notes — the backfill, not a flood) then `scanned 206, created 0`. Newest
  `sara_actions` row is 2026-08-15 16:16, so last night's rollup created **nothing**.
- **#34 confirmed.** Hope's mentions are real meetings top to bottom; no `Master Todo`,
  no `NEURO Tasks (export)`, no `.backup-` worksheet.
- **Re-index FINISHED** — 8,440 rows / 1,092 files / 7,348 multi-chunk, last write
  01:00:24 on 16 Aug, against the ~8,400 target. It got 14h undisturbed and completed.
  **The restart hazard is over**; deploys are safe again.

## What was done
- **#27** — `POST /api/tasks/retire-master`. Export verified against the DB, flag set,
  `Master Todo.md` → `Tasks/Archive/Master Todo (retired 2026-08-16).md`.
- **#46** — **eleven** (tracker said ten) superseded copies moved to `Tasks/Archive/`:
  `All Tasks.md`, 4× `Master Todo.backup-*`, 2× `Microsoft Tasks.sync-conflict-*`,
  `MoSCoW - Open Actions 2026-08-12.md` + its `.backup-`, `MUST - Prioritise 1-3.md`,
  `Rescued from Archive - MoSCoW.md`. The two sync-conflicts differed from the live
  `Microsoft Tasks.md` **only by the `Last synced` stamp** — checked before moving.
- Verified after: 165 todos = 147 NEURO DB + 9 MS ToDo + 7 MS Planner + 2 daily note,
  and **zero** Master-Todo-sourced. `Tasks/` now holds only the five live files.
- CLAUDE.md updated (the "still parsed as a fallback" sentence was stale the moment
  #27 landed).

## #81 — shipped, deployed, verified live (`df7b49a`)
Lint no longer calls an archived note a broken link. Measured before/after on the SAME
vault: **177 reported → 58 real + 114 archived + 5 `_about`**, i.e. 67% of the bug list
was noise. Three parts:
1. `lint()` returns **`archivedTargets`** as its own class beside `broken` — a link into
   the bin is a signal ("points at retired content"), just not a defect, so it is
   reclassified rather than dropped. Route exposes it; scheduler logs it.
2. **Archive discovery now runs at ANY depth** (`collectArchiveDirs`). This was the
   load-bearing half: the notes behind 54 of the false positives live in
   `Projects/Archive/90 Day Plan (retired 2026-08-12)/`, and BOTH `lint` and
   `buildFixModel` only ever looked at `<root>/Archive`. `EXCLUDE_DIRS` still applies to
   everything else, which is what keeps `.stversions` and `Scripts/.lint-backups` — both
   full of Archive-shaped copies — from resolving dead links against backups.
3. `[[_about]]` excluded — `walk()` skips `_about.md` by design, so it can never resolve.
`buildArchiveIndex(root, normalise)` **takes the normaliser** so each caller matches
archived targets exactly as it matches active ones (`lint` case-only, `fixPlan` the
aggressive `norm`); mixing them would let a punctuation variant resolve to Archive while
an active note existed. Archived count is logged but **kept out of the push** (#17).
New `vault-hygiene.test.js`, 8 tests. Suite 303 local / 294 Pi (the 9 is the parked
stress-score work). Deployed and confirmed on the live endpoint.

**GOTCHA that cost time: `vault-hygiene.js` contains a literal NUL byte** (` `) as
the dedup-key separator in `lint()`. `file` reports the module as binary, `grep` treats it
as such, and **exact-match string editing of that file silently fails to match**. Patch it
with a Node script that writes ` `, not with a text edit.

**Pi and Windows lint counts differ (74/98 vs 58/114) — this is EXPECTED, not a fault.**
1,463 of the 1,665 archived notes the Pi lacks are `Archive/Recycle Bin/`, which
`.stignore` excludes by design (plus ~123 `_Staging` variants). From the Pi's view a link
into a deletion pen it does not have really is broken. Don't "fix" this.

## Findings worth carrying
- **#46 is what actually finished #34.** `GENERATED_FILE_PATTERNS` never matched
  `MUST - Prioritise 1-3.md` (29 entity rows), `Rescued from Archive - MoSCoW.md` (6) or
  `All Tasks.md` (1) — 36 rows still naming real people. Moving them under `Archive/`
  excludes them by DIRECTORY, which is the general fix; extending the regex list would
  have meant guessing every future worksheet name. **They prune on the next 02:30 sweep**
  via `pruneExcludedEntities()` — expect 36 rows to drop.
- **Nudge count read 2, up from a baseline of 1 — but it is one fact, twice.** Both rows
  are `1 urgent email needs a reply — Riannah Clegg`, date_keys 2026-08-15 and -16.
  `syncFactNudge` keys on `(type, dateKey)` so the rollover mints a new row, and the
  stale-clearing branch that should retire the old one lives in `nagCheck`, scheduled
  `*/15 9-17 * * 1-5` in `scheduler.js:193` — **weekdays only**. Saturday's row had no
  cleaner. Real outstanding pressure is still 1. **Unfixed, deliberately** — small, and
  the tree was not clean enough to commit it into.
- **#88/#89 still unused.** `agent_state.focus_session` is empty and there is no
  `focus_session_history` key at all. Nick has never started a session. Do not build on it.
- **652MB of the 939MB vault is two Windows installers** in `Imports/PLAUD/`
  (`Docker Desktop Installer.exe` 537M, `Plaud Setup 1.0.5.exe` 115M). **Correction to
  what was said mid-session: `*.exe` IS in `.stignore`, so Syncthing is NOT replicating
  them** — but they sit on the Pi regardless, because an ignore pattern stops syncing and
  does not delete what is already there. Stale copies sync will never clean up, so
  removing them means doing it per device. They also break any git-based backup.

## #59 — off-site backup: git was ruled out, with numbers
Nick asked whether a private GitHub repo would do. It won't, as the primary:
- **Hard rejects on first push** — GitHub's per-file limit is 100MB; `agent.db` is
  **150M** and `Docker Desktop Installer.exe` is **537M**. LFS free tier (1GB storage
  *and* 1GB bandwidth/month) is exhausted in under a week by a daily 150MB binary.
- **Binary churn compounds forever** — `agent.db` (150M) + `home-assistant_v2.db` (22M)
  rewrite constantly and don't delta; git keeps every version. ~4.5GB/month of
  irreversible growth, unprunable without rewriting history.
- **The content is the real blocker.** The vault holds named-employee HR material
  (`...Employee Health, Reasonable Adjustments... Kayleigh.md`, `Projects/PIP/`,
  `Counter-Offer to Retain Isabel Busk`) — special-category data under UK GDPR — plus
  `.env` with 50 vars. A private repo is access control, **not encryption**; that would
  be Nurtur employee data in plaintext on a personal account.
- Git *does* fit the ~32M of actual notes (`Projects` 18M, `Plaud` 7.9M, `Meetings` 3M,
  `Documents` 2.1M, `Daily` 540K). It's the DB and the HR content that break it.
- **Recommendation: `restic` → B2/R2.** Client-side encrypted (kills blocker 3),
  deduplicating (kills 2), no size limits (kills 1). ~250MB after excluding installers,
  ~a penny a month. **Needs an account + API key from Nick** — that is the one step
  that can't be done for him. NOT STARTED; awaiting his call.

## Still pending
- **#44** — stress-score work **PARKED by Nick this session**. `backend/services/stress-score.js`,
  its test, and the modified `backend/routes/health.js` are untracked but **complete and
  green** (suite is 295 pass / 0 fail, up from 283). Leave them; don't sweep into a commit.
- Local == Pi at `486bfb6`. CLAUDE.md edit above is uncommitted.
- P4 chain next: **#81** (lint calls archived notes broken — 69 of 228 false positives,
  and #46 just archived eleven more link targets, so this got slightly worse today) →
  #53/#54 → #65 → #71 → #64.
- P5 are decisions, not builds: #40 (Apple Health transport, blocks #41–#44), #47, #57, #91.
- Nick's P0s unchanged: **#63** Tailscale key (28 Sept, home only), **#2**, **#106**,
  and the **#22/#23/#99** conversations.

## Gotchas
- `OBSIDIAN_VAULT_PATH=/home/nickw/nuero-vault` is a **symlink** to `/mnt/data/nuero-vault`
  — same tree, verified by inode. Either path is safe.
- PM2/Node 22 path and the `db/agent.db` location: see the `pi5-deployment` memory file.
- Read the DB `-readonly` while the backend is running.
