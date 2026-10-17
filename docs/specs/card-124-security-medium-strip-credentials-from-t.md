# C-124: Security [Medium]: Strip credentials from the origin URL and error text the runner reports

> Security audit 2026-10-16 · **WI-22** · severity **Medium** · size **S** · findings: F-22 (Z5 M3), Z5 I1
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-22 (Z5 M3). `apps/runner/src/projects/inspect.ts:143` reports the git origin URL verbatim in `project.inspect` / `project.refresh`, including `https://user:token@host/...`. The server stores and shows it. Z5 I1: runner error messages sent to the server can also carry URLs with userinfo.

**Attacker.** Any project member who can read the project's inspection data, or anyone with DB access.

**Scenario.** A checkout cloned with a token in the remote URL is added as a project.

**Impact.** A forge token is disclosed to every member and stored in the database.

## Fix
- Strip `user:pass@`, query and fragment from `remote.url` before reporting; add an inspection warning `origin_url_had_credentials` when something was stripped.
- One helper (`redactUrlUserinfo`) applied to every error message the runner sends to the server.

## Acceptance criteria
- Inspect regression test: an origin with a token in userinfo is reported as `https://github.com/o/r.git` plus the warning.
- Error-message test: a message containing a URL with userinfo is sent with the userinfo masked.
- SSH-style origins (`git@github.com:o/r.git`) are reported unchanged.

## Touches
- apps/runner/src/projects/inspect.ts
- apps/runner/src/projects/remote.ts
- apps/runner/src/redact-url.ts
- apps/runner/src/log.ts

## Decision
none needed

## Must not run in parallel with
- WI-26


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
