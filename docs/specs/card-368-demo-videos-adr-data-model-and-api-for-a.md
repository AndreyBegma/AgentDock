# C-368: Demo videos: ADR, data model and API for a card's DemoFlow demo

Stack "Demo videos of finished cards", stage 1 (Foundations). DemoFlow (https://github.com/AndreyBegma/DemoFlow, npm `demoflow` 0.4.0) stays a standalone product; Nautelle uses its CLI/MCP on the runner machine. Goal: when a feature card finishes, the person opens it, watches a video of the feature working, then merges.

## Decisions (settled with the person 2026-10-24)
- Trigger: automatic for feature cards that change UI, after CI green (and review, ADR-0084), plus a "Record again" action on any card.
- The card worker writes the scenario through DemoFlow MCP and commits it in the PR (`demoflow/cards/C-<n>-<slug>.demo.json`).
- The video is a card attachment, played with luna-player (adapter with native `<video>` fallback).
- A failed demo never blocks Finished or merge: it is a warning with the reason.
- Runner provisions DemoFlow itself (pinned version via npx, `demoflow setup` for Chromium).
- Per-project switch "Demo videos", off by default; the app starts from the repo's `demoflow.config.json` (`devCommand`/`readyUrl`) in the card's worktree on a free port the runner assigns.
- Logins/data for the demo: project "Demo env" secrets stored encrypted in Nautelle, handed by the runner to the `demoflow` process env; scenarios read them via `valueFrom.env` (DemoFlow blurs them).
- Delivery: the card, and Telegram.
- Size: video up to 100 MiB; no auto-deletion, videos live as long as the card.

## This card
1. **ADR** (next number from origin/develop): "A finished card may carry a demo video recorded by DemoFlow on the runner" — records the decisions above; amends ADR-0031 (video types and limit) and relates to ADR-0084/0035 (non-blocking step after CI/review). Spec in `docs/specs/`.
2. **Prisma** (`prisma migrate dev --name card_demo_videos`):
   - board settings: `demoVideosEnabled bool default false`, `demoUiPaths string[]` (globs that make a card "UI"; default `apps/web/**`, `**/*.tsx`, `**/*.css`), `demoTelegram bool default true`;
   - `project_demo_secrets` (name, value encrypted with the existing encryption service, audit on change; values never returned by the API, only names);
   - `card_demos`: card, round, status (`queued|recording|ready|failed|skipped`), reason, scenario path, attachment id, duration, size, started/finished, trigger (`auto|manual`).
3. **Attachments (ADR-0031 amend):** allow MP4 and WebM by content signature; per-type limit 100 MiB for video (images/others stay 25 MiB); a video counts outside the 20-per-card limit. `GET …/attachments/:id/content` answers HTTP Range requests (206) so the player can seek. Runner upload endpoint `POST /runner/cards/:n/demos/:demoId/video` (runner token, only the runner owning the project, size+sha256 checked).
4. **API** (DTOs with class-validator): `GET/PATCH` project demo settings; `GET/PUT/DELETE` demo secret names/values; `GET /projects/:p/board/cards/:n/demos`; `POST …/demos` (manual "Record again", operator+); runner reports `demo.status`. Typed runner command `card.demo` defined in `packages/shared` (framework-free): `{ card, round, demoId, worktree, scenario, env: names only }` — secrets fetched by the runner over HTTPS, never in the socket payload.
5. Shared types for the demo status so web/runner use one source.

e2e tests for: settings, secrets never echoed, Range responses, video signature check, upload auth (foreign runner → 403), manual demo creation.

## Design (as built)

The decision record is [ADR-0090](../adr/0090-a-finished-card-may-carry-a-demo-video-recorded-by-demoflow-on-the-runner.md). The card asked for ADR-0089, but that number was taken on `develop` while the card was worked, so the ADR is 0090.

### Data model

Migration `20261231000023_card_demo_videos`:

- `board_settings`: `demoVideosEnabled` (false), `demoUiPaths` (the three default globs), `demoTelegram` (true).
- `project_demo_secrets`: `(projectId, name)` unique, `valueCiphertext` sealed by `SecretCipher` (`v1:<iv>:<tag>:<ct>`), `updatedById` (set null when the user is deleted). At most 32 per project, enforced under an advisory lock.
- `card_demos`: `cardId`, `round`, `status`, `trigger`, `reason`, `scenarioPath`, `attachmentId` (set null when the attachment is deleted), `durationMs`, `size`, `requestedById`, `startedAt`, `finishedAt`, `createdAt`.

### Shared contracts (`packages/shared`)

- `src/demos/contracts.ts`: `DEMO_STATUSES`, `DEMO_ACTIVE_STATUSES`, `DEMO_TRIGGERS`, the name/scenario/id schemas, the views (`DemoSettingsView`, `DemoSecretView`, `CardDemoView`, `RunnerDemoEnvView`), `DEMO_ERROR`, `DEMO_UPLOAD_HEADERS`, `runnerDemoVideoPath`, `runnerDemoEnvPath`.
- `src/protocol/commands/demos.ts`: the typed command `card.demo` `{ cardId, projectId, card, round, demoId, worktree: { root, shortId }, scenario, env: names }`, minimum role operator, 15 s timeout. The runner's handler answers `unsupported` until stage 2; the API dispatches it only to a runner advertising the `cardDemo` capability.
- `src/protocol/events/demos.ts`: the runner's `demo.status` event (`recording`, `failed` with a reason, `skipped` with a reason). The video upload, not an event, makes a demo `ready`.

### Routes

| Route | Who | Answer |
| --- | --- | --- |
| `GET /projects/:p/demos/settings` | member | `DemoSettingsView` |
| `PATCH /projects/:p/demos/settings` | project admin | `DemoSettingsView`, audited |
| `GET /projects/:p/demos/secrets` | member | `DemoSecretView[]`, names only |
| `PUT /projects/:p/demos/secrets/:name` | project admin | `DemoSecretView`, audited without the value (`replaced` on an overwrite) |
| `DELETE /projects/:p/demos/secrets/:name` | project admin | 204, audited |
| `GET /projects/:p/board/cards/:n/demos` | member | `CardDemoView[]`, newest first |
| `POST /projects/:p/board/cards/:n/demos` | operator | 201 `CardDemoView` (`queued`, `manual`), audited |
| `GET /runner/cards/:n/demos/:demoId/env` | the project's runner token | `RunnerDemoEnvView` while the demo is queued or recording |
| `POST /runner/cards/:n/demos/:demoId/video` | the project's runner token | 201 `CardDemoView` (`ready`) |

Error codes are `DEMO_ERROR`: `demos_disabled`, `demo_in_flight`, `no_round` and `demo_not_active` (409), `encryption_unavailable` (409), `too_many_secrets` and `integrity_mismatch` (422). An unknown card, demo or secret is 404; a runner that does not own the card's project is 403.

### The runner's upload

The body is the raw video, with `Authorization: Bearer <runner token>`, `x-demo-sha256` (hex) and `x-demo-duration-ms`. Because the public route takes a non-JSON body, it is marked `@BearerBody()`: the CSRF guard exempts it only when the request carries a bearer token, which a cross-site form cannot set. The API checks the token, the project's runner and the demo's status before it reads the body, streams it to disk with a 100 MiB cap, checks the SHA-256 and the content signature, stores the attachment with no uploader and marks the demo `ready` under the demo's row lock.

### Attachments (amends ADR-0031)

MP4 (`ftyp` with a browser-playable major brand) and WebM (EBML with the `webm` DocType) are accepted by signature. A video may be up to 100 MiB, any other type 25 MiB. Videos do not count toward the 20 per card and are not handed to the card worker. The member content route answers a single `Range` with 206 and `Content-Range`, and 416 past the end.

### Proxies

Both Caddy configurations (`deploy/staging/Caddyfile` and the inline one in `deploy/compose/docker-compose.yml`) keep the 10 MB request cap everywhere except the video upload path, which gets 100 MiB.

### Out of scope (later stages of S-12)

Dispatching `card.demo`, the auto trigger, recording on the runner, Telegram delivery, the Demo section on Overview, the board tile chip and the Settings → Demo videos tab.
