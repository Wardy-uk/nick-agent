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
