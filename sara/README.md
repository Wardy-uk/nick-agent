# SARA Runtime

Systematic Action & Response Agent — the manifestation/interaction layer of NEURO.

## The boundary (read this first)

**NEURO is the canonical brain and the source of truth.** It owns the tasks table, the
vault, the calendar, the people graph, the AI routing, the schedulers — everything.

**SARA is a thin manifestation layer.** Its job is to *surface* what NEURO knows and to
*hand writes back* to NEURO. Concretely, SARA is:

* notifications and ambient presence,
* widget/kiosk payloads and lightweight focused UI,
* capture handoff — catching a thought and forwarding it to NEURO.

**SARA is NOT a second brain and NOT a canonical store.** It has no database. It must
never become the only place a piece of Nick's data lives. If you find yourself adding
persistence to `sara/backend`, that is the signal you are building the wrong thing —
the write belongs in NEURO, behind a NEURO route.

The one exception is *transport state*: the Home Assistant telemetry bus, the presence
lock, and the cached NEURO snapshot. None of it is authoritative and all of it is
disposable.

> Note there are two SARA frontends. `sara/frontend` (this one) is the **Pi 4 desk
> kiosk**, served by `sara/backend` on :3005. `sara/app` is the **phone PWA** and is a
> direct NEURO client — it never touches `sara/backend` at all.

## Provenance: SARA never invents Nick's day

Every screen must be able to say where its numbers came from. The model exposes a
`provenance` block and every domain carries a `source`, and there are exactly four:

| Provenance | Means | What a screen may claim |
|---|---|---|
| `neuro` | read from NEURO just now | the number, plainly |
| `neuro-stale` | read from NEURO earlier; NEURO is not answering now | the number, **labelled with its age** |
| `unavailable` | could not be read | **nothing** — empty, and say why |
| `demo` | invented | nothing real; the banner shouts DEMO |

Two rules follow from that table, and they are the ones to protect:

1. **Empty-because-unread is never rendered as empty-because-clear.** An unread queue
   is `open: null`, not `0`, and the briefing says *"SARA cannot read anything from
   NEURO right now… this is not an all-clear"* rather than *"Queue is calm"*.
2. **Seeded content cannot reach production.** `backend/src/state/seed.js` still
   exists, but it is only reachable under `SARA_DEMO_MODE=true`, is stamped `demo` on
   every domain, and is **refused outright when `NODE_ENV=production`**. It previously
   served as the outage fallback, which meant a dead feed rendered as a plausible,
   specific, entirely fictional day — including an invented performance concern about
   a named colleague.

The UI half is `frontend/src/components/ConnectionStatus.jsx`: a compact banner that is
**silent when everything is live** and loud otherwise. Silence is the signal.

## The NEURO connection (explicit configuration)

SARA cannot do its job without NEURO, so the dependency is explicit. There is **no
default base URL** — an earlier version defaulted to a public host, so an unconfigured
SARA silently reached out over the open internet and looked configured while doing it.

| Variable | Required | Purpose |
|---|---|---|
| `NEURO_BASE_URL` | **yes** | Where NEURO is, e.g. `http://100.100.28.58:3001`. No default. |
| `NEURO_API_TOKEN` | one of these | Machine credential (`X-NEURO-API-TOKEN`). Preferred — SARA is a machine client. |
| `NEURO_PIN` | one of these | PIN credential (`X-NEURO-PIN`). Can also be set at runtime from the Settings screen. |
| `SARA_PORT` | no | Backend port, default **3005** (kept off NEURO's 3001). |
| `SARA_NEURO_POLL_MS` | no | Snapshot poll interval, default 30000. |
| `SARA_NEURO_TIMEOUT_MS` | no | Per-request timeout, default 5000. |
| `SARA_DEMO_MODE` | no | `true` enables seeded content. **Never set this in production** — it is refused under `NODE_ENV=production` anyway. |

Configuration is **validated at startup** and logged (`[SARA NEURO] configured — …` or
`[SARA NEURO] NOT CONFIGURED — …`), and exposed non-sensitively on `GET /api/health`
under `neuro`: `configured`, `ready`, `baseUrl`, `credentialConfigured`,
`credentialKind`, `problems`, `available`, `stale`, `ageMs`. It reports **whether** a
credential is set, never what it is. Nothing here — logs, health, state — ever carries
a PIN or a token, and captured text is never logged.

SARA never refuses to boot on a bad NEURO configuration: the kiosk is also where a PIN
gets entered, so a SARA that will not start cannot be repaired from the device in front
of you.

### Behaviour by environment

* **Local development.** Point `NEURO_BASE_URL` at a NEURO you can reach (`http://localhost:3001`
  if you are running one, or the Pi over Tailscale). Without it, SARA boots, logs the
  problem, reports `not-configured` on `/api/health`, renders empty screens with the
  banner explaining why, and **refuses captures** rather than dropping them silently.
* **Deployed NEURO (the Pi).** `NEURO_BASE_URL=http://127.0.0.1:3001` plus a credential.
  Health goes `ready: true`, the banner goes silent.
* **NEURO unavailable.** The snapshot keeps the last good payload for up to 15 minutes
  and marks it `stale` with its age; past that it degrades to `unavailable` and the
  screens go empty. Captures fail loudly (see below). There is **no offline write
  queue** — that is a deliberate Phase 1 non-goal.

## Capture

`POST /api/capture/note` and `POST /api/capture/todo` forward to NEURO's canonical
capture routes. SARA stores nothing of its own; NEURO writes the note file / the tasks
row and runs its own vault hooks, activity tracking and dedupe.

**A capture is reported saved only when NEURO acknowledged it** — a 200 carrying
`success: true`, not merely a 200. Everything else answers `saved: false` with a reason:

| Situation | HTTP | `reason` |
|---|---|---|
| `NEURO_BASE_URL` / credential missing | 503 | `not-configured` |
| NEURO unreachable | 504 | `unreachable` |
| NEURO too slow | 504 | `timeout` |
| Credential rejected | 502 | `unauthorized` |
| NEURO refused the content | its own 4xx | `rejected` |
| NEURO errored, or answered without acknowledging | 502 | `upstream-error` |

The Capture screen prints `NOT saved — <reason>` and **leaves the text in the box**.
That last part is the point: clearing the box on a failure destroys the only remaining
copy of the thought, which is exactly what capture exists to prevent.

## Screen inventory

Registered in `frontend/src/state/views.js` and routed by `components/ViewRouter.jsx`.

| View id | Screen | Status |
|---|---|---|
| `cognition` | CognitionEnvironment | built |
| `context` | ContextView | built |
| `briefing` | MissionControl | built (full-bleed) |
| `sara` | CompanionView | built — chat, proxied to NEURO's `/api/chat` |
| `standup` | StandupView | built |
| `queue` | ExecutiveDashboard | built, but see the note below |
| `at-work` | AtWorkView | built — reads NOVA, not NEURO |
| `team` | TeamView | built |
| `focus` | FocusView | built |
| `todos` | TodosView | built |
| `vault` | VaultView | built |
| `capture` | CaptureView | built — the capture bridge above |
| `settings` | SettingsView | built |
| — | `screens/stream-deck/StreamDeck.jsx` | **orphaned** — not registered, not routed, unreachable |

⚠ **The Queue view has no upstream.** NEURO **deleted** its Jira queue feature (July
2026; the last readers went on 27 Aug 2026), so `/api/queue/summary` no longer exists.
SARA still asks for it — marked `optional`, so its absence does not drag the whole
snapshot to "partial" — and the queue domain renders `unavailable` with that reason.
Escalations are tracked live through a different NEURO path. If queue awareness is
wanted back, build it on the live escalation path, not on this endpoint.

## Layout

```
sara/
  backend/                 Express (CommonJS) runtime backend — NO database
    server.js              boot, startup config validation, /api routes, serves built frontend
    src/state/
      contract.js          state-engine-v1 contract + validate()
      provenance.js        live / stale / unavailable / demo — and the empty domains
      seed.js              DEMO-ONLY hardcoded inputs (unreachable in production)
      stateEngine.js       assemble -> derive briefing -> validate
      inference.js         bounded, advisory context inference
    src/integrations/
      neuroConfig.js       THE place that knows where NEURO is and how to authenticate
      neuroSnapshot.js     bounded read poller (live/stale/unavailable)
      neuroCapture.js      the capture forwarder (the write seam)
      neuroChat.js         chat transport bridge
      novaSnapshot.js      NOVA signals for the At Work view
    src/routes/            health, state, chat, capture, focus, actions, telemetry, …
    test/                  node --test  (npm test)
  frontend/                React + Vite UI (one state, many views)
    src/state/saraState.jsx   the in-app shared state; exposes `provenance`
    src/state/presentation.js the EMPTY fallback (see Provenance above)
    src/components/ConnectionStatus.jsx  the provenance banner
    src/screens/<id>/         one folder per view
  runtime/                 PM2 process definition + one-command bring-up
  desktop/                 desktop icon (XDG entry) for the Pi
```

## The runtime path

Frontend and backend talk over **`/api`**:

- `GET /api/health` — liveness **and NEURO readiness** (the signal to watch)
- `GET /api/state` — the single shared state model, carrying `provenance`
- `GET /api/chat` / `POST /api/chat` — NEURO chat bridge
- `POST /api/capture/note` / `POST /api/capture/todo` — the capture bridge

In **dev**, Vite serves the frontend on port 5174 and proxies `/api` to the backend
(default 3005). In **production**, `vite build` emits `frontend/dist`, which the backend
serves directly — so the whole runtime is a single process on one port.

## Run it locally (dev)

```bash
cd sara
npm run install:all
# terminal 1
npm run dev:backend       # http://localhost:3005
# terminal 2
npm run dev:frontend      # http://localhost:5174  (proxies /api -> 3005)
```

Open http://localhost:5174. With no `NEURO_BASE_URL` set you will get empty screens and
a red banner saying NEURO is not configured — that is the correct behaviour, not a bug.

## Run it on the Pi 5 (auto-start on boot)

The Pi 5 already runs PM2 under systemd (`pm2-nickw.service`). Registering SARA with PM2
and saving makes it start automatically after a reboot.

```bash
cd /mnt/data/nuero/sara
bash runtime/start.sh        # installs deps, builds frontend, starts under PM2, pm2 save
```

Then:

```bash
curl http://localhost:3005/api/health      # check .neuro.ready is true
```

Open `http://100.100.28.58:3005/` (or `http://pi5.tailecb90f.ts.net:3005/`) over
Tailscale to see the runtime UI.

`runtime/start.sh` is safe to re-run after a `git pull`: it reinstalls, rebuilds, and
restarts the PM2 process.

### Launch on the Pi desktop

The runtime stays alive under PM2; the desktop icon only *displays* the UI:

```bash
cd /mnt/data/nuero/sara
chmod +x scripts/start-sara.sh
cp desktop/SARA.desktop ~/Desktop/ && chmod +x ~/Desktop/SARA.desktop
```

Full install/usage notes: [`desktop/README.md`](desktop/README.md). Or launch from a
terminal: `bash scripts/start-sara.sh`.

## Tests

```bash
cd sara/backend && npm test
```

Covers the state contract, provenance (live / stale / unavailable / demo, including a
negative test that no seeded name can reach a production screen), the snapshot's
freshness handling, and the capture bridge — every failure path of which asserts the
same thing: `saved` is false.

## Known limitations

- No auth on the SARA backend itself (NEURO's PIN/token middleware is not ported). Only
  reachable over the private Tailscale network.
- **No offline write queue.** A capture made while NEURO is down is not saved and says
  so. This is deliberate: a queue that silently holds writes is another way for SARA to
  become a store.
- The Queue view has no upstream (see the inventory above).
- `StreamDeck.jsx` is orphaned code.
- Voice I/O and nudge streaming are not built on this surface.
- `npm test` only; no CI wired.
