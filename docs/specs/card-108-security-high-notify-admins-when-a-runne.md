# C-108: Security [High]: Notify admins when a runner's connection is replaced, and stop the replaced daemon loudly

> Security audit 2026-10-16 · **WI-06** · severity **High** · size **S** · findings: F-07 (Z5 H2), the detection part
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
Every agent session runs as the daemon's UID and can read `~/.config/agentdock/runner.json` (`apps/runner/src/config.ts:37,135`; the file is 0600 but same-UID). A second connection with the same token replaces the first: `RunnerConnections.attach` closes the older socket with 4409 (`apps/api/src/runners/runner-connections.ts:84-85`, `packages/shared/src/protocol/version.ts:14`). The runner treats 4409 as terminal and exits 78, which the unit does not restart (`apps/runner/src/service.ts:10-12,66-68`). Nothing is recorded or shown.

**Attacker.** A prompt-injected agent session (card worker, skill, any Claude session on the machine).

**Scenario.** The session reads the token and connects with it; the real daemon is silently kicked off and the impostor receives the machine's commands and reports its own events.

**Impact.** Silent takeover of a runner identity; nobody learns of it.

## Fix
- API: when `attach` closes a live socket with 4409, write an audit row `runner.connection_replaced` with both peer IPs and user agents, and notify admins (new notification kind `runner.connection_replaced`).
- Runner: before exiting 78 on 4409, write a local log line and a status file that `agentdock-runner status` prints: "replaced by another connection at <time>, re-pair if this was not you".

## Acceptance criteria
- Regression e2e: two sockets for one runner, the second sends `hello`; an audit row `runner.connection_replaced` with both IPs and an admin notification exist
- Runner unit test: a 4409 close writes the status that `agentdock-runner status` prints, then exits 78
- A normal reconnect after the first socket closed on its own writes no audit row and no notification

## Touches
- apps/api/src/runners/runner-connections.ts
- apps/api/src/notifications/**
- apps/runner/src/connection.ts
- apps/runner/src/daemon.ts
- apps/runner/src/cli.ts
- apps/runner/src/service.ts

## Decision
D-02 — detect now (this item), then move the token to the OS keychain / a key-bound token agents cannot read (later card, not in scope)

## Must not run in parallel with
- WI-16


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
