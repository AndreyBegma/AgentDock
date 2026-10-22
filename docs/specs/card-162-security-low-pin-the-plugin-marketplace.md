# C-162: Security [Low]: Pin the plugin marketplace and write absolute paths into the plugin hooks

> Security audit 2026-10-16 · **WI-60** · severity **Low** · size **S** · findings: L-36 (Z5 L8, Z9 L10), the marketplace and PATH parts
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- `apps/runner/src/setup/claude.ts:16-19,153-156` adds the repository marketplace (`MARKETPLACE_SOURCE`) at its default branch, so whatever lands on that branch is what `setup claude` installs.
- `plugins/agentdock/hooks/hooks.json:8` and `plugins/agentdock/.mcp.json:4` run `agentdock-runner` resolved from `PATH`.

**Attacker.** Anyone who can land a change on the default branch of the plugin source, or a process that can put a binary earlier on the user's `PATH`.
**Scenario.** A malicious or broken plugin revision is installed on every machine that runs `setup claude`; a shadowing `agentdock-runner` on `PATH` receives every hook payload.
**Impact.** Code runs in every Claude Code session on the machine; hook payloads (prompts, tool input) go to the wrong binary.

## Fix
- `setup claude` adds the marketplace at the tag matching `RUNNER_VERSION` (`runner-v<version>`).
- It writes the absolute path of the running `agentdock-runner` into the installed hook and MCP commands (or passes it through an env var the plugin reads), keeping the PATH form only as a fallback.
- Document the PATH trust assumption in `docs/guides/` for the plugin.

## Acceptance criteria
- Setup test: the marketplace ref passed to `claude plugin marketplace add` equals `runner-v<RUNNER_VERSION>`.
- Setup test: the hook and MCP commands written for the session contain an absolute path to the runner binary.
- The plugin still works when the absolute path is missing (fallback to PATH) — test with a fake binary.

## Touches
- apps/runner/src/setup/claude.ts
- plugins/agentdock/hooks/hooks.json
- plugins/agentdock/.mcp.json

## Decision
D-12 — fleet changes to `plugins/` need a human review and never auto-merge (00-decisions.md; ADR-0045)

## Must not run in parallel with
- WI-04


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
