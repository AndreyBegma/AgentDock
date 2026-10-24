# C-387: Runner: pin DemoFlow 0.6.0 and record demos in parallel with --port and --fresh-app

## Why
The runner pins `demoflow@0.4.0` (`apps/runner/src/demos/pin.ts`). 0.4.0 could not template the port, so `card.demo` refuses a demo whenever the app's port is taken, and demos run one at a time. DemoFlow 0.6.0 (DemoFlow#337, closed 2026-10-24) adds:
- `${PORT}` / `${BASE_URL}` templating in `baseUrl`, `readyUrl` and `devCommand`;
- `--port <n>`, which also exports `PORT` to the app;
- `--fresh-app`, which refuses an app that already answers on `readyUrl`;
- `allowedOrigins` following the substituted `baseUrl`.

## What
1. Bump the pin to `0.6.0`. Check DemoFlow's 0.5.0 and 0.6.0 release notes and CLI reference for breaking changes in `run --json` output, exit codes or config, and adapt the runner.
2. `card.demo` runs `demoflow run <scenario> --json --port <free port> --fresh-app --format mp4`, dropping `--base-url` if `--port` makes it redundant. Remove the "refuse when the port is taken" guard; keep one free-port pick per demo.
3. Allow up to N demos at the same time: a runner setting, default 2 (Chromium plus FFmpeg are heavy). Keep the queue beyond N.
4. Update the projects' docs (the card guide's Demo videos section) to say configs should use `${PORT}`. Show it for Nautelle's own `demoflow.config.json` (C-383 used `$PORT` in the dev command and a fixed 3517 baseUrl): switch it to `http://127.0.0.1:${PORT}` with the default kept.
5. Runner CHANGELOG under Unreleased.

Tests: argv built with `--port` and `--fresh-app`; two demos run at once with different ports; the N limit queues the third; the pin is 0.6.0.
