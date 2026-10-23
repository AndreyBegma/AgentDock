# C-169: Security [Low]: Treat agent-written fleet events as advisory

> Security audit 2026-10-16 · **WI-67** · severity **Low** · size **M** · findings: L-32 (Z5 L4)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- `apps/runner/src/collectors/events/events.ts` forwards any event type it parses from the worktree's `events.jsonl`.
- `apps/runner/src/local/service.ts:92` (`case 'event'`) forwards `op:event` hook events from any local caller.

Both sources are writable by the agents themselves.

**Attacker.** A prompt-injected agent session on the runner's machine.
**Scenario.** The agent appends events claiming a review passed, an approval was given or a PR merged.
**Impact.** The board and activity show false state; if a projector trusts such an event, merge or approval state changes without a person.

## Fix
The runner accepts, per source, only the event types that source is meant to emit (an allowlist per collector). The API marks these events advisory and never lets them set merge, approval or check state; those come only from runner commands and GitHub.

## Acceptance criteria
- Collector test: an `approvals.*` line written to `events.jsonl` is dropped with a warning.
- Local-service test: an `op:event` of a type outside the hook allowlist is refused.
- API projector test: an advisory event cannot change a slot's merge or approval state.

## Touches
- apps/runner/src/collectors/events/events.ts
- apps/runner/src/local/service.ts
- apps/api/src/fleet/*projector*

## Decision
none needed

## Must not run in parallel with
- WI-11
- WI-12
- WI-59


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
