# Session Handoff — 2026-08-17 (re-prioritise, then #119/#21, #38, #114, #59, #52, #107b)

## Shipped, deployed, verified live
`8ff4e51` #119(+#21) · `de69070` #38 · `7008955` #114 · `b921d06` #59 · `163f760` #52/#107b

Pi **457/457**, backend online, `unstable_restarts` 0, local at `163f760` = origin/main.
⚠ **Local 462 vs Pi 457 is NOT a regression** — it is the other session's uncommitted
`prompt-parity.test.js`. The same 5-test gap existed at session start (Pi 430 / local 435).

## ⚠ The second session is STILL live and still uncommitted
Same ~14 files as yesterday, unchanged: `CLAUDE.md`, `routes/{capture,imports,journal,
standup}.js`, `services/{ai-provider,briefing,claude,decision-engine,imports,nudges,
scheduler,standup-session}.js`, `prompt-parity.test.js`, `sara/app/src/views/{Focus,
Tasks}.jsx`, `services/sara-voice.js`.

**`CLAUDE.md` is STILL OWED** — now for #26/#40/#42 *and* #119/#38/#114/#59/#52/#107b.
I did not write it, for the second session running, because it is one of their modified
files and editing it is exactly how the 16 Aug PeopleBoard incident happened.
**Write it the moment their work lands.**

I routed around them twice rather than sharing a file: the #114 read route went in a new
`routes/features.js` instead of `routes/capture.js`, and #52 was cut at the SOURCE
(`working-memory`) so their guarded readers in `claude.js`/`standup-session.js` no-op
without being touched.

## The re-prioritisation (the actual first job)
66 open items → **64** after correcting nine rows. Four premises were stale or wrong:

- **#5/#78(a) "929 pending action candidates, do first" was already DONE.** Pi shows
  **5 pending**, not 929: 622 rejected + 51 executed. Nick's #108 bulk-reject pass did it.
- **#107's churn had already stopped.** Creation: 14 Aug **7,096** → 15 Aug **4** →
  16 Aug **1**, once `persistSuggestions` gained its write-side dedupe guard. So (a) was
  moot and only the index half was real.
- **#106 is narrower than written.** `capture_todo` ×51 and `chase_commitment` ×2 HAVE
  executed. What has never run is any **outbound** executor — no `reply_email`,
  `schedule_focus_block` or `complete_task`. The 14 Aug `draft_reply` (action 15814) is
  still pending. Still two minutes, still Nick's.
- **#21 understated itself** — see below.

## #119 (+#21) — `npm test` was writing to the live vault
`node --test` globs `test-*.js`, so all four Tier smoke scripts ran on every invocation
and were counted in the suite while asserting nothing. `test-tier1.js` defaulted
`OBSIDIAN_VAULT_PATH` to the REAL vault and created a prep note and a meeting note in it.
Renamed all four to `smoke-*` (that is what removes them from discovery), stripped the
real-vault defaults, put tier1's remaining write behind `--allow-writes`.

**#21's row said only "a comment and a test mention it".** It did not *mention* it —
`test-tier1.js` required and EXECUTED `one-to-one-prep.js` against the real vault on
every test run. That is gone, so the file now has **zero code consumers**. I did NOT
delete it: NOVA confirmation is blocked behind #116, and deleting on an unconfirmed
premise is the trap this repo keeps hitting.

## #38 — the ticket was backwards, and building it as written was a regression
It claimed aliases would rescue the ambiguous first names (`nathan`, `andrea`, `chris`).
Measured: **30 of 41** notes carry aliases (not 17 of 42), and **`Chris` is listed on BOTH
Chris Middleton and Chris Smith**, `Nathan` on both Nathans. The file does not
disambiguate those names, it asserts them twice — trusting it re-creates the four-Lucys
bug. It could never have worked regardless: `parseFrontmatter` returns `""` for a YAML
block list, so `fm.aliases` is empty for all 30.

So an alias earns the same uniqueness test a first name gets, with **three** rejection
rules — the middle one is the one the ticket missed: two people claim it; it is a first
name the ROSTER finds ambiguous (only Andrea Melisa lists `Andrea`, but a second Andrea
exists); or it is someone else's full name. What survives is the real value: `Seb`,
`Nath`, `Steve R`, and the Plaud mis-transcriptions — **`Naomi Winkworth` to Naomi
Wentworth means #39's phantom person is already solved in data**, before any rename.

⚠ **Two live bugs found while building, both silent:**
1. An alias TIER in `matchLocal` is the obvious implementation and is wrong. `Nath` is
   Nathan Button's alias, Button has no `email:` so he is not in the contact list, the
   tier matched nothing — and execution **fell through to "starts with", returning Nathan
   RUTLAND**. The alias now canonicalises the QUERY up front, so every tier below matches
   the real name and Graph is asked for "Nathan Button" not "Nath".
2. A name the ROSTER knows is ambiguous resolved anyway when only one candidate had an
   address — `localContacts()` is built from notes with `email:`, so it cannot see the
   ambiguity. "Nathan" resolved confidently to Rutland.

**Feedback loop (Nick asked mid-session):** an address typed by hand is now written back
to the People note. The hazard is the WRITE, not the loop — `updateFrontmatter` drops
list values, so writing through it would have deleted the `aliases:` block this commit
just made load-bearing. Hand-written single-line edit, backs up first, preserves CRLF,
**never overwrites an existing address**, never invents a note, and can never fail the
override it hangs off.

Checked and NOT a problem: 26 of 41 People notes have no `email:`, but **all 13 direct
reports do** — the gap is peers, leadership and auto-stubs, where the Graph fallback is
the intended path. I called this a booking hazard before checking; it is not.

## #114 — captured features can be read back
`GET /api/features/captured` + a count and the last three under the CapturePanel composer,
shown while a feature is being TYPED as well as after one is filed. Scoped to the capture
section only — listing the ranked sections would make it a second, worse backlog view.
Handles this file's **duplicate numbers** (sorts by number, file order as tie-break,
dedupes nothing) and separates "none captured" from "couldn't reach the tracker".
Verified against a running server, not just the suite.

## #59 — off-site backup is LIVE and restore-tested
Nick supplied a B2 key mid-session, so this went all the way rather than stopping
at "built". Bucket `pi5-neuro-offsite` (private), rclone `crypt` with filenames
AND directory names encrypted, nightly root cron 02:20, watchdog monitoring.
**First copy 2.05GB in 12 minutes; incremental runs ~2 minutes.**

Ships the irreplaceable half only: vault 895M (4,369 files) + Home Assistant 965M
+ ONE current agent.db 235M + syncthing 11M. `backups/` excluded deliberately —
2.1GB of 28 rotated copies of the same DB, derived and growing daily.

**The restore was actually performed, not assumed**: `integrity_check` returned
ok, 308,562 health samples / 150 tasks / 287 waiting_on readable, a People note
came back as plain text with frontmatter intact, and `rclone ls` on the RAW
bucket shows only ciphertext paths. Bucket lifecycle set to
`daysFromHidingToDeleting: 1` via the B2 API — without it a nightly 250MB DB
version would eat the 10GB free tier in six weeks, invisibly, because the
size check in that script only counts current files.

⚠ **Two follow-ups for Nick**, both in `backend/scripts/backup-offsite-SETUP.md`:
1. **Store the crypt password + salt off the Pi.** They are in
   `/root/.config/rclone/rclone.conf`, which is inside the thing being backed up.
   Lose both and the off-site copy is unrecoverable ciphertext.
2. **Regenerate the B2 master key.** He pasted it into the chat, so treat it as
   exposed — and a master key can delete buckets and mint further keys, so it was
   the wrong credential for a cron job regardless. I created a **bucket-scoped**
   key (`pi5-offsite-backup`, listBuckets/listFiles/readFiles/writeFiles/
   deleteFiles) and swapped it in; the master key is no longer in the config and
   regenerating it breaks nothing here. Writes were re-verified after the swap.

⚠ A doc bug worth remembering: the first restore check used
`nuero-vault/CLAUDE.md`, which is not at the vault root — it returned empty and
looked like a failed restore when nothing was wrong. **A verification that can
pass or fail by absence is not a verification.**

## #52 / #107(b)
#52: verified dead before removing (`getPlan()` returns null, folder archived 12 Aug). It
was **more than three places** and it re-walked the vault on EVERY request because a null
is not cached — one copy on `/focus`. Cut at the source; `decision-engine`'s
`collectPlanClosure` opens `if (!p || !p.over ...)` so null short-circuits identically —
checked, not assumed.
#107(b): added `type` + an expression index on `json_extract(payload,'$.sourcePath')`.
Confirmed with EXPLAIN QUERY PLAN that both scoped reads now SEARCH rather than SCAN —
an expression index whose text does not match the query exactly is ignored silently.

## ✅ Apple Health — the sync FINISHED, and everything arrived
Confirmed stopped (row count stable across 20s). Measured at completion:

| | 16 Aug afternoon | sync complete |
|---|---|---|
| Samples | 277,437 | **1,048,465** |
| Metrics | 13 | **66** |
| DB size | 235 MB | **447 MB** |

`heartRate` **479,296** · `hrv` **42,564** · `respiratoryRate` 35,121 ·
`blood_oxygen_saturation` 21,163 · sleep core/rem/deep/awake — all current to
16:32. **HRV units are sound**: none ≤ 0, only 23 below 5ms, mean 23.3, max 175.
I raised a worry that `stress-score` works in log space and `log(0)` is `-Inf` —
checked it: the scorer already filters `value > 0` before the log, and there are
no non-positive samples anyway. Not a bug.

**`/api/health/stress` left `calibrating` on arrival**: `status:"ok"`, score **19
("Very low")**, hrv 35.9, `baselineDays: 15`. So **#43 closed itself with no
code**, exactly as the parked row predicted — the backfill carried the history
with it, so a calibrating placeholder was never actually served to Nick. Tracker
updated: #43 closed, #41 confirmed live.

⚠ **One real finding, captured as #122.** Every night carries BOTH a staged
breakdown from the Watch (core/deep/rem) AND a single whole-night
`sleep_asleep_unspecified_hours` sample from a second source — 14 Aug is
core 6.23 + deep 0.62 + rem 0.53 = **7.38h staged** beside ONE unspecified sample
of **8.92h**. `GET /api/health/sleep` returns only `awake` + `asleep_unspecified`
and takes `asleepHours` from the unspecified value, **so the staged breakdown
never reaches the card built for it**, and 16 Aug reads 10.42h. Prefer the staged
source, and never sum both (that double-counts to ~2x). **The ingest is fine** —
this is a read-time rollup choice. `efficiency: null`, `inBedHours: 0` and
`currentHr: null` are all BY DESIGN, not symptoms.

⚠ **Two uncosted knock-ons.** The DB nearly doubled, and `backup-data.sh` keeps
**28** rotated copies — so `/mnt/data/backups/nuero-db` heads for **~12.5 GB**
and grows with every sync. And the off-site payload goes ~2.05 → ~2.26 GB against
B2's 10 GB free tier: fine now, but that is the number to watch.

## NEXT
**Nick, in the office / on his phone:** #116 NOVA msgraph re-auth (2 min, unblocks
#115/#117/#118 — best ratio on the board) · #2 Teams consent · #99 the 287 ·
#106 approve the pending `draft_reply` .

**Code, in order:** **#30** (Outlook moves don't come back — the card describes a meeting
that isn't there; NOT started, nothing half-done) · **#50** (`/api/todos/moscow` legacy
path) · **#36** (people-gap review UI) · **#31** (stale 1-2-1 Tracker) · then the NOVA
trio behind #116.

⚠ Left deliberately: the now-unreachable 90-day-plan readers in `claude.js` and
`standup-session.js` — finish those when the other session's work lands.


---

# Session Handoff — 2026-08-16 night (#26, #40, #41, #42)

## Shipped, deployed, verified live
`0a88af9` #26 · `0032f38`+`1ce0a4b` #40 · `6ff90c8`+`9df11a4` #42 (+#41 with #40)
Pi suite **430/430**, backend online, `unstable_restarts` 0. Docs: `a0f612c`, `52ae96e`.

## ⚠ READ FIRST — a second session is live in this repo
The tree was CLEAN at session start and grew ~14 modified files I never touched:
`CLAUDE.md`, `routes/{capture,imports,journal,standup}.js`,
`services/{ai-provider,briefing,claude,decision-engine,imports,nudges,scheduler,standup-session}.js`,
`prompt-parity.test.js`, `sara/app/src/views/{Focus,Tasks}.jsx`, plus a new
`services/sara-voice.js`. **I diffed every file hunk-by-hunk before staging and
committed only my own.** Their work is still uncommitted — do the same.
**`CLAUDE.md` is OWED for #26/#40/#42 and I deliberately did not write it**: it is
one of their modified files, and editing it is exactly how the 16 Aug PeopleBoard
incident happened. Write it once their work lands.

## #26 — the phone had no route to the CURRENT standup
Not "add a tab". `NotificationActionCard` was calling the **retired** stepper
(`/api/standup/questions` + `/submit-guided`), which holds answers in browser
state until one final POST — the exact failure `standup-session.js` exists to end.
Nick chose both halves: a **Ritual** tab (`sara/app/src/views/Standup.jsx`) driving
`/api/standup-session/*`, and the standup/EOD arms **deleted** from the card.
- **The trap was ordering, not registration**: `resolveSaraLitePlan` checks the
  'sheet' list BEFORE the 'tab' list, so adding the id to `SARA_LITE_TABS` alone
  would have been a no-op that looked finished. Only standup/eod moved;
  journal/meeting/brain are still sheets and a test asserts it.
- `Standup.jsx` deliberately does **not** use `apiFetch` — it flattens a non-2xx
  body into an Error *message*, discarding `retryable` and the SAVED SESSION the
  503 carries. Uses a local fetch over a new exported `authHeaders()`.
- Which ritual opens is derived from **what is outstanding**, not a clock.
- `action-surfaces.test.js` parses `TABS` out of `App.jsx` and asserts
  registration in BOTH directions — the silent trap now fails a test.
- Live bundle carried build label `0a88af9`, `Ritual` present, `submit-guided` **0**.

## #40 — Apple Health transport. The brief's Phase 2 answered: NO tsnet needed.
**No Docker, no TimescaleDB, no poller, no second copy.** The FreeReps iOS app
posts straight into NEURO's existing `health_samples`. Verified by reading
`app/Sources/FreeReps`, not assumed: config has **seven fields and no credential**,
bare `POST {base}/api/v1/ingest/`, **URLSession with no delegate** (so no cert
pinning), `ping()` doesn't parse `/me` (only needs 200), `IngestResult` fields all
optional, and FreeReps' own tests run with **no Tailscale middleware**.
**Phase 3 was already built** — `stress-score.js` had the 14-day baseline all
along, so #40 was only ever transport and the scorer is unchanged.

### ⚠ A security bug I introduced and fixed — understand this before touching the guard
The app can send no credential, so I guarded by source IP and trusted loopback.
**pi5 serves `https://pi5.tailecb90f.ts.net` → `127.0.0.1:3001` with Funnel ON**,
and Tailscale proxies BOTH tailnet and public traffic **from loopback** — so that
guard published an unauthenticated write endpoint to the internet for ~20 minutes.
Now fails closed: `Tailscale-Funnel-Request` → always refused,
`Tailscale-User-Login` → accepted, direct `100.64.0.0/10` → accepted, **bare
loopback NOT trusted** (`APPLE_HEALTH_ALLOW_LOOPBACK=1` for curl).
**Nick's off-tailnet test confirmed the refusal empirically** — the log recorded
`tailscale-funnel-request` and a 403. I could NOT verify this myself: WebFetch
egresses from the local machine, which is on the tailnet.
**Before exempting ANY route from auth on this Pi, run `tailscale serve status` first.**

### Real-world gotchas found during setup
- **iCloud Private Relay** routes Safari outside the VPN → the `.ts.net` name
  resolved publicly → Funnel → 403 **with Tailscale on**. Turning it off fixed it.
- The app has **no HTTPS toggle** and normal mode is hardcoded to **port 443** —
  only "Test Mode" exposes a port field. Host = `pi5.tailecb90f.ts.net`, nothing else.
- Sync is slow because the app posts **50 points per request**. NEURO answers in
  4–5ms; the phone is the bottleneck and there is nothing to fix server-side.

## #42 — the score renders, sleep rolls up, firehose has a switch
`HealthCard` in **InsightsPanel** (already in the Sidebar, so no unreachable gap).
**The card must never look more certain than the service**: `calibrating`/`stale`
render **no number**, the service's own `detail` is shown verbatim, `caveats`
always visible. Fetches independently so a quiet activity feed can't hide it.
- **Caught by deploying and looking**: `?days=30` returned 0 metrics over a
  161,637-row table, because the backfill runs forward chronologically. Both were
  right and it read as a broken feed — route now returns `allTime` beside the window.
- `GET /api/health/sleep` — a segment belongs to the night you **WAKE** on, applied
  at READ time so the rule can change without re-ingesting. Efficiency is null
  without In Bed data, never a confident 100%.
- `APPLE_HEALTH_EXCLUDE` — **empty by default**; Nick asked for everything. Built
  because the first backfill measured the cost: `physical_effort` was 65% of the
  first 59k rows, `basal_energy_burned` is what FreeReps' own uploader refuses.

## ⏳ STILL RUNNING — pick this up first
The 24-month backfill is **in progress**: ~172,000 samples, **0 rejected**,
13 metrics, spanning Aug 2024 → Nov 2025. It is still in ACTIVITY metrics.
**HRV has not arrived yet, so the metric #40 exists for is unconfirmed on real
data.** When vitals land, check: HRV units are `ms` (the parser rejects anything
else rather than storing at an unknown scale), and whether `/api/health/stress`
leaves `calibrating` — the backfill brings history, so it may go straight to a
real score rather than waiting a fortnight.

## Also still true from the previous session
`escalation_alert_wide_seeded` may still be null — `checkEscalationAlerts` is
`*/5 8-18 * * 1-5`, weekdays only. **Unset is NORMAL. Do not "fix" it.**

## NEXT — on Nick, in the office
**#2** Teams consent · **#99** read the 287 · **#106** approve one action — all
three are in-office, tomorrow. Then **#59** (off-site backup) is the ONLY ranked
build left; everything else in the Order of play is P5 decisions or "later".
Tracker corrected this session: #25/#28/#69 shipped yesterday but still read
"Ready", and #26/#40/#41/#42 are now marked Done. New rows #119–#121 captured.



## Three of the four queued items shipped, deployed and verified live
`6eae9db`+`ac0d823` #25 · `ab4278d` #28 · `31b2a50` #69.
Suite **408 local / 408 Pi — the gap is still closed.** Pi clean at origin/main,
`unstable_restarts` 0. **#26 (phone standup) is the one NOT started** — see below,
it was left deliberately, not forgotten.

## Every ticket premise was wrong again. Three for three.
- **#25** said "zero hits for bank holidays". There IS a list — a hardcoded
  three-date array in `obsidian.parseNinetyDayPlan()`, wrong for its own year
  (missing 25 May 2026) and **dead** besides: the 90 Day Plan folder was archived
  on 12 Aug so that function returns null. And it was **five** Mon–Fri copies, not
  three (`shared/due-dates.cjs` had one too).
- **#28** said "logged decisions render nowhere". **Nothing was ever logged.**
  Table 0 rows; `Decision Log/decisions.md` held ONE entry in five months, a
  pleasantry with a doubled bullet. Both prompts document `[DECISION: text]`; the
  parser matched `[DECISION] text`. **Building the view as asked would have shipped
  an empty screen that looked finished.**
- **#69**'s premise held, and its hook (`dismissEmail(id,'replied')`) was exactly
  where the brief said it was.

## `6eae9db` — #25, and the harm was live, not hypothetical
`SEARCH_DAYS` is 21, and **31 Aug 2026 (Summer bank holiday) is a Monday inside
the live booking window.** Proved it: the naive predicate calls it a working day
and a six-person batch filled it. Deployed code now steps 28 Aug → 1 Sep.

`shared/working-days.cjs` (pure, browser-safe) + `backend/services/working-days.js`
(the data). **The failure direction is the whole design** — failing open books
meetings on Christmas Day, so it never falls back to "every weekday works".
`live → cache → compiled-in floor`, and `status()` always names which answered.
The floor works because gov.uk is a *static publication covering 2019–2028*, not a
live API. **Leave is not a property of the day**, so `leaveDates()` reads
`showAs:'oof'` from events the caller already holds; Graph's all-day end date is
**exclusive**. Verified on the Pi: 83 events fetched, `builtin → cache`, and a
week's OOF from 7 Sep pushes the slot to Mon 14 Sep.

⚠ Both frontends import `shared/due-dates.cjs` directly, so **they still get plain
Mon–Fri** — no DB route. Deliberate and commented. Both bundles were rebuilt and
checked for the inlined predicate, because a `.cjs` require inside a browser-imported
file is real bundler risk.

## `ab4278d` — #28, capture fixed first, then rendered
`parseDecisions()` is pure and exported; one test asserts **the PROMPTS still
document the form the parser accepts**, so a rename fails there instead of silently
emptying the table for another five months. `DecisionsPanel` got a **Sidebar entry**,
not just an `App.jsx` case. Full chain verified on deployed code against a
**scratch DB + scratch vault** (Nick's real vault untouched): parse → DB row →
vault line, leading bullet stripped.

## `31b2a50` — #69, the one-row version Nick chose
`sent_replies` + `GET /api/email/replies` + a collapsed **REPLIED** section in
InboxPanel. Recorded AFTER the send and **never allowed to fail the request** —
the mail has already left. **Recipient provenance is the real judgement**: on a
plain reply/replyAll GRAPH picks the addressees, so `recipients_source` is
`explicit|inferred|unknown` and the UI says "from the thread, not confirmed"
rather than presenting a guess as the record.

A bug my own test caught: `limit=-5` clamped to **1** and returned a single row,
which looks like the truth. Nonsense input now falls back to the default.

**The richer #69 (extract commitments from reply bodies into waiting-on) is now
buildable and was NOT built** — Nick picked one-row explicitly. It needs real
replies to calibrate against, and there are currently **0 rows**.

## ⏳ STILL PENDING, unchanged, no action needed
`escalation_alert_wide_seeded` — `briefing.checkEscalationAlerts` backfills on its
first widened run, cron `*/5 8-18 * * 1-5`, **weekdays only**. Today was Sunday, so
the flag is still null and 11 keys still absent from `alert_seen_ids`. **Monday
08:00 it records them silently and pushes 0. If you see it unset that is NORMAL —
do not "fix" it, and do not widen anything else in that file first.** I did not
touch `briefing.js`.

## #26 — the phone can't start a standup. NOT STARTED, deliberately.
Context was long and `mistakes.md` (16 Aug) is explicit that splitting a build
across the boundary is how half-done work gets committed. Nothing was begun, so
there is nothing half-done to inherit. The brief still stands in full:
- Backend is **done and needs no changes** — `/api/standup-session/:kind/{start,
  reply,finish,abandon}` + GET to resume. Transcript is saved **before AND after
  every turn**; a failure returns **503 `retryable:true` WITH the saved session**,
  so the client retries without Nick retyping.
- **The trap is registration and it fails silently**: a new tab id must also exist
  in `SARA_LITE_TABS` in `shared/action-surfaces.cjs`, or notification routing
  falls back to Focus with no error.
- Tab ids do not always mount what their name suggests — `voice` mounts **Capture**
  with `autoRecord`, not Chat. **Read `App.jsx`, don't infer.**
- Deploys via Netlify (`sara-nickward`, base `sara/app`). Verify against the LIVE
  bundle and check `VITE_BUILD_LABEL` on screen — that is what #110 was for.

## Two things worth carrying
- **A green suite still says nothing about routing.** Both new routes
  (`/api/time/working-days`, `/api/email/replies`) were called against the running
  server before being called done. `/replies` is top-level rather than under
  `/triage` precisely so it can never be parsed as an email id.
- **`obsidian.appendDecision` writes a `## date` header per decision**, so two on
  one day give two headers. Pre-existing, cosmetic, deliberately untouched.

## NEXT — still on Nick, not code
- **#40 Apple Health transport** — still the single biggest unblock, still a
  research task. `/api/health/stress` correctly reads `calibrating`.
- **The 5 escalations are real and unanswered** — NT-21284 is 65 days old.
- **#106** approve the one `draft_reply` (sends nothing, gate 1 of 2).
- **Write up the Nathan/Stephen 1-2-1s**, or the board keeps calling them overdue.
- **#2** Teams consent on an office day; **#116** NOVA re-auth (gates #115/#117/#118);
  **#59** off-site backup.

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
