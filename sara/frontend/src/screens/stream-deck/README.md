# Stream Deck (component exists, NOT reachable)

**Not operational.** `StreamDeck.jsx` (+ `.css`) exists in this directory, but:

* it is **not** registered in `frontend/src/state/views.js`, and
* it is **not** imported or routed by `components/ViewRouter.jsx`.

So there is no way to open it in the running app. This is the honest status: not
"planned" (the code is written) and not "available" (nothing can reach it) — it is
orphaned code.

> The previous version of this file described it as a `planned` view that "renders the
> shared `PlannedView` placeholder" when selected. Neither half was true: no view id
> exists for it, so it cannot be selected at all.

To make it reachable: add an id to `SARA_VIEWS` and an entry to the registry in
`views.js`, then add a `case` to `ViewRouter.jsx`. It must read the same shared state
via `useSaraState()` and must not introduce its own source of truth.

Intended focus: a large touch-action grid for quick triggers.
