# Session Handoff — 2026-08-16 evening

## Nine shipped today. Suite **373 local / 373 Pi — the gap is CLOSED.**
`6512027` #94 · `ca1c032` #56 · `e18183b` #83 · `27f4e83` #44 · `792fc1d` #109 ·
`312c446` #111 · `3f23506` #110 · `d6a95a7` #105 · `6b8d979`+`4c16177` #70 · `c271653` #112
Pi clean at origin/main, `unstable_restarts` 0. **There are no parked files left** — #44
was the 9-test gap and Nick authorised shipping it.

## ⏳ STILL PENDING, no action needed — fires Monday 08:00
`briefing.checkEscalationAlerts` backfills its seen-list on its first widened run and its
cron is `*/5 8-18 * * 1-5` — **weekdays only, and today was Sunday**. So
`escalation_alert_wide_seeded` is still null and 11 keys are still absent from
`alert_seen_ids`. Monday 08:00 it records them silently and pushes **0**. Verified by
rehearsal against the real seen-list. **If a session sees that flag unset, that is normal
until Monday — do not "fix" it, and do not widen anything else in that file first.**

## Three places the ticket was wrong, and the measurement that caught each
- **#94** — feared "17 escalations waiting on you". Once `comment` is actually requested,
  Nick had **already replied to 12 of 17**; five surface. And the real push hazard was
  **`briefing.js`**, not the nudge: it pushes once PER ticket and `escalation_alert` IS in
  `ALWAYS_DELIVER`, with 11 of 17 absent from its seen list.
- **#110** — "VITE_BUILD_LABEL is unset". It was **set**, in the committed
  `.env.production`, to the static `prod-mobile`. Identical on every build, so it could
  never answer its own question; the UI fix the ticket asked for would have been just as
  static. Now derived from `COMMIT_REF`. **Verified `prod-mobile` is gone from the live
  bundle** rather than assumed.
- **#39** — "a transcription slip in one meeting note, one-line fix". It is a **FILENAME**
  (`Meetings/2026/04/2026-04-30 – 1-2-1 Meeting Naomi Winkworth`), a real 1-2-1 with Naomi
  **Wentworth**. Rename + re-link, and `Decision Log/vault-moves.md` is history that must
  NOT be rewritten. Left undone, deliberately.

## #56 was worse than its ticket too
"Degrades to near-keyword matching" — no. Fallback vectors are **128-dim** against Voyage's
**1024**, and `cosineSimilarity` returns **0** on a length mismatch, so those rows were
**unreachable**, and the real content hash made the rebuild skip them forever. **74 rows
across 32 files**, including one transcript's entire 16 chunks. **Now 0** — sweep found
exactly 32 files, re-embedded 148 chunks, 0 errors.

## What did NOT get done, and why — do not assume these are close
- **#69** (replies leave no trace) — real design work, not a small fix. Untouched.
- **#25** holiday awareness, **#26** phone standup, **#28** render logged decisions — all
  genuine builds. Untouched.
- **#21** delete `one-to-one-prep.js` — **gated, not skipped.** Its own precondition is
  "once NOVA is confirmed to cover everything", and NOVA's Graph token is expired (#116).
  It is also still required by `backend/scripts/test-tier1.js`. Deleting a fallback while
  the replacement is unverified is the wrong trade.
- **#32** — the 12 empty folders are gone; the **5 with real notes are untouched** (Arman,
  Hope ×2, Naomi Wentworth, Nathan, Sebastian — including Nathan's 14 Aug holding note,
  and one of Hope's is the only evidence of her 30 Apr 1-2-1). **"Dead folder tree" is not
  licence to delete the rest.**

## One bug I introduced and caught
`GET /api/email/triage/feedback` returned `{"ok":false,"error":"Email not found"}` — it was
registered **after** `/triage/:emailId`, and Express matches in registration order. The
suite was green throughout: it exercises the service, not the routing table. Fixed in
`4c16177`. Lesson is in `mistakes.md`.

## NEXT — still on Nick, not code
- **#40 Apple Health transport is the single biggest unblock** and it is now a research
  task, not a decision: **HA Companion is ruled out by measurement** (the phone publishes
  29 entities, all CoreMotion/battery/network/focus/location — the iOS Companion app does
  not read HealthKit at all). A deep-research prompt for free alternatives was handed over
  in chat. Until then `/api/health/stress` correctly reads `calibrating`.
- **The 5 escalations are real and unanswered** — NT-21284 is 65 days old.
- **#106** approve the one `draft_reply` (sends nothing, gate 1 of 2, executor never run).
- **Write up the Nathan/Stephen 1-2-1s**, or the board keeps calling them overdue.
- **#2** Teams consent on an office day; **#116** NOVA re-auth (gates #115/#117/#118);
  **#59** off-site backup.

# Session Handoff — 2026-08-16 14:00

## Shipped all three queued items, deployed + verified live
`6512027` #94 · `ca1c032` #56 · `e18183b` #83. Suite **363 local / 354 Pi**.
Pi clean at origin/main, `unstable_restarts` 0. Parked files untouched and
uncommitted: `backend/routes/health.js`, `backend/services/stress-score{,.test}.js`
— **still exactly the 9-test gap. Leave them.**

## ⏳ ONE THING STILL PENDING — fires Monday 08:00, no action needed
`briefing.checkEscalationAlerts` backfills its seen-list on its first widened
run, and its cron is `*/5 8-18 * * 1-5` — **weekdays only, and today is Sunday**.
So `escalation_alert_wide_seeded` is still null and 11 keys are still absent from
`alert_seen_ids`. Monday at 08:00 it will record those 11 silently and push **0**.
Verified by rehearsal against the real seen-list, not by argument. If a future
session sees that flag unset, that is the normal state until Monday — do not
"fix" it, and do not widen anything else in that file before it has run once.

## `6512027` — #94, and **the brief's "17 waiting on you" was wrong**
Narrow arm 6 → both arms 17, confirmed. But the loud number the brief feared
never existed: once `comment` is actually requested, **Nick has already replied
to 12 of the 17**, and `!hasComment && !seen` means those never reach the card.
**5 surface**, aged 6–65 days: NT-21284, NT-22339, NT-23239, NT-23803, NT-27431.
Live now, as one banner: *"5 escalations waiting on you — oldest is NT-21284, 65d
old."* Nick chose "let them surface" over seeding — seeding those 5 would have
made the fix cosmetic on the one surface it exists to correct.

**The brief missed the bigger landmine, and it was the second push path.**
`briefing.checkEscalationAlerts` had the SAME narrow query, pushes once **per
ticket**, and `escalation_alert` IS in `ALWAYS_DELIVER`. 11 of the 17 were absent
from its seen list → widening it blind is **11 notifications at any hour**. The
nudge path, by contrast, pushes type `escalation`, which is **not** in
ALWAYS_DELIVER — so it respects quiet hours. The hazard was in the file nobody
was looking at.

**Two things checked rather than assumed, both of which changed the code:**
- Jira caps the inline `comment` field at 20 per issue and returns the **NEWEST**
  20 (NT-14855: `startAt 32, total 52`). The oldest 20 would read "no reply" on
  exactly the long churning threads an escalation becomes. 3 of the 17 are
  truncated; all 3 still resolve to "replied". No follow-up fetch needed.
- `/search/jql` **has no `total`** — only `isLast`. That is now the cap signal
  and it logs loudly.

`nickCommented` is **null when comments were not requested, never false** — "we
did not look" must not be what puts a ticket on the card. #54's badge rules were
re-measured on the wider population and still hold (priority Unset 7 / Normal 8 /
Major 1 / Critical 1; assignee Nick 16 of 17), so nothing there changed.

## `ca1c032` — #56, **worse than the ticket said, and now measurable**
The ticket said "degrades to near-keyword matching". It does not. The fallback is
**128-dim** and Voyage is **1024-dim**, and `cosineSimilarity` returns **0** on a
length mismatch — so a fallback row is not a worse match, it is **unreachable**,
while the real content hash makes the rebuild skip the file forever.

**Measured on the live index: 74 rows across 32 files.** Whole transcripts gone —
16 chunks of one meeting, 13 of a NOVA doc, 8+8 of two standups. Oldest 18 June.
**None of it could ever have healed on its own.** Now **0** — triggered the
rebuild and watched it: sweep found exactly 32 files, re-embedded 148 chunks,
0 errors, 0 left behind.

Failed calls now write **nothing** (the file stays un-stamped and retries); a
**partial** response counts as failure; the query side returns null so
`semanticSearch` hands back to keyword search rather than returning an empty set
that reads as "nothing matches". With **no key at all** the hash index is left
alone — it is self-consistent, and only the *mixture* is broken.
`GET /api/activity/embeddings-health` follows #65: not-configured / unprobed /
degraded / ok, plus a live count of unreachable rows and the remedy.

## `e18183b` — #83, latent, kept small
Premise confirmed stale: **4 pending, not 929**. The real bug was that the route
asked for 1,000 actions of *every* type and discarded all but `capture_todo`, so
the bound was spent on rows it was about to throw away. Now typed
(`getPendingSaraActionsByType`), capped at 200, **logs when it bites**, and the
payload carries `suggestedTotal`/`suggestedCapped` so no number on screen is the
capped one. Live: `suggestedTotal 0`.

## NEXT — nothing queued from me. Still on Nick, not code:
- **#106** — still the cheapest thing on his list. One pending `draft_reply` to
  Stephen Mitchell, "Integration Partner Escalation Contacts". Approving **sends
  nothing** (gate 1 of 2). That executor has **run zero times ever**.
- **The 5 escalations are now visible and genuinely unanswered** — NT-21284 is
  65 days old. That is the point of #94, and it is Nick's to action.
- **Write up the Nathan (#22) / Stephen (#23) 1-2-1s** — until a note exists the
  board keeps calling them overdue. Looks like a bug, isn't.
- **#2 Teams** (office day, admin consent queue), **#116** NOVA re-auth
  (#115/#117/#118 gated behind it — do not build), **#59** off-site backup.

# Session Handoff — 2026-08-16 17:30

## Shipped today, all deployed + verified
`205c549` #71 · `edf9de8` #53/#54 · `c89d914` #65. Suite **347 local / 338 Pi**.
Pi clean at origin/main. Parked-by-Nick files still untouched and uncommitted:
`backend/routes/health.js`, `backend/services/stress-score{,.test}.js` — **that is the
9-test local/Pi gap, and it is #42/#44 in the tracker. Leave them.**

## State changes Nick reported (tracker updated)
- **#22 Nathan and #23 Stephen — DONE.** Both P0 1-2-1s held. ⚠ **NEURO will keep showing
  them overdue until a meeting note exists** — `last-1-2-1` only moves when a note proves
  it happened. Not a bug; will look like one.
- **#63 done** (Tailscale key expiry already disabled).
- **#2 Teams — parked, needs to be in the office.**
- **The action queue collapsed on its own: 930 pending → 4.** 621 `capture_todo` rejected,
  1,353 superseded. **#104 is effectively done**, and **#83's premise is stale** (tracker
  says "currently sits at 929").
- **#106 is still live and is the cheapest thing on Nick's list**: exactly one pending
  `draft_reply`, to **Stephen Mitchell, "Integration Partner Escalation Contacts"**.
  Approving SENDS NOTHING (gate 1 of 2). `draft_reply` has **executed zero times** ever —
  1,168 superseded, none run. Untested executor.

## NOVA findings logged as #115–#118 — do NOT build these
All gated behind **#116**, which is Nick's re-auth (NOVA → avatar → My Settings →
Microsoft 365). NOVA's bridge is missing four routes NEURO calls, reports failures as
HTTP 200, and its M365 card shows green off `--list-accounts` (row count, not token
validity). None of it is urgent — NEURO's own MSAL Graph is healthy.

## NEXT — #94, #56, #83, agreed with Nick, NOT started
Full brief in **`.claude/memory/next-session-prompt.md`**. Read that before starting.
**#94 has a landmine that will push-notify Nick at any hour if walked into blind** —
`ALWAYS_DELIVER` bypasses quiet hours and the cap. Do not swap the query naively.

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
