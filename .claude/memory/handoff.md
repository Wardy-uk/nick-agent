# Session Handoff — 2026-08-15 19:20

**#90 give SARA a voice — DONE and in use.** Nick can dictate on the Chat tab and hear the
reply. Chat reply quality was fixed along the way. One cosmetic item parked by choice.

## What was done

- **Voice in** — 🎤 in `sara/app` Chat, ported from `Capture.jsx`. Working on the iPhone.
- **Voice out** — browser speech first, **server TTS as fallback**. `backend/services/tts.js`
  + `routes/tts.js`, `POST /api/tts/speak` → WAV, via the existing OpenRouter key
  (`openai/gpt-audio-mini`, ~0.05p a reply, in-memory cache by text|voice|model).
- **Voice picker** — five feminine voices in the Chat header, tap to audition, persisted to
  `localStorage` (`sara_tts_voice`). Default `coral`.
- **Chat replies** — greeting no longer pulls the status dump; at-risk count no longer
  capped at 10; weekend prompt got its personality back.
- **Service worker** — `sw.js` now calls `skipWaiting()` + `clients.claim()`.

## What's still pending

- **Accent.** All five voices sound American. The prompt now pushes hard for RP, but these
  are American-trained voices and it may not convince. Nick's verdict: "that will do for
  now". Ladder if revisited: `TTS_MODEL=openai/gpt-audio` (full model follows style better,
  ~1p a reply) → **ElevenLabs** (genuine British voices; needs an account + key). Don't
  iterate further on the prompt, it's a model limitation.
- **Port the voiceUtils iOS fixes back to `frontend/`** — the copies diverged and the web
  app carries the same empty-utterance bug. Detail in CLAUDE.md.
- **`VITE_BUILD_LABEL` is unset on Netlify.** The header already renders it when present —
  setting it makes "which build is the phone running" readable instead of inferred.
- Briefings/nudges still silent on the phone; no wake word (#11 parked).
- Weekday and weekend system prompts are separate literals that drifted once already.

## Key decisions made

- **OpenRouter, not piper.** Nick challenged my claim that OpenRouter had no TTS — he was
  right, four audio-output models exist. No Pi install, no new account.
- **Browser speech stays first**, server TTS is the fallback: free where it works.
- Mic added to Chat because the `voice` tab mounts Capture, not Chat.

## Gotchas for next session

- **`ECHO_SHOT` in `tts.js` is load-bearing.** gpt-audio is conversational: asked plainly to
  read text it *answers* it, once inventing a commitment SARA never made. 0/3 verbatim
  without it, 3/3 with it. The TTS cache key does NOT include the system prompt — restart
  the backend after changing it, or stale audio survives.
- Audio output **requires `stream: true`** and streaming **only supports `pcm16`**.
- `busy` gates the speaking, never `messages`. `rec.onend` fires from a stale closure.
- `<audio>` needs its own gesture unlock, separate from `speechSynthesis`.
- **The ↻ button in the SARA header is the update path** — `registration.update()` + reload.
  Telling Nick to swipe-close is not reliable on iOS.
- **iOS drops `speechSynthesis` entirely in an installed standalone PWA** — accepted, never
  played, no error, even inside a user gesture. This was never confirmed against Safari.
