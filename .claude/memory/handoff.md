# Session Handoff — 2026-08-15 18:05

**#90 give SARA a voice.** Dictation IN works. Speech OUT went through three wrong
theories before the real cause; server-side TTS is now built and deployed, **untested by
Nick on the phone**. Also fixed the chat-reply quality complaint that surfaced en route.

## What was done

- **Voice in** — 🎤 in `sara/app` Chat, ported from `Capture.jsx`. Works on the iPhone.
- **Voice out (browser)** — 🔊 toggle + speak-on-completion. Fixed three real iOS bugs in
  `voiceUtils.js` (empty unlock utterance, unconditional `cancel()`, no explicit unlock).
  **None of them were the cause.** iOS drops `speechSynthesis` in an installed standalone
  PWA — accepted, never played, no error, even from inside a user gesture.
- **Voice out (server)** — `backend/services/tts.js` + `routes/tts.js`, wired in
  `server.js`. `POST /api/tts/speak` → WAV. Verified on the Pi: 200, `audio/wav`, 220KB.
  Chat falls back to it when browser speech produces nothing after 1.2s.
- **Chat replies** — a greeting no longer drags in the full status dump, and the at-risk
  count is no longer capped at 10. Deployed to the Pi (`635f7a5`) and live.

## What's still pending

- **Nick has not confirmed any of this works on the phone.** Everything above is verified
  in the bundle and on the Pi, not in his ear.
- **The Safari test was never run.** The standalone-PWA diagnosis is inferred from "no
  sound even inside a tap", not confirmed against Safari. If Safari is *also* silent the
  diagnosis is wrong and the TTS build was unnecessary.
- **Port the voiceUtils iOS fixes back to `frontend/`** — the two copies have diverged and
  the web app carries the same empty-utterance bug. Detail in CLAUDE.md.
- Briefings/nudges still silent on the phone; no wake word (#11 parked).

## Key decisions made

- **OpenRouter, not piper.** Nick pushed back on my claim that OpenRouter had no TTS — he
  was right. `openai/gpt-audio-mini` via the existing key. No Pi install, no new account.
- **Browser speech stays first**, server TTS is the fallback: free where it works, ~0.05p
  a reply where it doesn't.
- Mic added to Chat (Nick's call) because the Voice tab mounts Capture, not Chat.

## Gotchas for next session

- **`ECHO_SHOT` in `tts.js` is load-bearing.** gpt-audio is conversational, not a TTS
  engine: asked plainly to read text it *answers* it — one test line came back with an
  invented commitment SARA never made. 0/3 verbatim without the echo shot, 3/3 with it.
- Audio output **requires `stream: true`**, and streaming **only supports `pcm16`** — mp3
  is rejected. Hence SSE parsing and a hand-written WAV header.
- `busy` gates the speaking, never `messages`. `rec.onend` fires from a stale closure.
- `<audio>` needs its own gesture unlock, separate from `speechSynthesis` — the 🔊 tap
  plays 50ms of silence to prime it.
- **I asserted live behaviour from code/memory three times this session and was wrong each
  time** (voiceUtils "proven in daily use" = desktop only; "OpenRouter is text-only";
  a deploy "confirmed" off a grep whose `.` matched an apostrophe). Verify against the
  running thing. See mistakes.md.
