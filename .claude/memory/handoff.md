# Handoff — 28 Aug 2026: PLAUD sync was silently dropping meetings

## Why this session happened
Nick processed a 25 Aug 1-2-1 (Isabel Busk performance review) and it never appeared in
the vault. The last real meeting notes were **18 August**. Nine days missing.

## What was actually wrong — four bugs, all silent

**1. `get_file` metadata was being thrown away** (`plaud-sync.js`)
PLAUD's MCP now returns valid JSON followed by a human-readable hint paragraph *in the
same text block*. `JSON.parse` rejects that as "Extra data" and `callTool`'s fallback
returned the raw **string**. A string has properties — they are just `undefined` — so
nothing threw. Every note carried `plaud_id: "undefined"`, the generic "Summary" title
and the **sync** date instead of the meeting date. The 01:30 dedupe pass then *correctly*
archived ~86 of them as duplicates.
→ `parseLeadingJson` + `assertUsableDetails` (refuses unusable metadata per recording).

**2. The incremental window was "today only"** (`plaud-sync.js`)
`dateFrom` started AT `lastSuccessfulSyncAt`. A recording is only ledgered once PLAUD has
a summary; until then it is correctly skipped as "not ready". But the sync runs every 30
min and succeeds, so that stamp is always today — anything still processing at midnight
fell out of the window and was **never asked for again**.
→ `incrementalDateFrom` (pure), `PLAUD_SYNC_LOOKBACK_DAYS`, default 14.
**General trap:** any "sync since last success" loop whose readiness is decided by a
third party must LAG by longer than the thing it is waiting for.

**3. MCP timeouts were never retried** (`plaud-sync.js`)
`isRetryableError` matched `timeout`; the SDK says `Request timed out` (-32001). All 4
recordings in the failed ledger died on attempt 1 with 3 retries unused.

**4. Frontmatter quotes** (`knowledge-memory.js`) — found late, and the nastiest
`parseFrontmatter` does NOT strip quotes. `normalizePlaudId` in that same file already
did, which is why grouping by id worked while everything else silently did not:
- three `note_type === 'summary'|'transcript'` comparisons were false for every note
  plaud-sync has ever written;
- `noteDateParts` did `new Date('"2026-07-16T..."')` → Invalid Date → fell back to
  `new Date()`, so a July meeting's consolidated note was dated **today**.

## Result
Ledger 5 → 11 of the recent recordings; notes land correctly named/dated, e.g.
`Meetings/2026/08/2026-08-25 – Performance Review Isabel Busk KPIs, Workflows, and
Operational Planning.md`, routed as a 1-2-1 with a linked transcript.
Remaining gaps are meetings Nick has not processed in PLAUD yet — correctly skipped, and
they will now be collected whenever he does rather than expiring overnight.

## Vault cleanup done (on WINDOWS — canonical; Pi is the replica)
- 7 mis-named orphans + 6 empty transcript stubs → `Archive/` (**moved, never deleted**),
  each verified against its correctly-named replacement first (0.81–0.87 body similarity;
  the gap is routing enrichment).
- Zero `plaud_id: "undefined"` files left in the live vault.
- The 86 already in `Archive/Summary Duplicates/` were left — Archive is excluded from
  embeddings and entity extraction, so they are inert.

## The transcript-folder thing (resolved, but read this before "fixing" it again)
`backend/.env` deliberately sets `PLAUD_TRANSCRIPT_FOLDER=Plaud/Transcripts`. **That is
correct.** 311 transcripts are there and are the largest single source in the embeddings
index (308 files / 4,378 chunks). `Meetings/transcripts` holds **zero**.
Two CONSUMERS had hardcoded the empty default — that was the real defect:
- `knowledge-memory.RAW_FOLDERS` (raw-intake had never read a transcript; the `+3`
  promotion score was dead code). Both paths now listed — the old one is still where a
  rescued stray goes.
- `imports.canonicalizePlaudTranscript` would have relocated all 311, and because
  `routePlaudSummary` runs BEFORE the move with the pre-move path, left 300+ summaries'
  `transcript_path:` pointing at files that had gone. It now refuses to move a transcript
  already inside the configured folder, while still rescuing a genuine stray.

## ⚠ OPEN DECISION — Plaud consolidation stays OFF (Nick's call, 28 Aug)
`groupPlaudNotes` only considered notes under `Plaud/`. True once; summaries are now
routed to `Meetings/YYYY/MM/`, where **222 notes carry a `plaud_id`**. So the pipeline
sees **2 recordings out of 222**.

Behind **`PLAUD_CONSOLIDATE_ALL`, default OFF**. Measured: flag off → 2 items; flag on →
**219 notes written**, at 30/hour, each landing in `Meetings/YYYY/MM/` **beside the
summary it was built from**, and stamping every source note's frontmatter.

**A sample was generated and reviewed. It was worse than the note it consolidates:**
- content reduced to the opening paragraph + a truncated snapshot (the KPI detail, the
  bottlenecks and the action items were all dropped);
- nested wikilinks that cannot resolve —
  `[[Meetings/.../2026-08-25 – Performance Review [[Isabel Busk|Isabel Busk]] KPIs...]]`;
- redundant `[[X|X]]` aliases.
The sample was deleted and both source notes unstamped.
**Do not enable the flag.** It needs the link-nesting fixed and the body actually carrying
the summary's content first — that is a build, not a toggle. (The date bug it also
exposed IS now fixed.)

## Still outstanding (small)
- **4 recordings in `failedRecordings`**, all `Request timed out`: `ad0bb8d3` (9 Jul),
  `5ee6e45d`, `66389e90` (both 12 Aug), `79c942d4` (18 Aug). Retry is fixed now, but the
  three July/early-Aug ones sit outside the 14-day lookback, so they need
  `repullPlaudRecordings({ids})` to come back. Nick has not asked for these.
- `Plaud/Summaries` holds only 2 files (everything else routes to `Meetings/`), so the
  `+5` promotion score for that folder is near-inert. Not touched.

## Commits (all deployed; Pi on `8434a5d`, 1086 tests passing)
- `85d37cc` metadata parse + lookback window
- `012abd3` MCP timeout retryable
- `c261b5b` transcript folder consumers
- `7e0c8ee` PLAUD_CONSOLIDATE_ALL flag (off)
- `51a515b` note_type quote fix
- `8434a5d` quoted-date fix
- `df08db4` CLAUDE.md

## Deploy notes that mattered
- `export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH` before any pm2 command.
- Pi DB is `/mnt/data/nuero/backend/db/agent.db` (note the `db/`), open `?mode=ro` to
  inspect while running.
- Scratch scripts go in `/tmp` on the Pi, never the repo tree (blocks `--ff-only`).
- Git Bash heredocs mangle backslashes — build regex/paths with `String.fromCharCode(92)`
  in probe scripts, or write them without escapes.
