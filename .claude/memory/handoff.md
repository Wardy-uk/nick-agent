# Session Handoff — 2026-08-15 16:35

**Task: give the SARA phone app a voice.** Tracker **#90**. Code is DONE and builds clean.
**NOT committed, NOT deployed — see "still pending".**

## What was done

- `sara/app/src/voiceUtils.js` — verbatim copy of `frontend/src/voiceUtils.js`, verified
  byte-identical with `diff`. Do not let the two drift.
- `views/Chat.jsx` — 🔊/🔇 toggle in `chat__head` (persisted, OFF by default) and a
  speak-on-complete effect keyed on **`busy`**.
- `views/Chat.jsx` — ALSO a 🎤 composer button (ported from `Capture.jsx:62-84`). This was
  NOT in the original plan; see decisions.
- `Chat.css` — toggle + mic styles. `CLAUDE.md` — SARA mobile section records the traps.
- `npm run build` in `sara/app` passes.

## What's still pending

- **Commit + push.** `main` moved during this session (HEAD is now `0a0118b`, a concurrent
  session's escalation work). Rebase/check before pushing. Working tree also carries that
  session's `backend/routes/health.js`, `stress-score.js` + test, and
  `workstream-escalation-and-chasing.md` — **NOT mine, do not commit them with #90.**
- **Deploy.** `sara/app` is its own **Netlify** site `sara-nickward` →
  https://sara.nickward.co.uk (branch URL `main--sara-nickward.netlify.app`, so it looks
  git-linked to `main`). I could not confirm the build config — the Netlify API 502'd.
  There is NO Pi deploy for this: `sara/app` talks straight to the NEURO backend.
- **On-device test.** Nick has not tried it yet. Watch the iPhone console for
  `[SARA Voice] Selected: …`; the `No suitable voice found` warning dumps the full list.

## Key decisions made

- **Mic added to Chat, on Nick's call.** The plan said chat-only speech OUT, but the done
  criterion was "talk and hear the reply" — and `App.jsx:28` maps the **Voice tab to
  Capture**, not Chat, so no tab could do both. Nick chose adding the mic over remapping
  the tab (which would have cost the one-tap voice capture).
- Off by default, persisted (`sara_voice_out`). A PWA that talks unprompted on a train
  gets disabled forever.
- Dictation is `continuous` — the **stop tap sends**, so a mid-thought pause doesn't fire
  early. No wake word (#11 stays parked).

## Gotchas for next session

- **`busy` gates the speaking, never `messages`** — keying on `messages` speaks every
  streamed token. Both reply paths (SSE + `/api/chat/sync`) clear `busy` in one `finally`.
- **`rec.onend` fires from a stale closure** — hence `dictatedRef` (text) and `busyRef`
  (in-flight guard) instead of state. `send(e)` is now a thin wrapper over `submit(text)`.
- The Voice tab still mounts Capture. The talk→hear loop lives on **Chat**. If Nick finds
  that confusing in use, remapping the tab is the follow-up.
- Briefings/nudges are still silent on the phone — NEURO's `speakIfEnabled` is not wired
  into `sara/app`. That's the next increment, once #90 is judged.
