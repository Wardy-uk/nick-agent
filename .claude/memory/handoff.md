# HANDOFF — Next build: proactive briefings ("what must Nick do next")

## THIS SESSION'S MISSION
Make SARA **tell Nick what to do next**, proactively — he shouldn't have to go looking. Build regular briefings + alerts into SARA (the live light-touch app at **sara.nickward.co.uk**).

1. **Aggregate ALL the sources** into one "do next" picture: email, **Microsoft Teams**, and every todo source (Jira queue, vault `Master Todo.md`, Microsoft To Do/Tasks, do-next).
2. **Scheduled briefs** — a **morning brief** + a **midday brief** at minimum (EOD/more optional).
3. **Alerts when needed** — event-driven pushes for the stuff that can't wait for the next brief.
4. **Deliver into SARA** — push notification + a glanceable brief surface in the app.

⚠️ Talk the shape through with Nick FIRST (open questions below) before building — especially where the brief surfaces and the Teams scope.

## Big head start — most of this already exists (do NOT rebuild)
- **`/api/focus`** (`backend/services/decision-engine.js`) ALREADY synthesizes "what matters now" across escalations, at-risk Jira, meetings, overdue todos, nudges, email — tiered + scored + urgency-ranked, with an AI-enhanced SARA block (`ai-provider.js`). The briefing is mostly *schedule this + add the missing sources + deliver it*, not a from-scratch build.
- **Sources already wired in the brain:**
  - Email → `microsoft.js` (Graph), `email-triage.js`, `inbox-scanner.js`, `/api/inbox`
  - Calendar → `microsoft.js`, `calendar-sync.js`, `/api/meeting-prep`
  - Todos → `todos` routes (MS Tasks sync), vault `Tasks/Master Todo.md`, `do-next.js`, `next-action-engine.js`, `task-scoring.js`
  - Jira queue + SLA → `jira.js`, jira cache
  - Nudges + scheduling → `nudge` routes + `scheduler` (node-cron) — morning/midday jobs slot straight in here
  - Push → `webpush` service + `/api/push` (push/SSE are PIN-exempt in `server.js`)
  - Daily rollup → `activity.js`
- **Teams is the likely gap:** email/calendar/tasks come via Graph, but Teams messages/@mentions are probably NOT pulled yet. Adding Teams likely needs new Graph scopes (`Chat.Read`, `ChannelMessage.Read`, `Chat.ReadBasic`) via the existing MSAL device-code flow. **Verify current scopes before assuming.**

## What's genuinely new to build
1. **Teams source** — `services/teams.js`: pull recent Teams @mentions/DMs via Graph, triage for "needs Nick." New scopes + re-consent (device code).
2. **Briefing synthesizer** — `services/briefing.js` + `GET /api/briefing`: assemble a prioritized "do next" brief across all sources (reuse `/api/focus` + email/Teams triage). Short list: Do-next 1/2/3 · Can-wait · Ignore.
3. **Schedule it** — node-cron jobs (morning ~08:00, midday ~12:30) in the scheduler that build the brief and push it. Context-aware (skip if already actioned — the decision-engine already tracks this).
4. **Alerts** — event-driven push when urgency trips a threshold (new escalation, SLA imminent, urgent email, Teams @mention, meeting in N min). The decision-engine already scores urgency — hook alerts to its high-urgency signals. Keep alerts RARE + high-signal (Nick's ND: alert noise = ignored app).
5. **Deliver into `sara/app`** — ⚠️ the new app does NOT yet have web-push wired (legacy `frontend/` had `usePushNotifications.js`; `sara/app` is minimal). Build: push subscription in `sara/app` + a **Brief** surface (new nav area, or fold into Focus which is already "what matters now").

## Open questions for Nick (decide before building)
1. **Where does the brief live?** New "Brief" tab, or enhance the existing **Focus** view (already the "what matters now" glance)? Push body + tap-through?
2. **Teams:** OK to add Teams Graph permissions (re-consent via device code)? Just @mentions/DMs, or channels too?
3. **Cadence + times:** morning brief at ? · midday at ? · EOD? · weekends on/off?
4. **Alert thresholds:** what earns an interrupt vs. waits for the next brief?
5. **AI for synthesis:** a genuinely good synthesized brief wants a capable model — but **cloud AI is currently unfunded** (see below), so synthesis falls back to local Ollama (weaker) or the deterministic path. Funding OpenRouter materially improves brief quality. Flag to Nick.

---

## CURRENT STATE — SARA lite app is LIVE (background; stable)
- **Live at https://sara.nickward.co.uk** (Netlify site `sara-nickward`, id `e6fdb633-cfd7-4c05-996a-b6bbdfd01a5b`, team `5ef71a8c88e4b776f2e4ebc2`). Custom domain on Netlify DNS (nsone/NS1). Installable PWA, PIN-gated, verified working end-to-end.
- **App = `sara/app`** (React 19 + Vite + PWA, per-component CSS). NEW sub-project (npm `--prefix`, NOT root workspaces), sibling to `sara/backend`+`sara/frontend`, wired in `sara/package.json` (`dev:app`/`build:app`). Six nav areas: **Focus · Capture · Voice · Chat · Prep · Brain** (Voice = one-tap into live dictation). Legacy `frontend/` still exists — retire whenever.
- **Definitions:** NEURO = brain, SARA = interface. Canonical vault note `Projects/NEURO/NEURO & SARA — What They Are.md`.

## Deploy facts (both tiers)
- **Frontend → Netlify.** `VITE_API_URL` is committed as **`sara/app/.env.production`** (public URL, not secret) so every build bakes in the brain URL. ⚠️ GOTCHA: the Netlify *build-env var* silently did NOT apply → relative `/api` → Netlify served the SPA not the brain → empty screens with no error. `.env.production` is the fix. **After ANY deploy verify:** `curl <site>/assets/index-*.js | grep pi5.tailecb90f.ts.net` must return a hit.
  - **Redeploy:** Netlify MCP `deploy-site` (siteId above) → returns an `npx -y @netlify/mcp@latest --site-id ... --proxy-path "<one-use token>"` command → run it **from `sara/app`** (uploads + builds server-side). No Netlify CLI auth in-session; the proxy token carries auth.
- **Backend → Pi 5.** `nickw@100.100.28.58`, `/mnt/data/nuero`, branch `main`, PM2 `neuro-backend`. Deploy: `git pull --ff-only origin main` then `export PATH=/home/nickw/.nvm/versions/node/v20.20.2/bin:$PATH && pm2 restart neuro-backend --update-env`. ALWAYS check `git status` clean on the Pi first (see mistakes.md).
- **Brain URL:** `https://pi5.tailecb90f.ts.net` — Pi exposes `:3001` over Tailscale **Funnel = PUBLIC HTTPS**, PIN-gated. `app.use(cors())` already open. Works off-tailnet.
- **Auth:** PIN in `localStorage['neuro_pin']` → `X-Neuro-Pin` header; vault key → `X-Api-Key` on `/api/vault*`. Lock screen now VALIDATES the PIN against `/api/focus` before unlocking (wrong PIN → "Incorrect PIN"); header **🔒** button clears the PIN to re-enter. One-time PIN per device (no persistent lock).

## Known / pending (optional, Nick's call)
- **Cloud AI unfunded** → chat + AI synthesis run local-Ollama-only. `OPENROUTER_API_KEY` is absent; the Pi's `ANTHROPIC_API_KEY` has no credit balance. OpenRouter is the brain's intended cloud path (`ai-routing.js`, default `anthropic/claude-haiku-4.5`). Fund OpenRouter → powers chat AND better brief synthesis. **Directly relevant to this mission.**
- **Brain is public via Funnel, PIN-gated** (pre-existing Pi config). If unintended → switch `:3001` to tailnet-only Serve (app then needs the device on Tailscale). Noted in the vault note.
- Handwriting capture = free iPadOS Scribble into the Capture note box (paid ink/OCR path was built then removed — Anthropic/OpenRouter unfunded).

## Git state
- `main` @ `edfcb8f` (pushed, Wardy-uk/nuero). All app work is on main.

## Session Start Ritual (from CLAUDE.md)
1. Read this handoff. 2. `mistakes.md`. 3. `patterns.md`. Repo `Wardy-uk/nuero`. Pi 5 = `nickw@100.100.28.58`.
