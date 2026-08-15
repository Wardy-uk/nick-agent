# Session Handoff — 2026-08-15 16:20

The escalation/chasing/Teams workstream. **BA is answered — `.claude/memory/workstream-escalation-and-chasing.md` holds the decisions. Do not re-derive them.** Build order steps 1–3 shipped; step 4 is half done.

## What was done

- **BA: all 18 questions answered**, written back into the workstream brief as decisions. Escalation first-drafts was dropped mid-BA then reinstated by Nick — it is IN, as steps 6–7.
- **Manual escalation, live and verified end to end on NT-28075**: `Unset → Critical`, due date set, internal-only comment signed *"Escalated by Nick Ward"*, `escalation_log` row 5018, no warnings.
- Azure SQL migration ran (`reason_kind` + 5 urgency codes + 3 reclassified + `resolved_at`/`minutes_to_resolve`/`disputes_escalation_id`). Verified: 8 urgency reasons returned.
- **NEURO Escalations view** (sidebar) — key → ticket detail → reason → confirm → escalate. Plus `escalate_ticket` chat/voice tool (queued for approval).
- **waiting-on KV → `waiting_on` table**, with `snooze`. **287 items / 29 people / oldest 107d migrated and verified intact.**

## What's still pending

- **Step 4b — the chasing UI.** Backend is done and deployed; there is still NO UI. Per Q10–Q12: per-person card on the People board + surfaced in 1-2-1 prep, grouped by person oldest-first, actions chase / done / drop / snooze. Pull-only, no nudge (Q14).
- **Step 5 — Teams.** Build BOTH paths, fail-soft, config-gated (Q8/Q9). Raise the `ChatMessage.Send` admin consent request early.
- **Steps 6–7 — escalation first-drafts.** Phase A internal draft first, Phase B customer-facing only after the closed-ticket prototype passes zero-wrong (Q17).
- **Tracker #77** (new): escalated tickets have no acknowledgement — one-way today.

## Key decisions made

- **Escalation goes over the NEURO bridge, not a NOVA service account.** The `@sara` account's password did not exist anywhere. The bridge (`/api/neuro-bridge/*`, `x-neuro-bridge-secret`) was already there for Microsoft, needs no password, and is hardcoded to Nick — so attribution is a property of the route, not a config map.
- Nick overruled two recommendations, both stand: escalation **also raises Priority** (to `Critical`, raise-only) because it is the field assignees filter on; and **all 8 urgency codes stay active** despite `exec_ask`≈`customer_request` and `deadline`≈`sla_risk` being near-synonyms — `by_reason` stats will split across the pairs.
- The Escalations **form does not queue for approval**; the confirm step is the gate. Chat/voice still queues, because SARA acts on inferred intent.

## Files changed

- NOVA `7a6655a`: `db/schema.ts` (migration), `services/manual-escalation-service.ts` (new), `routes/escalation.ts`, `routes/neuro-bridge.ts` (escalate/ticket/reasons), `services/jira-sync-service.ts` (closure stamping), `index.ts`.
- NEURO `006ca71`: `routes/escalation.js` + `services/nova-client.js` (new), `components/EscalationPanel.{jsx,css}` (new), `services/waiting-on.js` (SQL), `db/schema.sql`, `db/database.js` (exports `all/get/run`), `chat-tools.js`, `suggestion-engine.js`, `server.js`, `Sidebar.jsx`, `App.jsx`.

## Gotchas for next session

- **Jira priority IDs are NOT in rank order** — `Normal` is 10100, `Minor` is 4. Rank via the explicit list in `manual-escalation-service.ts`, never the id.
- **Jira reads lag writes by seconds.** An immediate read-back after escalating shows pre-write values; it is not a bug. Verify from a second source before believing it.
- **Another Claude session works in this repo on `main` at the same time.** Its commits interleave with ours and its pushes carry our work. Stage explicitly; never `git add -A`.
- NOVA deploys with `.\deploy.ps1 -Branch nova-codex` (Nick runs it) and **pulls a branch it never checks out**. Push to `origin` AND `azdo`.
- `deploy.ps1` reported "Already up to date" on a run that did have new commits — treat its output as untrustworthy; verify with `git -C C:\Nurtur\NOVA log -1`.
