# Handoff — 30 Aug 2026: Phase 3 Gate 1, and three live bugs

**Commits (all pushed, `main`):**
- `6655ccd` attention lifecycle (Gate 1 backend + contract)
- `769cae0` **fix:** State of Play was killing every menu
- `7d7b6d8` SARA is the default screen + the control surface
- `e1c62a7` one Field, shared by the phone and the Pi

**Deployed:** Pi 5 on `e1c62a7`… **NO — on `7d7b6d8`.** The full deploy
(backend + frontend + restart) was done at `7d7b6d8` and verified live. `e1c62a7`
is pushed but **NOT on the Pi**, and the kiosk on pi-dev has **not** been
deployed at all. See "What still needs deploying".

**Tests:** backend 1438 pass / 0 fail (dev), 1388 on the Pi. sara/backend 82.
All three frontends build (`frontend`, `sara/app`, `sara/frontend`).

---

## The three bugs Nick reported mid-session

### 1. "A number of menus now fail to open" — FIXED and deployed

One cause, and the reason it spread to several menus.

`StateOfPlay.jsx` still rendered a **"Support queue"** card after the Jira queue
was ripped out on 27 Aug. The service correctly stopped sending a `queue` block;
this component was missed, so `queue` destructured to `undefined` and
`queue.staleDays` threw on **every** render.

⚠ **The spread is the important half.** There was **no ErrorBoundary anywhere in
the app**, so a throw in the rendered view unmounted the entire React root. Once
the root is gone every later click does nothing until a reload — which is why the
report was *plural* and why unrelated menus looked broken. `ErrorBoundary` now
wraps the view **inside** the shell (sidebar and chat keep working), names the
error on screen, and clears on navigation via `viewKey` so a bad screen cannot
latch the good ones shut.

Backend was verified healthy FIRST — `state-of-play`, `todos/focus`, `todos` and
`attention` all 200 on the Pi. This was never a server fault.

### 2. "Morning standup says it's done — I didn't do it" — NOT a bug, and NOT fixed

Measured, read-only, against the live DB:

- `standupDone` is `todayActivity.some(a => a.event_type === 'standup_done')`.
- There is **no `standup_done` row for 2026-08-30**. The last one is 28 Aug.
- So `standupDone` is **false**, and NEURO is not claiming it was done.

**30 Aug 2026 is a SUNDAY** (`day_of_week: 0`, and `/api/attention` reports
`activity: "off"`, *"It's the weekend."*). So whatever Nick is reading as "it says
it's done" is a **weekend rendering**, not a completion claim — most likely a
surface showing the ritual as not-outstanding because it is not a working day.

⚠ **I could not identify WHICH screen says it**, and I did not guess at a fix.
Ask Nick where he saw it (NEURO Standup tab? SARA Review? the briefing?) — the
wording is almost certainly a weekend/`off` branch that reads as "done" when it
means "not expected today". Those are different facts and the screen should say
the second one.

### 3. "SARA's default screen should ALWAYS be SARA, with her presence" — DONE

- **Phone:** `sara/app` opens on `surface` again (Phase 2 had moved it to `now`).
  A launch **intent still wins**, so tapping a notification lands on the thing
  that pinged him, not the home screen.
- **Pi kiosk:** new `screens/presence/PresenceView`, and `DEFAULT_VIEW` is now
  `PRESENCE`. It renders **the same Field file** as the phone.

Nick's steer: *"the pi app and sara mobile should essentially be the same app."*
See "The convergence" below for what that still needs.

---

## Phase 3 Gate 1 — one attention model

**Contract: `docs/attention-contract.md`.** Read it before touching any of this.

### The audit (what was actually wrong)

`decision-engine` was already the single generator and `attention.gate()` the
single re-ranker — both good, both unchanged. Four things blocked the contract:

1. **No lifecycle.** An attention item lived for one HTTP request. The only
   durable state was a suppression timer, which cannot tell *"I have seen this"*
   from *"hide it for 30 minutes"* from *"this is finished"*.
2. **Notifications were not linked to items.** All 30 `sendToAll` sites pass free
   text and the governor deduped on a fingerprint of **that text** — so a meeting
   alert counting down ("in 25 min" → "in 10 min") produced a fresh fingerprint
   each pass and every one went out. The rule was not merely unenforced, it was
   unexpressible.
3. **Item ids were unstable.** `todo-overdue-top` becomes `todo-overdue-summary`
   the moment a second task goes overdue, so a dismissal stopped applying as the
   pile grew.
4. **No control surface.** Quiet hours were env-only; no pause, no level, no
   history.

### What was built

`attention_records` + `attention_events` (additive, `CREATE TABLE IF NOT
EXISTS`), `services/attention-lifecycle.js` (judgement PURE, storage separate),
`services/attention-settings.js`, the webpush funnel, and
`/api/attention/{records,history,settings,records/:id/act}`.

**Verified live on the Pi**, not just in the suite: two held records with
evidence cited from real tasks, correctly `surfaced: no (held)` because it is a
Sunday and the gate holds work back. And the headline claim proved directly —
two standup pushes with **different wording**, the second held as *"already
notified, nothing changed"*.

### The refusals worth not undoing

- **Surfacing without evidence is allowed; INTERRUPTING is not.** Hiding real
  work on a bookkeeping gap is the worse error. Operational alerts (watchdog,
  scheduler) are exempt, or the rule eats the thing it protects.
- **The sweep never ages records out while the pool is unreadable**, and ages
  them to `expired`, never `resolved` — Nick decided nothing.
- **An operational push never overwrites a pool record** it shares a key with, or
  the nag escalation the tone is built on gets flattened to the push default.
- **Terminal states never re-match**, so today's standup opens a fresh record
  rather than inheriting yesterday's dismissal.
- **The webpush funnel fails OPEN** and says so in `push_log`. The contract wants
  no notification without a record; it wants an unanswered escalation more.

### ⚠ The permission prompt no longer fires on launch

`usePushSubscription` called `requestPermission()` the moment the PIN was
accepted — the browser's one-shot dialog in front of someone who opened the app
to write a thought down, and on iOS a denial is close to permanent. Now split:
the automatic path only **re-registers an already-granted** subscription, and the
prompt is reachable only from an explicit tap in **Controls**. Pinned by a source
test **with a positive control**, because node has no `Notification` and the only
other thing that would catch it is Nick's phone.

---

## The convergence: phone and Pi as one app

Done so far: **`sara/shared-ui/Field.{jsx,css}`** is now ONE source imported by
both apps (git recorded it as a 100% rename). Verified `field__canvas` is present
in **both** built bundles. It needed no re-tuning for the bigger panel because
its density is per **area**, not a node count — which is also why the widget's
opacity mistake does not repeat here.

⚠ **The `presence` ALIAS had to be removed** from `views.js`. It pointed at
mission-control from when no presence screen existed; leaving it would have
silently rewritten every request for the new screen into the briefing.

### What full convergence still needs

The kiosk **cannot yet render the attention feed**: `sara/backend` has no route
to NEURO's `/api/attention` (grepped — there is nothing). So `PresenceView` shows
her presence and the honest connection state, and **deliberately invents no
ranking** — inventing a second one on that side is exactly what
`state/inference.js` was retired for.

Two routes forward, and it is a real decision:

1. **Make the kiosk a direct NEURO client**, as `sara/app` already is. Truest to
   "the same app". Needs PIN/token handling on the kiosk and Pi 4 → Pi 5
   reachability over the tailnet.
2. **Proxy `/api/attention` through `sara/backend`.** Smaller, keeps the kiosk's
   existing transport, but leaves two client shapes.

Also unresolved: the kiosk is **React 18**, the phone is **React 19**. `Field`
uses only `useEffect`/`useRef` so it is fine in both, but anything richer shared
between them will hit this.

---

## What still needs deploying

- **Pi 5 is on `7d7b6d8`.** `e1c62a7` (the shared Field) is pushed but not
  pulled. Harmless — it only affects `sara/*` — but the Pi is one commit behind.
- **`sara/app` ships via Netlify on push to main**, so the phone should already
  be picking up the SARA-default + Controls + shared-Field build. **Confirm the
  asset hash CHANGED** before believing it (a marker that could exist in the old
  bundle proves nothing).
- **The kiosk (`sara/frontend`) has NOT been deployed** to pi-dev. It builds
  clean here; nobody has seen it on the actual DSI panel.

## Residual risks

1. **Nothing has been seen on real hardware.** The kiosk Presence screen, the
   Controls screen at 390px, and the SARA-default landing are all proven only in
   a build. The 15 Aug lesson — "proven means proven ON THE TARGET PLATFORM" —
   applies to all three.
2. **Phase 2's iPhone acceptance test is still not done** (aeroplane mode →
   capture → swipe away → reopen → reconnect → lands exactly once). Still Nick's
   to run; I cannot fly a phone into aeroplane mode.
3. **Gate 1's "one card generated → displayed → deferred → re-surfaced →
   resolved" is proven by test, not by hand on the live box.** The test does the
   full circuit; nobody has driven it through the UI.
4. **The 63 core dumps (~7.9 GB) on the Pi are still there**, untracked, from
   28 Aug. Still nobody's call but Nick's.
5. **The Pi runs 50 fewer tests than the dev box** (1388 vs 1438). Pre-existing
   and still unexplained; the deploy gate is weaker than it looks.
6. **The other session's notion-sync work is still uncommitted** in this tree
   (`backend/{server.js,services/scheduler.js,.env.example,routes/notion-sync.js,
   services/notion-sync/}`, `frontend/src/{App.jsx,components/Sidebar.jsx,
   components/NotionSyncPanel.*}`). I staged around it throughout — my
   `frontend/src/App.jsx` commit contains **only** the ErrorBoundary hunks.

## Next

- Gate 2 (ambient SARA): wire the canonical record into the widget and kiosk
  payloads, verify dedupe and deep-linking across surfaces.
- Ask Nick where the standup "says it's done" so bug 2 can be pinned to a screen.
- Decide route 1 vs 2 for kiosk convergence above.
