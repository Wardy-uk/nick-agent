# Session Handoff — 2026-08-17 (end of day, two parallel sessions)

## What was done
- **SARA voice unified across every surface she speaks from** (`3809eda` and earlier). Blocks extracted to `services/sara-voice.js`; chat, standup, EOD, journal and briefing all compose from it. Deployed and verified live — `[AIRouting] standup_questions: openrouter` with a briefing that names what slipped and asks one question at a time.
- **Two router bypasses removed.** `routes/standup.js` and `routes/journal.js` called Ollama with a hardcoded `fetch` BEFORE `ai-routing`, so `standup_questions`/`eod_questions` never reached OpenRouter despite being in `LATENCY_SENSITIVE_TASKS`. No prompt rewrite could have landed without this.
- Nudge pools, Focus card labels, push senders (all SARA now, never NEURO), `TONE_INSTRUCTIONS` third-person fix, two emoji removed.
- Six tickets from the other session (#36, #31, #39, #13, #66, #104) plus Plaud blocks and the PIN rotation — detail archived in `handoff-2026-08-17-tickets-and-voice.md`.

## What's still pending
- **The Pi is 10 commits behind origin/main.** It sits at `3809eda`; everything from `8e69b29` to `ec80ff5` (1-2-1 tracker, Plaud write-up blocks, weekly risk report, crypt-secret rotation, PIN docs) is committed and pushed but NOT deployed. Deploy sequence is in the pi5-deployment memory.
- `outcomes.test.js` — 2 failures, both date rollover. Fixtures pin `WED = 2026-08-12` while `outcomes.recent(4)`/`trend(5)` resolve "now" themselves, so the fixture week has fallen out of the window. It will fail every week from here. **Fix is to pass the date in, not to re-pin the fixture.** 570/572 otherwise.

## Key decisions made
- `VOICE_FULL` vs `VOICE_COMPACT` — the compact block exists because journal prompts and briefing synthesis can land on qwen2.5:1.5b with a 2048-token context, where a full personality spec crowds out the task and makes output *worse*. Don't grow it.
- The technical-partner rules and the debugging order live in `claude.js`'s `SYSTEM_PROMPT` ONLY. The standup debugs nothing; carrying them in the shared block taxes every ritual message. `prompt-parity.test.js` asserts they stay out.
- `action-presenter` and `watchdog` copy was already right and was deliberately left alone.
- ⚠ **The voice must never reach anything outbound.** Email drafts, the 1-2-1 invite body and chase messages say "as Nick Ward" on purpose — that mail sends under his name.

## Files changed
- `backend/services/sara-voice.js` — new; the one definition, two sizes.
- `backend/services/{claude,standup-session,briefing,nudges,decision-engine,ai-provider,scheduler,imports}.js`, `backend/routes/{standup,journal,capture,imports}.js` — compose from it / copy fixes.
- `backend/services/prompt-parity.test.js` — pins the consumer list, compact size, push sender, and the five behaviours the first cut compressed away.
- `sara/app/src/views/{Focus,Tasks}.jsx` — celebration emoji removed.

## Gotchas for next session
- **Two sessions committing at once corrupted a commit today.** `82804bd` swept up another session's staged index under its own message, and because that index was staged against the pre-#13 commit, it silently REVERTED #13 — the prompt went back to naming Arman. Caught and fixed forward in `3809eda`. If parallel sessions run again: stage and commit in one action, or check `git log` immediately before committing. Already logged in `mistakes.md`.
