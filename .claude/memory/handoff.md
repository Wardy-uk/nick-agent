# HANDOFF — Fix SARA Mobile Netlify Host / iPhone Offline State

## SUMMARY

SARA Mobile is not genuinely offline.

The NEURO brain behind it is healthy and reachable over Tailscale:
- `https://pi5.tailecb90f.ts.net/api/health` responds
- `https://pi5.tailecb90f.ts.net/api/focus` responds with a valid `X-Neuro-Pin`

The real issue is that `https://sara.nickward.co.uk` is currently serving the **NUERO** frontend, not the `sara/app` mobile PWA. That means the iPhone-installed SARA Mobile app is coming from the wrong host or from a stale install of the wrong site, so it appears "offline" / broken even though the backend is up.

## WHAT WAS CHANGED IN CODE

These mobile-app hardening changes are already in the repo:

| File | What it does |
|------|-------------|
| `sara/app/index.html` | Renames browser/PWA title to **SARA Mobile** |
| `sara/app/src/runtime.js` | Reads deploy/runtime config and detects wrong-host / missing-API deployments |
| `sara/app/src/components/DeploymentGuard.jsx` | Shows a blunt deployment error screen instead of a fake offline state |
| `sara/app/src/App.jsx` | Blocks normal app boot when deploy is miswired; shows build label in header |
| `sara/app/src/App.css` | Styles deployment-guard screen |
| `sara/app/.env.example` | Documents `VITE_ALLOWED_HOSTS`, `VITE_CANONICAL_URL`, `VITE_BUILD_LABEL` |
| `sara/app/README.md` | Documents the Netlify/mobile-host setup |

The mobile build passes locally.

## PRIMARY OBJECTIVE

Use the **Netlify MCP server/tools** to fix the SARA Mobile deployment so the iPhone app comes from its own dedicated host and not from the NUERO site.

## WHAT CLAUDE CODE SHOULD DO

### 1. Find the two relevant Netlify sites

Use the Netlify MCP server to identify:
- the site currently serving `sara.nickward.co.uk`
- the separate site that should deploy `sara/app`

Confirm which site is building:
- repo root / `frontend` = NUERO
- `sara/app` = SARA Mobile

Important repo facts:
- Root Netlify config: `C:\Users\NickW\Claude\nuero\netlify.toml`
  - builds `frontend`
- Mobile Netlify config: `C:\Users\NickW\Claude\nuero\sara\app\netlify.toml`
  - builds `sara/app`

### 2. Do NOT leave `sara.nickward.co.uk` pointing at the mobile app unless that is the final deliberate decision

Current problem:
- `https://sara.nickward.co.uk` returns HTML titled `NUERO`
- `https://sara.nickward.co.uk/manifest.webmanifest` returns `404`
- `https://sara.nickward.co.uk/registerSW.js` returns `404`

That proves it is not serving the mobile PWA build.

Best fix:
- keep the main SARA/NUERO site on its existing host
- assign SARA Mobile its **own dedicated host**

Recommended host options:
- `mobile.nickward.co.uk`
- `sara-mobile.nickward.co.uk`

### 3. Configure the SARA Mobile Netlify site

In the Netlify site that deploys `sara/app`, set these environment variables:

```bash
VITE_API_URL=https://pi5.tailecb90f.ts.net
VITE_ALLOWED_HOSTS=<mobile-host>,<netlify-site-name>.netlify.app
VITE_CANONICAL_URL=https://<mobile-host>
VITE_BUILD_LABEL=prod-mobile
```

Example if using `mobile.nickward.co.uk`:

```bash
VITE_API_URL=https://pi5.tailecb90f.ts.net
VITE_ALLOWED_HOSTS=mobile.nickward.co.uk,<actual-mobile-site>.netlify.app
VITE_CANONICAL_URL=https://mobile.nickward.co.uk
VITE_BUILD_LABEL=prod-mobile
```

### 4. Make sure the Netlify site is actually building `sara/app`

Confirm in Netlify:
- base directory is `sara/app`
- build command is `npm run build`
- publish directory is `dist`

Do not let the root `netlify.toml` for `frontend` drive the mobile site.

### 5. Trigger a deploy through Netlify MCP

Once env vars and domain are correct:
- trigger a fresh deploy of the mobile site
- wait for it to finish
- verify the live site returns:
  - title `SARA Mobile`
  - `manifest.webmanifest` exists
  - `registerSW.js` exists

### 6. Verify the live mobile site behaves correctly

Check that the deployed mobile host:
- loads the SARA Mobile shell
- targets `https://pi5.tailecb90f.ts.net`
- does **not** show the deployment-guard screen when opened on the correct host
- **does** show the deployment-guard screen if served from the wrong host

### 7. Update stale links if appropriate

Search for old mobile-facing links that still point at `https://sara.nickward.co.uk`.

Known example:
- `C:\Users\NickW\Claude\nuero\backend\services\email-sender.js`

If that link is intended to open the mobile app, update it to the new dedicated mobile host.
If it is intended to open desktop/full SARA, leave it alone.

### 8. Give the user clear post-deploy steps

After the correct mobile host is live, tell Nick to:
1. delete the current iPhone home-screen `SARA Mobile` app
2. open the new mobile URL in Safari
3. add it to the home screen again

This is necessary to flush the stale install/origin mismatch.

## SUCCESS CRITERIA

The task is only complete when all of these are true:
- SARA Mobile has its own dedicated Netlify-backed host
- that host serves the `sara/app` build, not NUERO
- the site exposes `manifest.webmanifest` and `registerSW.js`
- the app opens on iPhone without showing "offline" due to host mismatch
- the app still talks to `https://pi5.tailecb90f.ts.net`

## IMPORTANT DIAGNOSIS TO PRESERVE

This was **not** a Tailscale outage.

Backend checks already proved:
- backend reachable
- auth working
- mobile app production API target correct

The problem was the **wrong public host / wrong Netlify site / stale iPhone PWA origin**.

---

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
