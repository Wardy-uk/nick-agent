# Workstream — escalation, chasing and Teams

Brief for a dedicated session. **Do the BA first, then build.** Four features, two
codebases. Written 2026-08-15.

Nick's instruction: *"do the BA then build for these."* So the first output of that
session is answers, not code. Several of the questions below have a wrong answer that
is expensive and public — putting a commercial escalation reason in front of a
customer, or emailing a direct report something that reads as surveillance.

---

## Ground truth — already verified, do not re-derive

**NOVA already has most of the escalation machinery.**
- `escalation_log` (Azure SQL) — `ticket_key, escalation_type, from_tier, to_tier,
  reason_code, reason_label, escalated_by, assigned_to, notes, decision_id, source,
  created_at`. Indexed on `(ticket_key, created_at DESC)` and `(created_at DESC,
  escalation_type)`.
- **It already records CC→T2 tier moves.** `jira-sync-service.ts` writes every tier
  change as `escalation_type: 'jira_transition'`, `source: 'jira_sync'`, with a 5-minute
  dedupe guard. `escalation_type` already accepts `'manual'`. Adding manual escalation is
  an addition to a live table, not a new one.
- `escalation_reasons` table exists, SOP-002 aligned, seeded: `complexity`, `access`,
  `third_party`, `data_issue`, `recurring` — each with `requires_troubleshooting` and a
  `troubleshooting_checklist`.
- Routes today: `GET /escalation`, `GET /escalation/stats`, `POST /escalation/rejection`,
  `POST /escalation/backfill`. **No manual-escalation endpoint.**
- `jira-client.ts` `addComment(issueKey, body, { internal })` and `addCommentAdf(...)` —
  the JSM internal flag is set via `properties: [{key:'sd.public.comment',
  value:{internal:true}}]`. **Visibility is controllable. See Q1.**
- `escalation-policy.ts`, `escalation-predictor.ts`, `notification-engine.ts` exist.

**Jira facts (verified read-only via the API, 15 Aug).**
- `duedate` is writable on `NT`/`Support` (10706): system field, `"operations":["set"]`,
  token carries `write:jira-work`. **Residual check: that was createmeta (create screen)
  — confirm editmeta on a real ticket before writing.**
- `Current Tier` = `customfield_12981` (Customer Care / Production / Tier 2 / Tier 3 /
  Development / Escalations) — the field `jira-sync-service` already reads.
- `Agent Next Update` = `customfield_14185` (datetime); `Agent Last Updated` =
  `customfield_14081`; `Triaged By AI Agent` = `customfield_14114`.
- NEURO's queue is `JIRA_PROJECT_KEY=NT`, request type `"Escalation (NT)"`.

**Teams does not work anywhere. Verified, not assumed.**
- NOVA's `alert-service.ts` has a Teams path but `agent_teams_webhook_url` is **unset**
  in `settings.json` — it returns on the first line and has never sent anything.
- That code posts a `MessageCard` via an **O365 connector, an API Microsoft has retired**.
  Replacement is a Power Automate Workflows webhook taking Adaptive Cards.
- NOVA's Graph (`msgraph-client.ts`) is **client credentials — app-only**. App-only Teams
  DM is a restricted API and the message arrives from an app identity.
- NEURO's Graph is **delegated as Nick** (`Chat.Read` only today). Adding
  `ChatMessage.Send` is one admin consent and the DM comes from Nick.

**NEURO side, built 15 Aug and parked.**
- `services/waiting-on.js` — records what others owe Nick, folds duplicates, re-opens on a
  newer note, oldest-first, stale at 3 days. Backfilled: **287 items, 29 people, oldest
  107 days**, from 232 meeting notes.
- `POST /api/waiting-on/:key/chase` queues a `chase_commitment` action. The executor in
  `suggestion-engine.js` resolves the address via `contact-directory.resolveName` and
  refuses on anything less than `status: 'resolved'`. Sends via `email-sender.sendMail`.
- **No UI at all.** That is the gap.
- Storage is the `agent_state` KV store, not a table, because `schema.sql` was held by a
  concurrent session. Move it when that frees up.

**Safety rules that apply.**
- Nick's Azure SQL rule: `escalation_reasons` and `escalation_log` are NOT on the
  forbidden list, but **writes need explicit confirmation from Nick**. Read
  `daypilot/CLAUDE.md` before touching NOVA.
- Every outbound action in NEURO is approval-gated (`queueAction` → pending
  `sara_action` → `/api/actions/:id/approve`). Keep that.

---

## BA — ANSWERED 15 Aug 2026. These are decisions, not proposals.

### NOVA manual escalation

**Q1. Jira comment visibility → INTERNAL ALWAYS, no override.**
Every manual-escalation comment sets `properties: [{key:'sd.public.comment',
value:{internal:true}}]`. There is **no public flag on the API** — not defaulted-internal,
*absent*. A commercial reason (*"the AM says they're at renewal"*) can never reach a
customer, including by a caller passing the wrong boolean.

**Q2. `urgency` reason codes → the proposed five.**
`commercial` (renewal/upsell/contract), `customer_impact` (blocking their operation),
`reputational` (complaint risk, visible failure), `deadline` (external date), `exec_ask`
(SLT or AM request). The existing five (`complexity`, `access`, `third_party`,
`data_issue`, `recurring`) stay as `reason_kind = 'capability'`.
`requires_troubleshooting` **defaults false for `kind = 'urgency'`** — the column keeps
applying to capability reasons only.

**Q3. Who can escalate → Nick only in v1, but built for more.**
No NOVA UI in v1; reached from NEURO chat and the SARA mobile route. **`escalated_by`
comes from the JWT, never hardcoded**, so a NOVA AM-facing UI in v2 is purely additive.

**Q4. What the escalation writes → `duedate` + internal comment + Priority.**
*Nick overruled the recommendation to leave Priority alone.* Rationale accepted: Priority
is the field assignees actually filter on, so an escalation that doesn't move it is
invisible in their working view. **Known cost: priority-based SLA reporting now mixes "how
bad is this" with "who escalated it".** Accept it, don't re-litigate.
Tier is NOT written (`jira-sync-service` owns `Current Tier`). `Agent Next Update`
(`customfield_14185`) is NOT written in v1.

**Q4b. Priority rule → only ever raise, always to `Critical`.**
Never lowers. Verified live on NT 15 Aug: the scheme runs **Blocker (190 issues) →
Critical (805 total, only 13 currently open) → Major → Minor → Unset**. So `Blocker` stays
reserved for genuine outages, and Critical is rare enough in the open queue that landing
there still carries signal. If the ticket is already Blocker, leave it.

**Q5. Existing `duedate` → only tighten, silently.**
Write only if the requested date is earlier than the current one. If it is later, log the
escalation and post the comment but **leave `duedate` untouched** — no error. An escalation
must never push a commitment out.

**Q6. Notification → assignee only, with a route back.**
The assignee is notified; their lead is not, by default. The notification **names how to
push back** — a dispute lands as a row on `escalation_log` so a contested escalation is
visible in the stats rather than resented in private.

**Q7. Closure → mark resolved, keep the row, record time-to-close.**
`jira-sync-service` stamps `resolved_at` when it sees closure, plus the interval from
escalation to close, so *"did escalating actually change anything"* is answerable without
a join. Rows are never deleted.

### Teams

**Q8. → BUILD BOTH, degrading gracefully.**
DM (delegated `ChatMessage.Send` from NEURO, arrives as Nick) **and** channel post (Power
Automate Workflows webhook + Adaptive Card from NOVA, replacing the retired O365 connector
path in `alert-service.ts`). It is a weekend and admin consent cannot be obtained — so
**both paths must be built to fail soft and log, never to throw or block the escalation**,
and must light up on consent + config alone with no code change. An unset webhook or an
unconsented scope is a normal, silent state.

**Q9. Fallback → email-first, Teams is an upgrade.**
Ship on email, which works in both codebases today. Teams becomes a delivery preference
layered on. **Nothing in the build blocks on the consent request.**

### Commitment chasing (UI)

**Q10. Lives on → the People board (per-person card) + surfaced in 1-2-1 prep.**
*"What does Naomi owe me"* is a 1-2-1 question; that's where it goes. No standalone tab.

**Q11. → Grouped by person, oldest-first within each person.**
Use `byPerson()`. One conversation per person, not one row per item.

**Q12. Row actions → chase, mark done, drop, snooze.** All four.
`chase` queues a `chase_commitment` action (approval-gated, already built end-to-end);
`done` = they delivered; `drop` = misparsed or overtaken (needed, since it was backfilled
automatically from 232 notes); `snooze` = hide until a date, for *"they said next Friday"*.

**Q13. KV→table → migrate FIRST, before the UI.**
`schema.sql` is free now. Filter/sort/snooze all want SQL, and snooze especially — it's a
per-item date the KV blob has nowhere to put.

**Q14. Staleness nudge → none. Pull-only in v1.**
It appears when you open a person or 1-2-1 prep. The notification budget is the thing most
at risk, and 287 backfilled items would make a very loud first day.

### Escalation first-drafts — IN. (Dropped mid-BA, reinstated by Nick the same day.)

*What it is, stated plainly, because the name confused this once already:* when an NT
escalation ticket lands, an agent spends ~20 minutes reading the history before writing
anything. NOVA assembles that context and pre-writes the first substantive update, so the
agent **edits instead of starting blank**.

**Q15. Output → BOTH, internal first.** One context pipeline, two output shapes.
- **Phase A — internal handover draft.** What's been tried, account context, suggested
  next step. Internal-only comment. Near-zero risk, and it is the honest test of whether
  the context assembly is any good. Saves reading time.
- **Phase B — customer-facing update.** Only attempted once Phase A demonstrably works.
  This is where the real 20 minutes is, and where the Q17 gate applies.

**Q16. Context → ticket history + account context + similar past escalations.**
Comments, transitions and tier moves; `bc-account-resolver` for who the customer is and
their contract state; retrieval over closed escalations that resemble this one so the
draft can reuse what actually worked. **NOT** the SOP-002 troubleshooting checklists.
All three live in NOVA — NEURO has none of them, which is why this is a NOVA feature.
⚠️ `bc-account-resolver` is also the route by which commercial detail could reach a
public comment. Phase B must never emit contract/renewal state into customer-facing text.

**Q17. Pass mark → 20 closed tickets, ZERO-WRONG is the only gate.**
*Nick declined a percentage target.* The single blocking rule: **no draft may state
something untrue about the ticket or the account** — no invented history, no wrong
account, no claiming a step was taken that wasn't. One such draft in 20 and it does not
ship. Everything above that line is Nick's judgement on the day, not a scored threshold.
Run the prototype against closed tickets only, comparing to what was actually sent.

**Q18. Approval → the assignee approves, Nick is notified.**
*Nick overruled the recommendation to reserve customer-facing drafts for himself.*
Internal drafts need no approval plumbing; customer-facing sends are approved by the
person on the ticket, with a notification to Nick after the fact.
**Recorded risk, accepted, do not re-litigate:** Q17 is a one-off gate judged by Nick at
prototype, but production enforcement then sits with whoever is on shift — on text a
customer reads. Cheap mitigation to build in from the start: **log every approved
customer-facing send (draft text, final text, approver) so the delta is auditable**, and
Nick's notification carries what actually went out, not just that something did.

Note for whoever reads this later: "escalation" named two unrelated things in the original
brief. Commitment chasing is **internal, about Nick's team, never touches Jira**. Manual
escalation and first-drafts are **the NT support queue**. They only share a word.

---

## Build order — BA has landed, this is the plan

**STATUS 15 Aug 16:20 — steps 1–3 DONE and live (NOVA `7a6655a`, NEURO `006ca71`).
Step 4's migration is done; its UI is not.** Escalation reaches NOVA over the
**NEURO bridge**, not the `@sara` service account — that account's password did
not exist anywhere, and the bridge is hardcoded to Nick so attribution is honest.
Verified end to end on NT-28075. Resume at the chasing UI (Q10–Q12).

1. ~~**`reason_kind` migration**~~ — DONE, verified: 8 urgency reasons live. (NOVA, **needs Nick's explicit OK before running** per the
   Azure SQL rule) — column on `escalation_reasons` + seed the five urgency codes with
   `requires_troubleshooting = 0`. Schema before code.
2. **`POST /escalation/manual`** — log row, internal-only comment, `duedate` tighten-only,
   Priority raise-only-to-Critical. **Verify editmeta on a real ticket before the first
   write** (createmeta is not proof). Notification behind the Q8/Q9 email-first path.
3. **NEURO capture surface** — a chat tool and a SARA mobile route calling NOVA directly
   (decided: direct, not via n8n). NEURO needs a service identity; NOVA's routes are
   JWT-guarded by role, and `escalated_by` reads from that token.
4. **waiting-on KV→table migration** (Q13) — then the **People board + 1-2-1 prep UI**
   (Q10–Q12), pull-only (Q14).
5. **Teams, both paths** (Q8) — fail-soft, config-gated, no code change needed when
   consent lands. Raise the `ChatMessage.Send` admin consent request early so it's queued
   while the rest is built.
6. **Escalation first-drafts, Phase A** (internal handover draft) — context pipeline
   (Q16) + internal-only output. No approval plumbing needed.
7. **Escalation first-drafts, Phase B** (customer-facing) — **only after the Q17
   prototype passes on closed tickets, zero-wrong**. Ships with the send audit log from
   Q18 on day one, not retrofitted.

## Rules for that session

- **Read `daypilot/CLAUDE.md` before touching NOVA.** Different stack: Express 5 +
  TypeScript ESM, MSSQL, routes are `createXxxRoutes(deps)` factories.
- **Nothing outbound sends without approval.** Escalation comments, chases and drafts all
  go through the pending-action queue.
- **Verify from the running system, not from the code.** Five bugs on 14 Aug were
  "something exists, so it looks done" — an unset webhook, a function called by nothing, a
  hardcoded provider label. Check pm2 logs, `/api/status`, the settings row.
- **Another session works in this repo, in the same directory.** Stage files explicitly,
  never `git add -A`, and re-check `git status` before every commit.
