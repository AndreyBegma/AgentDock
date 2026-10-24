# ADR-0090: A finished card may carry a demo video recorded by DemoFlow on the runner

Status: accepted · Date: 2026-10-24 ·
Card: C-368 (stack S-12, stage 1) ·
Spec: [`docs/specs/card-368-demo-videos-adr-data-model-and-api-for-a.md`](../specs/card-368-demo-videos-adr-data-model-and-api-for-a.md) ·
Amends: [ADR-0031](0031-attachments-are-stored-by-the-api-on-a-local-volume.md) (video types and limit) ·
Relates to: [ADR-0084](0084-a-card-passes-its-review-steps-before-finished.md), [ADR-0035](0035-a-card-ships-itself.md)

## Context

When a feature card finishes, the person reads the diff and the checks, but has
to start the app themselves to see the feature work. [DemoFlow](https://github.com/AndreyBegma/DemoFlow)
(npm `demoflow`) is a standalone product that records a browser scenario as a
video, with an MCP server an agent uses to write the scenario. Nautelle should
use it, not reimplement it, and keep its own rules: the control plane never
reads a project's filesystem ([ADR-0001](0001-control-plane-and-per-machine-runner.md)),
the runner accepts typed commands only ([ADR-0010](0010-typed-command-allowlist-on-the-runner.md)),
and attachment bytes live on the API's volume ([ADR-0031](0031-attachments-are-stored-by-the-api-on-a-local-volume.md)).
The decisions below were settled with the person on 2026-10-24.

## Decision

1. **When a demo is recorded.** Automatically for a `feature` card whose diff
   touches a path matching the project's `demoUiPaths` globs (default
   `apps/web/**`, `**/*.tsx`, `**/*.css`), once CI is green and, with review on,
   after the review steps of ADR-0084. A "Record again" action on any card
   (operator and above) asks for one more. One demo per card is queued or
   recording at a time.
2. **The card worker writes the scenario** through DemoFlow's MCP server and
   commits it in its pull request as `demoflow/cards/C-<n>-<slug>.demo.json`.
   The scenario is code under review like any other file.
3. **The runner records it.** The API sends the typed command `card.demo`
   `{ cardId, projectId, card, round, demoId, worktree, scenario, env }`, with
   `env` the names of the Demo env secrets only. The runner provisions DemoFlow
   itself — a pinned version through `npx`, `demoflow setup` for Chromium —
   starts the app from the repository's `demoflow.config.json`
   (`devCommand` / `readyUrl`) in the card's worktree on a free port it assigns,
   and runs the scenario. It reports progress as the `demo.status` event
   (`recording`, `failed`, `skipped`, each with a reason when it ends).
4. **Demo env secrets.** A project holds at most 32 named secrets
   (environment variable names), sealed with `APP_ENCRYPTION_KEY` by the
   existing `SecretCipher`. They are write-only: the API answers with names and
   who changed them last, never a value, and every change is audited without
   the value. The runner reads the values over HTTPS from
   `GET /runner/cards/:n/demos/:demoId/env` with its runner token, only while
   that demo is queued or recording, and hands them to the `demoflow` process
   environment. A scenario reads them through `valueFrom.env`, and DemoFlow
   blurs them in the video. A value is never in a socket payload or a log.
5. **The video is a card attachment.** The runner uploads it to
   `POST /runner/cards/:n/demos/:demoId/video` as a raw body
   (`Content-Type: video/mp4` or `video/webm`) with `x-demo-sha256` and
   `x-demo-duration-ms`. The API checks the runner token, that the runner owns
   the card's project, and that the demo is still active **before reading a byte
   of the body**; it then streams the body to disk, at most 100 MiB, checks the
   SHA-256 and the content signature, stores it as an attachment of the card
   (no uploader) and marks the demo `ready`. The upload is re-checked under the
   demo's row lock, so a second upload cannot land.
6. **Attachments (amends ADR-0031 §5 and its 25 MiB bound).** MP4 and WebM are
   accepted, by content signature: MP4 is `ftyp` at offset 4 with a major brand
   a browser plays (so HEIC, AVIF and QuickTime are refused); WebM is the EBML
   magic with the `webm` DocType in the first 64 bytes. A video may be up to
   100 MiB; every other type stays at 25 MiB. A video does not count toward the
   20 attachments of a card, and it is not handed to the card worker.
   `GET /projects/:p/attachments/:id/content` answers one HTTP `Range` with 206
   and `Content-Range` (416 past the end), so a player can seek.
7. **Playback.** The web app plays a demo with luna-player, falling back to a
   native `<video>` element.
8. **A failed demo never blocks.** Finished and merge never wait for a demo.
   A failed or skipped demo shows as a warning with its reason, next to the
   card's other facts. It is a step after CI and review, not a gate in the
   sense of ADR-0035 or ADR-0084.
9. **Per-project switch, off by default.** Board settings gain
   `demoVideosEnabled` (false), `demoUiPaths` and `demoTelegram` (true). A
   ready video is delivered to the card and, with `demoTelegram`, to Telegram.
10. **Retention.** No automatic deletion: a video lives as long as its card,
    like any attachment, and counts toward the project's attachment quota.
11. **Proxies.** A raw upload carries a bearer token, which a cross-site form
    cannot set, so a `@BearerBody()` route called with `Authorization: Bearer …`
    is exempt from the JSON-only rule for public non-GET routes; without the
    header the rule still answers 415. Caddy, in staging and in the public
    install's compose file (ADR-0088), keeps its 10 MB request cap for
    everything but the video upload path, which gets 100 MiB.
    Cloudflare's free plan caps a request at 100 MB, so a self-hosted instance
    behind it uploads a video of at most that size.

## Consequences

- A person can watch a feature work before merging, without starting the app.
- The runner machine needs Node and room for Chromium; DemoFlow is fetched on
  first use, pinned, so an upgrade is a runner release.
- Demo env secrets are only as safe as the runner machine and the app under
  test: the runner sees them in the clear while it records. They are meant for
  demo accounts, not production credentials; the settings UI says so.
- Without `APP_ENCRYPTION_KEY` (or with a different one) a secret cannot be
  set and the env route answers 409 `encryption_unavailable`.
- The attachment volume grows faster: up to 100 MiB per recording, kept for the
  card's lifetime. The project quota bounds it.
- Stage 1 (C-368) ships the data model, the API, the attachment changes and the
  shared contracts; "Record again" only queues the row. Dispatch and the UI
  follow in the stack's later cards.
- C-369 ships the runner side. The runner pins `demoflow@0.4.0`, fetches it
  and runs `demoflow setup` on the first demo (not at start), and reports
  `demoflow: { version, ready, reason }` in its capabilities. A round of a
  project with `demoVideosEnabled`, on a runner that advertises `cardDemo`,
  carries `demo: true` on `card.run`: the session gets DemoFlow's MCP server
  and the prompt a "Demo video" section with the scenario path and the secret
  names. `card.demo` answers at once (`recording` or `queued`); one demo
  records at a time, at most 16 wait, and a recording is stopped after
  10 minutes with every process DemoFlow started. DemoFlow 0.4.0 has neither
  port templating nor `--fresh-app`, so until a pinned version does the runner
  does not assign a port: it records only an app DemoFlow starts itself
  (`devCommand`) on a loopback `readyUrl`, and refuses with `failed` when that
  port is already in use, rather than record another app. The upload is tried
  three times on a network error, 408, 429 or 5xx.
- Rejected:
  - **Recording in the API container.** It would need the project's code and a
    browser on the control plane (ADR-0001).
  - **Secrets in the `card.demo` payload.** The socket payload is logged and
    replayed; a fetch over HTTPS, scoped to an active demo, is not.
  - **Multipart for the runner upload.** A raw body is one stream with one
    checksum; multipart adds a parser and a field name for no gain.
  - **Auto-deleting old videos.** The person asked to keep them with the card.
