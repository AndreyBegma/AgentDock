# Terminal attach hangs on Connecting on staging: the socket URL drops the /api prefix

Issue: #387 · Board card: C-50 · Kind: bug

## What to do

On staging, opening Terminal attach on a card (e.g. C-39) sits on **Connecting…** and never shows the session. Reproduced on 2026-10-16 from the staging page:

- `wss://staging-agentdock.luna-realm.com/api/live` opens;
- `wss://staging-agentdock.luna-realm.com/api/terminal?ticket=x&cols=80&rows=24` opens;
- `wss://staging-agentdock.luna-realm.com/terminal?ticket=x&cols=80&rows=24` stays in CONNECTING (readyState 0) — this is the URL the web app builds.

Root cause: `terminalSocketUrl` in `apps/web/src/lib/terminal/format.ts` takes `NEXT_PUBLIC_LIVE_URL` and replaces the whole pathname with `TERMINAL_WS_PATH` (`/terminal`). Locally the live URL is `ws://localhost:8180/live`, so this works. Staging builds with `NEXT_PUBLIC_LIVE_URL=wss://<host>/api/live` (`deploy/staging/build-staging.sh`), so the `/api` prefix is lost and the request goes to the web app, not the API.

Fix: derive the terminal path from the live URL's base path. Replace only the last segment (`/api/live` → `/api/terminal`, `/live` → `/terminal`), keeping the host, scheme and any prefix. Check other places that build a socket URL from `NEXT_PUBLIC_LIVE_URL` for the same mistake.

Also check why the view showed **Connecting…** instead of **Could not connect**. `AttachSupervisor` (`apps/web/src/lib/terminal/attach.ts`) should abandon an attempt after 10 s and give up after 30 s. If the supervisor is not driving the view in this path, fix it so a socket that never opens ends in the failed state with Retry.

## Acceptance criteria

- [ ] With `NEXT_PUBLIC_LIVE_URL=wss://host/api/live`, the terminal socket URL is `wss://host/api/terminal?...`; with `ws://localhost:8180/live` it stays `ws://localhost:8180/terminal?...`. Unit tests in `format.test.ts` cover both, plus a prefix with a trailing slash.
- [ ] On staging, Terminal attach on a running card session reaches **Attached** and shows the pane, read-only, with Take control working.
- [ ] A terminal socket that never opens ends in **Could not connect** with Retry within 30 s, not an endless **Connecting…**. A test covers it if the cause is in testable logic.
- [ ] `bun run check` and `bun run test` pass.

## Out of scope

- Changing the Caddy routes or the staging build arguments.
- The live-updates socket itself, unless it has the same path bug.
