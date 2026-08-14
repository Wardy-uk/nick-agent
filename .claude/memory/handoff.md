# Session Handoff — 2026-08-14 18:00

## What was done
- **O365 event creation** — `POST /api/calendar/events`, plus `/parse` (free text → draft) and `/resolve` (name → email). `+ New` in CalendarView opens EventComposer, which doubles as picker and text entry.
- **Inbox "Read & dismiss"** — marks read in Outlook via Graph PATCH, then dismisses.
- **Calendar hour offset — two separate bugs, both fixed.** (1) `graphFetch` never sent `Prefer: outlook.timezone`, so Graph answered in UTC while the frontend sliced the time out of the string raw. (2) `parseIcsDate` never converted the trailing `Z` despite its own comment saying it did. Also fixed `toISOString()` in CalendarView (reported tomorrow on a BST evening).
- **Scopes widened + admin-approved + deployed.** Pi is at `7948c4a`, restarted, frontend rebuilt, live API verified (KPI Meet now 09:15, matching Outlook).

- **`create_meeting` chat tool** — added to the *other session's* new `chat-tools.js`. Resolves attendee names via contact-directory and queues a `schedule_focus_block` action (their executor already forwards `payload.attendees` to `createCalendarEvent`, so no new executor). Refuses rather than guessing: an ambiguous name returns both candidates for the model to ask about. Also fixed two things in their executor — it dropped `location`, and its success line never said invites had gone out.

## What's still pending
- **NOT COMMITTED, NOT DEPLOYED.** The chat work sits inside the other session's 35 uncommitted files (`chat-tools.js` is still untracked). Agreed with Nick 14 Aug: that session commits and deploys its own work, and these two changes ride along. Do not cherry-pick them out — it would split their work across two commits. The calendar/inbox work from earlier IS committed and live (`7948c4a`).
- **Event creation has never actually written to the calendar.** Reads verified end-to-end; writes are code-complete but untested. Nick was advised to try a throwaway (no attendees) first. This now covers three paths: the composer, the approval queue, and `create_meeting` from chat.
- **`aliases` frontmatter is unused by the resolver.** 17 of 42 People notes carry it (e.g. Abdi's lists "Abdi Mohammad"), and it is exactly the nickname→person map contact-directory wants. Offered to Nick, not taken up.
- **16 core dumps, 510MB, in `/mnt/data/nuero/backend/`**, all stamped Aug 13 12:10 — one minute, so a crash loop, not 16 incidents. Fits the known Node 20 / better-sqlite3 ABI segfault (see mistakes/pi5-deployment). Left in place deliberately; Nick hasn't decided delete vs investigate. Disk is fine (423G free).
- No People note carries `email:`, so name resolution leans entirely on Graph + inbox history. Adding it would make "with abdi" resolve instantly and offline.

## Key decisions made
- **Parse never creates.** Attendees mean Graph emails real invites, so free text always produces a draft to confirm. Non-negotiable for this feature.
- **Regex-first parsing**, model call only when the rules find no time — instant, works with the Pi offline, matches task-store's inline-hint pattern.
- **Resolver never guesses** — >1 match returns `ambiguous` for Nick to pick, 0 returns `unresolved`.
- **ICS `Z` conversion goes through `Intl` against `NEURO_TIMEZONE`, not the host clock** — the Pi may run in UTC, which would silently make it a no-op.

## Files changed
- `backend/services/microsoft.js` — scopes; `createCalendarEvent`, `markEmailRead`, `searchPeople`; `graphFetch` takes extraHeaders; `EVENT_TIMEZONE`
- `backend/services/{event-parser,contact-directory}.js`, `backend/routes/calendar.js` — new
- `backend/services/obsidian.js` — `parseIcsDate` UTC conversion
- `backend/routes/email-triage.js` — dismiss accepts `{markRead}`
- `frontend/src/components/{EventComposer.jsx,.css}` — new; `CalendarView.jsx`, `InboxPanel.{jsx,css}`

## Gotchas for next session
- **NEURO rides on NOVA's app registration** (`@softeria/ms-365-mcp-server` client ID) and, on Windows dev, NOVA's token cache. Consent is therefore shared: widening NEURO's scopes widens that app for NOVA too, and revoking would take NOVA's Graph access down with it. Confirmed correct by Nick.
- **Nurtur's tenant blocks user consent** — any new Graph scope needs admin approval, regardless of whether the scope is user-consentable by default. Approve via Entra → Enterprise applications → **Admin consent requests** (grants the exact scopes asked for). The "Grant admin consent" button on the app's Permissions page grants the *statically configured* set instead, which for a third-party multi-tenant app may not include ours — that's why the first approval attempt appeared to do nothing.
- Once consent is granted tenant-side, the Pi widens **silently** on next refresh — no second device-code run needed.
- Anywhere building a date string must use local getters, never `toISOString()`.
