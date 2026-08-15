# Session Handoff — 2026-08-15 20:45

**P3 is clear.** #88 (focus session container) and #89 (interruption recovery) shipped
together, deployed and verified live. Pi is at `6876646` + a docs-only commit behind
(`2b1f9dc`, CLAUDE.md). 283 tests local / 274 on the Pi — the 9-test gap is still the
uncommitted stress-score work.

## What was done
- **#88 / #89** — `services/focus-session.js`, `routes/focus-session.js` (`/api/session`),
  session + recovery cards at the top of `AdhdPanel`. Shipped as one build: #89 is a single
  read off #88's state, and the container without the return prompt is the half that
  doesn't pay for itself.
- Escalation arrival now stamps an interruption via `jira.syncEscalations()`.

## What's still pending
- **The 22:00 rollup has STILL never run** (`scheduler_last_run:nightly-rollup` UNSTAMPED).
  #34 (person mentions vs Master Todo) and #78 (`[Scheduler] Meeting actions:` created count
  — small = the hash gate held) remain unverified two sessions running.
- **Re-index is ~45% through: 3,778 rows / 1,091 files / 499 multi-chunk** against a target
  of ~8,400. **Every backend restart kills it mid-flight** and it only resumes at next boot
  via catch-up — and deploys restart the backend several times a day. It may never finish
  unless a run is left alone. Worth watching, or forcing outside a deploy window.
- **#88/#89 are live but unused.** Same shape as #106: the executors nobody has run are the
  ones that are quietly broken. First real session started is the actual test.
- **#44** — `stress-score.js` / `health.js` still uncommitted, left where they were found.
- Nick's P0s unchanged and still outranking all code: **#63** Tailscale key (28 Sept,
  home only), **#2** consent request, **#106** approve the Stephen Mitchell draft,
  **#22/#23/#99** the conversations.

## Key decisions made
- **Elapsed is focus time, not wall clock.** Paused stretches excluded, or "twenty minutes
  in" is wrong the instant you're pulled away — the only case #89 exists for.
- **Stale asks, never decides.** Auto-completing invents a win; deleting loses the thread.
- **An escalation is noted but never auto-pauses.** NEURO can't know if he switched, and
  guessing corrupts the one number the prompt rests on.
- **Pull-only.** Nudge volume is the signal allowed to argue against the backlog, so a new
  feature doesn't get to raise it. Baseline measured: **1 active nudge**.
- **Start by text resolves the task via `task-store.dedupeKey`** — decision-engine items
  carry a slug (`todo-overdue-top`), never a task row.

## Gotchas for next session
- `ASSUMED_MINUTES` is imported from `time-fit`, not re-declared. Keep it that way.
- Deploy + DB paths + Node 22 requirement: see the `pi5-deployment` memory file.
- Verify against the live system before declaring done — it caught the "0 minutes into"
  prompt and the slug-not-task-id assumption this session.
