# C-214: Accept photos and voice messages in the Telegram /new intake

Issue: #594

## What to do
Let the person describe New work in Telegram with photos and voice messages, on top of the `/new` intake flow in `apps/api/src/telegram/`.

- **Photos.** A photo sent with `/new`, as its caption, or during an open intake is attached to the plan:
  - the bot downloads it with `getFile` (add it to `telegram-client.ts`);
  - it stores it through the attachments service (`apps/api/src/attachments/attachments.service.ts`);
  - it passes it as `attachmentIds`, like the web dialog does.
  - Image documents count too.
  - The existing allowlist and limits apply: `ATTACHMENT_MIMES`, `ATTACHMENT_MAX_BYTES` and `ATTACHMENTS_PER_CARD_MAX` in `packages/shared/src/attachments/`. Anything over a limit gets a clear refusal.
- **Voice.** A voice message or audio note is transcribed to text, which becomes the brief or the answer. The bot echoes the transcript back so the person can see what was understood.
  - Transcription goes through a speech-to-text service configured by an admin.
  - When none is configured, the bot replies that voice input is off.
  - The audio is not stored as an attachment.
  - Add the configuration variables to `apps/api/.env.example`.
- The intake roles and guards stay as in `/new`.

## Acceptance criteria
- [ ] `/new` with a photo creates a plan whose attachment is visible in the web intake view.
- [ ] A photo sent during an open intake round is added to that plan.
- [ ] A file outside the allowlist, or over the size limit, is refused with a clear message, and nothing is stored.
- [ ] With transcription configured, a voice message starts or answers the intake, and the bot shows the transcript.
- [ ] With transcription not configured, a voice message gets a "voice input is off" reply.
- [ ] Voice audio is never stored as an attachment.
- [ ] There are e2e specs on the Telegram fake client for a photo and for both voice cases. The speech-to-text call is faked in tests.

## Out of scope
- Adding audio types to the attachment allowlist.
- Videos, documents other than images, and albums beyond the per-card attachment cap.

## Open questions
- Which speech-to-text service. Default: a Whisper-compatible HTTP endpoint (OpenAI-style `/audio/transcriptions`), configured with a URL and API key in env. Voice is off when they are unset.
