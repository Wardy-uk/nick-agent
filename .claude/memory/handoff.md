# HANDOFF — Briefing chain revived, task sources fixed, Pi reconciled

**Session:** 2026-08-12. Everything below is deployed and verified live.

## STATE: Pi 5 == origin/main == `19996aa`

The Pi is no longer diverged. Clean working tree, on `main`, matching origin exactly.
Deploying is now `git pull && pm2 restart neuro-backend --update-env` again.

Backups taken before the merge (keep until confident):
- `/mnt/data/backups/agent.db.20260812-123913` (57MB)
- `/mnt/data/backups/.env.20260812-123852`
- Branch `pi-local-2026-07-31` @ `9e954f9` on GitHub — the Pi's pre-merge state, and the rollback point.

## WHAT WAS FIXED

**1. The proactive delivery chain — every path was dead, all three now live.**
- `Mail.Send` + `Chat.Read` added to `GRAPH_SCOPES`. Nick re-consented via device code.
  `[EmailSender] Brief sent to nickw@nurtur.tech` — first briefing email NEURO has ever sent.
  Deliberately EXCLUDED `ChannelMessage.Read.All`: delegated, needs tenant admin consent,
  and requesting it fails the whole device-code flow.
- Push works — 5 subscriptions, 0 failures, incl. Nick's reinstalled iPhone PWA.
- OpenRouter was already funded; briefing synthesis uses it, not Ollama.

**2. SARA Mobile.** `sara.nickward.co.uk` was serving a stale build predating the mobile app.
Real cause of "offline": `sara/app/.env.production` is COMMITTED and is the actual config
source — the Netlify site has zero env vars, so `VITE_ALLOWED_HOSTS` was empty and
DeploymentGuard was inert. Host guard values now live in that file.
Screen wake lock added (`sara/app/src/hooks/useWakeLock.js`, ☀ button in header).

**3. Microsoft tasks were being destroyed daily.** `syncMicrosoftTasks()` wrote the vault file
unconditionally; a failed Graph fetch returns null (not throws), so while auth was expired it
overwrote 26 real tasks with a 4-line header — every morning since 13 July, spawning a
Syncthing conflict copy each time. Now guarded. 26 tasks restored (14 Planner + 12 To-Do).

**4. Task visibility + ranking.** Engine saw 18 tasks; `/api/todos` had 91. Added
`vaultCache.getPlanTasks()`. Then REVERTED most of that per `Tasks/Task System Boundary.md`
(10 Jul) — the one-file rule. Plan tasks now filtered to a ±14-day window (currently 0 of 73
qualify; the plan ended 16 days ago). `collectPlanClosure()` raises the finished plan as ONE
Tier 2 decision instead of 73 nags. `collectOverdueTodos()` now uses `task-scoring.rankTasks()`
instead of a flat 65, so the brief names a real next action instead of "101 overdue tasks —
Top: Succession plan" (a 2022 Planner item that scores 0). Overdue: 7 → 101 → **28**.

**5. Email markdown.** Synthesis rendered literal `**asterisks**`; now converted, with escaping.

## THE OPEN ITEM — promotion

**Capture is fine. Promotion never runs.** Four working paths into `Master Todo.md`
(manual, `/api/capture/todo`, chat, SARA suggestion approval). But `action-candidates` is
only ever called from `vault-hooks.onVaultWrite()`, which fires when NEURO writes a note.
Notes written in Obsidian arrive via Syncthing — a file copy, not a NEURO write — so nothing
is ever proposed. Embeddings (2am) and entities (10pm) both have nightly jobs; action
extraction never did.

`scanRecentNotes()` is written and committed (`backend/services/action-candidates.js`) —
**dry-run by default and NOT yet scheduled**. Before enabling it:
- Candidates at ≥ `AUTO_PROMOTE_CONFIDENCE` (0.93) write STRAIGHT into Master Todo, no review.
- Run `scanRecentNotes({ days: 7, dryRun: true })` first; read `wouldCreate` / `wouldAutoPromote`.
- `shouldSkipPath` was widened (Scripts/, .stversions/, .trash/, .claude/, Conflicts/, nested
  Archive/, sync-conflict copies) — without it a sweep hits ~10k generated checkboxes.
- Vault has ~3,000 open checkboxes; by the boundary rule only Master Todo's 18 are tasks.
  Meetings (1153) and Projects (1101) are records, NOT a task list. Do not auto-promote them.

## OTHER KNOWN ISSUES (not fixed)

- `startDeviceCodeFlow()` caches the pending code forever — an expired code can't be replaced
  without a pm2 restart. Burned three codes on this today.
- `fetchPlannerTasks()` uses `?$top=200` with NO `@odata.nextLink` handling. Returns 275 today
  (261 completed), so it isn't biting — but as completed history grows it will silently push
  active tasks out. Same failure class as the overwrite bug: fails quietly.
- 4 Planner tasks have no due date and are invisible to the engine — the undated fix only
  catches `priority: high`, and MS tasks are written as `normal`.
- `addTodoToMasterList()` still writes `#mustdo`, retired 10 July per the boundary doc.
- 3 stale Apple push subscriptions from the old PWA install. Not pruned — NEURO only stores
  endpoint prefixes, so they can't be targeted without risking the live one.
- Syncthing conflict copies still in `Tasks/`. Nick's call to delete.
- `sara/backend/public/` build output got committed in the merge.

## NEXT

1. Dry-run `scanRecentNotes`, review the numbers WITH Nick, then decide auto-promote policy
   and add the nightly cron.
2. Triage the 28 overdue — top score is only 51/100, which suggests much of it is dead.
3. Watch the 9am brief land tomorrow. That's the real test: does he read it.
