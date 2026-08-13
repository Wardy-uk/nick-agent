> ## ✅ RESOLVED 2026-08-13 11:40 — it was a Node ABI mismatch, NOT a bad platform/prebuild
>
> **NEURO is up on better-sqlite3 v13.0.3. Do NOT roll back the migration — that advice below is
> superseded.** All three apps online, endpoints 200, `integrity_check ok`, 574 state / 33,745
> entities (grown since 12 Aug, so nothing was lost and no restore was needed).
>
> **Real cause: the PM2 daemon ran Node 20.20.2 while the shell and `npm install` ran Node 22.22.2.**
> A native module built for one Node ABI cannot load in the other (`NODE_MODULE_VERSION 115` vs
> `127`). Proved by loading the same binary under both runtimes: Node 22 → OK; Node 20 → silent
> death. That IS the "segfault". The prebuild inventory was a red herring — a clean install ships
> `linux-arm64.node`; the earlier missing-prebuild reading came from a half-repaired module dir.
> It ran fine on 12 Aug only because `pm2 restart --update-env` injected the shell's Node 22 into
> the process env; once the router outage forced restarts from the daemon's own env, it fell back
> to Node 20 and crashed.
>
> **Fixes applied (all verified):**
> 1. Removed the conflicting root-level `better-sqlite3: ^11.10.0` (`git checkout package.json
>    package-lock.json`). backend/package.json's `^13.0.3` is the single declaration again.
> 2. Deleted both installed copies and reinstalled clean under Node 22. `prebuilds/linux-arm64.node`
>    present; the other session's hand-edits (`prebuilds.disabled-*`, hand-compiled build/Release)
>    are gone.
> 3. Deleted **1.1GB of core dumps** (`backend/core.*`, 34 files) left by the crash loop.
> 4. `pm2 update` — daemon now runs Node 22.22.2, matching the nvm default.
> 5. **`/etc/systemd/system/pm2-nickw.service` hardcoded Node 20 in both `Environment=PATH` and
>    `ExecStart`** — this was the real landmine: the fix would have survived only until the next
>    reboot. Regenerated via `pm2 startup systemd` under Node 22. Backup:
>    `pm2-nickw.service.bak-20260813`.
> 6. Verified by *cold-boot simulation*: `pm2 kill` then `systemctl start pm2-nickw` → service
>    `active`, all three apps online, neuro-backend on v22.22.2, restart counters 0. Also survives
>    a plain `pm2 restart` with no `--update-env`.
>
> **Prevention:** any native module is now hostage to Node version drift — sql.js was pure JS and
> immune. If the backend ever dies right after an `npm install`, check
> `readlink -f /proc/<pid>/exe` for the app vs the node that ran the install BEFORE suspecting data.
>
> **Still open:** `sara-backend` runs under Node 20.20.2 even after the daemon moved to 22 (its
> saved env pins it). It is healthy, and forcing it to 22 risks breaking native deps built for 20 —
> left alone deliberately. Also `sara_actions` holds ~4,240 pending rows; a purge policy is still
> worth doing.
>
> <details><summary>Original (superseded) diagnosis — kept for the trail</summary>
>
> **Cause: better-sqlite3 v13.0.3 segfaults (exit 139) on this platform.** Not the data:
> - `sqlite3` CLI reads `db/agent.db` perfectly — `PRAGMA integrity_check` → **ok**, 55 tables, WAL.
> - `require("better-sqlite3")` succeeds, but `new Database(":memory:")` segfaults — so it is not
>   the file, not corruption, not the WAL. Instantiation itself crashes.
> - Root of it: the hoisted module is at `/mnt/data/nuero/node_modules/better-sqlite3` (workspace
>   root, NOT backend/) and ships prebuilds for `linuxmusl-x64`, `darwin-arm64`, `linux-x64` —
>   **no `linux-arm64`**, and the Pi is aarch64.
> - Tried: `npm rebuild` in backend/ (no-op, no copy there); `npm rebuild --build-from-source` at
>   root (reports success, compiles nothing — v13 uses prebuildify, not node-gyp);
>   `npm run build-release` in the module dir (DID compile `build/Release/better_sqlite3.node`);
>   moving `prebuilds/` aside so it cannot load a wrong-arch binary. **Still segfaults after all
>   of that.** `prebuilds/` is currently renamed `prebuilds.disabled-20260813`.
>
> **Data is safe and nothing is lost.** Preserved copies:
> - `/mnt/data/backups/crash-20260813-105423/` — agent.db + -wal + -shm as found
> - `/mnt/data/backups/agent.db.pre-bs3.20260812-185140` — **pre-migration, 63MB** ← restore target
> - `/mnt/data/backups/agent.db.20260812-123913` — 57MB, midday 12 Aug
>
> **Two ways out, Nick's call:**
> 1. **Roll back the migration.** Revert `00925c4` ("Migrate the database from sql.js to
>    better-sqlite3") + `41f738e` (its docs), restore `agent.db.pre-bs3.20260812-185140`, restart.
>    Known-good — sql.js ran for months. Loses whatever was written after 18:51 on 12 Aug.
> 2. **Downgrade better-sqlite3** to v11.x, which has broader prebuild coverage, and keep the
>    migration. One `npm i better-sqlite3@11 -w` at root plus a rebuild. Cheaper if it works.
>
> Confirmed working before the crash: the 105 stale suggestions WERE rejected and persisted
> (`sara_actions`: rejected 178). The Todos panel still showing 105 is IndexedDB cache, not state.
> Also `sara_actions` holds **4,240 pending** rows overall — worth a purge policy once up.
>
> </details>
>
> ---
>
> ## ⚠ RESOLVED — Pi 5 went offline 2026-08-13 04:01 BST (router, not the Pi)
>
> NEURO/SARA/quest are all down: the **host** is unreachable (ICMP, SSH :22 and HTTP :3001 all
> time out), Tailscale shows `Online: false`, last seen `2026-08-13T03:01:37Z`. Not an app fault —
> everything was verified healthy at 20:56 the previous evening.
> No remote path exists: pi-dev has been offline 46 days and nothing else at home is on the tailnet.
> Nick is 30 miles away and will look at it **this evening (13 Aug)**. Power/broadband are ruled
> out — his wife works from home and would have flagged it. So: SD card, PSU, the HDD, or a hang.
>
> **LEADING HYPOTHESIS (updated): the ASUS router, not the Pi.** Nick's wife's work PC is wired
> direct to the *broadband* router and was unaffected; the Pi is plugged into a *separate ASUS
> wifi router* that drives the rest of the house, and its wifi was dead. Corroborated by dmesg
> from the previous day: `macb eth0: Link is Down` flaps on 6 Aug and **three drops on 10 Aug
> starting 04:01:24** — the same minute-of-hour the Pi vanished on 13 Aug. It recovered then; it
> did not this time.
>
> **So check `uptime` FIRST.** ~32 days continuous ⇒ the Pi never rebooted, it only lost its link:
> router confirmed, Pi blameless, skip the crash forensics below. Near-zero uptime ⇒ it did
> restart, so work the list. Then `dmesg -T | grep -i "link is"` for the exact drop time.
>
> **If it is the router:** a Pi 4 standby plugged into the same ASUS is worthless for this failure
> mode — both die together. The cheap fix is moving the Pi 5 onto the broadband router alongside
> the wife's PC, removing the ASUS from its dependency chain entirely; or dual-homing it (wired to
> one, wifi to the other). Revisit the Plan B tiers with this in mind.
>
> **Nick confirms the ASUS router fails PERIODICALLY — this is a known recurring fault, not a
> one-off.** So the goal is removing the dependency, not root-causing a single incident. He cannot
> reach the router externally. Plan for the evening of 13 Aug:
> - `dmesg -T | grep -i "link is"` on the Pi — with ~32 days uptime this is a full history of every
>   ASUS drop since 12 July. Frequency and clustering turn "it plays up" into evidence. Pull it
>   early, before the ring buffer rotates.
> - SSH to the ASUS (AsusWRT/Merlin usually ships SSH **disabled** — Nick to enable it via
>   Administration → System while home). Want: uptime, free memory, syslog. The classic ASUS
>   failure is a memory leak that wedges the box every few weeks, which fits "periodic".
> - Mitigations, cheapest first: (a) move the Pi 5 onto the broadband router entirely; (b) smart
>   plug on the ASUS but joined to the **broadband** router's wifi, so it stays reachable when the
>   ASUS dies and can power-cycle it remotely/automatically — a plug behind the failing router is
>   useless; (c) scheduled nightly router reboot if it is a leak.
>
> **If it rebooted, capture evidence BEFORE anything rotates it:**
> 1. `journalctl --list-boots` — if only boot 0 exists, journald is volatile and the previous
>    boot's logs are already gone; say so rather than guessing at a cause.
> 2. `journalctl -b -1 -e` — last messages of the dead boot. Clean shutdown? Panic? Or just stops?
> 3. `last -x | head` — wtmp survives reboots and distinguishes crash from shutdown.
> 4. `vcgencmd get_throttled` — undervoltage/throttle flags since boot. **Note the HDD reports
>    `Power-Off_Retract_Count 275`, i.e. a history of unclean power loss — PSU is a live suspect.**
> 5. `dmesg -T | grep -iE "error|fail|panic|voltage|throttl|mmc|I/O"` — SD card errors matter most.
> 6. `sudo smartctl -H -A -d sat /dev/sda` — the HGST was clean yesterday; confirm it still is.
> 7. `systemctl --failed`, then `pm2 list`.
> 8. `tail -20 /mnt/backup/backup.log` — confirm the 00:00 snapshot landed before the outage.
>
> **Also open:** pi-dev (Pi 4) has been down since 27 June. It is supposed to run the worker, which
> is why the logs are full of `[AIRouting] Pi 4 worker failed for email_triage: fetch failed`.
> Tally may be down with it. Nick wants a Plan B — agreed shape: **Tier 1** dead-man's-switch
> alerting + off-site copy of the backup (this is what was actually missing today — nothing told
> him), then **Tier 2** warm standby on pi-dev once it is proven stable. Tier 3 auto-failover
> was judged not worth the moving parts. A standby in the same house shares power and broadband,
> so it only covers Pi-specific death — that caveat was accepted.

# HANDOFF — Briefing chain revived, task sources fixed, Pi reconciled

**Session:** 2026-08-12. Everything below is deployed and verified live.

## STATE: Pi 5 == origin/main == `19996aa`

The Pi is no longer diverged. Clean working tree, on `main`, matching origin exactly.
Deploying is now `git pull && pm2 restart neuro-backend --update-env` again.

Backups taken before the merge (keep until confident):
- `/mnt/data/backups/agent.db.20260812-123913` (57MB)
- `/mnt/data/backups/.env.20260812-123852`
- Branch `pi-local-2026-07-31` @ `9e954f9` on GitHub — the Pi's pre-merge state, and the rollback point.

## THE TASK AUDIT (afternoon of 12 Aug) — READ THIS BEFORE THE PROCESS REVIEW

**Nick is mid-triage.** Worksheet: `Tasks/TRIAGE - All Open Actions 2026-08-12.md` — 538 tickable
lines, grouped by source, each tagged with its origin. **Nothing has been logged anywhere new.**
He closes what's done, THEN we review the process, THEN move what's left to Master Todo and delete
the PIP file + worksheets.

### Definitive count: ~521 distinct (538 worksheet lines)

| Source | Count |
|---|---|
| Meeting Actions — `Projects/PIP/Nick - Meeting Actions (2026-06 to 08).md` | 265 raw / 258 distinct |
| NEW — found in meetings, in no list | 29 |
| 90-Day Plan (3 files, deduped) | 169 / 159 distinct |
| Jira — genuinely open | 19 |
| Master Todo | 18 |
| MS Planner | 14 |
| MS To Do | 12 |
| Flagged Emails | 12 |

538 vs 521: the worksheet keeps each source's line as written rather than cross-deduping, on
purpose — for triage you want the original wording.

### Three findings that matter beyond this exercise

**1. Jira is lying to you. 1,005 unresolved tickets assigned to Nick; 986 sit in a
statusCategory="Done" status with no resolution set.** Real open workload is **19** (14 To Do,
5 In Progress). Any report on "unresolved assigned to Nick" is inflated ~50x. Worth fixing at
source — those 986 need bulk-resolving.

**2. Ran the owner classifier over 2,875 previously-uncounted checkboxes across 9 vault areas.
Every single Nick-attributable action came from `Meetings/`.**
```
area                    raw   MINE  others  unowned-act  noise
Meetings               1404    128     333          420    523
Projects (excl NOVA)   1038      0      19          256    763
Daily                   208      0       1           65    142
Documents               160      0      16           53     91
Decision Log/MOCs/Personal/Reflections/Ideas  65  0  0   3   62
```
Projects, Daily, Documents, Ideas, Decision Log — **1,471 checkboxes, zero attributable to Nick**.
The boundary doc's "those are records, not task lists" is now measured, not asserted. (Ideas was
checked explicitly: 4 checkboxes, none his.)

**3. The consolidated view is UNREACHABLE.** `TodoPanel` exists and `App.jsx` routes `case 'todos'`,
but **`Sidebar.jsx` has no `todos` entry** (briefing/chat/capture/focus/dashboard/people/calendar/
meeting-prep/vault/inbox/plan/standups/journal/imports/recent/insights/pi-health/admin). **SARA
mobile has no todos tab either.** Only the nudge banner navigates there. I claimed earlier in the
session that "the single view already exists" — it does in code, but Nick was right that it isn't
a menu option. Fixing that is a prerequisite for any of this sticking.

### Of the 128 Nick-owned meeting actions, 99 were already in the PIP list, 29 were not

The 29 are mostly from **1-2-1s, which the PIP file excludes by design**, plus the 12 recovered
meetings. Several are people-management commitments (Heidi 1-2-1 feedback, design work for
Kayleigh/Isabel, circulating meeting notes) — the category you least want silently dropped.

### REVISIT AT THE PROCESS REVIEW

- **A+C was sized on NEW meetings (~41/week), never against the backlog.** There are **797
  unowned-but-actionable** items sitting in the vault (420 meetings, 256 projects). Feeding those
  into the review queue would recreate the 1,161 problem. Decide the backlog policy separately
  from the go-forward policy.
- **The 28 auto-promoted lines are still in Master Todo** (18 real items → 46). Mistagged
  `#mustdo`, under `## Links`, ~half not Nick's. Cleanup still pending Nick's go-ahead.
- `addTodoToMasterList()` appends to end-of-file when it can't find a `📥 Inbox` heading — Master
  Todo's headings don't match its pattern, which is why the 28 landed under `## Links`.

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
