# C-179: Security [Info]: Load no MCP servers in capture, normalize and assess runs

> Security audit 2026-10-16 · **WI-77** · severity **Info** · size **S** · findings: Z5 I2
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`apps/runner/src/capture/executor.ts:203-218`, `normalize/executor.ts:145-160` and `assess/executor.ts:148-163` pass `--strict-mcp-config` only through `textCallTokenSaver` (`apps/runner/src/launch/token-saver.ts:83-100`). With Token saver off they load the profile's own MCP servers; with it on they load the project's allowlist. These calls run with `--tools ""` and need none.

**Attacker.** Text in a session or card that these headless calls read (prompt injection), combined with a user MCP server that acts.
**Scenario.** A headless capture call starts the user's MCP servers; their startup side effects run and their tools are listed in the context.
**Impact.** Unneeded code runs on every capture; a wider surface for injected text.

## Fix
These three launches always pass `--strict-mcp-config` with an empty MCP config, independent of Token saver and its allowlist.

## Acceptance criteria
- Argv tests for capture, normalize and assess: `--strict-mcp-config` with an empty config is present with Token saver off and with a non-empty allowlist.
- The existing Token saver launch tests still pass.

## Touches
- apps/runner/src/capture/executor.ts
- apps/runner/src/normalize/executor.ts
- apps/runner/src/assess/executor.ts
- apps/runner/src/launch/token-saver.ts

## Decision
none needed

## Must not run in parallel with
- WI-59


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
