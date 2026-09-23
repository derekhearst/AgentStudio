# Read Aloud (Text-to-Speech)

## Overview

AgentStudio can read an assistant's reply out loud. Every reply in a chat has a speaker button next to its copy button; pressing it plays the reply, and pressing it again stops it. For hands-free use, such as listening from a phone while doing something else, the **Auto-read** switch above the message box reads each new reply out loud as soon as it finishes.

The voice comes from OpenRouter's text-to-speech models, so reading aloud costs a small amount per character. The spend goes into the same usage ledger as chat, and the same budget limits apply to it. The model and the voice are chosen in **Settings > Model & AI**.

Dictation (speaking to AgentStudio) is the reverse direction and is not covered here. It uses the separate **Transcription Model** setting.

## Key concepts

| Concept | What it means |
| --- | --- |
| **Read-aloud model** | The OpenRouter speech model that turns text into audio. Stored per user as `ttsModel`. Default: `hexgrad/kokoro-82m`, the cheapest paid speech model in OpenRouter's catalogue. |
| **Voice** | One of the voices the chosen model offers, for example `af_heart`. Stored per user as `ttsVoice`. Left empty, the model uses its own default voice. |
| **Speech catalogue** | OpenRouter's list of speech models, with each model's price per character and the voices it accepts. The Settings pickers are filled from it, and it is used to price each request. It is fetched from OpenRouter at most once an hour. |
| **Chunk** | A piece of a reply sent for synthesis in one request. A request can carry at most 8,000 characters, so longer replies are split. |
| **Auto-read** | An on/off switch, **per device**. It is off until you turn it on, and turning it on in one browser does not turn it on anywhere else. |
| **Speakable text** | The reply rewritten for listening: formatting is removed and code is skipped (see Business rules). |

## User flows

### Reading one reply

1. The user presses the speaker button under an assistant reply.
2. The reply is rewritten as speakable text and split into chunks. The first chunk is short (up to 400 characters) so the audio starts quickly. Later chunks are up to 2,000 characters.
3. The first chunk is sent to the server. A spinner shows on the button while it is prepared.
4. The server checks the user's budget limits, asks OpenRouter to synthesise the chunk as MP3 with the user's model and voice, and records the cost in the usage ledger.
5. The chunk plays. While it plays, the next chunk is already being requested, so there is usually no gap between chunks.
6. When the last chunk ends, the button returns to its normal state.

Pressing the button again at any point stops playback straight away and cancels any request still in progress. Starting another reply stops the current one: only one reply plays at a time.

### Auto-read (hands-free)

1. The user turns on **Auto-read** above the message box. The switch shows "Auto-read on".
2. The user sends a message (typed or dictated) as normal.
3. When the turn finishes and the reply has been saved, the reply is read aloud automatically, using the same steps as above.
4. While an auto-read reply is playing, a **Stop** button appears next to the switch.
5. Turning the switch off also stops a reply that auto-read started. It does not stop a reply the user started with its own speaker button.

A reply is **not** read automatically when:

- the user pressed Stop on the turn, or the turn failed part-way (the half-finished reply is saved, but it is not read);
- the reply has no text, for example a turn that only ran tools;
- the reply was already on screen before the turn started. Opening an old conversation never reads it.

If the browser refuses to play audio, or the server refuses the request, the reason appears next to the switch.

### Choosing the model and voice

1. The user opens **Settings > Model & AI**.
2. **Read-aloud Model** lists OpenRouter's speech models with their price per million characters (or "free").
3. **Read-aloud Voice** lists the voices the chosen model offers. Changing to a model that does not offer the current voice switches to that model's first voice.
4. The play button next to the voice reads a short sample sentence with the model and voice currently on screen, so the user can hear a voice before saving it. The sample is charged like any other read-aloud request.
5. **Save** stores the choice. **Reset** returns both settings to the defaults.

If OpenRouter's catalogue cannot be reached, both pickers become plain text fields. The saved values keep working.

## Roles & permissions

| Action | Who can do it |
| --- | --- |
| Play a reply aloud, use auto-read | Any signed-in user, on conversations they can open |
| Change their own read-aloud model and voice | Any signed-in user |
| Call `/api/tts` | Signed-in users only. Anonymous requests are refused. |

Auto-read is stored in the browser, not on the account, so it cannot be turned on for someone else.

## Integrations

- **OpenRouter speech endpoint** (`/api/v1/audio/speech`). Receives the text, model and voice, and returns MP3 audio. It needs `OPENROUTER_API_KEY` on the server. Without it, read-aloud reports that the key is missing.
- **OpenRouter speech catalogue** (`/api/v1/models?output_modalities=speech`). Supplies the model list, the voices, and the price per character.
- **Usage ledger**. Each synthesised chunk writes one row with source `tts` ("Read Aloud" in the cost view). The row records the model, the voice, the number of characters, why it was requested (`message`, `autoplay` or `preview`), and OpenRouter's generation id.
- **Budget limits**. Checked before every chunk, using the chunk's expected cost. A blocking limit that would be exceeded stops the request before anything is paid for.

## Business rules

- **Size cap.** One request carries at most 8,000 characters. The app splits longer replies itself, so no reply is too long to read.
- **Where chunks are cut.** Between sentences where possible, and between paragraphs by preference. A single sentence longer than a chunk is cut between words. No text is dropped or reordered.
- **What is read.**
  - Code blocks are skipped. Each run of code is announced once as "Code block omitted".
  - Links are read as their text. A bare web address is read as its site name, for example "github.com".
  - Headings, list items and table rows are read as separate sentences, so the voice pauses between them.
  - Emphasis, table borders, HTML tags and similar formatting are removed.
  - Inline code such as a function name is read as written.
- **Cost.** OpenRouter does not report the cost of a speech request, so the cost is worked out as characters × the model's catalogue price. A model with no price in the catalogue is recorded at $0 and marked as unpriced. For speech rows, the ledger's "tokens in" column holds the character count.
- **Stopping part-way.** Stop cancels any request still in progress, and the server cancels its call to OpenRouter too. A chunk that was already prepared has been paid for, though. Besides the rest of the chunk that was playing, at most one more chunk (up to 2,000 characters) can have been paid for and not heard.
- **Errors the user sees.**

| Situation | What the user is told |
| --- | --- |
| The model or voice is not accepted | The provider's own message, for example `Unknown voice "zz". Supported voices: …` |
| OpenRouter is out of credits | That OpenRouter could not bill the request |
| A budget limit blocks it | "Budget limit reached", with the limit that blocked it |
| Too many requests | That the provider is rate limiting, and to try again shortly |
| OpenRouter is down or slow | That the provider failed, or took too long to answer |
| No API key on the server | That read-aloud needs `OPENROUTER_API_KEY` |
| The browser blocks playback | To press play on the reply |

- **Browser playback rules.** Browsers only let a page start sound after the user has interacted with it, and iPhones only on audio that was first started by a tap. Turning on Auto-read and pressing any speaker button both count, so auto-read works from then on. If a browser still blocks it, the reason is shown next to the switch.

## Where it lives

| Piece | Location |
| --- | --- |
| Speaker button | `src/lib/speech/SpeakButton.svelte`, shown by `MessageBubble` |
| Auto-read switch | `src/lib/speech/AutoRead.svelte`, shown above the message box on the chat page |
| Playback, chunking and the auto-read preference | `src/lib/speech/speech-player.svelte.ts`, `src/lib/speech/speech.ts` |
| Settings pickers | `src/lib/speech/SpeechVoicePicker.svelte`, inside the Model & AI panel |
| Endpoint | `POST /api/tts` (`src/routes/api/tts/+server.ts`) |
| OpenRouter client, pricing, budget check, ledger | `src/lib/llm/tts.server.ts` |
