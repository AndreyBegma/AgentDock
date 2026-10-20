# Attachments on board cards — files and screenshots, delivered to the card worker

Issue: [#309](https://github.com/AndreyBegma/Nautelle/issues/309) ·
Decision: [ADR-0031](../adr/0031-attachments-are-stored-by-the-api-on-a-local-volume.md)

## Summary

A person can attach files and screenshots to a board card: paste a screenshot
from the clipboard, drop a file, or pick one. Attachments go on the card itself
or on a round's feedback. The card worker gets them: before each round, the
runner downloads the card's attachments into the worktree, and the prompt lists
their paths so Claude reads images and text directly. The product owner asked
for this on 2026-10-15 ("attach files, screenshots and so on to every task").
Today the only way to show an agent a screenshot is to describe it in words.

## Scope

### In scope

- Attachments on every **board card** in To Do, In progress, Finished and
  Completed. That covers all card sources: manual cards, cards accepted from
  the Inbox, and the terminal-tracked and fleet-mirrored cards of
  [#282](https://github.com/AndreyBegma/Nautelle/issues/282).
- Attachments on a **round's feedback** (the text sent with Approve & continue
  or Send feedback).
- Upload: paste, drag and drop, file picker. The places are:
  - the New card dialog;
  - the card sheet;
  - the feedback box.
- Viewing: an image thumbnail with a click to full size; other files download.
- Delivery to the **card worker** (`card.run`) through the runner.
- Delete an attachment (its uploader or an admin), with an audit record.
- Storage on a local volume behind the API (ADR-0031), limits, and the cleanup
  of uploads that were never attached.

### Out of scope

- **Plan tasks.** On the Board they are read-only projections (ADR-0028). Their
  content is edited in the Planner, and their worker is the orchestrator fleet,
  which works from GitHub issues. Follow-up: attachments in the Planner, carried
  into the published issue.
- **Inbox cards** (captured suggestions). They are content-derived and purged
  with session content (ADR-0026 §6). Attaching starts once a person accepts
  the card.
- **Workers other than the card worker:**
  - a terminal-tracked card (#282) — the person's own session;
  - a fleet-mirrored card (#282) — the orchestrator's slot.

  Both cards still store and show their attachments; only delivery is missing.
  Follow-up: an MCP tool `card_attachments` in the agentdock plugin for tracked
  cards, and an attachment line in the slot message for fleet cards.
- Design comments (ADR-0022/0025).
- Server-side image thumbnails, an image editor, annotations.
- Scanning attachments for secrets or malware. The defence is the type
  allowlist plus nosniff and download-only serving. See Risks.
- An S3-compatible store. The `AttachmentStore` port keeps it possible.

## Decisions

Every decision below is the orchestrator's. The product owner gave the goal; the rest is resolved from the decision
records, under the autonomy the owner granted for specs.

| # | Decision | Source |
|---|---|---|
| D1 | "Task" means a **board card**, of any source except the Inbox. A plan task is out of scope (see Out of scope). | ADR-0024, ADR-0028 |
| D2 | **Storage.** The API writes bytes to `ATTACHMENTS_DIR` (default `./data/attachments` in dev; a named volume `attachments` in compose and staging). Files are named `<projectId>/<attachmentId>`. Metadata lives in a new table `attachments`. All access goes through an `AttachmentStore` port (`put`, `open`, `remove`) with one filesystem implementation. | ADR-0031 §1 |
| D3 | **Owner.** An attachment belongs to a card (`cardId`), optionally to one of its rounds (`roundId`, the feedback). While uploading it is **pending**: `cardId` is null and `expiresAt` is now + 24 h. Pending attachments are bound to the project and the uploader. Creating a card or sending feedback with `attachmentIds` claims them. A pending attachment past `expiresAt` is deleted by a sweep, together with its file. | new |
| D4 | **Limits** (shared constants), each refused with its own error code: 25 MiB per file (`too_large`), 20 attachments per card including rounds (`too_many`), 1 GiB per project (`ATTACHMENTS_PROJECT_QUOTA_BYTES`, default 1073741824; `quota_exceeded`). | new |
| D5 | **Types** are an allowlist checked by **content signature** (magic bytes) in `packages/shared`, never by the name or the browser's MIME: PNG, JPEG, GIF, WebP, PDF. A file with no binary signature is text if it is valid UTF-8, has no NUL byte, and its extension is one of `.txt .md .log .csv .json .diff .patch`. Everything else gets `unsupported_type`. SVG, HTML and archives are refused. The stored MIME is the detected one. | ADR-0031 §5 |
| D6 | **Names.** The display name is the original name, cut to 200 characters. On disk and in the worktree, the name is derived: `<attachmentId>-<safe name>`, where the safe name keeps `[A-Za-z0-9._-]`, maps everything else to `_`, and is at most 80 characters with the extension kept. No path from the user ever reaches a filesystem call. | new |
| D7 | **Who.** Read: any project member, which is the role that sees the card. Upload, attach and delete own: operator, the role that edits cards. Delete anyone's: admin. Every upload, delete and claim is audited (`attachment.added`, `attachment.removed`). | ADR-0024 roles |
| D8 | **Serving.** `GET /projects/:projectId/attachments/:id/content` always sends `X-Content-Type-Options: nosniff` and `Cache-Control: private, max-age=0`. PNG, JPEG, GIF and WebP go `inline`; every other type goes `attachment` with `Content-Security-Policy: sandbox`. No public, signed or shareable URLs exist. | ADR-0031 §3 |
| D9 | **Delivery.** `card.run` args gain `attachments: AttachmentRef[]` (`id`, `name`, `mime`, `size`, `sha256`): every attachment of the card and its rounds, in upload order. Before it launches or resumes the session, the runner: (1) downloads each missing file over HTTPS from `GET /runner/attachments/:id` with `Authorization: Bearer <runner token>`; (2) checks the size and SHA-256; (3) writes it atomically to `<worktree>/.agentdock/attachments/<attachmentId>-<safe name>`; (4) deletes files there that are no longer listed; (5) makes sure `.agentdock/` is git-excluded for the worktree. If a download or check fails, `card.run` fails with `attachments_unavailable`. The API answers `/runner/attachments/:id` only for the runner of the attachment's project (`Project.runnerId`): 404 for any other runner, 401 without a valid token. | ADR-0010, ADR-0031 §4 |
| D10 | **Prompt.** `cardWorkerPrompt` gets an "Attachments" section that lists each file's worktree-relative path, name and type, and says images can be opened with Read. `cardChange` (#273) reports attachments added or removed since the last round. `CARD_WORKER_PROMPT_VERSION` becomes 4. | #273 |
| D11 | **Text.** Attachment names are not normalized (#271), and capture never reads attachments (ADR-0026). Attachments are not session content, so a content purge or content retention does not touch them. They are deleted with their card, by the same transaction that deletes the card plus a file delete after commit. | ADR-0021, ADR-0031 §6 |
| D12 | **Upload transport.** `POST /projects/:projectId/attachments` takes `multipart/form-data` with field `file`. That is what glass-ui's `useFileUpload` sends. The body is parsed by the multer that `@nestjs/platform-express` already bundles, so no dependency is added. The file streams to a temporary file under `ATTACHMENTS_DIR/tmp`, then is hashed, sniffed and renamed into place. | glass-ui #110 |
| D13 | **UI**, glass-ui only (ADR-0011): `FileDropzone` (drop, picker, paste with `pasteTarget="self"`), `useFileUpload` (progress, queue, cancel, retry), `FileItem` (row with `thumbnailUrl` for images). A click on an image opens its content URL in a new tab. No viewer is hand-rolled. A glass-ui lightbox is a possible follow-up, not a requirement. | ADR-0011 |

## Data / Schema

New table `attachments` (Prisma model `Attachment`); migration
`apps/api/prisma/migrations/20261121000000_attachments/`:

| Column | Type | Notes |
|---|---|---|
| id | String @id cuid | |
| projectId | String | FK → projects, `onDelete: Cascade` |
| cardId | String? | FK → board_cards, `onDelete: Cascade`; null while pending |
| roundId | String? | FK → board_card_rounds, `onDelete: Cascade`; set for feedback attachments |
| uploaderId | String? | FK → users, `onDelete: SetNull` |
| name | String | display name, ≤ 200 |
| mime | String | detected |
| size | Int | bytes |
| sha256 | String | hex |
| expiresAt | DateTime? | set while pending, cleared on claim |
| createdAt | DateTime @default(now()) | |

Indexes: `(cardId, createdAt)`, `(projectId)`, `(expiresAt)`.

A cascade deletes rows, not files. Files are removed by the service after a
delete commits, and by a daily orphan sweep: files with no row, and pending rows
past `expiresAt`. The sweep is a BullMQ repeatable job, so it does nothing
without `REDIS_URL`, as other jobs do.

## API

All routes are under the global `ValidationPipe`. Inputs are DTOs.

| Method · path | Role | Does |
|---|---|---|
| `POST /projects/:projectId/attachments` | operator | multipart `file` → 201 `AttachmentView` (pending). Errors (422 `attachment_error` with `code`): `too_large`, `unsupported_type`, `quota_exceeded`. |
| `DELETE /projects/:projectId/attachments/:id` | uploader (operator) or admin | 204. Refused for a card in Completed (409 `card_completed`). |
| `GET /projects/:projectId/attachments/:id/content` | member | streams the bytes (D8). |
| `POST /projects/:projectId/board/cards` | operator | body gains `attachmentIds?: string[]` (≤ 20). Each must be pending, in this project, and uploaded by the caller, else 422 `attachment_error` `not_claimable`. |
| `POST …/cards/:cardId/attachments` | operator | `{ attachmentIds }`: claims pending attachments onto an existing card. `too_many` is checked per card. |
| feedback (`Approve & continue`, `Send feedback`) | operator | body gains `attachmentIds?`, claimed onto the card and the new round. |
| `GET /runner/attachments/:id` | runner token | streams the bytes to the project's runner (D9). |

Views (in `packages/shared`): `AttachmentView` (`id`, `name`, `mime`, `size`,
`createdAt`, `uploaderName`, `roundId`, `contentUrl`), plus
`BoardCardDetail.attachments: AttachmentView[]`. The card face shows a count
(`BoardCardView.attachmentCount`).

## UI

- **New card dialog:** a `FileDropzone` under the body. Uploads start at once.
  Create sends the ids of finished uploads, and stays disabled while any upload
  is running.
- **Card sheet:**
  - an "Attachments" section with `FileItem` rows (image thumbnails), each with
    Download and, for the uploader or an admin, Remove;
  - a dropzone that claims onto the card as soon as an upload finishes;
  - pasting a screenshot anywhere in the open sheet attaches it.
- **Feedback box:** a dropzone and paste. Attachments go with the feedback, and
  the round shows them.
- **Card face:** a paperclip with the count when it is above 0.
- **Copy:** under every dropzone, "Every member of this project can open
  attachments. Do not attach secrets."
- **Refusals:** each error code has its own sentence (size, type, count, quota).
- `docs/ui/screens.md`: rows for the dialog, the sheet section and the feedback
  attachments.

## Configuration

`apps/api/.env.example` gains:

- `ATTACHMENTS_DIR` (default `./data/attachments`);
- `ATTACHMENTS_PROJECT_QUOTA_BYTES` (default `1073741824`).

`deploy/staging/docker-compose.yml` gains a named volume `attachments` mounted
into `api` at `/data/attachments`, with `ATTACHMENTS_DIR=/data/attachments` in
`deploy/staging/env/api.env.example`. `data/` is git-ignored.

## Acceptance criteria

Uploads:

- [ ] A pasted PNG screenshot uploads, shows a thumbnail, and opens full size in a new tab.
- [ ] A 26 MiB file is refused with `too_large`. A `.svg`, a `.html` and a `.zip` are refused with `unsupported_type`. A PNG renamed `.txt` is stored as `image/png`. A binary renamed `.txt` is refused.
- [ ] A 21st attachment on a card is refused with `too_many`. An upload past the project quota is refused with `quota_exceeded`.

Authorization and serving:

- [ ] **Authorization (browser):** a user who is not a member of the project gets 404 from `GET …/attachments/:id/content`. A viewer can read but gets 403 on upload and delete. An operator cannot delete another user's attachment; an admin can.
- [ ] **Authorization (runner):** `GET /runner/attachments/:id` returns 404 to a valid runner that is not the project's runner, 401 without a token, and the bytes to the project's runner.
- [ ] Every content response has `X-Content-Type-Options: nosniff`. A PDF and a text file are served `Content-Disposition: attachment` with `Content-Security-Policy: sandbox`.

Claiming and cleanup:

- [ ] Creating a card with `attachmentIds` claims them. An id from another project, or another user's pending upload, is refused with `not_claimable`.
- [ ] A pending attachment past `expiresAt` and its file are gone after the sweep runs. Deleting a card removes its attachment rows and files.

Delivery to the worker:

- [ ] `card.run` lists the card's and its rounds' attachments. The runner writes them under `.agentdock/attachments/`, verifies SHA-256 (a tampered response fails the run with `attachments_unavailable`), removes unlisted files, and `git status` in the worktree does not show `.agentdock/`.
- [ ] The worker prompt (version 4) lists the attachment paths. A round after an attachment was added says so through `cardChange`.

Isolation:

- [ ] A content purge leaves attachments in place. Capture input never contains attachment data.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i309-contract | the attachments module in shared (types, limits, signature sniffing, safe names, views, error codes); board view fields and request fields; `card.run` args and `attachments_unavailable`; worker prompt v4 and `cardChange`; audit actions; schema + migration | packages/shared/src/attachments/**, packages/shared/src/index.ts, packages/shared/src/board/contracts.ts, packages/shared/src/board/worker-prompt.ts, packages/shared/src/board/worker-prompt.spec.ts, packages/shared/src/protocol/commands/cards.ts, packages/shared/src/protocol/commands/cards.spec.ts, packages/shared/src/audit/actions.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261121000000_attachments/** | — | yes | opus |
| i309-runner | download, verify, write and prune into `.agentdock/attachments/`, git exclude, `attachments_unavailable` | apps/runner/src/cards/attachments.ts, apps/runner/src/cards/attachments.spec.ts, apps/runner/src/cards/executor.ts, apps/runner/src/cards/git.ts | i309-contract | no | sonnet |
| i309-api | store port and filesystem store, upload/content/delete/claim routes, runner route, card create and feedback claims, `card.run` args, card views, sweep job, env and compose | apps/api/src/attachments/**, apps/api/src/app.module.ts, apps/api/src/board/board.service.ts, apps/api/src/board/board-rounds.service.ts, apps/api/src/board/board-mapper.ts, apps/api/src/board/dto.ts, apps/api/src/board/board.module.ts, apps/api/.env.example, deploy/staging/docker-compose.yml, deploy/staging/env/api.env.example, deploy/README.md, .gitignore | i309-contract | no | opus |
| i309-web | dropzones in the New card dialog, the card sheet and the feedback box, the attachments section, paste, card-face count, refusal copy, screens doc | apps/web/src/lib/attachments/**, apps/web/src/components/attachments/**, apps/web/src/components/board/new-card-dialog.tsx, apps/web/src/components/board/card-sheet.tsx, apps/web/src/components/board/card-face.tsx, apps/web/src/components/board/use-card-actions.tsx, apps/web/src/lib/board/actions.ts, docs/ui/screens.md | i309-contract | no | sonnet |

The runner, API and web slots run in parallel once the contract merges. The web
slot works against the contract types. The runner slot tests against a stubbed
HTTP server; the real route arrives with i309-api.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, migrations | i309-contract | do not open |
| packages/shared/src/index.ts | i309-contract | do not open |
| apps/api/src/app.module.ts | i309-api | do not open |
| deploy/staging/docker-compose.yml, .gitignore | i309-api | do not open |
| docs/ui/screens.md | i309-web | do not open |

## Live contention

Checked against the published plan of
[#282](https://github.com/AndreyBegma/Nautelle/issues/282) (`cs:ready`, docs
PR #308). #282 and this spec own the same files:

| File(s) | #282 owner | Rule |
|---|---|---|
| packages/shared/src/board/contracts.ts, apps/api/prisma/schema.prisma, migrations | i282-contract | dispatch i309-contract only after i282-contract merges. #282's migration is `*_board_terminal_fleet`; this one is `20261121000000_attachments`, which sorts after it |
| apps/api/src/board/board.service.ts, board.module.ts, board-mapper.ts, dto.ts | i282-api-terminal | dispatch i309-api only after i282-api-terminal merges |
| apps/web/src/components/board/**, apps/web/src/lib/board/**, docs/ui/screens.md | i282-web | dispatch i309-web only after i282-web merges |
| apps/runner/src/cards/** | — | #282 touches the runner only in `apps/runner/src/mcp/**`; i309-runner may run beside #282 |

The two specs share no table. `attachments` is new, and it has foreign keys to
`board_cards` and `board_card_rounds`, which #282 only extends.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A screenshot or log contains a secret, and every project member can read it | medium | Copy under every dropzone; uploader or admin can delete; audit trail. A scan is out of scope (ADR-0031 consequences). |
| A crafted file executes in the browser | medium | Type allowlist by signature, no SVG or HTML, nosniff on every response, only raster images inline, CSP sandbox on everything else. |
| The volume is not backed up and files are lost | medium | ADR-0031 consequence; `deploy/README.md` gets a line in i309-api's PR. |
| The disk fills (the host hit 100% on 2026-10-15) | medium | Per-file, per-card and per-project limits; the pending-upload sweep. |
| `card.run` gets slower on large attachment sets | low | At most 20 × 25 MiB, downloaded only when the SHA-256 changes. |
| Overlap with #282 delays dispatch | low | Live contention above serializes per file group. |

## Open questions

- Should plan tasks get attachments in the Planner? Default: a follow-up issue
  after this ships. No change here.
- Should fleet-mirrored and terminal-tracked cards deliver attachments to their
  workers? Default: a follow-up (see Out of scope). Their cards store and show
  attachments now.

Depends on #282 (file contention only, see Live contention)
