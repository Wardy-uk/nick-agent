# Next session prompt — #94, #56, #83

Paste the block below into a fresh session.

---

Continuing NEURO. Read `.claude/memory/handoff.md` first — the 16 Aug entries, newest at
the top. Then `.claude/memory/mistakes.md`, especially the last line.

Before touching anything: `git status`, and `git diff <file>` on every file before you
stage it. Nick runs 2-3 Claude sessions on this repo simultaneously. A previous session
ran `git add` on a file it was legitimately editing and swept ~45 lines of another
session's unfinished work into the commit. Explicit staging protects against unrelated
files, not unrelated hunks. If an edit tool says "the file had been modified on disk since
you last read it", that is a collision signal, not line-ending noise.

`backend/routes/health.js` + `backend/services/stress-score{,.test}.js` are parked by Nick
— complete and green, deliberately uncommitted, and they are #42/#44 in the tracker. Leave
them; never sweep them into a commit. They are the 9-test local/Pi suite gap (347/338).

Verify against the live Pi, not the tracker — the tracker's status column is stale in
places (#53, #54, #64, #71 still say "Ready" in their Found sections and all shipped on
16 Aug). Deploy notes and the `db/agent.db` path are in the pi5-deployment memory; read
the DB `-readonly` while the backend runs. Deploy sequence: pull → `frontend && npm run
build` → `backend && npm test` → `pm2 restart neuro-backend --update-env`, Node **22.22.2**
on PATH for any pm2 command.

Three items, agreed with Nick and not started. **Do #94 first** — it is the highest value
and it carries the only real hazard, so it wants the freshest context, not the cheapest-
first slot.

## #94 — the Focus card counts 6 escalations when there are 17

`syncEscalations()` calls `fetchEscalationTickets()`, which queries the **request-type arm
only** — tickets a customer raised as an escalation through the portal. `syncEscalations`
drives the escalation count, the Focus card rows, the briefing and the nudge. So the
surface Nick checks every morning has understated escalations by two thirds, silently,
for as long as it has existed.

`fetchActiveEscalations()` already exists and ORs in the second population — tickets the
team moved into the Escalations tier. **Nothing that surfaces escalations to Nick uses
it.** Measured live on 16 Aug: narrow arm **6**, OR'd **17**, so **11 invisible**:
`NT-14855, NT-20737, NT-21284, NT-22302, NT-22339, NT-22445, NT-22697, NT-23239,
NT-23803, NT-24257, NT-27431`.

**Do not swap the call naively. Three things bite, in this order:**

1. **Shape mismatch.** `fetchEscalationTickets` returns **raw Jira issues** and
   `syncEscalations` reads `issue.fields.summary` / `.created` / `.status` off them.
   `fetchActiveEscalations` returns objects already **flattened** by `mapEscalationIssue`
   — no `.fields` at all. A straight swap silently blanks every summary and created date.
2. **`nickHasCommented()` reads `issue.fields?.comment?.comments`, and
   `ESCALATION_FIELDS` does not request `comment`.** On the wide path it returns **false
   for every ticket**, so all 17 land as *unseen*.
3. **That fires a push at any hour.** `syncEscalations` always calls
   `nudges.triggerEscalationNudge()`, and `escalation_alert` is in webpush's
   `ALWAYS_DELIVER` — it **bypasses quiet hours and the hourly cap**. Deploy this wrong at
   23:00 and Nick gets "17 escalations waiting on you" in bed. `focus-session
   .noteInterruption()` would also fire 17 times.

**The decision worth putting to Nick before deploying, not after:** the 11 newly visible
escalations are months old (NT-14855 is the oldest). Do they arrive as *unseen* — one
genuinely loud day, honest but brutal — or does a one-time migration seed the existing 11
as `seen: true` so only genuinely new ones nag? Nudge volume is the one signal the tracker
says is allowed to argue against building more (#17), so this is his call. Recommend
seeding, then letting the normal flow handle anything new.

Note this lands on top of 16 Aug's #53/#54 work: the card renders `meta.escalations`
capped at 5 with an `overflow` count, so going 6 → 17 makes that overflow line load-bearing
for the first time. Check it reads sensibly.

## #56 — embeddings are the last AI path that can fail silently

Voyage calls bypass `ai-routing` entirely: not in the provider mix, not counted against
any budget, no telemetry, nothing on the AI panel. When they fail the fallback is
`computeSimpleVector()` — a local hash — so **vault search quietly degrades to
near-keyword matching with no error anywhere**. This already happened on 13 Aug (`Voyage
call failed: operation aborted due to timeout`) and nothing surfaced it.

Everything else got instrumented in the week of 15 Aug; this is the remaining blind spot,
and it is true whether the calls go to Voyage or a local model. It matters more now the
8,440-row re-index has landed — a silent fallback would degrade a corpus that is finally
complete. Follow the honesty pattern established by #65 on 16 Aug (`getBridgeHealth` /
`getMailAccessStatus`): record what actually happened, distinguish "not probed" from
"working", and never let a degraded path read as a healthy one.

## #83 — the pending-action queue truncates at 1,000

`routes/todos.js:91` reads `db.getPendingSaraActions(1000)`. Past 1,000 the oldest
candidates vanish from the UI with no error and no signal, so the queue would *look*
stabilised while losing its tail.

**The tracker's premise is stale — check before building.** It says "the queue currently
sits at 929"; measured 16 Aug it is **4 pending** (621 `capture_todo` rejected, 1,353
superseded). So the urgency is gone and #104 is effectively done. This is now a latent
bug, not a live one — worth a real bound plus a loud log when it caps, in the same spirit
as `scanRecentNotes`'s `maxCreate` and the actions cap at 120, rather than a bigger magic
number. Keep it small; it does not deserve a large build now.

## Still on Nick, not code

- **#106 — the cheapest thing on his list.** Exactly one pending `draft_reply`, to
  **Stephen Mitchell, "Integration Partner Escalation Contacts"**. Approving **sends
  nothing** (gate 1 of 2 — it drafts the words and queues a separate `reply_email`).
  `draft_reply` has **executed zero times ever**, so this is the first real test of that
  executor.
- **Write up the Nathan (#22) and Stephen (#23) 1-2-1s** — both were held on 16 Aug, but
  `last-1-2-1` only moves when a note proves it happened, so the Team board and the 1-2-1
  nudge will keep calling them overdue until then. Will look like a bug.
- **#2 Teams** — parked, needs to be in the office. Raise the `ChatMessage.Send` admin
  consent request first thing on an office day; there is an approval queue in front of it.
- **#116** — NOVA's Microsoft re-auth (avatar → My Settings → Microsoft 365 → Sign Out,
  then Sign in). **#115/#117/#118 are NOVA work gated behind it — do not build them.**
- **#59** — off-site backup is one Backblaze B2 keyID + applicationKey away from
  buildable, and needs a decision on where the restic password lives off the Pi.
