# Next session — #26: the phone can't start a standup

Continuing NEURO. Read `.claude/memory/handoff.md` (16 Aug "late" entry is newest, at the
top), then `mistakes.md`, especially the last three lines.

Before touching anything: `git status`, and `git diff <file>` on every file before you
stage it. Nick runs 2-3 Claude sessions on this repo simultaneously. A previous session
ran `git add` on a file it was legitimately editing and swept ~45 lines of another
session's unfinished work into the commit. Explicit staging protects against unrelated
files, not unrelated hunks. If an edit tool says "the file had been modified on disk since
you last read it", that is a collision signal, not line-ending noise.

## State — verified at the end of 16 Aug, not assumed
Local and Pi both clean at `5345098`. Suite **408 local / 408 Pi — gap closed, no parked
files.** `unstable_restarts` 0. #25, #28 and #69 shipped and verified live that evening.

**One thing pending, needs no action.** `briefing.checkEscalationAlerts` backfills its
seen-list on its first widened run and its cron is `*/5 8-18 * * 1-5` — weekdays only, and
16 Aug was a Sunday. So `agent_state.escalation_alert_wide_seeded` may still be null with
11 keys absent from `alert_seen_ids`. On the first weekday 08:00 it records them silently
and pushes 0. **If you see that flag unset, that is the normal state — do not "fix" it, and
do not widen anything else in that file before it has run once.**

Deploy sequence: `git pull --ff-only` → `cd frontend && npm run build` → `cd ../backend &&
npm test` → `pm2 restart neuro-backend --update-env`. **Node 22.22.2 must be on PATH for any
pm2 command** (Node 20 segfaults better-sqlite3). DB at `/mnt/data/nuero/backend/db/agent.db`
— open `{readonly:true}` while the backend runs. `sara/app` deploys to Netlify
(`sara-nickward`, base `sara/app`) on push to main.

---

# #26 — the phone can't start a standup

**I investigated this at the end of the 16 Aug session but wrote no code. Nothing is
half-done; there is nothing to inherit.** What follows is measured, and it corrects the
original ticket in four places. Verify anything you intend to rely on — the last four
tickets in a row had wrong premises, and each was caught only by measuring first.

## What the ticket said, and what is actually true

**Ticket:** "sara/app has seven tabs and standup isn't one; the only way in is tapping a
standup notification, which falls back to Focus."

Four corrections:

**1. There are EIGHT tabs, not seven.** `TABS` in `sara/app/src/App.jsx` is
`today, focus, tasks, capture, voice, chat, prep, brain`. The ticket's list omits `today`,
which is the DEFAULT tab (`useState(() => readLaunchIntent()?.tab || 'today')`).
`SARA_LITE_TABS` in `shared/action-surfaces.cjs` matches all eight.

**2. A standup notification does NOT fall back to Focus.** `resolveSaraLitePlan()` hits
this branch first:
```js
if (['standup', 'eod', 'journal', 'meeting', 'brain'].includes(kind)) {
  return { kind, canHandle: true, presentation: 'sheet', tab: resolveSaraLiteTab(raw) };
}
```
So tapping it opens a **sheet** (`NotificationActionCard`), and Focus is only the tab
sitting behind it — because `resolveSaraLiteTab` falls through to `return 'focus'` when the
kind isn't a tab id. The standup IS reachable from a notification today. It is reachable
from nowhere else.

**3. The real trap is bigger than `SARA_LITE_TABS`, and it is still silent.** Adding
`'standup'` to `SARA_LITE_TABS` is necessary but **not sufficient**: the sheet branch above
runs first, so `presentation` stays `'sheet'` and `App.jsx` keeps rendering the card
instead of switching tabs —
```js
setActionIntent(resolveSaraLitePlan(intent).presentation === 'tab' ? null : intent);
```
Both have to be reasoned about together. **Note that branch also covers `eod`, `journal`,
`meeting` and `brain`** — changing it naively changes four other notification paths. Scope
the change to standup/eod, or gate it.

**4. The biggest finding, and it is not in the ticket at all: the phone is on the OLD
standup flow entirely.** `NotificationActionCard.jsx` calls
`/api/standup/questions` + `/api/standup/submit-guided` (and the `eod` equivalents) — the
**retired fixed three-question stepper**, not the session API. Verified live: both old
endpoints and `/api/standup-session/standup` return **200**, so nothing is broken today,
but the phone's only route into the standup is the flow that
**holds everything in client state until one final POST and loses it all when that POST
fails.** That failure mode is the entire reason `standup-session.js` exists.

So #26 is not "add a tab". It is "the phone has no route to the current standup at all".

## What the backend already gives you — no changes needed

`/api/standup-session/:kind/{start,reply,finish,abandon}` plus `GET /:kind` to resume.
Two things the client MUST respect:
- The transcript is **saved before AND after every turn**. Do not batch turns client-side.
- A failure returns **503 with `retryable:true` AND the saved session**, so the client can
  retry without Nick retyping. Honour that or you rebuild the bug being replaced.

Also: `session.degraded` is set when no tool-capable provider is available and the session
falls back to a tool-less conversation. Say so on screen rather than pretending.

Reference implementation: `frontend/src/components/StandupSession.jsx` (246 lines) — the
desktop equivalent, already built against this API. Read it before writing the phone one.
It is a reference, not something to copy wholesale: the phone is a different surface and
`sara/app` has its own conventions.

## A scope decision to put to Nick BEFORE building

There are two halves and they are separable:

- **(a) A standup tab** on `sara/app`, driving `/api/standup-session/*`.
- **(b) Migrating the notification sheet** off the retired stepper onto the same API.

Doing (a) alone leaves two different standup flows on one phone — a tab on the new session
API and a notification card on the old stepper — which is how they silently disagree about
what today's standup was. Doing both is the coherent answer but is a larger change and
touches `eod`/`journal`/`meeting`/`brain` routing. **Ask him which, don't assume.**

## Gotchas specific to this surface

- **Tab ids do not always mount what their name suggests.** `voice` mounts **Capture** with
  `autoRecord`, not Chat. Read `App.jsx`; don't infer from the label.
- Every view needs a matching `.css` file — `sara/app` follows the same per-component CSS
  rule as the rest of NEURO. No Tailwind.
- **Verify against the LIVE Netlify bundle, not localhost**, and check `VITE_BUILD_LABEL`
  on screen to confirm which build the phone is running. That is exactly what #110 was for.
  `sara/app`'s sw.js needed explicit `skipWaiting`/`clients.claim` — a swiped-away iOS PWA
  does not reliably release old workers, and four deploys were once spent debugging a stale
  bundle.
- Bears on **#16**: the ritual is hardest to skip when it is reachable from the thing
  already in his hand.

## Two rules this repo keeps having to relearn
- **A green suite says nothing about routing.** `GET /api/email/triage/feedback` returned
  "Email not found" for its whole first deploy because it sat below `/triage/:emailId`, and
  the tests exercise the service, not the routing table. Call any new route against the
  running server before calling it done.
- **A feature is not available until it is reachable from the UI.** `TodoPanel` was
  routable for months with no menu entry. A new view needs its entry in the same commit.
