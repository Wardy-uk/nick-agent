# Next session — gather everything left, re-prioritise it, then build

Continuing NEURO. Read `.claude/memory/handoff.md` (the **2026-08-16 night** entry
is newest, at the top), then `mistakes.md`, then `patterns.md`.

## Before touching anything

`git status`, and `git diff <file>` on **every file before you stage it**. Nick runs
2–3 Claude sessions on this repo at once. As of the last session another one was
live and holding ~14 uncommitted files — `CLAUDE.md`, `routes/{capture,imports,
journal,standup}.js`, `services/{ai-provider,briefing,claude,decision-engine,
imports,nudges,scheduler,standup-session}.js`, `prompt-parity.test.js`,
`sara/app/src/views/{Focus,Tasks}.jsx`, plus a new `services/sara-voice.js`.
Explicit staging protects against unrelated *files*, not unrelated *hunks* in a
file you legitimately touched. If an edit tool says "the file had been modified on
disk since you last read it", that is a collision signal, not line-ending noise.

**`CLAUDE.md` is OWED** for #26, #40, #41 and #42 and was deliberately not written
— it is one of that session's modified files. Write it once their work lands, and
diff it first.

## State — verified at the end of 16 Aug, not assumed

Local and Pi both clean at `c135730`, `main` in sync with origin. Pi suite
**430/430**, backend online, `unstable_restarts` 0.

Shipped that night: `0a88af9` #26 · `0032f38`+`1ce0a4b` #40 (+#41) ·
`6ff90c8`+`9df11a4` #42, plus docs `a0f612c`, `52ae96e`, `c135730`.

### Two things in flight that need checking FIRST

1. **The Apple Health backfill is still running.** ~256,000 samples, **0 rejected**,
   13 metrics, newest `2026-05-08` and climbing (it backfills forward from Aug
   2024). It is still in ACTIVITY metrics. **HRV has not arrived yet, so the one
   metric #40 exists for is still unconfirmed on real data.** When vitals land:
   - check HRV units are `ms` (the parser refuses anything else rather than
     storing at an unknown scale — see `UNIT_RULES` in `services/apple-health.js`);
   - check whether `/api/health/stress` leaves `calibrating`. The backfill brings
     history with it, so it may go straight to a real score. **If it does, #43
     ("the score says nothing for its first fortnight") closes itself with no code
     — verify before building anything for it.**
   - The card is Sidebar → **Insights**, top of the panel.
2. **`escalation_alert_wide_seeded` may still be null.** `checkEscalationAlerts`
   runs `*/5 8-18 * * 1-5`, weekdays only. **Unset is NORMAL — do not "fix" it**,
   and do not widen anything else in `briefing.js` before it has run once.

## The task

**Gather everything left to build, re-prioritise it, then crack on.**

### Why a re-rank is the first job, not the second

The tracker's own **"Order of play"** section (`Projects/NEURO/NEURO Feature
Tracker.md` in the vault) was written **15 Aug** and has not been re-run since.
Measured at the end of 16 Aug: **66 open items — 34 Ready, 20 Needs Nick, 5
Blocked, 7 Parked.** P1–P4 are clear, so the ranked queue currently contains
exactly one build (**#59**, off-site backup) while **16-odd items numbered #99 and
above have never been ranked at all** — including #119–#121, captured that night.
So "what's ranked" and "what's outstanding" have come apart, and the ranking is
the thing that fixes it.

Rank the way that section already does: **by cost of waiting, not by size or by
how interesting it is.** Everything not named is genuinely "later" — that is the
point of ranking. Put the proposed order to Nick before building from it.

### Known facts to fold into the ranking

- **The cheapest unlock on the board is #116** — NOVA's msgraph MCP token has
  expired. That single re-auth (Nick, ~2 min) unblocks **#115, #117 and #118**,
  all Ready. Best ratio anywhere in the list.
- **#59 is the only ranked build left**, and it is infrastructure rather than a
  feature: backups are hardlinked snapshots on a USB stick plugged into the same
  Pi as the data, so one fire/theft/power event loses the vault, the HA history
  and the NEURO DB together.
- **P0 is not software** and is Nick's, in the office: **#2** (Teams consent),
  **#99** (read the 287 waiting-on items), **#106** (approve one SARA action —
  no executor except the chase has ever run).
- **P5 is decisions only Nick can make**: #91, #47, #57, #37, #18, #67/#68.
  Note **#40 has dropped out of that list** — it was the biggest blocker there
  ("blocks #41/#42/#43/#44 entirely") and is now done.
- **Debt worth ranking honestly**: #21 (dead `one-to-one-prep.js`), #52 (the
  90-day plan still injected in three places), #107 (`sara_actions` 96% dead rows,
  nothing prunes it), #78 (929 pending action candidates), #119 (`npm test`
  creates and deletes files in the REAL vault via `scripts/test-tier1.js`).
- ⚠ **The tracker has duplicate numbers** — #66, #78, #106 and #107 each appear
  twice, and `feature-tracker.js` already works around this by numbering
  `max+1` rather than counting. **The number is not a reliable key**; match on
  title as well.
- ⚠ Rows go stale. #25, #28 and #69 shipped on 16 Aug and still read "Ready" the
  next day until corrected. **Cross-check any "Ready" row against `git log`
  before ranking it as outstanding.**

## The rule this repo keeps relearning

**Every ticket premise has been wrong.** #25 said "zero hits for bank holidays"
(there was a dead, wrong list). #28 said "logged decisions render nowhere"
(nothing had ever been logged — building the view as written would have shipped
an empty screen that looked finished). #26 said "seven tabs, falls back to Focus"
(eight tabs; it opened a sheet; and the real finding — the phone was on the
retired stepper — was not in the ticket at all). #40's brief specified a Docker +
TimescaleDB stack and a poller; reading the app's source showed none of it was
needed, and Phase 3 was already built.

**Measure before building. State what you measured. If the ticket is wrong, say
so and correct it in the tracker row.**

Two more that keep biting:
- **A green suite says nothing about routing.** Call any new route against the
  running server before calling it done.
- **A feature is not available until it is reachable from the UI.** A new view
  needs its Sidebar entry in the same commit.

## Deploy sequence

`git pull --ff-only` → `cd frontend && npm run build` → `cd ../backend && npm test`
→ `pm2 restart neuro-backend --update-env`.

- **Node 22.22.2 must be on PATH for any pm2 command** (Node 20 segfaults
  better-sqlite3): `export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH`.
- DB at `/mnt/data/nuero/backend/db/agent.db` — open `{readonly:true}` while the
  backend runs.
- `sara/app` deploys to Netlify (`sara-nickward`, base `sara/app`) on push to main.
  Verify against the LIVE bundle and check `VITE_BUILD_LABEL` — it carries the
  commit SHA.
- ⚠ **Before exempting any route from auth on the Pi, run `tailscale serve status`
  first.** pi5 serves `https://pi5.tailecb90f.ts.net` → `127.0.0.1:3001` with
  **Funnel ON** (public internet), and Tailscale proxies both tailnet and public
  traffic from `127.0.0.1` — so a source-IP check that trusts loopback publishes
  the route to the world. That happened on 16 Aug; see `mistakes.md`.
