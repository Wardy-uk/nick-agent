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

**6. Plaud meeting notes were named after the tab, not the meeting.** PLAUD's `data_title` is
the summary TAB name — almost always the literal "Summary" — and it came first in the fallback
chain, beating `recording.name` (the real meeting title). So every routed meeting note landed
as `<date> – Summary.md`, then `Summary 3`, `Summary 4` as collisions piled up. Nick looked at
his vault, searched for "Experience Enablement Charter", saw "Summary 3", and reasonably
concluded imports had stopped. They hadn't. `pickNoteTitle()` in `plaud-sync.js` now skips
generic tab labels. `plaud_summary_tab` deliberately unchanged — `looksLikePlaudSummary()` and
`getPlaudSummaryPreference()` in imports.js key off it.
Proven live: `Meetings/2026/07/2026-07-01 – Performance Review Zoe Rees - Workload, Support,
and KPIs.md`. **Forward-looking only.**

## THE PLAUD BACKLOG — where this was left

Sync itself is healthy (ran 08:01–08:04 on 12 Aug). Windows and Pi vaults are byte-identical,
so Syncthing is fine. Three separate problems were found:

### STATUS AT END OF SESSION — A and B are DONE

**A (repull): DONE.** `present 217 → 292 / 295`, `missing 76 → 3`. 73 recovered.
The 3 left: two (`07-07 Weekly Meeting: Customer Success…`, `07-22 Weekly Meeting: Project
Delivery…`) fail repeatedly with `MCP error -32001: Request timed out` — both are among the
longest recordings, so the transcript fetch is likely exceeding the MCP timeout. Retried
explicitly, failed again; **this needs a code fix, not another retry.** The third is
`08-12 Meeting: Team Performance, KPI Revisions…` — recorded after the last sync, arrives on
the next 08:00 run.
Gotcha that cost an hour: `nohup … &` inside an ssh command dies with the session. Use
`setsid nohup … < /dev/null & disown`. The first run silently stopped at 24 of 76 and looked
like Plaud rate-limiting when it was just a killed process.

**B (rename): DONE.** `renamePlaudSummaryNotes(root, {apply:true})` — **101/101 renamed, 197
links rewritten across 128 files, 0 failures**, in 680ms.
Backups: `Scripts/.lint-backups/2026-08-12T14-54-41-880Z` (229 files).
Report: `Documents/System/Vault Audit/PLAUD Summary Rename 2026-08-12.md`.
Verified after: 0 generic `– Summary` notes remain; **0 broken links caused by the rename**.
(One candidate turned out to be a 23-June file in `Conflicts/` — an excluded dir the pass never
walked — pointing at a path that has never existed. Pre-existing, not ours.)
Remaining cosmetic debt: **97 stale ALIASES in 34 files** — `[[new name|2026-06-03 – Summary]]`.
The links resolve; only the display label is outdated. Mostly `Daily/` notes and `MOCs/Orphan.md`.
Worth a follow-up alias-rewrite pass, low priority.

**C (empty transcripts): STILL OPEN.** 9 stubs, `POST /api/plaud/repull-stubs`.

### Original findings (kept for context)

**A. 76 of 293 recordings had no note at all (26%).** Not trivia — performance reviews, 1-2-1s,
a return-to-work HR discussion. `POST /api/plaud/repull` with `{}` was started in the background
on 12 Aug ~13:20 and was still running at hand-off (~9 of 76 done). It is throttled (750ms gap,
concurrency 1), 429-backoff, and **ledger-persisted so it resumes** — safe to re-run if it died.
Check: `POST /api/plaud/reconcile` (read-only) returns `{total, present, missing[]}`.

**B. 101 existing meeting notes are still named `– Summary N`.** The repull does NOT fix these —
it only fetches recordings with no active note, and these already have one, so reconcile counts
them `present` and skips them. **This is the next real piece of work.** A rename pass must:
- recover the true title — all 101 carry both `plaud_id` and `transcript_path`, and the
  transcript filename already holds the descriptive title, so it works OFFLINE, no API needed
- rename the file
- rewrite **197 wikilinks across 128 files** — skip this and the graph breaks
- handle same-date collisions, back up first
Build it in `vault-hygiene` (backups to `Scripts/.lint-backups/<ts>/`, changelog, idempotent,
dry-run first), not as a one-off script. Review the proposed names WITH Nick before applying.

**C. 9 of 216 transcripts are empty stubs** — "No transcript returned by Plaud for this
recording". Summary is fine, raw text missing; looks like Plaud-side timing (summary ready
before transcript). `POST /api/plaud/repull-stubs` exists for exactly this. Run after A finishes.
Also `Plaud/Transcripts/2026-08-11 undefined.md` — a recording Plaud never named.

Note: every recording legitimately produces TWO notes — summary → `Meetings/`, transcript →
`Plaud/Transcripts/`, cross-linked. That pairing is correct, not a bug.

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

## THE DRY RUN WAS DONE — do not schedule the sweep as-is

`scanRecentNotes({days:30, dryRun:true})` → **562 candidates, 562 auto-promote (100%)**. Any
unchecked `- [ ]` scores 0.93 and `AUTO_PROMOTE_CONFIDENCE` IS 0.93, so every checkbox promotes
itself. It would have turned an 18-item list into 368 overnight. What it wanted to add:
"Chris to provide updates on the TPFG GRS release" (someone else's), "**WP-51** Grant NTPJ
permission" (NOVA backlog), 258 items from one PIP meeting-actions record.

`#accepted` is dead as a signal — last used 15 July, only on hand-written 1-1 prep notes,
never on a Plaud import. Do not build on it.

**Agreed design instead — owner classification, review-only:**
1. Scope to `## Next Arrangements` / Actions / Follow-ups / Next Steps in `Meetings/` ONLY.
   Kills the PIP file, the NOVA backlog and ~10k generated checkboxes in one move.
2. Classify by leading actor, validated against the `People/` index (42 entries) so verbs
   aren't misread as names — "Reclassify Lomond" and "Remind Taus" both fooled a naive regex.
   Match BOTH "<Name> to …" and "<Name> will …"; missing the "will" form put Catherine's
   actions in the unowned bucket.
3. Measured over 23 meetings (Jul–Aug), 261 action lines:
   **A. named Nick 48 (18%) · B. named someone else 45 (17%) · C. unowned 168 (64%)**
   B is excluded automatically — that IS the "don't carry other people's actions" rule.
4. Auto-promote OFF. Everything goes to the `suggested` queue `/api/todos` already returns and
   `suggestion-engine` can already approve. That machinery works; it has just never had input.
5. Approved → `addTodoToMasterList()` with `sourcePath`, so it lands in Master Todo Inbox with
   a backlink. One-file rule preserved.

**UNANSWERED — ask Nick:** start with A only (~8/week, high precision) or A plus filtered C?
Recommendation was A only, adding C later behind an action-verb filter that drops statements
of fact ("A follow-up meeting between Isabel and Mel is scheduled" is not a task).

## NEXT

1. Check the background repull finished (see PLAUD BACKLOG A); then `repull-stubs` for the 9.
2. Build the 101-note rename pass — dry-run, review with Nick, then apply. Biggest usability win.
3. Then the task extraction above, once Nick answers A vs A+C.
4. Triage the 28 overdue — top score is only 51/100, which suggests much of it is dead.
5. Watch the 9am brief land. That's the real test: does he read it.
