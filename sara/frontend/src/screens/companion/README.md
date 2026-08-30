# Companion (built view)

**Built and live.** `CompanionView.jsx` (+ `.css`) is implemented, registered in
`frontend/src/state/views.js` as `sara` (status: `available`) and routed by
`components/ViewRouter.jsx`.

> This file used to say *"Placeholder for a future SARA view. Not built in WS2-WP1"*.
> It had been wrong for some time, and it named the wrong view id as well.

It is the text conversation surface. Messages go through SARA's `/api/chat` route,
which is a **transport bridge only** — it proxies to NEURO's own `/api/chat`
(`src/integrations/neuroChat.js`). SARA does not run a second AI, hold a second
conversation history, or decide anything about the reply.

## What it shows when NEURO is unavailable

The surface still loads and the composer still works, but sending returns a clear
"NEURO chat is not configured / could not be reached" message rather than a fabricated
reply. The opening lines are derived from the shared model, so with NEURO down they
carry the same `unavailable` provenance everything else does.

Intended focus: a conversational companion mode.
