# Patterns That Work

# High-signal learnings from NEURO development. Claude reads this at session start.

- Backend is CommonJS (`require`/`module.exports`). NEVER use `import` statements in backend code. This is the single most common mistake.
- Database is better-sqlite3 (native SQLite, WAL) as of 2026-08-12 — migrated from sql.js. Writes commit immediately, so there is NO save()/flush step: never add one. WAL means external scripts can read while the server runs (the old "stop the server first" rule is dead). Writes from a second process still need care. All access goes through the ~90 helpers in `db/database.js`; keep it that way rather than reaching for `getDb()`.
- `batchSaves(fn)` is now a real transaction (sync fn only) — it rolls back on throw. Use it for any multi-write operation that must be all-or-nothing.
- PIN auth is app-level middleware in server.js. New routes under `/api/*` get auth automatically. Push, SSE, and Strava OAuth endpoints are explicitly exempted.
- Machine clients (n8n) authenticate via `X-NEURO-API-TOKEN` header, not PIN. Check `req.apiClient` to identify machine callers.
- AI routing (`ai-routing.js`) decides between Claude API and local Ollama. Don't hardcode AI provider in individual services.
- Vault sync is Syncthing over Tailscale — NOT Git. Don't add Git-based sync code.
- Worker on Pi 4 is stateless. It processes AI tasks and returns results. Never add state management or database access to the worker.
- Frontend uses per-component CSS files, NOT Tailwind. Every new component needs a matching `.css` file.
- IndexedDB caching (`cacheStore.js`, `useCachedFetch.js`) provides offline resilience. API responses should be cacheable where possible.
- The repo name `nuero` is a historical typo. Don't rename it.
