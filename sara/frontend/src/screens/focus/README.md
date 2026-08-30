# Focus (built view)

**Built and live.** `FocusView.jsx` (+ `.css`) is implemented, registered in
`frontend/src/state/views.js` as `focus` (status: `available`) and routed by
`components/ViewRouter.jsx`.

> This file used to say *"Placeholder for a future SARA view. Not built in WS2-WP1"*,
> which had been wrong for some time. A README claiming an implemented screen is a
> placeholder is worse than no README: it is the thing a reader trusts instead of
> looking, and it sends them to build something that already exists.

It reads the **same shared state** as every other view via `useSaraState()` and owns no
data of its own. Focus content comes from `model.domains.focus` (the State Engine
domain) and from the focus-assist payload the shell fetches from `/api/focus`.

## What it shows when NEURO is unavailable

Nothing invented. `model.domains.focus.source` is `unavailable` and `current` is
`null`, so the view has no action to show and the connection banner
(`components/ConnectionStatus.jsx`) says why. It does **not** fall back to a seeded
"prep the probation review" item — that fallback existed and was removed; see
`sara/backend/src/state/provenance.js`.

Intended focus: one thing, timeboxed — the current do-next.
