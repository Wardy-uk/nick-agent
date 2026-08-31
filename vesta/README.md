# VESTA

The shared home surface. SARA is Nick's; VESTA is the household's.

Four things: tasks she adds and what became of them, his diary with work
redacted to "Busy", what is in the kitchen, and what can be cooked out of it.

## Running it

```bash
npm install
npm run dev          # :5176, proxies /api → localhost:3001
```

`NEURO_BACKEND_URL` overrides the dev proxy target.

## Deploying

Netlify, base directory `vesta`, build on push to main → **vesta.nickward.co.uk**.
Same arrangement as `sara/app` → sara.nickward.co.uk.

⚠ **`VITE_API_URL` must be the Pi's public Tailscale FUNNEL address, not the
`.ts.net` tailnet one SARA uses.** Her phone is outside the house and has no
Tailscale — that is the entire reason `/api/v` is exempt from the PIN.

## The one thing to understand before changing anything

**This client enforces nothing.** `/api/v` is deliberately open to the public
internet, and every rule that holds that boundary lives on the server:

- A work event's subject and location are **absent from the response object**,
  not hidden by this app. `backend/services/vesta.js` does that. If you ever
  find yourself filtering a title in a component, something upstream has broken
  and the fix is upstream.
- Scopes are re-checked on every route. `scopes` in the login response is used
  here to decide what to **render**, which is a convenience, never a boundary.
- A catalogue is private unless its own frontmatter says `shared: true`, and
  naming a private one returns the same 404 a missing one does.

## Three renderings that must stay distinct

Conflating any two of these is how this surface starts lying:

| | means | looks like |
|---|---|---|
| **gap** | the server could not read it | amber, names why, "don't treat it as nothing" |
| **empty** | it read fine, nothing there | quiet grey line |
| **absent** | no permission to see it | the section is not mounted at all |

"I couldn't read the kitchen" and "the fridge is empty" send her to different
shops. Likewise `meals.known === false` means *nothing is recorded*, which is
not *there is nothing to eat*.

## Before it shows anything

Two things only Nick can do, and until both exist the app is correct and empty
(it says which is missing rather than showing a blank panel):

1. Her account, with scopes — it is her PIN, so he sets it:
   `capture.create({ label, username, pin, scopes: ['tasks','calendar','kitchen'] })`
2. The kitchen catalogue:
   `POST /api/catalogues { title: 'Kitchen', sections: ['Fridge','Freezer','Cupboard'], shared: true }`
