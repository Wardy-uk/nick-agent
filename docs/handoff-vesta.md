# Handoff — build VESTA

**For a fresh Claude Code session. Self-contained: everything you need is here or named here.**

Written 31 Aug 2026. Backend is **built, tested and deployed**; the frontend does not exist yet and is your job.

---

## What VESTA is

A shared home surface for Nick and his partner, on its own subdomain, beside NEURO and SARA rather than inside them. Named for the goddess of hearth and home — SARA is Nick's, VESTA is the household's.

It grew out of a standalone task-entry page for his partner that was designed but never built (`backend/routes/capture-link.js` exists; no page was ever written). Nick's words, 31 Aug: *"we probably need to evolve that to a more generalised capture/display page — so she can see specific info. A sort of NEURO lite."*

**First iteration shows exactly four things:**

1. **Tasks** — added by her, for either of them, with their state.
2. **His calendar** — work events show as time + **"Busy"** and nothing else; personal events show in full.
3. **The kitchen** — what's in the fridge and freezer, add and consume.
4. **Meal suggestions** — from what is actually in.

---

## THE SECURITY MODEL — read this before you write a line

⚠ **`/api/v` is deliberately open to the PUBLIC INTERNET.** pi5 runs Tailscale Funnel, so an auth exemption in `server.js` publishes a route to anyone who finds it, not merely to the tailnet. This is intentional — his partner has no NEURO PIN and must never have one, because it unlocks his queue, inbox, 1-2-1 notes and health.

Four rules already enforced in the backend. **Do not weaken any of them from the client side.**

- **Redaction happens in `services/vesta.js`, never in the page.** A work event's subject is not truncated, it is **absent** from the returned object. Location goes too — "Chancellors' Offices" names a client as plainly as a subject line. If you ever find yourself filtering titles in a component, something upstream has already broken.
- **Every read is gated on a per-account SCOPE that defaults closed.** `tasks` / `calendar` / `kitchen` / `shared-tasks`. An account created before today gets `['tasks']` and nothing else. `login` returns the granted scopes purely so the UI knows what to render — **it is a convenience, never the enforcement.**
- **A catalogue is private unless its own frontmatter says `shared: true`.** Naming a private one directly returns the *same 404* a missing one gives, so the door cannot be used to enumerate what Nick owns.
- **The admin half is not on the public mount.** Creating accounts, granting scopes and sharing catalogues live behind the NEURO PIN.

Verified live on the Pi: `/api/v/home` returns **401 with no auth, and 401 with the NEURO PIN**.

---

## What already exists (deployed, commit `39520ce`)

| File | What it is |
|---|---|
| `backend/services/vesta.js` | Calendar redaction (pure) + meal suggestions (pure) + shared-catalogue reads |
| `backend/services/catalogue.js` | The general cataloguing engine — pure parse/render, CRUD over vault markdown |
| `backend/routes/vesta.js` | The public mount, `/api/v` |
| `backend/routes/catalogue.js` | Nick's own half, `/api/catalogues`, behind the PIN |
| `backend/services/capture-links.js` | Accounts, PINs, brute-force throttle, sessions, **scopes** |

Tests: `catalogue.test.js` (15), `vesta.test.js` (17), `routes/vesta-routing.test.js` (10, real HTTP). Full suite 1690 pass.

### The API you are building against

```
POST /api/v/login                     { username, pin }
    → { ok, token, label, scopes }

GET  /api/v/home                      Authorization: Bearer <token>
    → { ok, label, scopes, gaps[],
        tasks[],                      always
        calendar[],                   only with the `calendar` scope
        catalogues[], kitchen{}, kitchenSections[], meals{}   only with `kitchen` }

POST /api/v/tasks                     { text }
POST /api/v/catalogue/:slug/add       { section, name }
POST /api/v/catalogue/:slug/used      { section, name }
```

A calendar entry looks like `{ id, start, end, allDay, title, personal, location? }`. For work, `title` is the literal string `"Busy"` and there is no `location`.

`meals` is `{ known, meals: [{ name, using[] }], why }`. ⚠ `known:false` means *nothing is recorded in the kitchen*, which is a different fact from *there is nothing to eat* — render them differently.

---

## Your job

### 1. The app — `vesta/` at the repo root

React + Vite, same shape as `sara/app`. Deployed to Netlify on **`vesta.nickward.co.uk`**, exactly as `sara/app` → `sara.nickward.co.uk` (base dir `vesta`, build on push to main). The API is the Pi's public Funnel address, not the tailnet one.

Screens:

- **Sign in** — username + PIN. ⚠ Five wrong attempts locks the account for fifteen minutes; the API returns that as a real message, so **show it**. Store the bearer token in `localStorage`.
- **Home** — one `GET /home` renders everything. It's a fridge-door screen on a phone over mobile data, so one call, not four.
- **Tasks** — hers, with state, plus an add box.
- **Calendar** — today + the next two days. Work is a time block reading "Busy"; personal reads properly.
- **Kitchen** — sections from `kitchenSections`, tap to consume, a box to add. Meal suggestions below, each naming what it's using.

**Render only what the scopes allow**, and hide the section entirely rather than showing an empty one — an empty calendar and no permission to see the calendar are different things.

⚠ **`gaps[]` is not decoration.** A block that could not be read comes back `null` with a gap naming why. *"I couldn't read the kitchen"* and *"the fridge is empty"* must never look the same, or she shops for food that's already in.

### 2. A Catalogues panel in NEURO

`frontend/src/components/CataloguesPanel.jsx` + a sidebar entry. Against `/api/catalogues`: list, create, add/remove items, and a **share toggle** per catalogue. The share toggle is the one control with a consequence outside the house — make it read like it.

### 3. Then, and only then: photo → items

Nick wants to photograph the fridge rather than type it. **Do this last, after the typed path is proven** — if the list is wrong, a photo just makes it wrong faster. It's a vision call on upload producing a *proposed* list she confirms, never a direct write.

---

## Decisions Nick has already made — do not relitigate

- **Name: VESTA.** Subdomain `vesta.nickward.co.uk`.
- **Calendar: work = "Busy", personal in full.** He chose this over "everything is Busy".
- **Catalogues are vault markdown**, not a table — a vinyl collection outlives the app that made it, and he'll create most of them by hand in Obsidian.
- **Meal suggestions are rules, not a model.** Asked what to make from milk and half a cabbage, a model invents a recipe needing four things that aren't there, convincingly. A rule can be wrong about whether he fancies it, never about whether he can make it. If you extend this, extend `MEALS` in `vesta.js`.

## Two things Nick has to do himself

1. **Create her account** — it's her PIN, so he sets it:
   `capture.create({ label, username, pin, scopes: ['tasks','calendar','kitchen'] })`
2. **Create the kitchen catalogue** — `POST /api/catalogues` with `{ title: 'Kitchen', sections: ['Fridge','Freezer','Cupboard'], shared: true }`

Until both exist the app is correct but empty. Say so on screen rather than showing a blank page.

---

## Traps

- ⚠ **`db.upsertCalendarEvent` takes camelCase** (`id`/`start`/`end`/`showAs`), **not** the snake_case column names. Guessing from the schema writes a row of nulls — and every "the subject didn't leak" assertion passes on it, because an empty calendar contains no customer names either. **Always pair a negative assertion with a positive one.** This bit me on 31 Aug.
- ⚠ The mount is `/v/` and the exemption tests `startsWith('/v/')` — one letter from `/v1/` (the FreeReps health wire, exempt for an entirely different reason). Same care as `/c/` versus `/capture-links`.
- **Another session may be working in this repo.** Stage explicit paths, never `git add -A`; it happened twice on 31 Aug, once in each direction. See `.claude/memory/mistakes.md`.
- Read `CLAUDE.md` first — it is long, and the sections on `capture-links`, the auth middleware and vault-exclusions are the relevant ones.

## Done means

The app builds; she can sign in on her phone from outside the house; tasks, calendar and kitchen render with scopes respected; **a work subject cannot be found anywhere in a network response**; and `docs/` plus `CLAUDE.md` record what shipped.
