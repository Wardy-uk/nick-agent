# Handoff — Phase 4: Obsidian-First ADHD Chief of Staff

**All six workstreams built, plus a follow-up pass closing the three items the
first pass flagged** (see "Follow-up pass" below). Backend **1534** pass / 0 fail
(was 1480 — 54 new), sara/backend **96** / 0 fail. All three frontends build and
the 500 kB chunk warning is gone. `git diff --check` clean.

⚠ **The uncommitted Notion-sync work rode along in the deploy commit.** It was
not modified or reverted, but `frontend/src/App.jsx` and
`frontend/src/components/Sidebar.jsx` carry BOTH sessions' changes, and
committing Phase 4's half of those without the Notion panel would have shipped a
menu entry pointing at a component that is not in the repo — a broken build on
the Pi. `NOTION_SYNC_ENABLED` defaults false and the mapping table is empty, so
it ships inert.

⚠ **Deployed to the Pi, but not yet used through a real day.** Everything below
is verified by tests and by real-HTTP routing checks, not by Nick's own work.

---

## The canonical execution flow

```
Capture ──► vault record (Tasks/Captured/…) ──► task row (projection)
                                                     │
decision-engine  ──►  attention.gate()  ──►  attention_records (lifecycle)
   (what is worth surfacing)   (what fits now)      (durable identity)
                                                     │
                    ┌────────────────────────────────┴────────────────────┐
                    ▼                ▼                ▼                   ▼
                Now (default)     Focus          Briefing            phone / kiosk / widget
                    │
              Start this ──► focus session ──► shrink / step away / check in
                    │
              Done ──► resolve record + close task ──► wins ledger
                    │
              Not now / Waiting on ──► deferred (reason) ──► friction read
```

One decision, made once, rendered identically everywhere. The five actions mean
the same thing on every surface because all three desktop panels render the
same `AttentionCard`.

---

## WS1 — one canonical attention contract

`/api/attention` is now the user-facing decision and lifecycle contract on the
desktop too. `frontend/src/useAttention.js` is the one hook; `AttentionCard.jsx`
is the one renderer. React reranks nothing, rewords nothing and derives no
urgency — `title`, `say`, `reason`, `tab`, `urgency`, `evidence` and the bounded
`actions` all come off the record.

### The bug that was fixed

⚠ **`BriefingPanel`'s "Do it" POSTed `/api/focus/action-done`.** That route
calls `nextActionEngine.logOutcome()` **and** `engine.dismiss()` — so the button
that merely OPENED a thing recorded it as a completed outcome and hid the card.
It survived because the card vanishing looks exactly like the button having
worked. `FocusPanel`'s "Done" did the same and **never closed the task**, so
ticking a card left the work open and hid the reminder about it; and its "Defer"
POSTed `/api/focus/dismiss`, so "not now" and "not mine" were one gesture and
the difference was destroyed at the moment Nick expressed it.

The escalating `DEFER_MESSAGES` ("You're avoiding this") went with it: the count
lived in `localStorage`, so it was a fact about a browser rather than about the
work, and the wording was a claim about Nick no evidence supported.

### Exactly which actions can change lifecycle state

| Action | Route | State change | Touches work |
|---|---|---|---|
| **Open context** | *none — navigation only* | none | no |
| **Start this** | `POST /api/session/start` + `act:start` | **none** | starts a focus session |
| **Done** | `act:complete` | → `resolved` | closes the task **where one is resolvable**, and says which |
| **Not now** | `act:defer` reason `not-now` | → `deferred` (2h) | no |
| **Waiting on someone** | `act:defer` reason `waiting-on-someone` | → `deferred` (24h) | no |
| **Not relevant** | `act:dismiss` | → `suppressed` | no — teaches suppression only |
| *(existing)* | `act:acknowledge` | → `acknowledged` (stays visible) | no |

Nothing auto-completes, auto-defers, auto-dismisses, auto-starts or sends
anything. Every one of those is a click Nick made.

**Done never claims more than it did.** `completionTargetFor` is pure and
returns a LOOKUP, not an id — `collectOverdueTodos` emits a slug
(`todo-overdue-top`) and carries no task id, so the only handle is the task's
normalised text, the same key `focus-session.start` already matches on. A
meeting, an email pile or a nudge returns `null`, and the response says
"card cleared, no task was closed" rather than implying both. A tick held by
`task-blocks`' outcome-note rule comes back **held**, not completed.

### Remaining `/api/focus` consumers, and why

`/api/focus` and its four POSTs are **unchanged and still mounted**. Consumers:

| Consumer | What it uses | Why it stays |
|---|---|---|
| `frontend` Briefing | `GET` — `sara.briefing`, `tone`, `context.standupDone` | none of that is in the attention contract. **Read-only; it writes nothing.** |
| `frontend` Focus | `GET` — `sara.primary`, `tone` | same. **Read-only.** |
| `sara/app` `views/Focus.jsx` | `GET`, `POST /dismiss` | the phone's Focus tab; Phase 2 migrated the Surface, not this. Next to move. |
| `sara/app` `views/Surface.jsx` | `POST /dismiss` | its own documented fallback |
| `sara/app` `LockScreen.jsx` | `GET` | PIN check side effect |
| `sara/frontend` `saraState.jsx` | `GET` ×2 | kiosk; still reads through `sara/backend` |
| `sara/backend` `routes/focus.js`, `routes/actions.js` | `GET`, `POST /dismiss`, `POST /action-done` | the kiosk passthrough. ⚠ **`action-done` is still reachable from the kiosk** — same wrong semantics, one surface along. Not migrated this phase because the kiosk cannot yet reach `/api/attention` at all (no route in `sara/backend`), which is the prerequisite. |
| `sara/backend` `neuroSnapshot.js` | `GET` | health probe |
| `HANDOFF-nova-look-at-this.md` | a curl example | docs |

⚠ **The kiosk `action-done` path is the one piece of this bug still live.**
Closing it means giving `sara/backend` a proxy to `/api/attention` — the same
work the "full convergence" note in `CLAUDE.md` already describes.

**Fallback:** `useAttention.act()` uses `/api/focus/{dismiss,snooze}` **only**
when a card has no `recordId`, and says so on the card ("no record", "legacy
snooze"). `complete` and `acknowledge` have **no** legacy equivalent and are
refused with a reason rather than quietly mapped onto a dismissal.
`action-done` is not in the fallback map at all.

---

## WS2 — the execution surface

`Now` is the ADHD "Today" view, **promoted rather than rebuilt** — it already
owned every control that lowers the barrier to starting, and a thin new screen
composing them would have been a third "what should I do?" surface. It is
primary nav (desktop sidebar and mobile bottom nav) and the **default launch
view**; a notification's launch intent still wins.

The view id is still **`today`**, deliberately: every existing deep link,
notification route and `?view=` param keeps working. Only the label changed.

Order on the page, and the order is the argument: shape → **return prompt** →
**session** → Right now → friction → momentum → quick wins → wins → avoidance.
Session and recovery sit above any general suggestion, because the cost of an
interruption is the failure to return. Every session control is unchanged:
start/resume, **make it smaller (first, always)**, named next step, step away,
check-in, optional reflection, Done, Let it go. `paused` / `interrupted` /
`stale` / `needs-smaller` remain four distinct labels.

Briefing and Focus moved to MORE as supporting views. **Nothing was deleted.**

---

## WS3 — friction without shame

`services/friction.js` (`assess()` is pure) + `GET /api/friction` +
`FrictionSection` on `Now`.

**Signals, and the evidence each needs:**

| Insight | Evidence required |
|---|---|
| "put off twice because it needs context" | ≥2 attention `deferred` events **with a reason**, same `dedupe_key`, inside 21 days; the reason is named only when it **dominates** |
| "made smaller 3×, may need a different shape" | ≥2 recorded `shrink`s on the same task (live session or archived history) |
| "parked because it is too big as it stands" | the live session's `needs-smaller` state |
| "you were pulled away twice" | `stepAway` calls **only** |
| "waiting on Naomi — noted 30 days ago" | an open `waiting_on` row **with a `source_path`**, ≥7 days old |

**What NEURO explicitly refuses to infer:**

* ⚠ **Nothing from a missed check-in.** Being heads-down is exactly why one gets
  skipped; four hours of silence reads identically to four check-ins (pinned).
* ⚠ **Nothing from `interruptions`.** That array holds pauses and things that
  merely ARRIVED. `noteInterruption` deliberately leaves the clock running
  because NEURO cannot know whether Nick switched, so reading it here would
  build a claim about his attention out of other people's timing.
  `session.stepAways` is a **new, separate** array for exactly this.
* ⚠ **Nothing from an unattributed waiting-on row.** The backfill produced
  misparses, and `meeting-prep`'s rule — never imply a person failed without
  evidence — applies word for word.
* **No streaks, no scores, no diagnoses, no "avoidance" language.** Pinned by a
  forbidden-wording test over every generated line.
* **No insight without evidence**, and no consolation line in its place: with
  nothing recorded and nothing unreadable, the section renders **nothing at all**.
* A failed source is a **named gap**, never "nothing in your way" — `complete`
  keeps the two apart.

The existing "What you're pushing away" card is untouched and still separate:
it reasons about things NOT done (an absence, always open to a second reading);
this reasons only about things Nick DID.

---

## WS4 — the task/vault durability model

```
capture ──► Tasks/Captured/Task Captures YYYY-MM.md   ← THE DURABLE RECORD
                        │  (append-only, one line, carries <!--neuro-task:ID-->)
                        ▼
              tasks table                              ← the operational projection
                        │  (status, MoSCoW, due, MS links; origin_path points back)
                        ▼
       Tasks/NEURO Tasks (export).md                   ← a read-only VIEW of that
```

**Vault first, task row second.** A crash between the two loses the projection,
which is rebuildable, and never the words. The old order wrote a task row and
nothing else — the vault only heard about it when `task-export` next ran, up to
an hour later, into a file nothing parses back.

* ⚠ **Append-only, and never into the generated export.** That file is rewritten
  wholesale on every task change, so editing it destroys the record on the next
  export.
* ⚠ **A vault miss does NOT fail the capture** — refusing a capture is the one
  failure this area exists to prevent. It reports `vault.written: false` with a
  reason and the UI says so in words. Only a total miss is a 500; vault-saved
  with a failed task row is a **207 partial**, rendered as "the words are safe,
  it just is not on your task list yet".
* **Exactly-once offline** is the mobile ledger's job (`applyOperation` is
  synchronous from ledger read to ledger write), so a replayed capture appends
  no second line — pinned.
* `Tasks/Captured/` is under `Tasks/`, which `action-candidates.shouldSkipPath`
  already skips — otherwise every captured task would come back as a candidate
  to capture again. Pinned.
* It is **not** in `vault-exclusions`, so the durable record stays searchable.
* The export header now explains the three-layer relationship above.

Capture UI: "I'll route it" is gone — it promised classification and entity
extraction that run after the write and can fail. It now claims only what is
guaranteed (it reaches the vault) and reports each observable step.

---

## WS5 — retrieval scope guarantees and limits

**Guaranteed:** a result outside the requested scope is never returned. Enforced
three times, deliberately redundantly — inside each source, on each source's
output, and again after fusion. The last is the guarantee: a source added later
cannot leak past it by forgetting.

* `folder:<path>` — segment-aware (`Meetings` is not `Meetings archive/`), and
  the reverse containment the old code allowed is gone. The walk **prunes** to
  the folder rather than filtering afterwards.
* `person:<Full Name>` — the person's own note, or a **whole-word full-name**
  match in the body (`entities.js`'s rule: "Liam" must not match "William").
  Unreadable is **not** a match.
* An **unrecognised** scope admits nothing — fails closed, so a typo cannot hand
  back the whole vault labelled as scoped.
* Date bounds unchanged.

**Ranking:** the filesystem-order early stop is gone. Every permitted file is
scored, then sorted, then cut. Depth 4 → 12, and hitting either that or the
5,000-file cap is **reported** (`truncated`), never swallowed.

**Honest degradation:** `embeddings.semanticSearch` returning `null` means
"could not answer" and yields `semanticAvailable: false` with a reason —
keyword and temporal still answer, so an outage never renders as an empty vault.
An empty semantic result set is a different fact and is reported as available.

**Index health:** a note over `MAX_CHUNKS_PER_FILE` (60) is now recorded in
`agent_state.embeddings_truncated` and comes back marked `indexIncomplete: true`,
with `getEmbeddingHealth().truncated` listing them. Previously a transcript whose
tail was never embedded looked exactly as searchable as one indexed in full. A
note that shrinks below the cap clears its entry.

**Known limitations:** `person:` reads note bodies, so a scoped search over a
large vault is I/O-bound (cached per search, capped at 2,000 entries).
`search()` still returns a bare array for every existing caller;
`searchWithHealth()` is the new shape and nothing consumes it yet except the
tests — **wiring it into chat RAG and the MCP tools is the obvious next step.**

---

## WS6 — navigation and build

Primary: **Now · Capture · Ask · State of Play · Actions**. Briefing and Focus
are under MORE. Mobile bottom nav leads with Now, matching the sidebar — two
navs disagreeing about the main screen is how "Today" became the view nobody
opened.

Lazy-loaded: 27 specialist panels. **Eager:** `Now`, Capture, Ask, State of
Play, auth and the offline queue — a spinner at the moment the barrier to acting
needs to be lowest is the wrong trade, and Capture behind a network round trip
is a capture that fails when the network does. `Suspense` sits **inside**
`ErrorBoundary`, so a chunk that fails to download is caught and named exactly
like a panel that throws. Main chunk 359 kB (was over the 500 kB warning).

---

## Files

**New:** `backend/services/friction.js`, `backend/routes/friction.js`,
`frontend/src/useAttention.js`, `frontend/src/components/AttentionCard.{jsx,css}`,
`frontend/src/components/FrictionSection.{jsx,css}`, and six test files.

**Changed:** `attention-lifecycle.js` (+`start`/`complete`, `isStartable`,
`completionTargetFor`), `routes/attention.js`, `routes/capture.js`,
`capture-store.js`, `mobile-sync.js`, `task-export.js`, `retrieval.js`
(rewritten), `embeddings.js`, `focus-session.js` (+`stepAways`), `server.js`,
`App.jsx`, `Sidebar.jsx`, `AdhdPanel`, `BriefingPanel`, `FocusPanel`,
`CapturePanel`.

## Follow-up pass — the three flagged items, closed

**1. The kiosk `action-done` bug is gone.** `sara/backend/routes/actions.js` no
longer has a `/focus/done` route at all. `sara/backend/src/routes/attention.js`
gained `GET /records` and `POST /records/:id/act` — a PASSTHROUGH: the action is
forwarded verbatim and NEURO decides what it means, with the body **bounded to
the contract fields** (`action`, `minutes`, `reason`, `note`) so a proxy cannot
one day carry a field NEURO trusts and the kiosk should not set. A write reports
a refusal as a refusal, never the feed's `200 + available:false` — that shape is
right for a POLL and wrong for a button press.

⚠ **My earlier claim that the kiosk "cannot reach `/api/attention` at all" was
wrong** — the read passthrough already existed from the "one surface, two
shells" commit. Only the write half was missing.

`lifecycle.present()` now exposes **`engineId`** for one job: a legacy screen
holding a decision-engine item id and nothing else (the kiosk's `FocusView`, the
phone's `Focus` tab) can find the canonical record and act on THAT. It is
unstable by construction — `todo-overdue-top` becomes `todo-overdue-summary` the
moment a second task goes overdue — so it is a lookup key and must never be
stored.

The kiosk's Presence surface now passes `onAct`. The old objection was that
acting needs a credential the kiosk does not hold; that was true of the BROWSER
and never of `sara/backend`, which already holds it and already proxies the
feed. ⚠ **`done-focus` has NO fallback**: a dismissal is not a completion, and
substituting one for the other is the bug being removed, so an unresolvable card
says so and records nothing. Deferring falls back to the suppression timer and
**says so on the screen**.

**2. `sara/app` `views/Focus.jsx`** resolves the record and dismisses through it,
falling back to `/api/focus/dismiss` only when there is none — so one screen on
the phone can no longer teach suppression while the other records a lifecycle,
about the same card.

**3. `searchWithHealth` is wired in.** Three consumers:
* **chat RAG** (`chat-context-v2`) — tells the model in words when semantic was
  unavailable and marks a partly-indexed note. Three keyword hits look exactly
  like three hits from a healthy hybrid search, and a model reading a thin
  retrieval as "the vault has little on this" answers confidently from nothing.
* **the `search_vault` chat tool** — reports `incomplete`, marks
  `indexIncomplete` per note, and gained a `scope` argument.
* ⚠ **`GET /api/vault/search`** — which turned out to be a **THIRD substring
  walker**, with its own copy of every bug the retrieval rewrite fixed: depth
  capped at 4, an early stop at 20 results in filesystem order, no ranking, no
  semantic arm. **It is what the MCP `search_vault` tool calls**, so every
  external Claude Code session searching this vault was getting the crudest of
  the three answers and could not tell, because a substring walk always returns
  something. It runs on the unified retrieval now, `dir` is a real `folder:`
  scope, and the response keeps `matches[].text` (which `VaultBrowser` renders)
  alongside `excerpts` — with `matches[].line` **null rather than invented**.
  The MCP tool gained `dir` and prints a banner when semantic was unavailable.

**Not fixed, because it is not a bug:** a vault miss on capture still returns
success with `vault.written:false` and a reason. Refusing a capture is the one
failure that area exists to prevent.

**Tests:** backend **1534** / 0 fail, sara/backend **96** / 0 fail. All three
frontends build.

## Open ends

1. **`adhd-dashboard._rightNow()`** is now unused by the panel but still in the
   `/api/adhd` payload. Left in place deliberately; remove once nothing reads it.
2. **The kiosk's legacy `FocusView`** still renders `/api/focus` data and only
   reaches the lifecycle through the `engineId` lookup. Presence is the screen
   that renders the canonical feed directly; FocusView is a candidate for
   retirement rather than further repair.
3. **Not yet used on the real box by Nick.** Deployed, but the day has not been
   run through it.

---

# Handoff — 30 Aug 2026: Phase 3, all four gates

**All four Phase 3 gates are closed, deployed and verified against the live box.**
Detail per gate below; this header is just the state of play.

| Gate | Commit(s) |
|---|---|
| 1 — One attention model | `6655ccd` · contract in `docs/attention-contract.md` |
| 2 — Ambient SARA | `fcf6648`, `dcdd7fa` |
| 3 — Supported execution | `14df208`, `34fe8d2`, `c134663`, `6ed0773`, `137f7ff` |
| 4 — Relationship support | `9bcad4b` |

**Bugs Nick reported and their outcome:**
- `769cae0` menus failing to open — **fixed** (State of Play + no ErrorBoundary)
- `4e28eb5` "standup already done" — **fixed** (an empty `- [ ]` counted as done)
- `7d7b6d8` + `e1c62a7` SARA as the default screen — **done**, phone and kiosk

**Also:** `a827840` widget transitions · `1505473` kiosk guards.

**Deployed:** Pi 5 and the kiosk are current. `sara/app` ships via Netlify on
push to main — **confirm the asset hash CHANGED** before believing a deploy.

**Tests:** backend **1480** pass / 0 fail (dev), 1417 on the Pi. sara/backend 87.
All three frontends build (`frontend`, `sara/app`, `sara/frontend`).

⚠ **Nothing here has been used on the actual phone yet.** See the open ends.
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
- **The kiosk IS deployed and was verified ON THE PANEL** (built on pi5, served
  by `sara-backend:3005`, Chromium on pi-dev restarted via `lwrespawn`,
  screenshotted with `grim`). ⚠ **The screenshot caught two bugs a clean build
  could not**, and both are worth remembering:
  1. `min-height: 100vh`, copied from the phone where the Surface owns the whole
     viewport. On the kiosk the view sits inside `.app__view` below a banner and
     scrolls, so the section overflowed and everything anchored to the bottom sat
     **below the fold** — the field drew and not one word of hers did. Now bounded
     against the MEASURED chrome (`calc(100vh - 200px)`).
  2. **`provenance` has FIVE roll-up states, not four.** `mixed` ("partly live")
     is real and is what the live kiosk was actually in; there was no case for it
     so it fell through to "I can't see the brain" — a false negative when most
     of the read was fine. ⚠ **CLAUDE.md's "exactly four provenances" is wrong
     about the roll-up.**
  A third was fixed on the way: there was no branch for a live read with no
  headline, so the screen could render the field and NO WORDS — indistinguishable
  from a broken view. Exactly one branch always renders now.
- ⚠ **The field reads faint on the panel**, which is CORRECT for a `mixed`,
  low-confidence read (it barely settles by design) — but nobody has yet seen it
  on a clean `neuro` read at 1280x720. If it still looks invisible then, re-derive
  the opacity for that size and ground rather than copying the phone's, which is
  the mistake the widget already made once.

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

## Gate 2 — one decision, four surfaces (DONE, deployed, verified on the panel)

`fcf6648`. Three parts:

1. **The notification names its record.** `_enrichData` puts
   `attentionRecordId` + a resolved `tab` on the push payload, which `sw.js`
   already forwards wholesale. A tap now opens Neuro Mobile on the exact thing
   that pinged him and the client can act on that record.
2. **The Surface acts on the RECORD, not a timer.** It used to POST
   `/api/focus/dismiss`, so "seen it" / "not now" / "not mine" all collapsed into
   one gesture. "Not now" opens real durations, each carrying a **reason**.
   Dismiss is only offered when the record allows it. Falls back to the old route
   when a card has no `recordId`, so an older bundle keeps working.
3. **The kiosk can see the feed.** `sara/backend` gains a read-only passthrough
   (`src/routes/attention.js`, injectable `fetchImpl`/`env`, 5 tests). ⚠
   Deliberately **NOT** folded into `neuroSnapshot`'s poll set — that feeds the
   State Engine, and putting attention in the shared model would make the
   kiosk's own state a competing account. That is the seam where
   `state/inference.js` grew a second brain.

Verified live: passthrough returns `available:true` with the real payload, and
the panel renders **"Not a working day / It's the weekend."** — NEURO's own
card, verbatim, the same wording the phone gets.

## ⚠ Gate 2 is NOT fully closed: the kiosk still shows a SECOND opinion

The bottom strip (`components/RecommendedView.jsx`) renders `model.inference` —
the **retired** inference layer. On the screenshot it reads *"You're set up for
focused work: Start top task. High · 0.75 — Suggested view: Focus"* directly
below NEURO saying *"Not a working day. It's the weekend."*

Two accounts of Nick's state on one screen, disagreeing. That is precisely what
the Core Rule forbids: consumers "do not independently rerank work, invent
urgency, or phrase the same state differently". CLAUDE.md already names
`sara/backend/src/state/inference.js` as *"the thing to retire"* and says its
decision half was ported to `context-state`; the **frontend strip was missed**.

Two options, both small, and it needs Nick's call because it removes something
visible:
- **Drive the strip from the attention payload** (`context.label` / `say`), so it
  agrees with everything else by construction; or
- **Remove it.** The Presence screen now says the same thing better, and an
  advisory "suggested view" is a menu — which is the thing SARA is not.

## Gate 3 — supported execution (PART ONE done, deployed, driven live)

`14df208` (backend) + `34fe8d2` (phone). **The kiosk's second-opinion strip was
removed first** (`dcdd7fa`) — see above.

**What was missing was not a control, it was a KIND of control.** Every existing
one answers *when* — pause, resume, abandon. Nick's difficulty is INITIATION, and
his own rule is that anything raising awareness without lowering the barrier is
the wrong shape. `shrink()` is the only one that lowers it.

- `shrink({step})` names the smaller thing and carries straight on — naming it
  IS the unblocking, so it does not also demand a second press to restart.
- `shrink({})` parks the session in **`needs-smaller`**, a real state and NOT a
  pause: *"not now"* and *"I'm stuck on how big this is"* are different problems.
- `stepAway()` is Nick saying he was pulled off it. ⚠ Named that way because
  `/api/session/interrupt` already means `noteInterruption` (something ARRIVED,
  clock keeps running) and silently redefining it would break every caller.
- ⚠ `_isStale` now treats `interrupted` and `needs-smaller` as BANKED like
  `paused`. Without it a 15-minute task stepped away from at 09:00 went stale by
  10:30 and asked *"did this happen?"* about something he'd pick up after lunch.
- `shrink` is on **every** return prompt. Looking at a thing you walked away from
  is exactly when "this is too big" is the true answer; a menu without it pushes
  you to abandon, which loses the thread and reads as failure. That changed an
  existing assertion — updated deliberately, not routed around.
- **Nothing is scored.** Shrinks, the original wording and the final step all
  survive into history as EVIDENCE. A task shrunk three times is a finding about
  the work.

**Driven end to end against the live Pi** (checked no real session was running
first, and cleaned up after): start with a step → `needs-smaller` → the prompt
asks *"What is the smallest next bit of it?"* with `shrink` first → naming it
returns to `active` with `shrinks: 2` → step away → *"You had just started … when
you were pulled away — NT-99 landed."* → abandoned cleanly.

## Gate 3 parts TWO and THREE (also done, deployed, driven live)

`c134663` (transitions) + `6ed0773` (check-ins).

**Transitions — `services/transitions.js`, PURE, 10 tests.** The three seams
where an intention evaporates: before a meeting, straight after one, and
returning to something put down. Composed on `/api/attention` so all four
surfaces render one decision.
- It **proposes and never acts** — every option opens a screen. No timer, no
  calendar write, no completion. (52-blocks-where-27-were-wanted is the reason.)
- ⚠ **An unreadable diary yields NO transition**, rather than falling through to
  "nothing coming up".
- ⚠ **A meeting is `context-state.isRealMeeting`, now EXPORTED rather than
  re-derived.** Half the diary is solo blocks and Graph lists the organiser
  inconsistently, so `attendeesOther` must be exactly `true`; undecidable fails
  closed. "You just finished a meeting" after an hour of writing alone is the
  kind of wrong that gets a feature switched off.
- Being IN a meeting is silence. Precedence: leave-now > post-meeting > session.
- The session prompt is carried **verbatim** from `recovery()`.

**Check-ins + reflection.** "Still on this one?" on a running session, and an
optional note at the end.
- ⚠ **A PULL, never a push.** Nothing here notifies; the prompt is there because
  Nick already opened the screen. Body-doubling is precisely the feature that
  would justify a timer to itself.
- ⚠ **A check-in touches the clock in NO way** — presence, not time.
- **Nothing is inferred from a MISSED check-in.** Being heads-down is why one
  gets skipped; reading that as a signal would punish the good case. No target,
  no streak.
- **Finishing never depends on the reflection box.** A field you must fill to
  close a session is a reason not to close sessions.

Driven live: check-in recorded with the clock untouched; step-away surfaced as
`session-resume` on the attention feed with the right words; finish wrote
`reflection`, `checkIns` and `shrinks` into history; session cleaned up.

### The desktop panel caught up (`137f7ff`)

`AdhdPanel` had the pre-Gate-3 controls and collapsed every non-active state
into "Paused". It now names all four states, shows the next step, offers **Make
it smaller** first, surfaces the check-in when due, and reports the shrink count
with no verdict attached.

⚠ **The shrink box had to go in the RECOVERY block as well as the session card.**
Recovery renders INSTEAD of the card, so a button that only opened the card's
input would have been dead at the exact moment the option is offered. Verified
through `/api/adhd`: `needs-smaller` → `recovery.kind: 'shrink'` with
`options: ['shrink','resume','abandon']`.

## Gate 4 — prep that shows its evidence (done, deployed, verified on real data)

`9bcad4b`. Meeting prep already gathered the right material; it did not say
where any of it came from — seconds before Nick walks into a room with a real
colleague, on material that is an **automated parse of 232 meeting notes** whose
own service notes say some rows are misparses.

⚠ **`source_path` had been in `waiting_on` since the feature shipped and the
prep enrichment was DROPPING it.** The evidence existed and was discarded at the
one surface where it matters most.

**Verified live against the real diary** (52 meetings in the week, 6 carrying
commitments), and the first result makes the case better than any argument:

> *Noted as outstanding for Naomi — from `2026-04-30 – 1-2-1 Meeting Naomi
> Winkworth` (2026-04-30): "Naomi to clear all tickets older than five days…"
> (+10 more)*

That commitment is **four months old**. The old line read *"11 outstanding from
Naomi"* — stating as fact that she owes eleven things, with no hint that the
oldest is an April note, and no way to check.

- Commitments carry `sourcePath`, `sourceDate`, `sightings`. An unattributed row
  says **"no source recorded — worth checking before raising"** rather than
  looking identical to a sourced one.
- **"Owes you" → "Noted as outstanding."** Attributed, not asserted.
- ⚠ **Five swallowed catches** in `_buildPrep` (two to `console.warn`, three to
  nothing) now push named `prep.gaps`. An unreachable vault used to render as a
  prep sheet with no commitments — indistinguishable from a colleague who owes
  nothing. The phone shows *"Couldn't check … treat the above as incomplete, not
  clear."*
- **Sending is untouched and still gated.** Prep drafts nothing outbound; a
  chase still queues a `sara_action` for approval. Pinned by a test that fails if
  this file ever acquires `sendMail` / `sendDm` / `graphWrite`.

## All four gates are closed

| Gate | State |
|---|---|
| 1 — One attention model | done (`6655ccd`), contract in `docs/attention-contract.md` |
| 2 — Ambient SARA | done (`fcf6648` + `dcdd7fa`) |
| 3 — Supported execution | done (`14df208`, `34fe8d2`, `c134663`, `6ed0773`) |
| 4 — Relationship support | done (`9bcad4b`) |

## The standup bug — FOUND and fixed (`4e28eb5`)

Nick's screenshot carried the whole story under the claim:

```
## Focus Today
- [ ]
```

An **empty checkbox**. NEURO writes that skeleton into every daily note, and
`routes/standup.js` matched `- [ ]` — so the scaffold satisfied its own test and
the screen announced work nobody had done. The `task-blocks` empty-stub rule
exactly: NEURO writes the evidence its own detector accepts.

⚠ **The deeper fault was FOUR implementations of one question** at three
strictness levels — `parseDailyNote` (correct), `nudges.js` (correct,
independently reimplemented), `routes/standup.js` (empty checkbox counted),
`activity.js` (the bare HEADING counted). So the nudge kept correctly asking
while the screen said it was finished. `standupDoneIn` is the one predicate now.

⚠ **The scan itself was NOT banned.** `standup.js` walks Focus Today three more
times — carry-over items, EOD context — and those answer a different question
legitimately. A first cut of the guard banned `inFocus` outright and would have
forced three correct pieces of code to be rewritten. Verified live:
`/api/standup/ritual-state` → `standupDoneToday: false` against the real note.

## Also done this session

- **The widget shows transitions** (`a827840`). "Leave now" is worthless five
  minutes late and a lock screen is where it can arrive in time, so a transition
  outranks the ranked card — and only a transition does. Written with **no
  backslashes** (checked before saving); exporter re-run to the vault (v35).
- **The kiosk has guards** (`1505473`). Its three bugs today were caught by
  screenshotting a panel, which is not a gate. Now pinned from the backend
  suite, and **proved by reintroducing the alias bug and watching it fail**.

## Next — all four gates are closed, so these are the open ends

1. **The iPhone acceptance test (Phase 2) is STILL not done.** Aeroplane mode →
   capture → swipe away → reopen → reconnect → lands exactly once. Nick's to run.
2. **Nobody has used any of this on the phone in anger.** The Surface's defer
   row, the Controls screen, the session card's four buttons and the prep
   evidence lines are all proven in a build and against the API, never on a
   390px screen in a pocket. The 15 Aug lesson stands: *proven means proven on
   the target platform.*
3. ~~Where does the standup "say it's done"?~~ **FOUND AND FIXED** (`4e28eb5`)
   — Nick's screenshot showed the empty `- [ ]`, `routes/standup.js` matched it,
   and four detectors of one question disagreed. See the section above.
4. **The widget cannot ACKNOWLEDGE.** It renders the canonical payload and now
   shows transitions, but a Scriptable widget can only open a URL — acting on a
   record from the lock screen would need a Shortcut, which is a separate call.
5. **Kiosk convergence: the components are now SHARED** (`0c97510`). The kiosk
   renders the phone's actual screen via `sara/shared-ui/AttentionSurface` —
   verified on the panel, and it now carries the "2 held" honesty line it never
   had. What remains is only the transport question, and that is a decision
   about where the CREDENTIAL lives: a direct NEURO client would put a token in
   a browser on an always-on desk screen. Sharing the components did not need
   it, so there is no longer a reason to change it unless you want one.
6. **`sara/frontend` still has no runner of its own** — its invariants are
   guarded from the backend suite, which covers structure but not rendering.
   Anything visual on the kiosk still needs `grim` and a pair of eyes.
7. The other session's **notion-sync** work is still uncommitted in this tree.
