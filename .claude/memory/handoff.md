# Session Handoff — 2026-08-15 21:40

**Ten backlog items shipped, deployed and verified live.** All from the Feature Tracker,
picked for live correctness bugs over new features. Pi is at `a309f62`, 251 tests green
(260 local — the 9 extra are the still-uncommitted stress-score work).

## What was done

- **#29 calendar truncating at 50** — `graphFetchAll()` follows `@odata.nextLink`. Found the
  same bug on Planner (`$top=200` vs 275 tasks) while in there.
- **#79 embeddings only stored chunk 0** — multi-chunk now. **881 of 1,091 notes were being
  truncated.** Cap sized against the vault (median 4, p90 20, p99 60) → 60, not the 20 I
  first guessed.
- **#85/#34/#86** — one `services/vault-exclusions.js`; both consumers prune existing rows.
- **#84** wrong API key · **#55** AI budget persisted · **#45** export watchdog ·
  **#75/#76** lane renders its `why`, chips are tags.
- **#78(b,c)** — content-hash gate + `maxCreate` cap. The tap is shut.
- **#80** — `scheduleDaily`/`scheduleWeekly` + `runCatchUp()`. **Found 5 missed jobs on the
  first boot.** Watchdog now watches the scheduler.
- **#73/#74** — WHEN-words promote, WHAT-words don't. Measured on the live 130: classifier
  MUST **54 → 17**; 35 tasks entered the lane on `context=queue` alone, now 0.
- **#108** — paging + filters (month/source/owner) + filtered bulk **reject** (never approve).
- **#87** — `tasks.estimate_minutes`, `services/time-fit.js`, `/api/time/gap|what-fits`,
  `TimeFitCard` above the lane.

## What's still pending

- **Re-index still running** — hours on Voyage's free tier (~8,400 chunks). It resumes by
  itself: stamped on completion, so a restart leaves no stamp and catch-up re-triggers it.
- **Tonight's 22:00 rollup is the test of two things** — #34 (person pages should stop
  ranking `Master Todo` above meetings) and #78 (a small `created` number means the gate
  held; hundreds means it didn't).
- **Watch the nudge count.** #73/#74 moves it — `nudges.js` ranks off the same builder.
  That is the one baseline signal allowed to argue against the backlog (#17).
- **#44** — `stress-score.js` / `health.js` still uncommitted, left where they were found.
- Nick's own P0, unchanged and outranking all code: **#63** Tailscale key (28 Sept, fixable
  only from home), **#2** consent request, **#106** approve the Stephen Mitchell draft.

## Key decisions made

- **Chunk cap at p99, not p90.** 20 truncated the top 10% — the long transcripts #79 exists
  for. Measure against the vault before picking a bound.
- **Bulk reject, never bulk approve.** Rejecting is internal and reversible; approving runs
  executors and one sends email. Refuses without a filter, refuses if anything outbound
  matches, dry-runs first.
- **An assumed duration is labelled.** Un-estimated tasks are assumed 30 min and say so —
  a "this fits" that turns out to be a guess is never trusted again.
- **Catch-up does not replay history.** A job missed yesterday is not run today.

## Gotchas for next session

- **NEURO DB is `backend/db/agent.db`** — note the `db/`. Open `{readonly:true}` to inspect
  while the backend runs.
- **Deploy:** `git pull --ff-only` → `frontend && npm run build` → `backend && npm test` →
  `pm2 restart neuro-backend --update-env`. Node 22 path, per the memory file.
- **Verify against the live system before declaring done.** Two of this session's own bugs
  were caught that way and only that way: the 20-chunk cap, and `calendarKnown` derived
  from today's event count reporting "no calendar data" on a Saturday.
- `triageTodo`/`classifyMoscow`/`priorityFromMoscow` now take `today` as a parameter. They
  used to read the wall clock regardless of the `todayStr` passed in.
