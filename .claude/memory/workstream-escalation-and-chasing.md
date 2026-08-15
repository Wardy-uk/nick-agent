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

## BA — answer these before writing code

### NOVA manual escalation

**Q1. Is the Jira comment internal or customer-visible? (Answer this first.)**
The reason is commercial — *"the AM says they're at renewal"*. Customer-visible would be
bad. Recommend **internal by default, with no option to make it public** in v1.

**Q2. What are the `urgency` reason codes?** `reason_kind` is decided (`capability` |
`urgency`). The existing five are capability. Proposed starting set — confirm or replace:
`commercial` (renewal, upsell, contract), `customer_impact` (blocking their operation),
`reputational` (complaint risk, visible failure), `deadline` (external date), `exec_ask`
(SLT or AM request). `requires_troubleshooting` is meaningless for these — either default
it false for the kind, or the column stops applying.

**Q3. Who can escalate?** Just Nick in v1, or account managers too? Drives whether it
needs a UI in NOVA or only an API. `escalated_by` already exists on the table.

**Q4. Does escalation change anything other than `duedate` + comment?** Priority field?
`Agent Next Update` (`customfield_14185`)? Tier? Recommend **no** in v1 — a needed-by date
and a comment are legible; silently moving priority is not.

**Q5. What if the ticket already has a `duedate`?** Overwrite, refuse, or only tighten it?
Recommend **only tighten** — an escalation should never push a date out.

**Q6. Who gets notified, and does the assignee get a say?** Assignee only, or their lead
too? If the agent thinks the escalation is wrong, what is the route back? Today the answer
is "nothing", which is how escalations become resented.

**Q7. Closure.** Decided: the escalation closes when the ticket closes, and
`jira-sync-service` already sees closure. Confirm it should mark the `escalation_log` row
resolved rather than deleting or leaving it open.

### Teams

**Q8. Channel or DM?** They are different builds:
- **Workflows webhook** → posts to a channel. No Graph scope, no admin consent, works
  today. Team-visible, not personal.
- **Delegated `ChatMessage.Send` from NEURO** → a DM that comes from Nick. One admin
  consent. *"Nick escalated your ticket"* carries weight *"NOVA-bot says"* does not.

Recommend **DM via NEURO** for escalations and chasing (both are person-to-person), and
the webhook only if a team-wide feed is wanted separately. Note this splits the feature
across both codebases — worth deciding deliberately rather than by accident.

**Q9. What is the fallback when Teams is unavailable?** Email works today in both
directions. Recommend building email-first and treating Teams as an upgrade, so nothing
blocks on the consent request.

### Commitment chasing (UI)

**Q10. Where does it live?** Candidates: the People board (per-person card), 1-2-1 prep
(*"what does Naomi owe me"* is exactly a 1-2-1 question), a standalone view, or the Today
dashboard. Recommend **per-person on the People board, surfaced in 1-2-1 prep** — that is
where the question is actually asked.

**Q11. Grouped by person, or flat by age?** `byPerson()` and `list()` both exist.

**Q12. What can Nick do from the row?** Chase (queued), mark done, drop. Anything else?

**Q13. Does the KV→table move happen first?** 287 items is fine in KV; a UI that filters
and sorts will want the table. Cheap now, annoying later.

**Q14. Is there a staleness nudge?** Should something 30+ days old surface in Focus or the
weekly review, or does it stay pull-only? Recommend pull-only in v1 — the notification
budget is already the thing most at risk.

### Escalation first-drafts

**Q15. What is the output — a Jira comment draft, or an email?** And does it land as a
draft on the ticket, or in the approval queue?

**Q16. What context feeds it?** Ticket history, account context (`bc-account-resolver`),
similar past escalations. NOVA has all three; NEURO has none of them.

**Q17. How is quality judged before this goes near a customer?** Decided: prototype on
CLOSED tickets. Define the pass mark — e.g. Nick reads 20 drafts against what was actually
sent and says how many he would have sent. **Do not ship on a vibe.**

**Q18. Who is allowed to approve a send?** Nick only, or the assignee too?

---

## Build order once the BA lands

1. **`reason_kind` migration** (NOVA, needs Nick's explicit OK) — column + urgency
   vocabulary. Schema before code.
2. **`POST /escalation/manual`** — log row, internal Jira comment, `duedate` tighten.
   Verify editmeta on a real ticket first. Notification stubbed behind Q8.
3. **NEURO capture surface** — a chat tool and a mobile route that call NOVA directly
   (decided: direct, not via n8n). NEURO needs a service identity; NOVA's routes are
   JWT-guarded by role.
4. **Commitment chasing UI** — per Q10–Q14.
5. **Teams** — per Q8, after the consent request if the DM path wins.
6. **Escalation first-drafts** — last, and only after the prototype in Q17 passes.

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
