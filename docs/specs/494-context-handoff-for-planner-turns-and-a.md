# C-198: Context handoff for planner turns and a PreCompact freshness check

Issue: #494

## What
Follow-up of #449 (slot i449-runner): two parts of the spec were scoped out.

1. **Planner run notes.** An interrupted plan turn should leave a haiku-written note, and a turn that starts a new session for the same work (same project and prompt) should pick it up. This needs `apps/runner/src/planner/executor.ts`. Plan turns already `--resume` their session, and `round.restart` is card-only in the contract, so there is no restart decision for plan turns.
2. **PreCompact freshness check (D8).** Add the PreCompact hook event to the shared hook events, the card wiring and `plugins/agentdock/hooks/hooks.json`. Per D-12, a plugin change needs a person's review before merge. Today SessionStart `source: compact` re-injects the note instead.

## Acceptance criteria
- [ ] A killed plan turn leaves a note, and the next new session for the same plan task starts with it.
- [ ] Before compaction, a stale note gets exactly one update request (runner test).
- [ ] The plugin hook change is reviewed by a person.
