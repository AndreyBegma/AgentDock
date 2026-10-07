# ADR-0013: Codex workers and their fence

Status: accepted · Date: 2026-10-07

## Context

Claude workers are fenced by `fence.py` as a PreToolUse hook. Codex offers sandbox modes but, as far as is known today, no equivalent pre-tool hook. [Unknown — re-check against current Codex docs in M4.]

## Decision

Codex workers run in their own worktree with `workspace-write` sandbox, the same brief, and a pre-merge ownership check that fails the slot if the diff touches files outside `owns:`. Runtime per slot is chosen by project setting (claude only / codex allowed / codex preferred) and recorded on the board.

## Consequences

Weaker isolation than Claude slots: violations are caught at merge, not prevented.
