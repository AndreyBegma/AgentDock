# ADR-0024: Board cards are work items AgentDock owns; each runs a dedicated interactive worker outside the orchestrator

Status: accepted · Date: 2026-10-14 ·
Issue: [#242](https://github.com/AndreyBegma/AgentDock/issues/242) ·
Amends [ADR-0004](0004-github-issues-are-the-task-queue.md) · scopes
[ADR-0005](0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md)

## Context

People want to keep small pieces of work next to a project and hand each one
to an agent without writing a GitHub issue first, without waiting for the
orchestrator's next round, and without the fleet's ceremony (brief, fence,
checkpoints). They also want to see that work move — To Do, In progress,
Finished — and to review it and send it back before calling it done.

Until now every agent in AgentDock was either the fleet (ADR-0004: GitHub
issues are the queue; ADR-0005: AgentDock drives cs-orchestrator), a headless
skill run (spec 24), a planner turn (ADR-0019) or a person's own manual
session (ADR-0020). None of them is a long-lived, interactive worker bound to
one item of work that a person can talk to, resume with feedback, and accept.

## Decision

1. **A card is AgentDock's own entity** (`BoardCard`), per project, numbered
   `C-<n>` per project. It is not a GitHub issue and not part of the fleet
   queue. Starting work may create a GitHub issue and/or a spec file, per card
   (`issueOnRun`, `specOnRun`); an issue a card creates is **never queued** —
   it carries no ready label and says it is tracked on the board.
2. **Columns are a fixed enum** — `todo`, `in_progress`, `finished`,
   `completed` — and order inside a column is a fractional index. One pure
   function, `boardMoveRule` (`packages/shared/src/board/moves.ts`), decides
   every move: the API enforces it, the web pre-checks with it. A drag never
   starts a worker; an active round holds the card in In progress (except to
   Finished, or with an explicit stop); automation never completes a card and
   never moves a completed one.
3. **Run starts a dedicated worker**: its own git worktree
   (`.wt-<repo>-card-<shortid>`), its own tmux session
   (`agentdock-card-<shortid>`) and an **interactive** Claude Code session
   whose uuid the API chooses, so the session's `hook.*` events match the card
   deterministically. Each Run or feedback is a **round** with its own `runs`
   row of kind `card`, so cost, history and budgets work as they do for skill
   runs and planner turns.
4. **The worker is outside the orchestrator.** It is not a slot: no brief, no
   fence, no checkpoints, and `correlateCwd` gives non-slot worktree prefixes
   (`run-`, `skill-`, `card-`, `plan-`, `uiprofile-`) no slot, so card
   sessions never appear in Fleet. Its session origin is `run`.
5. **The worker prompt is AgentDock's fixed, versioned code**
   (`packages/shared/src/board/worker-prompt.ts`), not cs-worker and not
   editable: the card, branch, base and spec; work only in this worktree and
   branch; commit; do not push or open a PR; follow `CLAUDE.md`/`AGENTS.md`;
   run the tests; call `finish_card` when done.
6. **Done is detected in a fixed order of trust**: the worker's `finish_card`
   MCP tool (local method `card.finish`, resolved by the request's session
   id); the tmux session ending; the person (Mark finished, or a drag to
   Finished). Entering Finished collects the work — commit leftovers, push,
   open one PR into the base with `Closes #n` and an `AgentDock-Card: C-n`
   marker, push only afterwards. Feedback resumes the same Claude session in
   the same worktree as a new round. Only a person moves a card to Completed;
   that closes the worker and removes the worktree, and never merges.
7. **The runner gets typed commands only** (ADR-0010): `card.run`,
   `card.stop`, `card.collect`, `card.close` — strict objects, no command
   text, no session names, repository-relative files only — the event
   `card_run.phase_changed`, and a `card` terminal target that resolves only
   that project's card session. Attaching stays admin-only (spec 29 D1).

## Alternatives rejected

- **Cards as GitHub issues with a board label.** Every card would be public
  in the repository and dispatchable by the orchestrator, which is exactly
  what a card must not be; the board would also depend on the issue cache's
  latency for every move.
- **Queueing the card for the orchestrator.** The fleet's guarantees (fences,
  checkpoints, one slot per issue) are the wrong weight for a small card, and
  the person could not talk to or resume the worker.
- **A headless skill run per card** (`-p`). Not interactive: no way to answer
  the worker's question or to see it work, and feedback would start a new
  session without the context of the first.
- **Running cs-worker with a generated brief.** Couples the card to the
  orchestrator's protocol and its reply file, for a worker nobody orchestrates.
- **Free-form column names or per-project columns.** Automatic moves and the
  move rules need columns with a fixed meaning; custom columns can come later
  as a view over these.
- **Inferring the session from tmux or the worktree path.** The API choosing
  the session uuid makes matching exact and survives a resumed session.

## Consequences

- ADR-0004 now reads: GitHub issues are the **fleet's** queue. A card may
  create an issue for traceability; that issue is never queued.
- ADR-0005 is scoped: AgentDock drives cs-orchestrator for the fleet, and runs
  its own fixed prompt for card workers.
- A new `RunKind` (`card`), three tables (`board_cards`, `board_card_rounds`,
  `board_settings`), two notification kinds (`card.finished`,
  `card.waiting`) and ten audit actions.
- A card worker can run with the plugin's hooks absent; done detection then
  falls back to the session ending or the person, and the card says hooks are
  not installed.
- Card workers count against budgets and against `board_settings.maxRunning`,
  not against the fleet's slot limits.
- Consistent with ADR-0001 (the runner touches the filesystem, the control
  plane never does), ADR-0006 (runtime profiles; Codex is refused for now)
  and ADR-0010 (typed commands only).
