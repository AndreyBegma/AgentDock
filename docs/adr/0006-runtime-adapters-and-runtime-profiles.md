# ADR-0006: Runtime adapters and runtime profiles

Status: accepted · Date: 2026-10-07

## Context

Claude Code and Codex must both be supported, and the owner launches Claude through a profile function (`claude rc` → `CLAUDE_CONFIG_DIR=~/.claude-profiles/blacktoorroot`).

## Decision

The runner has one adapter per runtime (launch command, telemetry env, transcript parser, pane heuristics). A runtime profile = runtime + binary + environment + extra args, defined in the runner's config. Projects have a default profile; every orchestrator start, skill run and schedule may override it. Shell functions and aliases are never invoked — the profile reproduces what they set.

## Consequences

Adding a runtime is one adapter. Profiles are machine facts and never stored as secrets on the server.
