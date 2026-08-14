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

## What's still pending

- **NOTHING IS DEPLOYED.** All of this is uncommitted on Windows. The Pi has not
  been touched, so the board still shows the March dates until it's deployed.
- **`book()` has never actually created an event.** It goes through
  `microsoft.createCalendarEvent`, which the 14 Aug handoff already flagged as
  code-complete but never exercised. First real use sends a live invite to a real
  colleague — try a throwaway first.
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
