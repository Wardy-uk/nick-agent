# Session Handoff — 2026-08-14 (1-2-1 detection, booking, Team board)

## What was done

**The problem.** The Team board showed people 100+ days overdue for a 1-2-1 who had
actually been seen in July. `last-1-2-1` in People frontmatter was hand-maintained
and froze on 2026-04-02, and three sources disagreed with each other: the
frontmatter, `Areas/1-2-1 Tracker.md`, and the meeting notes themselves. The notes
were right; nothing read them.

- **`services/one-to-one-detect.js` (new)** — derives `last-1-2-1` from `Meetings/`.
  Two rules do the work:
  1. **A prep note is not a 1-2-1.** `type: meeting-prep` notes are NEURO-generated
     *before* a meeting and carry `meeting-type: "1-1"` like the real thing. Heidi
     had five (14 Apr → 14 Aug), every one generated off the same stale
     `last-1-2-1: 2026-03-26`, none followed by a meeting note. Counting them would
     have closed the loop on itself.
  2. **Attribution needs the body to agree.** Plaud's `people:` links are
     incomplete — the 4 Jun "Remote Work Adjustment — Stephen Mitchell, Heidi,
     Naomi" note links only Stephen. So a candidate must also dominate the mentions
     (≥12 hits, ≥0.6 share), and a title naming 2+ of the team is a group meeting
     outright. That last rule was added because the 4 Jun note landed at exactly
     0.60 and squeaked through.
- **`services/one-to-one-booking.js` (new)** — "Book now" on each card. Two-step:
  `propose()` reads the calendar and returns a draft, `book()` creates it. Prefers
  PM (every entry in the vault tracker reads "PM"), falls back to AM, working days
  only, from `next-1-2-1-due` or tomorrow.
- **Board rebuilt** — cards now show the last 1-2-1 that actually happened, its
  title and up to 3 highlights, plus earlier ones behind a toggle. Prep buttons
  gone, "Book now" added.
- **Prep removed** — `POST /api/1to1/prep`, `GET /api/obsidian/people/:name/121-prep/latest`,
  and the MCP `generate_1to1_prep` tool. Replaced the MCP tool with
  `list_recent_1to1s`. NOVA owns prep now.
- **Vault data fixed** — 12 People notes stamped with real dates; two Kayleigh
  1-2-1s were mislabelled by Plaud (`meeting-type: "Client Meeting"` for a staff
  member) and relabelled; `People/Nathan Rutland.md` had 92 NUL bytes mid-file
  from a torn write (backup: scratchpad `NathanRutland.corrupt.bak`).
- **Roster** — Arman (left) and Willem (moved teams) archived in both the vault
  (`archived: true`) and `TEAMS`; Nathan moved to Customer Care, Sebastian to 2nd Line.
- Tests: 23 new (11 detect, 12 booking). Full backend suite 87/87.

## Follow-ups done in the same session

- **Booking rules (Nick, 14 Aug)** — never at 9am, never 12–2, never after 4.30pm,
  never onto an existing meeting, never more than 2 a day. Implemented as two
  windows (10:00–12:00, 14:00–16:30) so the first three are true by construction;
  the daily cap is `countOneToOnes()`, which matches existing 1-2-1s by subject
  however they were named. Verified live: Mon 17 Aug is now correctly rejected
  (a *tentative* 13:00–17:30 blankets the PM window) where it previously proposed
  09:00.
- **Every People note now carries `email:`** (15 of them, promoted from the body
  text the 30 Jun team-note merge left behind, each cross-checked against Graph).
  This was not cosmetic: **Naomi, Adele and Maria each have a personal
  gmail/yahoo address sitting beside their work one in Nick's Graph contacts**, so
  all three resolved `ambiguous` — which the booking path treats as unresolved and
  would have booked with nobody invited. `contact-directory` matches local
  contacts before Graph, so frontmatter short-circuits it. All 13 active reports
  now resolve `source: vault`. Keep `email:` populated for new people.
- **Nathan's 22 Apr 1-2-1 recovered.** He appeared to have none on record because
  the 2026-06-23 Plaud reset archived it. Restored the summary to
  `Meetings/2026/04/` and the transcript to `Plaud/Transcripts/`. Plaud had filed
  it against Nick Ward with Nathan as "Unknown Speaker 1", so the `people:` link
  was corrected on restore. He now reads 2026-04-22 (114-day gap).
  A holding note sits at `Meetings/1-2-1/Nathan Rutland/2026-08-14 – …Holding Note.md`
  — deliberately `type: note` with NO `meeting-type`, or the detector would count
  it as a held 1-2-1. It carries the never-closed commitment from April: a
  structured career-progression follow-up that was due 2026-05-06.

## PARKED — "make the team cards fully editable" (14 Aug)

Raised by Nick, then parked: **another session is also working on People**, so
nobody should refactor `PeopleBoard.jsx` without checking with them first.

The blocker if it's picked up: `role`, the team grouping and the grey note come
from the hardcoded `TEAMS` constant at the top of `PeopleBoard.jsx`, not the
vault — which is why moving Nathan to Customer Care needed a code edit. The
vault already holds `role`, `team`, `line`, `status`, `contract`, `cadence`,
`email` for everyone, so most of a vault-driven board is already there.

Two things to settle before building:
- `TEAMS` carries a PeopleHR id used only as a React key — droppable.
- Grouping does NOT map cleanly to existing frontmatter: Isabel is
  `team: Production, line: Production` but displays under "Digital Design", and
  Heidi is `line: 1st Line` under "1st Line Customer Care". Either add an
  explicit `board-group` field or pick one existing field and correct the notes.

## What's still pending

- **NOTHING IS DEPLOYED.** All of this is uncommitted on Windows. The Pi has not
  been touched, so the board still shows the March dates until it's deployed.
- ~~`book()` has never actually created an event.~~ **RESOLVED 14 Aug** — Nick
  booked Zoe via Book now: the event exists in Graph as `1-2-1 — Nick / Zoe`
  (18 Aug 15:00), `next-1-2-1-due` was stamped to 2026-08-18, and `last-1-2-1`
  correctly stayed at 2026-07-01. The daily cap then counted that real event when
  planning the batch, which is how the 18th correctly took only one more.
  `bookAll()` (the batch path) has still not been exercised against Graph.
- **Nathan Rutland has no 1-2-1 on record at all in 2026** and Stephen's last
  genuine one is 2026-03-26 (~20 weeks). Kayleigh's was 21 weeks until the
  mislabelled July note was corrected. These are real gaps, not data artefacts.
- **`services/one-to-one-prep.js` is now unreferenced** (only `scripts/test-tier1.js`
  touches it). Left in place deliberately — delete once NOVA is confirmed to cover
  everything.
- **NOVA integration is the open decision** — see below.

## Key decisions made

- **Detection over declaration.** Rather than hand-typing the dates found in the
  audit (which would drift again in a month), the dates are produced by the same
  code that now runs nightly. The one-off fix and the ongoing fix are the same path.
- **`syncPeopleNotes` only moves a date forward.** A manual entry more recent than
  anything on disk — a 1-2-1 held but not yet written up — is never overwritten.
- **Booking stamps `next-1-2-1-due` but never `last-1-2-1`.** A booking is not
  evidence a meeting happened; only a note is. Stamping both would recreate the
  original bug in a new place.
- **Propose never creates**, matching `event-parser`'s existing rule.
- **Only Nick's free/busy is visible.** Reading a colleague's needs
  `Calendars.Read.Shared`, which NEURO doesn't hold, so the invite goes out as a
  normal request they can decline. The dialog says so.

## Gotchas for next session

- **The vault is mixed CRLF/LF and `\r` is a line terminator in JS regex**, so
  `/^key:\s*(.*)$/` silently returns `{}` on every CRLF note — no error, just
  missing data. Normalise with `.replace(/\r\n/g,'\n')` at read time. `obsidian.js`
  dodges this by parsing with `indexOf(':')`+`trim()` rather than regex.
- **`\s*` in a frontmatter key regex also crosses the newline** and swallows the
  first item of an indented list. Use `[^\S\n]*`.
- Another session was live in this repo throughout (`ai-routing.js`, then
  `database.js` / `schema.sql` / `health.js` / `stress-score.js`). No overlap with
  these files, but re-run tests before deploying.
- `MEETINGS/1-2-1/<person>/` folders are near-dead (4 files across 16 folders) —
  Plaud routes 1-2-1s to `Meetings/YYYY/MM/` instead. One orphaned transcript in
  there is Hope's only surviving evidence, which is why transcripts count.

## NOVA integration — findings (item 10, for Nick's decision)

NOVA already has a full 1-2-1 system of record that NEURO duplicates in weaker form:
- `agent_121_sessions` + `agent_development_plans` tables (Azure SQL)
- `one21-service.ts` (864 lines): sessions, agent prep submissions, actions with
  delivered/missed/carried_over tracking, `completeSession(next)`, weekly KPI email,
  day-before reminders
- `getOne21Overview()` returns per-agent `lastDate`, `nextDate`, `overdue`,
  `dueThisWeek`, `outstandingActions`, `deliveryRate` — i.e. exactly what the NEURO
  card computes by inference
- `scanPlaudForOneToOnes()` already detects 1-2-1 recordings from Plaud titles

**The gap is small.** `routes/neuro-bridge.ts` already exists on the NOVA side
(auth via `X-Neuro-Bridge-Secret`) and NEURO already calls it via
`novaBridgeFetch` in `microsoft.js` — but it only exposes `/flagged`, `/status`,
`/calendar`, `/mail`. Adding `/one21/overview` is a handful of lines each side.

**Recommendation:** worth doing, but as a *read* first — have the card prefer
NOVA's `lastDate` when the bridge answers and fall back to vault detection when it
doesn't. NOVA knows about 1-2-1s that produced no note; the vault detector knows
about ones held without a NOVA session. Neither is complete alone. Do not move
booking into NOVA — NEURO holds the Graph token.

Open question before building: whether NOVA's `agent_development_plans` roster is
current (does it still list Arman and Willem?). Couldn't check — NOVA wasn't
running.

---

# Session Handoff — 2026-08-14 (actions, rituals, measurement, meetings)

Ran alongside the 1-2-1 session above, in the same working tree. Everything is
committed, pushed and deployed — local, origin and Pi all at `361df08`, backend
healthy. 153 backend tests + 34 SARA, CI now runs both suites on push.

**Read the "Outstanding" section below first — it is ordered to be worked through.**

## The one thing to internalise

**Five of the ten bugs found today were the same species: something existed, so it
looked done.** Config in this codebase lives far from the code that uses it, and a
service's presence proves nothing about whether it is switched on.

- `queueSummary` was read in 4 places and set by nobody — chat had never seen the queue
- `upsertCalendarEvent` was defined, exported, and **called by nothing**; `calendar_cache`
  had been empty since creation, so meetings never reached Focus and the "starting in
  10 min" push had *never fired*. Hidden because calendar VIEWS call Graph live
- `briefing` called `emailTriage.getTriagedEmails()`, which does not exist — caught and
  swallowed, so every brief claimed an empty inbox
- SARA mobile's stream parser listened for `chunk` while every provider emits `text`
- NOVA's Teams webhook (`agent_teams_webhook_url`) is **unset**, so its sender has never
  sent anything — and it targets a retired O365 connector API anyway

**Verify from the running system** — pm2 logs, `/api/status`, the `agent_state` row —
never from a value you or the code hardcoded. I got this wrong four times in one day.

## Gotchas that will bite the next session

- **AI keys live in the DB, not `.env`.** `ai_setting_openrouter_api_key` in
  `agent_state`, bootstrapped into `process.env` at `server.js` start(). The blank
  `.env` line is by design. See memory note `neuro-ai-keys-in-db`.
- **The frontend PIN comes from a `window.fetch` monkey-patch** in `frontend/src/api.js`.
  121 raw `fetch(apiUrl(...))` calls work because of it. Anything off `window` loses auth.
- **`npm test` result depends on cwd.** Run from `backend/` (153) or `sara/backend/` (34);
  at the repo root `node --test` walks both trees. CI runs each from its own directory.
- **PM2 daemon runs Node 22.22.2.** Always `export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH`.
- **`getPendingSaraActions()` defaults to a limit of 10.** That default caused a 15,605-row
  duplicate pile-up. Pass an explicit limit anywhere you dedupe against it.

## Shipped

Actuators (`reply_email`, `complete_task`, `schedule_focus_block`, `respond_meeting`,
`chase_agenda`) · chat tools (`chat-tools.js`, 3 tiers: read / write / queued) ·
ADHD dashboard (`adhd-dashboard.js` + Today on both surfaces) · collaborative
standup/EOD (`standup-session.js`) · notification governor (quiet hours, dedupe,
hourly cap, persisted) · latency-based AI routing (OpenRouter for interactive,
Ollama for scheduled; Anthropic/OpenAI demoted to backstops — the Anthropic key has
**zero credit**) · mobile Tasks tab · snooze-to-date (`shared/due-dates.cjs`) ·
outcomes measurement (`outcomes.js`, weekly snapshot, Friday 4:30pm) · meeting
agenda triage + decline/propose.

## Outstanding — start here

**Plan for everything below**: https://claude.ai/code/artifact/cd51cfe0-e7db-4328-bdf8-8aac285f09d2

### Decided by Nick, 15 Aug — no longer blocked

1. **`sara/` tree — NOTHING RETIRES. The old framing was wrong.** Nick's architecture,
   in his words: *"NEURO is the brain, and the NEURO app gives me direct access to that
   when I need. SARA is my J.A.R.V.I.S — she uses NEURO's brain and should come to me,
   prompt me, push me, help me, but also be there as a visual/audio route to interact
   with the NEURO brain in a more interactive way."* So NEURO = brain + direct access;
   SARA = the proactive, ambient, conversational surface. The kiosk is the *ambient*
   half of that, not scaffolding.

   **Audit findings (verified against the running systems, not the code) — two of the
   three complaints in the old bullet do not survive checking:**
   - `sara/` is **three** things, not one: `app/` (2,168 LOC, the phone PWA, active
     14 Aug); `backend/`+`frontend/` (8,324 LOC, the Pi 4 desk kiosk); and
     `desktop-electron/` (194 LOC, dormant since 10 Jul).
   - **"Two backends" is misleading.** `sara/app` talks DIRECTLY to the NEURO backend
     (`VITE_API_URL=https://pi5.tailecb90f.ts.net`, standard PIN header) and never
     touches `sara/backend`. There is nothing to "fold in" — the PWA is already a
     NEURO client. `sara/backend` (:3005) serves ONLY the kiosk.
   - **"Seed data" is no longer what serves.** Live `/api/state` reports
     `dataSource: neuro` with all four domains (`queue`/`focus`/`people`/`vault`) at
     `source: neuro`. `seed.js` is now only an outage fallback + the location provider.
     **It is stale fiction though — it hardcodes `assignee: 'Arman'`, who has left and
     was archived 14 Aug.** A NEURO outage shows the kiosk a departed employee holding
     a ticket. Unambiguous defect; fix or delete the fixtures.
   - **"A state engine duplicating the decision engine" is not what `inference.js` is.**
     It opens by explicitly disclaiming exactly that and answers a different question —
     *which view should the kiosk show* — advisory only. `stateEngine.js` is an
     assembler over NEURO data, not a rival to `next-action-engine`/`do-next`.
   - The kiosk IS in use: `ss` on pi5 shows one established connection to :3005 from
     `100.69.158.50` (the Pi 4 DSI screen).

   **THE REAL GAP, and it is the handoff's own favourite failure species — it exists,
   so it looks done.** The kiosk backend is already plumbed for precisely the JARVIS
   behaviour: `neuroChat.js` configures a nudge stream at `/api/nudges/stream`, and
   `routes/actions.js` proxies `/api/actions/:id/approve` and `/reject`. **The screen
   consumes neither.** Its complete API surface is 17 paths and the only actions it
   calls are `/api/actions/focus/dismiss` and `/done`. So the one surface whose whole
   job is to come to Nick and prompt him is the one that never renders a nudge or a
   pending SARA action. This is a frontend job on an existing backend, not new
   architecture — and it is the natural batch-review surface for the **463 pending
   `capture_todo` actions** in item 12.

   **Open tension, Nick's call, deliberately not resolved here:** `inference.js` is
   advisory-only and "never switches a view" — a protected principle from WS5. Under
   "she comes to me", an ambient screen that knows what Nick is doing but refuses to
   change itself may now be the wrong constraint.

2. **`reason_kind` — DECIDED: add the column, two vocabularies.** `capability`
   (existing: "beyond T1 scope" + troubleshooting checklists) and `urgency` (new: "AM
   says the client is at renewal"). The agent picks kind first, then a reason from that
   kind's list. Schema migration lands BEFORE any code. NOTE: this is a NOVA-side change
   (Azure SQL) — `escalation_reasons` is not on the forbidden-table list, but per Nick's
   own safety rule the write needs explicit confirmation, and `daypilot/CLAUDE.md` should
   be read first. Coordinate: another session has been live in the NOVA/People area.

3. **Jira `duedate` — CONFIRMED WRITABLE, and the escalation also comments.** Nick:
   *"add it as a comment on the ticket, but there is also a due date field."* So the
   manual escalation writes BOTH a Jira comment (the needed-by rationale, human-readable
   on the ticket) and sets `duedate`. Verified read-only against the API 15 Aug: on
   `NT`/`Support` (10706), `duedate` is a system field, `"schema": {"type":"date",
   "system":"duedate"}`, `"operations": ["set"]`, and the token carries
   `write:jira-work`. Residual check when the code is built: this is createmeta (create
   screen); confirm the edit screen too via editmeta on a real ticket — cheap, and the
   prototype-on-CLOSED-tickets rule from item 11 applies.

   **Field IDs found in the same query, for item 7:** `Current Tier` =
   `customfield_12981` (Customer Care / Production / Tier 2 / Tier 3 / Development /
   Escalations — the field `jira-sync-service` already reads for CC→T2 moves);
   `Agent Next Update` = `customfield_14185` (datetime); `Agent Last Updated` =
   `customfield_14081`; `Triaged By AI Agent` = `customfield_14114`. NEURO's queue is
   `JIRA_PROJECT_KEY=NT`, request type `"Escalation (NT)"`.

### Agreed with the other session — ALL THREE NOW DONE (15 Aug)

4. ~~**Split the background tasks**~~ — **was already built and deployed** when this list
   was written (`CLOUD_ON_WORKER_FALLBACK` in `ai-routing.js`, commit `9800959`, which
   predates the `361df08` this handoff calls the deploy point). Confirmed live: two
   `email_triage` calls served by openrouter, `focus_enhancement` by ollama. The list was
   stale, not the code. No override env var exists — the set is a constant; add one only
   if the split turns out to be wrong.
5. ~~**Skip a known-dead Pi 4 worker**~~ — **also already built** (`shouldSkip()` /
   `SKIP_AFTER_FAILURES` 3 / `SKIP_FOR_MS` 15min in `pi4-worker-client.js`, commit
   `396090c`). The cooldown expiring IS the periodic retry.
6. **Surface worker-down in the AI health panel** — **done, `adb027c`.** It was worse than
   described. The worker is UP (`/health` 200 in 247ms) but **times out on every real
   triage** — live at 07:52 today: `consecutiveFailures: 2`, `errorClass: 'timeout'`,
   `lastHealthy: null`. Because a timeout deliberately no longer sets `lastHealthy: false`
   (`396090c`), both the panel and the Topbar rendered "unverified · background AI tasks
   have not run" — wrong on both counts. `shared/worker-health.cjs` now owns one verdict
   for both surfaces (too slow ≠ unreachable ≠ never asked ≠ in cooldown); pinned by
   `backend/services/worker-health.test.js` (9 tests).

   **The open question this exposed — why can't the Pi 4 finish a triage in 60s? — was
   answered the same morning by the other session and is now closed:** they measured 12
   tokens/sec prompt processing on the smallest model it had, so a ~3,700-token payload
   needed five minutes just to READ the prompt. A hardware ceiling, not model sizing.
   Worker RETIRED via `PI4_WORKER_ENABLED=false` (`78a0af6`), code left in place so
   re-enabling is one env var. `assessWorker` reports `disabled` as an ok state, so the
   panel says so plainly rather than flagging a fault.

   **Deployed and verified 15 Aug 09:12.** Pi at `49a97e4`, backend live with
   `skipAfter`/`lastFailure` in `/api/status`, frontend rebuilt and serving
   `index-8r4a6eOP.js`.

### Build queue (sequenced in the plan)

7. NOVA manual escalation — `escalation_log` already exists AND already records CC→T2
   tier moves via `jira-sync-service` as `escalation_type: 'jira_transition'`. Missing:
   a manual endpoint, the Jira comment, the notification, a view. Escalation closes when
   the TICKET closes; add a needed-by date that writes through to the ticket due date.
8. Agent-id join key → sensitive-content list → person record migrates to NOVA, with
   vault People notes becoming capture points (the `Tasks/Capture.md` drop-box pattern).
   NEURO renders a person card. Meeting-note backlinks must keep resolving.
9. 1-2-1 agenda, built in NOVA once the person record lands. Coordinate — the other
   session is live in this area.
10. Teams — a real build, NOT a config toggle. Decide first: Power Automate Workflows
    webhook for channels, or delegated `ChatMessage.Send` for a DM that comes from Nick.
11. Commitment chasing, then escalation first-drafts (prototype those on CLOSED tickets
    before they go anywhere near a customer).

### Known but unfixed

12. **463 pending `capture_todo` actions** — meeting-action candidates awaiting yes/no.
    Working as designed (review-only), but it wants a batch review session.

### Scoped out deliberately — reopen only if Nick disagrees

- Snooze-to-date works on NEURO-owned tasks only. Microsoft-owned would need a Graph
  `dueDateTime` write; a vault checkbox has nowhere to put a date. The control hides
  rather than failing silently.
- No snooze on the ADHD quick-wins list — those are "do this now", and a defer button
  works against them.

### Needs Nick in the real world, not another session

- **The Today panel's avoidance section** — useful or accusatory? One line to fix.
- **A real standup** — it should chase carried commitments and push back ONCE on
  anything vague. Twice is nagging; loosen it if that happens.
- **Baseline to beat**: week 2026-W33 = **9 things finished, 26 nudges pushed back**.
  The tone ladder changed 14 Aug (82 messages → 32, shame tiers deleted, gradient
  inverted so it warms rather than sharpens). Next Friday is the first honest read.

## Working alongside another session

Nick runs 2–3 Claude sessions on this repo **in the same working directory**. Today
one committed on top of mine mid-push. **Stage files explicitly — never `git add -A`** —
or you will sweep up their in-flight work. Re-check `git status` and `git fetch`
immediately before every commit, and `git pull --ff-only` so a concurrent push fails
loudly rather than merging silently.
