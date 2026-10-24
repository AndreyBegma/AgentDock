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
