# Handoff — commitment chasing + Teams (15 Aug 2026, ~18:20)

Separate from `handoff.md`, which a concurrent session owns for the SARA voice work.
The decisions live in `workstream-escalation-and-chasing.md` — **the BA is ANSWERED, do
not re-litigate it**, in particular the two Nick overruled (priority bump; all 8 urgency
codes stay).

## Done and PROVEN live

- **Chasing UI** (tracker #3) — `components/WaitingOn.jsx` on the People board, in
  PersonDetail, and read-only in 1-2-1 prep via `_buildPrep` → `sara/app` MeetingPrep.
  287 items / 29 people / oldest 107d.
- **The chase executor RAN** — real email sent and received. Queue → stored draft +
  resolved address → manual recipient override → approve → Graph send → `markChased`.
- **Email fallback from Teams proven** — a chase set to `channel: 'teams'` approved as
  `"Teams unavailable (consent), sent by email"`.

## Done in code, DARK until Nick does two external things

Neither is a code change. Both light up on their own.

1. **`ChatMessage.Send` admin consent** → the Teams DM path. Raise it in the tenant's
   **Admin consent requests queue** (not the Grant consent button — see Nick's global
   CLAUDE.md). Check with `GET /api/microsoft/teams-send-status`.
2. **A Power Automate Workflows URL** in NOVA's `agent_teams_webhook_url` setting → the
   channel path. NOVA also still needs `deploy.ps1 -Branch nova-codex` (Nick runs it) for
   commit `42b412c`.

## Next — step 6, escalation first-drafts Phase A

Internal handover draft only. Context = ticket history + `bc-account-resolver` account
context + retrieval over similar closed escalations (Q16). **NOT** the SOP-002 checklists.
All three live in NOVA, which is why it is a NOVA feature. No approval plumbing needed for
Phase A. Phase B (customer-facing) only after the Q17 zero-wrong prototype on 20 closed
tickets, and ships with the Q18 send audit log on day one, not retrofitted.

## Gotchas

- **Never add an optional scope to `GRAPH_SCOPES`.** `getAccessToken()` passes the whole
  list to `acquireTokenSilent`; one unconsented entry throws and takes Calendar, Mail,
  Tasks and briefings down. Use `microsoft.getScopedToken(scopes)`.
- **`waiting_on` stores a canonical FIRST name only.** Any match against a full name must
  go through `entities.getRoster().firstNames`. Matching the bare first name put one
  Lucy's 16 commitments on four Lucys and Chris Middleton's 31 on a Chris Smith.
- **`contact-directory.resolveName` takes a first name and `resolved` is a real gate** —
  "Chris" comes back `ambiguous` and is refused. Hence the editable recipient; a manual
  override is stamped `source: 'manual'` and skips the gate, because a choice is not a guess.
- **Chasing does not resolve.** `markChased` bumps the count; the item stays open and keeps
  ageing. The 287 only drops via Done and Drop.
- **A concurrent session works this repo on `main`.** Stage files explicitly, never
  `git add -A`, re-check `git status` before every commit.
- Pi deploy needs **Node 22.22.2** in PATH; 20 segfaults better-sqlite3.
