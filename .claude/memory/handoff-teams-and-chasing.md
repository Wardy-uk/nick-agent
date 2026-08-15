# Handoff — chasing UI + Teams (15 Aug 2026, ~18:45)

**Read the tracker first, not this file:**
`Projects/NEURO/NEURO Feature Tracker.md` (vault) — it opens with a ranked **Order of
play** and now carries items **#96–#102** from this session. This handoff is only the
"where the hands were" note.

`handoff.md` belongs to a **concurrent session** doing SARA voice (#90) — do not overwrite
it. Decisions live in `workstream-escalation-and-chasing.md`; **the BA is ANSWERED**. Do
not re-litigate it, in particular the two Nick overruled: escalation also raises Priority,
and all 8 urgency codes stay.

---

## Shipped this session, and PROVEN — not just deployed

- **Tracker #3, the chasing UI.** `frontend/src/components/WaitingOn.jsx` mounted on the
  People board, in the person overlay, and read-only in 1-2-1 prep
  (`routes/meeting-prep-view._buildPrep` → `sara/app` MeetingPrep). 287 items / 29 people
  / oldest 107d. Four row actions: chase / done / drop / snooze. Pull-only (Q14).
- **The chase executor ran.** A real email sent and received: queue → stored draft +
  resolved address → manual recipient override → approve → Graph send → `markChased`.
  Before this it had never once fired.
- **Teams, both paths, code-complete and fail-soft.** NEURO `teams.sendDm()` and NOVA
  `services/teams-webhook.ts` (`42b412c`). Email-first fallback proven live:
  `"Teams unavailable (consent), sent by email"`.

29 tests pass (`waiting-on.test.js` 17, `teams.test.js` 6, plus the rest).

---

## The two things blocking, both Nick's, neither a code change

1. **Raise the `ChatMessage.Send` admin consent request** — tenant's *Admin consent
   requests* queue, **not** the Grant consent button. Check with
   `GET /api/microsoft/teams-send-status`; it flips to `available:true` on approval with
   no redeploy, and the channel picker appears in the UI on its own.
2. **NOVA:** `deploy.ps1 -Branch nova-codex` for `42b412c` (pushed to origin **and**
   azdo), then paste a **Power Automate Workflows** URL into `agent_teams_webhook_url`.

Also outstanding but smaller: one queued chase to **Lucy** has no address (queued before
the address feature shipped) — set one or discard it. And `Chris` resolves `ambiguous`
by design, so any chase to a Chris needs the address set by hand.

---

## Start here next session

**Tracker #97 — nothing lists a pending action.** This is the direct successor to what #3
turned up and it is a small screen. `draft_email_reply`, `schedule_focus_block`,
`chase_agenda` and `reply_email` all reach the pending queue and **no frontend reads
`GET /api/actions`** — so the deliberate second gate on outbound email cannot be reached at
all. `WaitingOn.jsx` now does this for `chase_commitment` only; generalise that pattern.

Alternatively **step 6 of the workstream** — escalation first-drafts Phase A (internal
handover draft). That is a NOVA context pipeline: ticket history + `bc-account-resolver` +
retrieval over similar closed escalations (Q16), explicitly **not** the SOP-002 checklists.
No approval plumbing needed for Phase A. Phase B only after the Q17 zero-wrong gate on 20
closed tickets, shipping with the Q18 send audit log on day one.

---

## Gotchas — the expensive ones

- **Never add an optional scope to `GRAPH_SCOPES`.** `getAccessToken()` passes the whole
  list to `acquireTokenSilent`; one unconsented entry throws and takes Calendar, Mail,
  Tasks and briefings down with it. Use `microsoft.getScopedToken(scopes)`. Full reasoning
  in tracker **#100**.
- **`waiting_on` stores a canonical FIRST name only.** Any match against a full name goes
  through `entities.getRoster().firstNames`. Matching the bare first name put one Lucy's 16
  commitments on four Lucys (**#98**).
- **A design note saying "acceptable trade" is scoped to the caller it was written for.**
  That first-name merge is fine for 13 reports and wrong for a 309-attendee invite. Re-check
  such notes at every new call site.
- **Verify from the running system, not the code.** Every real find this session came from
  hitting the live Pi: the four Lucys, the 309-attendee meeting, `ChatMessage.Send`
  returning AADSTS65001, NOVA's Teams path having never sent anything.
- **Chasing does not resolve.** `markChased` bumps the count; the item stays open and keeps
  ageing. The 287 only falls via Done and Drop — see **#99**.
- **A concurrent session works this repo on `main`.** Stage files explicitly, never
  `git add -A`, re-check `git status` before every commit. Its uncommitted work this
  session included `backend/routes/health.js` and `backend/services/stress-score.*`.
- **Pi deploy needs Node 22.22.2 in PATH** — 20 segfaults better-sqlite3.
  `export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH && cd /mnt/data/nuero &&
  git pull && npm run build --workspace=frontend && pm2 restart neuro-backend --update-env`
- **`sara/app` deploys itself** via Netlify on push to main (site `sara-nickward`,
  sara.nickward.co.uk). No Pi step. NOVA does **not** self-deploy.
- **Mobile:** `.main-panel` is `display:flex`, so a panel that is a direct child and does
  not set `align-self: flex-start` gets stretched and clipped (fixed in `923c3b8`).
  `WaitingOn` is never a direct child, so it is unaffected — but the next new panel will be.
