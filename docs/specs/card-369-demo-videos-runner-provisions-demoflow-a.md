# C-369: Demo videos: runner provisions DemoFlow and records a card's demo (`card.demo`)

Stack "Demo videos of finished cards", stage 1 (Foundations). Decisions: see the stage-1 card "Demo videos: ADR, data model and API". The runner does all execution (ADR-0001, ADR-0010).

## What
1. **Provisioning.** A pinned DemoFlow version lives in the runner's config (`demoflow@0.4.x` — bump deliberately). The runner runs it with `npx --yes demoflow@<pin>`, runs `demoflow setup` once (Chromium + FFmpeg check) and reports a capability `demoflow: { version, ready, reason }` with its status, like `installed_skills`. No global install asked from the person.
2. **Card sessions get DemoFlow MCP** when the project has `demoVideosEnabled`: `demoflow mcp` added to the card session's MCP config, and the card brief gains a short section: "This project records a demo of finished UI features. Before finishing, write a scenario that shows the feature in `demoflow/cards/C-<n>-<slug>.demo.json` (DemoFlow MCP validates it), read secrets only via `valueFrom.env` using the names listed, commit it with the change."
3. **`card.demo` command** (typed, allowlisted): in the card's worktree, on the PR head:
   - pick a free local port, export `PORT` (and the project's demo secrets fetched over HTTPS with the runner token) into the process env only;
   - run `demoflow run <scenario> --json --base-url http://127.0.0.1:<port> --format mp4` with a fresh app (see DemoFlow change below); time limit 10 min; kill the app process tree after;
   - on success upload the MP4 (sha256, size) to the API upload endpoint, report `ready`; otherwise report `failed` with the failed stage and the last lines of DemoFlow's summary (never `fill` values, never env);
   - no scenario in the worktree → `skipped` with reason.
   One demo at a time per runner (Chromium + FFmpeg are heavy); others wait in a queue.
4. Secrets never touch disk or logs; the runner's filter/redaction applies to DemoFlow output.

## Depends on DemoFlow
DemoFlow reuses an app already answering on `readyUrl` and `readyUrl` is a fixed URL — parallel cards would record each other's app. A DemoFlow card (in the DemoFlow project) adds port templating (`${PORT}` in `baseUrl`/`readyUrl`/`devCommand` args) and `--fresh-app` (refuse to reuse an answering URL). Pin the DemoFlow version that ships it; until then the runner refuses `card.demo` when the port is already taken.

Tests: command allowlist, port assignment, secrets only in env, upload retry, timeout kill, skipped/failed reports.
