# Handoff — outstanding NEURO builds

**For a fresh Claude Code session.** Written 31 Aug 2026, at commit `39520ce`. Everything below is *not started* unless it says otherwise. VESTA has its own brief: `docs/handoff-vesta.md`.

⚠ **Read `CLAUDE.md` before touching anything** — it is the accumulated record of why things are the way they are, and most of the traps below are already documented there in more detail.

⚠ **Another session is often working in this repo at the same time.** Stage explicit paths, never `git add -A`. On 31 Aug both sessions swept each other's in-flight work into commits, once in each direction. See `.claude/memory/mistakes.md`.

---

## Waiting on a decision from Nick — do not start these

| | |
|---|---|
| **Should ambient observations ever notify?** | `services/ambient.js` is **pull-only** by design. Six new interruption sources is how SARA becomes a pest and gets muted, and nudge volume is the one budget allowed to argue against building more. My read: the health trends earn a push, the water one never does. His call. |
| **`NEVER_MENTION` in `desktop-activity.js` is deliberately empty** | Is four hours in Teams or Excel the same finding as four hours in VS Code? Inventing that list would be inventing his preferences. |
| **Personal context in the vault** | The biggest single lever left, and he has said he wants to think about it first. SARA now has eyes on his body, his diary and his laptop, and almost nothing on what he cares about doing with his time. `WHO_IS_NICK` in `sara-voice.js` says so explicitly and tells her to ask rather than invent. |
| **Plaud consolidation sees 2 of 222 recordings** | `groupPlaudNotes` filters `path.startsWith('Plaud/')`, but summaries now route to `Meetings/YYYY/MM/` where **222 notes carry a `plaud_id`**. Keying the group on `plaud_id` wherever the note lives switches a dormant pipeline back on and writes ~222 consolidated notes (30/run, hourly). That is a decision, not a bug fix. |
| **63 core dumps, 3.0 GB, in `/mnt/data/nuero/backend/`** | From a pm2 restart loop on 28 Aug 20:04–20:05: something ran `server.js` under `/usr/bin/node` (v20), and better-sqlite3's prebuild is Node 22 ABI. Harmless now (403 GB free) but they land in the **repo working tree**, which per the deploy notes can block `--ff-only` pulls. Also worth setting `ulimit -c 0` for the pm2 service so it cannot recur. |

---

## Ready to build

### 1. ~~Catalogues panel in NEURO~~ — **DONE, 31 Aug 2026**
`frontend/src/components/CataloguesPanel.jsx` + `.css`, sidebar **Catalogues**, wired in `App.jsx`
(view id `catalogues`, lazy like every other non-primary panel). List, create, add/remove, and the
share toggle — which asks first and names where the list goes, because VESTA is on the public
internet. Created catalogues are **private**; there is no `shared` control on the create form.

⚠ **A real bug was fixed on the way in.** `render` writes `*(empty)*` under a section with nothing
in it, and `parse` did not recognise its own placeholder — so it was preserved into `trailing`,
re-rendered under the sections, and read back on the next save. **Every write appended one more
copy, for ever**, to any catalogue with an empty section, which every newly created one is. The
existing `parse -> render -> parse is STABLE` test compares the parsed FIELDS and is blind to it;
the new pins are on the **text** and on the **file on disk** across add/remove cycles.

Pinned by `catalogue.test.js` (16) + `routes/catalogue-routing.test.js` (9, real HTTP). Frontend
builds. ⚠ **Not seen rendering** — there is no component test harness in `frontend/`, so a build
proves it compiles and nothing more.

### 2. `chunkReload` in `frontend/src/main.jsx` — **belongs to another session**
The SPA-fallback fix (`server.js` + `sw.js` v8 + `ErrorBoundary.jsx` + `routes/spa-fallback.test.js`) landed on 31 Aug and its comment references a `chunkReload` in `main.jsx` **that does not exist**. The server now honestly 404s a missing hashed chunk instead of answering with `index.html`, which is strictly better than the dead-menu bug it replaced — but the client-side recovery is missing. **Check with the other session before writing it.**

### 3. ~~NOVA's team-availability bridge needs an IIS deploy~~ — **ALREADY DONE**
⚠ Corrected 31 Aug 2026 by calling the endpoint instead of believing this note. It is deployed and
working: `known:true`, `matchedBy:"id"`, roster of 13, 20 absence days, fetched minutes ago, and it
correctly had a colleague on annual leave that day. `CLAUDE.md`'s "needs an IIS deploy" line dates
from 27 Aug and was stale; I repeated it twice before checking. **Nothing to do here** — and the
general lesson is rule 5 below, which I had written at the bottom of this very file.

### 4. Backups — two items outstanding from #59
- Store the rclone **crypt password + salt off the Pi**. Right now a total loss of the Pi loses the ability to decrypt the off-site backups.
- **Regenerate the B2 master key.**

Full context: `backend/scripts/backup-offsite-SETUP.md`.

### 5. Photo → catalogue items
Nick: *"I can scan a pic of what's in there, and another pic/text entry when it's consumed."* A vision call producing a **proposed** list she confirms, never a direct write. ⚠ Do this **after** the typed path is proven — if the list is wrong, a photo makes it wrong faster.

---

## Built on 31 Aug — context for anything you touch nearby

All deployed and verified live. Each is documented at length in `CLAUDE.md`.

- **Task de-dupe now compares NEURO against itself.** Six real duplicate pairs found among 143 open tasks, four scoring 1.000. `INTERNAL_MIN_SCORE = 0.65`, measured — the Microsoft half's 0.42 was measured on independently-worded lists and is wrong for a corpus that is all Nick's own vocabulary.
- **`friction.js` no longer reads `waiting_on`.** It was rendering four "Naomi to…" lines under a heading saying *"Friction noticed"*. The bar is not attribution but **whose act the evidence records** — a `waiting_on` row evidences that someone said they'd do something; nothing records that Nick is blocked on it.
- **The HA Companion app never stopped reporting** — the phone re-registered and every entity gained a `_2` suffix **on the entity id**, not the device prefix. `resolvePhoneEntities` discovers it and self-heals.
- **`services/ambient.js`** — sedentary (Apple Watch stand data), exercise gaps, health trends, food/water. ⚠ Its governing rule: **not logged is not not done.**
- **`services/desktop-activity.js` + `desktop-agent/`** — installed and running on Nick's Windows box. ⚠ Sends the **foreground process name only**, never window titles.
- **`services/signals.js` + NEURO Health** — one row per sensor, five states. `off` must never render like `stale`.
- **`sara-voice.js`** — merged with Nick's own personality spec, now with REGISTERS (work / building / personal / stuck). Spec archived at `Projects/NEURO/SARA — Personality Spec` in the vault.

---

## The rules that keep biting

Every one of these cost something real on 31 Aug:

1. **Absence is never a zero.** A dead sensor, an unlogged meal, an unread domain and a quiet one are different facts. `known:false` with a reason, never an empty list dressed as an answer.
2. **Verify identifiers against the live system, never a mental model.** Two failures in one day: HA's `_2` suffix, and `upsertCalendarEvent`'s camelCase. Copy real identifiers into fixtures.
3. **Pair every negative assertion with a positive one.** "The secret didn't leak" passes on an empty payload.
4. **A green suite says nothing about routing.** Call the route against a running server.
5. **Measure before building, and again after deploying.** The most valuable findings of the day came from calling a live endpoint and reading the output, not from the test run.
6. **Say what failed, in words, where the person is looking.** An installer that printed "Installed and started" after failing was the worst bug written that day.
