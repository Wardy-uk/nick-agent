# Session Handoff — 2026-08-27 (review + three fixes)

Started as "how's the tool looking?" — a product review against the live Pi DB,
not a code read. It turned into four fixes. Pi is deployed and current.

## The review finding that frames everything

The engineering is strong; the ENGAGEMENT is collapsing, and the tool's own
ledgers say so. From `activity_log`:

| | W32 (10–16) | W33 (17–23) | W34 (24–27) |
|---|---|---|---|
| `tab_open` | 266 | 89 | **17** |
| tasks completed | 3 | 12 | **0** |
| standups | 4 | 4 | **0** |
| commits shipped | 235 | 64 | 21 |

Lifetime: **16,637 sara_actions raised / 57 executed** (0.34%); **148 tasks open,
15 ever completed**; **2 focus sessions ever**; **1 task_block ever** (ten tasks
in a thirty-minute window, closed five minutes in). `pi-health` is the second
most-opened screen (44) behind `briefing` (115) — the screens that report on the
system beat the screens that move work. 26 tabs, flat.

**The unifying fault: nothing arrives, everything must be gone to.** Vantage —
the coaching layer, explicitly built because Nick's difficulty is *initiation* —
has **no push code at all** (`grep -rE 'webpush|sendToAll|notification'` → zero).
Neither did `task-blocks`. The only things that do arrive are the todo/email
nags, which are the demand restated.

## What was built (all deployed, `715cab0`)

1. **`fix(jira)` 3125851** — the queue cache has had NO WRITER since 3 Jul
   (48e6481 deleted it, "too much noise"); three later commits reintroduced
   readers. Seven weeks of a frozen 12-ticket snapshot stated as fact in chat,
   3 standup prompts, EOD, accountability and working-memory. Consumers now gate
   on `getQueueSummary().fresh`. `syncQueue()` restored behind
   `JIRA_QUEUE_SYNC_ENABLED` (**default off** — reversing the removal is Nick's
   call). Legacy `/rest/api/3/search` is **410 Gone**; use `/search/jql`.
2. **`feat(capture)` d680a4a** — cross-note fold. 258 pending → 54 distinct,
   204 folded, 0 false merges. **FOLD_SCORE 0.85, NOT task-dedupe's 0.42** — see
   mistakes.md; 0.42 hid a dated meeting inside a form task.
3. **`feat(planner)` b29a063 + `fix` 715cab0** — `day-planner.js`, half-day
   auto-planning at 07:15 / 12:30. **`DAY_PLANNER_ENABLED` default FALSE.**
4. Deduped triage note written to the vault:
   `Tasks/Captured commitments - triage 2026-08-27.md` (54 items, checkboxes).

947/947 tests green on the Pi.

## NEXT SESSION — start here

**The planner is built, verified and NOT ARMED.** Live dry run today returned:
morning → one 65m block at 11:50 holding task #60, correctly flagged
`[assumed]` + `[tight]`; afternoon → "no free gap", correctly. Nick has not yet
seen a dry run himself.

- Show him `GET /api/day-plan?window=morning` output, then arm with
  `DAY_PLANNER_ENABLED=true` in `backend/.env` + restart. **Do not arm it
  unattended** — it writes real calendar events on a timer.
- ⚠ **Nothing has been deleted from the 258 pending capture_todos.** Nick asked
  to review them first. The fold only prevents NEW duplicates; a backfill for
  the existing pile is NOT written. Do not bulk-reject without him.

## Later the same day — nudges, standup, EOD (deployed, `2e5eb8d`)

5. **`feat(nudges)` bb90027** — ritual nudges now gate on `nudgeSuppression()`:
   bank holidays (the crons were already Mon-Fri; **nothing knew about bank
   holidays, and Mon 31 Aug is one**) and a 🌴 **annual leave** button in the
   snooze menu (today / rest of this week / two weeks). Leave is an INCLUSIVE
   DATE, local time. The line drawn: **nudges go quiet, ALWAYS_DELIVER alarms
   still ring** — say if that is wrong. Verified live end-to-end and cleared.
6. **`fix(standup)` e0b51ff** — the "SARA is confused" bug. `_renderDailyNote`
   built Focus Today from `o.focus` AND carried-resolved-today and reconciled
   neither, so one job rendered twice (six lines for three jobs). Today's Focus
   Today is tomorrow's carry source, so **duplicates breed** — that is where the
   phantom "four escalations" came from. Deduped at 0.85, carried version wins.
   Also: "Write the daily note" called `setMode('manual')`, making the success
   panel unreachable by construction; and **EOD had no menu entry** — now
   "End of day" in the sidebar.
7. **`feat(standup)` 2e5eb8d** — SARA identity on the standup/EOD conversation.
   The prompt already used `VOICE_FULL`; the screen never said whose it was.

8. **`feat/fix(tasks)` e5c11fc + 12b8c34** — WIP button on Must Move Today.
   `in-progress` was already a valid status with no way to set it. Task STAYS
   in the lane (Nick's call). Two traps: `buildTodayLane`'s whitelist dropped
   `status` (toggle would have been one-way), and **Planner rows already carry
   real progress** — see mistakes.md.

## ▶ NEXT — read Nick's leave from NOVA (answered, not yet built)

**Nick IS in the feed.** He resolved the mapping himself (27 Aug):
`AgentId 24, Nick Ward, Team Support, Department NT, IsActive 1,
PeopleHrId D2V00244` — and roster_id 24 already appears in
`agent_availability`. All 13 active NT agents carry a PeopleHrId, so nobody
falls through.

The chain, which is why it looks unmapped: **PeopleHR EmployeeId →
`dbo.Agent.PeopleHrId` → `AgentId` → `agent_availability.roster_id`.**
`agent_availability` stores NO names and there is no FK or join table — it is
a bare integer pointing at a different server (`TechSupportJSM`). Names are
stitched on at READ time by `agent-availability.ts` (`getDaySnapshot` builds a
Map keyed on AgentId). That is also why NOVA's own `agent_roster` table being
empty is a red herring — nothing uses it for this.

⚠ **The feed only carries APPROVED leave.** Nick has an absence tomorrow that
is not yet approved and there are no rows for him in the next 14 days. So the
NOVA feed and the 🌴 button are COMPLEMENTARY, not primary-and-fallback: the
feed is authoritative for booked-and-approved leave, the button covers leave
that is unapproved, same-day, or decided that morning — and it still works
with NOVA or the Pi unreachable.

**BUILT — one deploy step outstanding.**

- **NOVA** `da42b2a` on branch **`nova-codex`** (pushed): `routes/neuro-bridge-availability.ts`,
  `GET /api/neuro-bridge/availability?days=14`. Reuses `AgentAvailabilityService`
  so it cannot drift from the Team Availability widget.
- **NEURO** `aee9276` (deployed, 997/997): `services/team-availability.js`,
  folded into `nudgeSuppression()`, refreshed every 30 min + 20s after boot,
  `GET /api/nudges/availability` (+ `POST .../refresh`). `NOVA_AGENT_ID=24` set
  in the Pi's `backend/.env`.

⚠ **NOVA IS NOT DEPLOYED.** It is an IIS site — `make-deploy-zip.ps1` writes
`NOVA-deploy.zip` to Nick's OneDrive Desktop, then `deploy/deploy.ps1` on the
server. Not run: that is his production and his call. Verified live meanwhile:
`/availability` answers 401 with `"Not authenticated"` (NOVA's APP auth, not
`bridgeAuth`'s `"Unauthorized"`), which is the #65 signature for a route that
has not shipped. The positive control `/status` returns 200 with the same
secret, so the secret is fine.

Until it ships NEURO reports `known:false, "never fetched"`, `suppressed:false`
— it keeps nudging rather than going quiet on a failed read, which is the
correct direction. **After the deploy**, `POST /api/nudges/availability/refresh`
should return `ok:true` with a 13-agent roster; 28 Aug has roster 9 and 25
booked, so that is the first real content.

## ⏳ PARKED — one interface, the chat (Nick, 27 Aug)

"Maybe the longer term plan should be that there is only one interface — the
chat — and we do everything there... let's pick that up later." **Do not start
migrating screens.** Recorded in CLAUDE.md as the tie-breaker for design calls
in the meantime: prefer making a surface feel like talking to SARA over adding
another panel. The 27 Aug measurements support it (26 flat tabs, `pi-health` the
second most-opened screen).

## Still outstanding from Nick's four asks

Two of his four were done (dedupe, planner). These were not:

- **"I can't find anything half the time"** — 26 flat tabs. Plan: rank the
  sidebar by real `tab_open` counts and collapse `pi-health`/`admin`/`state`/
  `insights` (88 opens of pure self-monitoring) into a **System** group.
  TaskBlocks also needs lifting out of TodoPanel into its own destination — being
  buried inside it is why he forgot it existed.
- **NEURO ↔ Vantage** — Vantage already reads NEURO (`backend/services/neuro.js`
  at `/mnt/data/vantage`, live at vantage.nickward.co.uk). Nothing goes the other
  way. Cheapest win: surface Vantage's one coaching next-step in NEURO's
  **briefing** (115 opens vs Vantage's zero this week), and let the planner pull
  Vantage plan actions as block candidates. **Do not build a second push stack** —
  NEURO's webpush has 4 live subscriptions and a governor.
- **The boundary pushes (T−5 / T−0 / T+end)** are designed but NOT built. The
  T+end prompt is what fixes the estimate problem: 148/148 open tasks carry no
  estimate, and it is the only moment the real duration is known.

## Gotchas

- Non-interactive ssh has no node/npm/pm2: `export
  PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH` first.
- Live DB is `/home/nickw/nuero/backend/db/agent.db`. Open `?mode=ro`.
- Verify behaviour by curling the RUNNING server, never a standalone `node -e`
  against the same DB (no dotenv, own module caches, clobbers shared AI budget).
- No other session was active today; tree was clean throughout.
