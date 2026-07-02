# HANDOFF — SARA light-touch app is LIVE (2026-07-01)

## TL;DR
Both this session's missions are DONE. (1) Defined NEURO (brain) vs SARA (interface) in a canonical vault note. (2) Built a **brand-new** SARA light-touch app (`sara/app`) and deployed it live at **https://sara.nickward.co.uk** (Netlify, custom domain, HTTPS), wired to the NEURO brain. Handwriting capture landed on the free iPadOS Scribble route (the paid ink-canvas/OCR path was built, proven, then removed).

## The model we locked (canonical)
- **NEURO** = the brain. Headless service layer (vault, Jira, M365, AI, APIs). No app of its own.
- **SARA** = the interface. Persona + every surface (kiosk, desktop, Stream Deck, **and the new light-touch app**).
- Canonical note (Windows vault): `Projects/NEURO/NEURO & SARA — What They Are.md` — has the definitions, the 5-area scope, and the build/deploy/security decisions. If anything contradicts it, that note wins. It supersedes the older `Documents/Reference/NEURO - SARA Architecture Review.md`.

## What got built — `sara/app` (NEW sub-project)
- **Not** a rebuild of the legacy `frontend/` (which stays as legacy, retire whenever). Brand-new React 19 + Vite + PWA, per-component CSS.
- Sibling to `sara/backend` + `sara/frontend`. `sara/` uses `npm --prefix` sub-projects, NOT root workspaces — wired into `sara/package.json` as `dev:app` / `build:app` / `install:all`.
- Local dev: `npm --prefix app run dev` (port 5175); launch.json config `sara-app`. Dev proxy `/api` → `http://localhost:3001` (NEURO backend).
- **Five areas, nothing else** (heavy command-centre stays on kiosk/desktop):
  | Area | Endpoint(s) |
  |---|---|
  | Focus (default) | `GET /api/focus` (+ `/dismiss`) |
  | Capture | `POST /api/capture/note` · `/todo` · `GET /recent` (+ voice dictation; handwriting = Scribble into the note box) |
  | Chat | `POST /api/chat` (SSE) → `/api/chat/sync` fallback |
  | Prep | `GET /api/meeting-prep` |
  | Brain | `/api/vault-hygiene/*` (lint/contextual-link/alias-suggest/connect-orphans) + `/api/plaud/reconcile`·`/repull` |
- Auth: PIN in `localStorage['neuro_pin']` → `X-Neuro-Pin` header on every call; vault key → `X-Api-Key` on `/api/vault*`. Enter-once-per-device. (Decided to KEEP the PIN — it's the only gate on the public brain; see security note.)

## Deploy facts (both tiers)
- **Frontend → Netlify.** Site `sara-nickward`, id `e6fdb633-cfd7-4c05-996a-b6bbdfd01a5b`, team `5ef71a8c88e4b776f2e4ebc2`. Primary domain **sara.nickward.co.uk** (Netlify DNS — zone on nsone.net/NS1, so custom domains auto-create record + cert; no external registrar step). `VITE_API_URL=https://pi5.tailecb90f.ts.net` is committed as **`sara/app/.env.production`** (public URL, not a secret) so every build bakes it in. ⚠️ GOTCHA: the Netlify *build-env var* silently did NOT apply — the deployed bundle called relative `/api` (Netlify served the SPA, not the brain) → empty Focus/Prep with no error. `.env.production` is the reliable fix (commit `89cfb04`). Verify after any deploy: `curl <site>/assets/index-*.js | grep pi5.tailecb90f.ts.net` must return a hit.
  - **Redeploy:** call Netlify MCP `deploy-site` (siteId above) → it returns an `npx -y @netlify/mcp@latest --site-id ... --proxy-path "<token>"` command → run it **from `sara/app`** (uploads + builds server-side; token is single-use, get a fresh one each time). No Netlify CLI auth in-session; the MCP proxy carries auth.
- **Backend → Pi 5.** `nickw@100.100.28.58`, `/mnt/data/nuero`, branch `main`, PM2 `neuro-backend`. Deploy = `git pull --ff-only origin main` then `export PATH=/home/nickw/.nvm/versions/node/v20.20.2/bin:$PATH && pm2 restart neuro-backend --update-env`. ALWAYS check `git status` clean on the Pi before pulling (see mistakes.md — never force a dirty tree).
- **Brain connectivity (as-built):** app calls `https://pi5.tailecb90f.ts.net` — the Pi already exposes `:3001` over **Tailscale Funnel = PUBLIC HTTPS**, PIN-gated. `app.use(cors())` is already open (verified preflight with `x-neuro-pin` → 204). So the app works off-tailnet; zero brain/Pi changes were needed to deploy.

## Handwriting → text = iPadOS Scribble (free)
- Final answer: write with the Pencil directly into the Capture note box; iPadOS converts on-device. No canvas, no OCR endpoint, no cloud key. Works in the standalone PWA today.
- We DID build an ink-canvas + `POST /api/capture/handwriting` (Claude vision) and proved it end-to-end — but the paid path was unfunded, so it was removed (commit `c13b305`). If revisited: **the Pi's `ANTHROPIC_API_KEY` has NO credit balance; `OPENROUTER_API_KEY` is absent.** OpenRouter is the brain's intended cloud path (`ai-routing.js`, default model `anthropic/claude-haiku-4.5`). Fund **OpenRouter** once → powers chat AND could power vision; no direct-Anthropic dependency needed (the only direct-Anthropic caller was the now-removed handwriting route).

## Known / pending (all optional, all Nick's call)
- **Cloud AI is unfunded** → chat currently runs local-Ollama-only (works, weaker). Fund OpenRouter (`OPENROUTER_API_KEY` + `OPENROUTER_ENABLED=true` in `backend/.env`, restart) to get full-strength chat.
- **Brain is public via Funnel, PIN-gated** (pre-existing Pi config, NOT set up this session). Flagged in the vault note. If unintended, switch `:3001` from Funnel to tailnet-only Serve (app then needs the device on Tailscale).
- Legacy `frontend/` PWA still exists — retire whenever.

## Git state
- `main` @ `c13b305` (pushed to origin/Wardy-uk/nuero). Feature branch `feat/sara-light-touch-app` was ff-merged into main.
- Vault note is Windows-canonical (Syncthing to Pi); not a git repo.

## Session Start Ritual (from CLAUDE.md)
1. Read this handoff. 2. `mistakes.md`. 3. `patterns.md`. Repo `Wardy-uk/nuero`. Pi 5 = `nickw@100.100.28.58`.
