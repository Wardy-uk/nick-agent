# HANDOFF — Proactive briefings built; deploy + Monday re-consent needed

## WHAT WAS BUILT THIS SESSION

Full proactive briefing system:

| File | What it does |
|------|-------------|
| `backend/services/briefing.js` | Core: builds brief from all sources, stores in KV, pushes + emails |
| `backend/services/teams.js` | Teams Graph integration (Chat.Read scope, graceful degradation) |
| `backend/services/email-sender.js` | Graph Mail.Send (graceful degradation until Monday re-consent) |
| `backend/routes/briefing.js` | `GET /api/briefing` + `POST /api/briefing/trigger` |
| `sara/app/src/hooks/usePushSubscription.js` | Push subscription hook, fetches VAPID key at runtime |
| Modified `backend/services/scheduler.js` | Added 9am + 1pm Mon-Fri brief jobs + every-5min alert checks |
| Modified `backend/server.js` | Wired `/api/briefing` route |
| Modified `backend/routes/focus.js` | Injects `last_brief` synthesis text into `sara.briefing` (Focus view picks it up) |
| Modified `sara/app/src/App.jsx` | Added `usePushSubscription(authed)` |
| Modified `backend/services/microsoft.js` | Added scope comment for Monday re-consent |

## WHAT NEEDS TO HAPPEN BEFORE IT'S FULLY LIVE

### 1. Deploy to Pi (can do now)
```bash
# On Pi 5: nickw@100.100.28.58
git pull --ff-only origin main
pm2 restart neuro-backend --update-env
```

### 2. Fund + enable OpenRouter (do when API key available)
In `/mnt/data/nuero/backend/.env` on Pi, add/change:
```
OPENROUTER_API_KEY=<your key from openrouter.ai>
OPENROUTER_ENABLED=true
AI_MODE=hybrid
```
Then `pm2 restart neuro-backend --update-env`.

This powers both brief synthesis AND chat. Without it, briefs use local Ollama (weaker) as fallback — still works, just lower quality.

### 3. Monday re-consent for Teams + email (device code flow)
On Pi after deploy:
```bash
# Hit the device-code endpoint to get a code
curl -X POST http://localhost:3001/api/microsoft/device-code \
  -H "X-Neuro-Pin: <your-pin>"
```
Then follow the URL it gives you to re-consent with these new scopes:
- `Mail.Send` — enables brief emails
- `Chat.Read` — enables Teams DM + mention alerts
- `ChannelMessage.Read.All` — enables Teams channel message alerts

In `backend/services/microsoft.js` line 48 `GRAPH_SCOPES`, add them:
```js
const GRAPH_SCOPES = ['Calendars.Read', 'Mail.Read', 'Mail.Send', 'Tasks.Read', 'User.Read', 'Chat.Read', 'ChannelMessage.Read.All'];
```
Then deploy again + restart.

### 4. Deploy sara/app to Netlify (for push subscription)
```bash
# From sara/app dir
# Get deploy token via Netlify MCP netlify-deploy-services-reader
# Run the npx deploy command it returns
```
Push subscription code is already in App.jsx — just needs the new build deployed.

### 5. Test manually
Hit `POST /api/briefing/trigger` to force a brief without waiting for 9am:
```bash
curl -X POST https://pi5.tailecb90f.ts.net/api/briefing/trigger \
  -H "X-Neuro-Pin: <pin>" \
  -H "Content-Type: application/json" \
  -d '{"label":"test"}'
```
Check: push notification arrives, email attempted (will fail until scope added), `/api/briefing` returns the brief, Focus view shows synthesis text.

## HOW IT WORKS (brief)

1. **Scheduled**: 9am + 1pm Mon-Fri → `buildAndDeliver()` runs
2. **Collects**: decision-engine items + email triage + Teams (if scope granted)
3. **Synthesizes**: OpenRouter (if funded) → Ollama fallback → deterministic text
4. **Stores**: `db.setState('last_brief', brief)` — Focus view picks this up automatically
5. **Delivers**: push notification → email (when Mail.Send scope granted)
6. **Alerts** (every 5min): new escalation (request type OR neuro-escalation label) → push; Teams @mention → push; meeting in 10min → push

## CURRENT STATE
- All code committed to `main` on Wardy-uk/nuero
- NOT yet deployed to Pi (deploy is the next step)
- email-sender + teams.js will gracefully degrade until Monday scopes
- Brief synthesis will use Ollama until OpenRouter funded

## GIT STATE
Last commit before this session: `edfcb8f`
Files changed this session: 8 new/modified files listed above (not yet committed)
