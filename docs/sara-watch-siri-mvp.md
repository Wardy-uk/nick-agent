# SARA Watch + Siri MVP

## Goal

Raise wrist → "Hey Siri, add a note to SARA" → Siri asks for the note → dictated text is posted into NEURO → note lands in the Obsidian vault.

For MVP, **Apple handles the speech-to-text**. NEURO/SARA just receives the transcribed text and stores it.

## Backend endpoint

Use:

`POST /api/capture/siri-note`

Auth:

- same `X-Neuro-Pin` header as the rest of NEURO

JSON body:

```json
{
  "title": "Watch note",
  "note": "Book time with finance tomorrow morning."
}
```

Response:

```json
{
  "ok": true,
  "filename": "2026-07-12-...-Watch-note.md",
  "path": "...",
  "spokenText": "Saved to SARA.",
  "preview": "Book time with finance tomorrow morning."
}
```

The route writes to the same Obsidian Imports flow as normal capture.

## Shortcut build

Build an iPhone Shortcut, then enable it on Apple Watch.

Suggested shortcut name:

`Add a note to SARA`

Suggested Siri phrase:

`Add a note to SARA`

### Shortcut steps

1. `Ask for Input`
   Prompt: `What is the note?`
   Input type: `Text`

2. `Text`
   Contents:

```json
{
  "title": "Watch note",
  "note": "[Provided Input]"
}
```

3. `Get Contents of URL`
   - Method: `POST`
   - URL: `https://pi5.tailecb90f.ts.net/api/capture/siri-note`
   - Headers:
     - `Content-Type: application/json`
     - `X-Neuro-Pin: <your-pin>`
   - Request Body: `JSON`
   - Body: map `title` = `Watch note`, `note` = `Provided Input`

4. `Get Dictionary Value`
   - Input: result of previous step
   - Key: `spokenText`

5. `Speak Text`
   - Speak the `spokenText` value

## Notes

- This is **transcribed**, not audio-preserving. The watch/iPhone Siri pipeline turns speech into text first.
- That is the right MVP because it is fast, reliable, and uses infrastructure already in NEURO.
- If we later want raw audio too, that becomes a V2 flow using iPhone/watch app support rather than pure Shortcuts.

## V2 ideas

- Add tags like `source: watch-siri`
- Auto-detect todo language and create a todo instead of a note
- Return richer spoken confirmations like `Saved to SARA as a watch note`
- Add a companion `Add a todo to SARA` shortcut
