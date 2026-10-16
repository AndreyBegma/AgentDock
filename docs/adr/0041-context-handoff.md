# ADR-0041: Context handoff — a kept note, and the runner restarts the cheapest way

Status: accepted · Date: 2026-10-16 ·
Issue: [#449](https://github.com/AndreyBegma/AgentDock/issues/449) ·
Spec: [`docs/specs/449-context-handoff.md`](../specs/449-context-handoff.md)

## Context

A card round resumes the card's Claude session (ADR-0024, D5 of #273). That keeps context only while the session lives, and a cache-cold resume re-reads the whole history at full input price. Compaction drops decisions and dead ends. A person's own terminal session, a dead session, and a re-run design or planner turn start from zero.

## Decision

1. **Every card and long run has a handoff note.** It has fixed sections and is capped at about 3k tokens. The agent keeps it at key moments, and a local haiku writes it from the transcript when a session died without one. It lives in the worktree or run directory, with a copy in the API only when session content is on (ADR-0021).
2. **The runner restarts the cheapest way.** It estimates the first turn's cost for `--resume` (history, cache warm or cold) and for a fresh session seeded with the note, the diff and the checklist, and takes the cheaper one. Both estimates and the decision are recorded. The old session is never discarded.
3. **A person can steer through the note.** Edits in the card sheet are marked as the person's, and the agent keeps them.
4. **A person's terminal session on a card gets the note** through the agentdock plugin's `SessionStart` hook, `track_card` and the `resume_context` MCP tool.
5. **The warm-up is measured:** tokens and time to the first edit, resume vs fresh, before and after. It is shown with Token saver (ADR-0039).

## Consequences

- One more piece of agent discipline (the note), enforced by a freshness check and a haiku fallback.
- A wrong restart choice costs tokens, not correctness: the old session can still be resumed, and the recorded estimates let the rule be tuned.
- The fleet keeps its own resume mechanism (ADR-0005) until the plugin adopts the note.
