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

### Exact build steps in Shortcuts

#### Part 1: Create the shortcut on iPhone

1. Open the **Shortcuts** app on your iPhone.
2. Tap the **+** in the top-right corner.
3. Tap the shortcut name at the top and rename it to:

`Add a note to SARA`

4. Tap **Done** on the rename panel.

#### Part 2: Add the input prompt

1. Tap **Add Action**.
2. Search for:

`Ask for Input`

3. Select **Ask for Input**.
4. Configure it as:
   - Prompt: `What is the note?`
   - Input Type: `Text`

This is the bit Siri will read back to you on the Watch.

#### Part 3: Add the web request

1. Tap **Add Action** underneath the Ask for Input step.
2. Search for:

`Get Contents of URL`

3. Select **Get Contents of URL**.
4. Set **URL** to:

`https://pi5.tailecb90f.ts.net/api/capture/siri-note`

5. Tap **Show More**.
6. Set:
   - Method: `POST`
   - Request Body: `JSON`

#### Part 4: Add the headers

Inside the same **Get Contents of URL** action:

1. Find **Headers**.
2. Add these two headers:

`Content-Type` = `application/json`

`X-Neuro-Pin` = `<YOUR-NEURO-PIN>`

> The real value is `NEURO_PIN` in `backend/.env` on the Pi — it is **never**
> written into this repo. It was committed here in plaintext on 15 July 2026
> (#123) and this repo is public, so treat any PIN that has ever appeared in
> these docs as compromised regardless of what the current history looks like.

#### Part 5: Add the JSON body

Still inside **Get Contents of URL**:

1. In the JSON body section, add:

`title` = `Watch note`

2. Add another field:

`note` = **Provided Input**

Important:
- do **not** type the words `Provided Input`
- tap the variable picker above the keyboard
- select the magic variable from the **Ask for Input** action

When finished, the request body should effectively be:

```json
{
  "title": "Watch note",
  "note": "<whatever you dictated>"
}
```

#### Part 6: Read the response back to you

1. Tap **Add Action** under the web request.
2. Search for:

`Get Dictionary Value`

3. Select it.
4. Set:
   - Dictionary: **Contents of URL**
   - Get: `spokenText`

5. Tap **Add Action** again.
6. Search for:

`Speak Text`

7. Select it.
8. Set the text to the **Dictionary Value** from the previous step.

That makes Siri say:

`Saved to SARA.`

if the note landed correctly.

#### Part 7: Test it on iPhone first

Before involving the Watch:

1. Tap the **play** button in Shortcuts.
2. When prompted, enter:

`Test note from iPhone shortcut`

3. Wait for Siri to speak the result.

Expected result:
- Siri says `Saved to SARA.`
- a markdown note appears in your Obsidian vault Imports area

If it fails:
- check Tailscale is connected on the phone
- check the PIN header is exactly `<YOUR-NEURO-PIN>`
- check the URL is exactly:
  `https://pi5.tailecb90f.ts.net/api/capture/siri-note`

#### Part 8: Make it available on Apple Watch

Once it works on iPhone:

1. In the Shortcut, tap the **info** button or shortcut settings.
2. Turn on:
   - **Show on Apple Watch**
   - **Use with Siri**

3. Add or record the Siri phrase:

`Add a note to SARA`

#### Part 9: Use it from the Watch

Then the MVP flow becomes:

1. Raise wrist
2. Say:

`Hey Siri, add a note to SARA`

3. Siri asks:

`What is the note?`

4. Dictate the note
5. Siri sends the transcribed text to NEURO
6. Siri says:

`Saved to SARA.`

## Troubleshooting

### Siri says it ran, but nothing lands in Obsidian

- Confirm the Shortcut is using `Get Contents of URL` with `POST`
- Confirm the body is `JSON`, not form data
- Confirm `note` is wired to the **Ask for Input** magic variable
- Confirm the phone is on Tailscale when the Shortcut runs

### Siri says it could not complete the request

- Tailscale likely is not connected
- or the Pi backend is unreachable
- or the `X-Neuro-Pin` header is wrong

### Siri says “I did not catch a note to save.”

That response is coming from the backend and means the request reached NEURO, but the Shortcut sent an empty `note` value.

Usually that means:
- the `note` field was left blank
- or `note` was typed as plain text instead of using the **Provided Input** magic variable

### The shortcut works on iPhone but not Watch

- Open Watch app on iPhone and confirm Shortcuts sync is enabled
- Confirm **Show on Apple Watch** is enabled for this shortcut
- Sometimes the watch list lags; open Shortcuts on Watch and let it sync for a minute

## Notes

- This is **transcribed**, not audio-preserving. The watch/iPhone Siri pipeline turns speech into text first.
- That is the right MVP because it is fast, reliable, and uses infrastructure already in NEURO.
- If we later want raw audio too, that becomes a V2 flow using iPhone/watch app support rather than pure Shortcuts.

## V2 ideas

- Add tags like `source: watch-siri`
- Auto-detect todo language and create a todo instead of a note
- Return richer spoken confirmations like `Saved to SARA as a watch note`
- Add a companion `Add a todo to SARA` shortcut
