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
  (`Docker Desktop Installer.exe` 537M, `Plaud Setup 1.0.5.exe` 115M). Syncthing is
  replicating those to every device. Junk, and they also break any git-based backup.

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
