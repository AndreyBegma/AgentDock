# ADR-0056: Telegram voice input goes through a configured speech-to-text service; photos are ordinary uploads

Status: accepted · Date: 2026-10-17 ·
Card: C-214 (stack S-1) ·
Spec: [`docs/specs/594-accept-photos-and-voice-messages-in-the.md`](../specs/594-accept-photos-and-voice-messages-in-the.md) ·
Widens: #574 (the `/new` intake), #309 / ADR-0031 (attachments), #337 D10

## Context

The `/new` intake (#574) takes text only. On a phone, a person describes a bug fastest with a screenshot and a spoken sentence. The web dialog already lets a plan hold uploads (#337 D10), with the allowlist, size limit, per-card cap and project quota of ADR-0031. Voice has no counterpart anywhere in AgentDock: the runner has no speech model, and the planner reads text.

## Decision

1. **A photo is an ordinary upload.** The bot downloads it with the Bot API's `getFile` and stores it through `AttachmentsService` as the author's pending upload — the same content sniffing, allowlist, size limit and quota as `POST /attachments`. The plan claims it: at `/new` as `attachmentIds`, like the web dialog, or between turns while the intake is open (`PlanService.attach`, under the plan's row lock, refused once the intake is closed). A photo sent before the description waits in `telegram_intakes.attachmentIds` until the plan is created. Image documents count; other documents, videos and albums past the per-card cap are refused with a reply that says nothing was stored. The intake view lists the plan's attachments (`PlanIntakeView.attachments`).
2. **Voice is transcribed by a Whisper-compatible HTTP service an admin configures** with `SPEECH_TO_TEXT_URL` (the API base; the bot posts to `<base>/audio/transcriptions`, OpenAI-style multipart), an optional `SPEECH_TO_TEXT_API_KEY` sent as a bearer token, and `SPEECH_TO_TEXT_MODEL` (default `whisper-1`). OpenAI and self-hosted servers that copy its route both fit. Without a URL, voice input is off and the bot says so.
3. **The audio is never stored.** It is downloaded into memory, sent to the service and dropped. The transcript is shown back to the chat first ("Heard: …"), then used as the description or as the answer to the question the voice message replies to.
4. **The intake's guards do not change.** Every photo and voice message passes the same role and chat checks as `/new` before anything is downloaded.

## Consequences

- With voice on, a person's recorded voice leaves the host for the configured service. That is an admin's choice, made by setting the URL; a self-hosted server keeps the audio local.
- The key is server-side only: it is never logged, returned or sent to a runner, and a failed transcription is reported in fixed words, not the service's answer.
- The Bot API serves files up to 20 MB, so a larger voice message is refused before download; photos keep the 25 MiB attachment limit, which Telegram's own limit makes unreachable in practice.
