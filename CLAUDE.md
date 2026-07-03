# NEURO — Nick's Executive Utility & Reasoning Orchestrator

Personal AI-powered productivity system. Aggregates Jira queue, Obsidian vault, Microsoft 365 (calendar/tasks/email), Strava, location tracking, and AI chat into a single PWA. Runs on Raspberry Pi 5 (16GB) via Tailscale, installed as PWA on iPhone.

## Tech Stack
- **Backend:** Express 4 + Node.js (CommonJS, `require()` — NOT ESM)
- **Frontend:** React 19 + CSS modules (per-component `.css` files) + Vite
- **Database:** sql.js (in-memory SQLite, flushed to disk). Same flush caveat as NOVA.
- **Auth:** PIN-based (`X-NEURO-PIN` header) + API token for machine clients (n8n)
- **AI:** Anthropic SDK (Claude) + Ollama (local models on Pi) with AI routing layer
- **External:** Jira REST, Microsoft Graph (MSAL device code), Strava OAuth, OwnTracks, Obsidian vault filesystem, n8n webhooks, web-push notifications
- **Monorepo:** npm workspaces — `backend/`, `frontend/`, `worker/`
- **Worker:** Separate Express app (port 3002) on Pi 4 for background AI tasks (email triage, import classification, journal prompts, transcript processing). Uses Ollama locally. Worker is stateless — it only processes, never decides.

## Project Commands
```bash
npm run dev              # API (3001) + Vite concurrently
npm run dev:backend      # nodemon server.js
npm run dev:frontend     # vite
```

## Architecture

### Backend (`backend/`)
- `server.js` — Express bootstrap, PIN auth middleware, route wiring, SPA fallback (262 lines)
- `db/database.js` — sql.js init, state KV store, query helpers
- `db/schema.sql` — Full schema (conversations, jira cache, todos, calendar, inbox, vault embeddings, entities, do-next, location visits, task MoSCoW, nudges, SARA actions, daily summary)
- `routes/*.js` — ~40 Express route modules (CommonJS `module.exports`), incl. `vault-hygiene` (lint / contextual-link / alias-suggest)
- `services/*.js` — ~45 business logic modules including AI pipelines, vault access, Jira sync, Microsoft Graph, scheduling, and `vault-hygiene` (deterministic vault-graph maintenance)

### Frontend (`frontend/src/`)
- `App.jsx` — Main SPA shell, tab navigation
- `components/*.jsx` — ~35 view components, each with matching `.css` file
- `api.js` — API client with PIN header injection
- `cacheStore.js` + `useCachedFetch.js` — IndexedDB offline caching (idb library)
- `usePushNotifications.js` — Web push subscription management
- `voiceUtils.js` — Voice input utilities

### Worker (`worker/`)
- Separate Express app on port 3002 for Pi 4
- Ollama-powered AI tasks only — email triage, import classification, journal prompts, transcript processing
- Auth via `WORKER_SECRET` header
- Stateless: processes tasks, returns results, owns no data

### MCP Server (`mcp-server/`)
- Standalone MCP server exposing NEURO APIs as tools for external Claude Code sessions
- Vault tools are **NEURO-first with local-vault fallback**: they call `/api/vault/*` (writes re-index embeddings/entities via vault-hooks); on transport failure (Pi down) they fall back to direct filesystem access via `OBSIDIAN_VAULT_PATH`, served by the `localVault` helper + `vaultDispatch` circuit breaker. NEURO reconciles offline writes on next startup (hash-based `rebuildEmbeddings`). `delete_note` is NEURO-only (needs index cleanup); `vault_backlinks`/`related_notes` degrade gracefully offline.
- Env: `NEURO_URL`, `NEURO_PIN`, `NEURO_VAULT_KEY` (→ `X-Api-Key` for `/api/vault`), `OBSIDIAN_VAULT_PATH` (local Syncthing copy for fallback)

## Key Feature Areas
| Area | Frontend | Backend |
|------|----------|---------|
| Chat | ChatPanel | chat-context-v2, claude service, AI routing |
| Queue | QueueTable | jira service, jira cache, SLA tracking |
| Vault | VaultBrowser | obsidian service, vault-cache, vault-hooks, vault-logger, embeddings |
| Standups | StandupsPanel, StandupEditor | standup routes, transcript-processor |
| Focus | FocusPanel, DoNextPanel | focus routes, do-next, next-action-engine, task-scoring |
| Briefings | sara/app Focus view (sara.briefing) | briefing.js (build+deliver), email-sender.js (Graph Mail), teams.js (Graph Chat), routes/briefing.js |
| People | PeopleBoard, PersonDetail | person-profile, person-timeline, one-to-one-prep, meeting-prep, development-plan |
| Calendar | CalendarView | microsoft service (Graph API), calendar-sync |
| Inbox | InboxPanel | email-triage, inbox-scanner |
| Journal | JournalPanel | journal routes |
| Todos | TodoPanel | todos routes, Microsoft Tasks sync |
| Insights | InsightsPanel, MetricsRow | activity service, health service |
| QA | QATab | qa routes |
| Training | — | training-sync |
| Strava | StravaPanel | strava service (OAuth) |
| Location | — | location service, OwnTracks integration |
| Nudges | NudgeBanner | nudge routes, scheduler |
| Capture | CapturePanel | capture routes |
| Imports | ImportsPanel | imports, import classification |
| Knowledge | — | kb-article, knowledge-gaps, embeddings, retrieval |
| Evidence | — | evidence-register |
| Checkpoint | NinetyDayPlan | checkpoint-progress |
| Vault Hygiene | — | vault-hygiene (routes/vault-hygiene); MCP: vault_lint, vault_contextual_link, vault_alias_suggest, vault_fix, vault_connect_orphans, vault_graph_config, vault_plaud_reconcile, vault_plaud_repull |

## Key Patterns
- **CommonJS throughout backend** — `require()` / `module.exports`. NOT ESM. No `import` statements.
- **PIN auth middleware** — all `/api/*` routes require `X-NEURO-PIN` header or `?pin=` query param. Machine clients use `X-NEURO-API-TOKEN` instead.
- **State KV store** — `db.getState(key)` / `db.setState(key, value)` for runtime state (sync status, last errors, etc.)
- **AI routing** — `ai-routing.js` routes between Claude API and local Ollama based on task type and availability
- **Vault sync** — Syncthing over Tailscale (replaced Git-based sync). Obsidian vault at `C:\Users\NickW\Documents\Nicks knowledge base`
- **Plaud intake** — `plaud-sync.js` writes transcript + preferred Plaud summary/Obsidian note, then `imports.js` routes the note of record into canonical vault paths: meetings in `Meetings/YYYY/MM/` and transcripts in `Meetings/transcripts/YYYY/MM/`, while enriching people links and keeping backlinks aligned
- **Plaud cleanup** — `/api/plaud/cleanup` and `imports.backfillPlaudNotes()` backfill historical Plaud notes, re-route legacy meeting-note copies into correct folders, archive duplicate variants, and write a cleanup report into `Documents/System/SARA Import Reports/`
- **Vault hygiene** — `services/vault-hygiene.js` is the deterministic graph-maintenance engine (pure CommonJS, takes vault root so it runs in-process or standalone via `node`). Capabilities: `lint`, `contextualLinkPlan`/`Apply`, `aliasSuggest`, `fixPlan`/`fixApply` (tiered: skip|conservative|moderate|aggressive — links default conservative=exact-only; fuzzy mislinks here so it's review-only), `connectOrphans` (fallback), `graphConfig`. Read-only by default; mutating ops are append-only/surgical, back up every touched file to `Scripts/.lint-backups/<ts>/`, write a changelog, and are idempotent (markers `<!-- ctx-links -->`, `<!-- hub-link -->`, `<!-- daily-nav -->`). Precision rules: FULL-NAME matching only, strip wikilinks/code/paths before matching, resolve path-form links when deduping, skip names mapping to >1 person. Reports → `Documents/System/Vault Audit/`. Exclude set must include generated output (`Vault Audit`, `.lint-backups`, `Archive`…) or scans self-pollute. Wired into the scheduler as a READ-ONLY Friday 4:35pm pass (refreshes lint + link cards, never applies). Ports of the throwaway `Scripts/_*.js` prototypes; full spec in `Projects/NEURO/Vault Hygiene Engine — Build Handoff` (vault).
- **PLAUD reconcile/repull** — `plaud-sync.js` `reconcilePlaudRecordings()` (read-only) lists every PLAUD recording and finds those with no ACTIVE note (Archive excluded) by plaud_id or date+title-token Jaccard ≥0.5; `repullPlaudRecordings({ids?,limit?})` re-pulls them FRESH (never from Archive) through the existing throttled (750ms gap, concurrency 1), 429-backoff-with-jitter, ledger-persisted-per-recording pipeline — resumable: a crash continues from the ledger. The §9.3 "no throttling" lesson was about the separate Obsidian plaud-mcp-sync plugin, NOT this service.
- **Offline-first** — IndexedDB caching via `idb` library, service worker for PWA
- **Per-component CSS** — each component has its own `.css` file, no Tailwind
- **SPA fallback** — non-API routes serve `index.html` with no-cache headers
- **Scheduler** — `node-cron` based background jobs (Jira sync, nudge checks, etc.)

## Deployment
- Runs on Raspberry Pi 5 (16GB) at home
- Accessible via Tailscale VPN
- Frontend built with Vite, served by Express in production
- PWA installed on iPhone
- Worker runs on separate Pi 4

## GitHub
Repo: `Wardy-uk/nuero` (note: typo in repo name is intentional/historical)

## Post-Build Rule
**After every successful build or significant feature completion, update this CLAUDE.md to reflect any new routes, services, views, patterns, or architectural changes. Keep it accurate to the codebase.**

## Session Start Ritual
At the start of every session, before writing any code:
1. Read `.claude/memory/handoff.md` — pick up where the last session left off
2. Read `.claude/memory/mistakes.md` — avoid repeating past errors
3. Read `.claude/memory/patterns.md` — follow established conventions

## Session End Rule
When context is getting long (~60%+), or Nick says "write a handoff", or a task is complete — write a handoff summary to `.claude/memory/handoff.md` following the skill in `.claude/skills/handoff.md`.
